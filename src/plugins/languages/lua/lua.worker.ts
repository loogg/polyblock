import { LuaFactory } from 'wasmoon';
import type { WorkerControlMessage } from '../../../workers/debugSession';
import { WorkerProtocolHost } from '../../../workers/workerProtocolHost';

let cachedWasmUrl: string | null = null;
let factory: LuaFactory | null = null;

const host = new WorkerProtocolHost((payload) => self.postMessage(payload));

function formatLuaArg(val: unknown): string {
  if (val === null || val === undefined) return 'nil';
  if (typeof val === 'object') {
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

const LUA_BOOTSTRAP = `
local function __poly_escape_str(s)
  return (tostring(s)
    :gsub("\\\\", "\\\\\\\\")
    :gsub('"', '\\\\"')
    :gsub("\\n", "\\\\n")
    :gsub("\\r", "\\\\r")
    :gsub("\\t", "\\\\t"))
end

local function __poly_fmt_val(v, depth)
  depth = depth or 0
  local t = type(v)
  if t == "string" then
    return '"' .. v .. '"'
  elseif t == "number" or t == "boolean" then
    return tostring(v)
  elseif t == "nil" then
    return "nil"
  elseif t == "table" then
    if depth >= 2 then return "{...}" end
    local parts = {}
    local n = #v
    if n > 0 then
      for idx = 1, math.min(n, 16) do
        parts[#parts + 1] = __poly_fmt_val(v[idx], depth + 1)
      end
      if n > 16 then parts[#parts + 1] = "..." end
      return "[" .. table.concat(parts, ", ") .. "]"
    else
      local count = 0
      for k, val in pairs(v) do
        count = count + 1
        if count > 10 then
          parts[#parts + 1] = "..."
          break
        end
        parts[#parts + 1] = tostring(k) .. "=" .. __poly_fmt_val(val, depth + 1)
      end
      return "{" .. table.concat(parts, ", ") .. "}"
    end
  end
  return tostring(v)
end

function __poly_snap(tbl)
  if type(tbl) ~= "table" then return "{}" end
  local entries = {}
  for k, v in pairs(tbl) do
    entries[#entries + 1] = '"' .. __poly_escape_str(k) .. '":"' .. __poly_escape_str(__poly_fmt_val(v, 0)) .. '"'
  end
  return "{" .. table.concat(entries, ",") .. "}"
end

print = function(...)
  local n = select('#', ...)
  local out = {}
  for i = 1, n do
    out[i] = tostring(select(i, ...))
  end
  __poly_print(table.concat(out, "\\t"))
end

__poly_start_co = nil

-- Pure-Lua yieldable require wrapper: prevents Lua 5.4 "attempt to yield across a C-call boundary"
-- when on_start() coroutine loads companion modules like require("timers") with stepping or breakpoints.
local __poly_orig_require = require
function require(modname)
  local cached = package.loaded[modname]
  if cached ~= nil then return cached end
  local loader = package.preload[modname]
  if type(loader) == "function" then
    local res = loader(modname)
    if res == nil then res = true end
    package.loaded[modname] = res
    return res
  end
  return __poly_orig_require(modname)
end

function sleep_ms(ms)
  local cur, is_main = coroutine.running()
  if cur == nil or is_main or cur ~= __poly_start_co then
    error("禁止在同步事件回调或顶层脚本中调用 sleep_ms()；请移至「当程序启动 (on_start)」协程内。", 2)
  end
  coroutine.yield("__POLY_SLEEP__", tonumber(ms) or 0)
end

function __poly_tick(blockId, varsJson)
  if __poly_start_co ~= nil and coroutine.running() == __poly_start_co then
    coroutine.yield("__POLY_STEP__", blockId, varsJson)
    return
  end
  __poly_step(blockId, varsJson):await()
end

function __poly_yield_check()
  if __poly_start_co ~= nil and coroutine.running() == __poly_start_co then
    coroutine.yield("__POLY_SLICE_CHECK__")
  end
end
`;

self.onmessage = (event: MessageEvent<WorkerControlMessage>) => {
  void host.handleMessage(
    event.data,
    async ({
      msg,
      runId,
      session,
      scheduler,
      post,
      emitScopedState,
      getScopedState,
      emitCustomEvent,
    }) => {
      const { code, wasmUrl, mockModules } = msg;

      if (!factory || cachedWasmUrl !== wasmUrl) {
        factory = new LuaFactory(wasmUrl);
        cachedWasmUrl = wasmUrl;
      }

      const engine = await factory.createEngine({ openStandardLibs: true });

      try {
        const seed = Math.floor(Date.now() % 2147483647);

        engine.global.set('__poly_print', (...args: unknown[]) => {
          const line = args.map(formatLuaArg).join('\t');
          post({ type: 'STDOUT', runId, line });
        });

        engine.global.set('__poly_step', (blockId: string, varsJson: string) =>
          session.onStep(String(blockId), varsJson, false),
        );

        engine.global.set('__poly_step_start', (blockId: string, varsJson: string) =>
          session.onStep(String(blockId), varsJson, true),
        );

        engine.global.set('__poly_final_snap', (varsJson: string) => {
          session.setFinalVars(varsJson);
        });

        engine.global.set('__poly_sim_set', (kind: string, value: unknown) =>
          emitScopedState(undefined, kind, value),
        );
        engine.global.set(
          '__poly_sim_set_scoped',
          (packId: string, kind: string, value: unknown) =>
            emitScopedState(String(packId), kind, value),
        );
        engine.global.set('__poly_sim_get', (key: string) =>
          getScopedState(undefined, key),
        );
        engine.global.set('__poly_sim_get_scoped', (packId: string, key: string) =>
          getScopedState(String(packId), key),
        );
        engine.global.set('__poly_emit_event', (eventName: string, ...args: unknown[]) =>
          emitCustomEvent(eventName, args),
        );
        engine.global.set('__poly_last_event_name', () => scheduler.getLastEventName());
        engine.global.set('__poly_last_event_argc', () =>
          scheduler.getLastEventArgCount(),
        );
        engine.global.set('__poly_last_event_arg', (idx: number) =>
          scheduler.getLastEventArg(idx),
        );

        engine.global.set('__poly_now_ms', () => performance.now());

        // Phase 5 rt scheduler bindings (isolated per run / per lua_State)
        engine.global.set('__poly_rt_set_run_period', (ms: unknown) =>
          scheduler.setRunPeriod(ms),
        );
        engine.global.set('__poly_rt_start_run', () => scheduler.startRun());
        engine.global.set('__poly_rt_stop_run', () => scheduler.stopRun());
        engine.global.set(
          '__poly_rt_start_timer',
          (id: unknown, periodMs: unknown, repeat: unknown) =>
            scheduler.startTimer(id, periodMs, repeat ?? 0),
        );
        engine.global.set('__poly_rt_stop_timer', (id: unknown) =>
          scheduler.stopTimer(id),
        );
        engine.global.set('__poly_rt_get_timer_value', (id: unknown) =>
          scheduler.getTimerValue(id),
        );
        engine.global.set('__poly_rt_is_timer_running', (id: unknown) =>
          scheduler.isTimerRunning(id),
        );
        engine.global.set('__poly_rt_tick', () => scheduler.getTick());
        engine.global.set('__poly_rt_ms_to_tick', (ms: unknown) =>
          scheduler.msToTick(ms),
        );
        engine.global.set(
          '__poly_rt_is_expired',
          (startTick: unknown, timeoutTicks: unknown) =>
            scheduler.isTickExpired(startTick, timeoutTicks),
        );
        engine.global.set(
          '__poly_init_scheduler',
          (
            hasStart: unknown,
            hasRun: unknown,
            hasTimer: unknown,
            hasExternalEvents: unknown,
          ) =>
            scheduler.initCoroutineMode(
              Boolean(hasStart),
              Boolean(hasRun),
              Boolean(hasTimer),
              Boolean(hasExternalEvents),
            ),
        );
        engine.global.set(
          '__poly_sync_handlers',
          (hasRun: unknown, hasTimer: unknown, hasExternalEvents: unknown) =>
            scheduler.syncHandlers(
              Boolean(hasRun),
              Boolean(hasTimer),
              Boolean(hasExternalEvents),
            ),
        );
        engine.global.set('__poly_co_sleep', (ms: unknown) =>
          scheduler.onStartCoSleep(ms),
        );
        engine.global.set('__poly_co_yield_slice', () =>
          scheduler.onStartCoYieldSlice(),
        );
        engine.global.set('__poly_co_done', () => scheduler.onStartCoDone());
        engine.global.set('__poly_get_time_slice_ms', () =>
          scheduler.getTimeSliceMs(),
        );
        engine.global.set('__poly_logic_now_ms', () => scheduler.now());
        engine.global.set('__poly_is_stop_requested', () =>
          scheduler.isStopRequested(),
        );
        engine.global.set('__poly_cb_enter', (name: unknown) =>
          scheduler.beginCallback(String(name ?? 'callback')),
        );
        engine.global.set('__poly_cb_exit', () => scheduler.endCallback());
        engine.global.set('__poly_cb_expired', () =>
          scheduler.isCallbackTimedOut(),
        );
        engine.global.set('__poly_next_event', () => scheduler.nextEvent());

        await engine.doString(`math.randomseed(${seed})\n${LUA_BOOTSTRAP}`);

        // Mount sandbox extension mock modules into Lua's package.preload with automatic packId scoping
        for (const mod of mockModules ?? []) {
          const luaSrc = mod.sources?.lua;
          if (!luaSrc || !mod.moduleName) continue;
          const safeModName = JSON.stringify(mod.moduleName);
          const safeSrc = JSON.stringify(luaSrc);
          if (mod.packId) {
            const safePackId = JSON.stringify(mod.packId);
            await engine.doString(`
              package.preload[${safeModName}] = function()
                local _pid = ${safePackId}
                local _env = setmetatable({
                  __poly_sim_set = function(k, v) return __poly_sim_set_scoped(_pid, k, v) end,
                  __poly_sim_get = function(k) return __poly_sim_get_scoped(_pid, k) end,
                }, { __index = _G })
                local chunk, err = load(${safeSrc}, "@" .. ${safeModName}, "t", _env)
                if not chunk then error(err) end
                return chunk()
              end
            `);
          } else {
            await engine.doString(`
              package.preload[${safeModName}] = function()
                local chunk, err = load(${safeSrc}, "@" .. ${safeModName})
                if not chunk then error(err) end
                return chunk()
              end
            `);
          }
        }

        await engine.doString(code);
      } finally {
        engine.global.close();
      }
    },
  );
};
