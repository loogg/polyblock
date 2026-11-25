import { LuaFactory } from 'wasmoon';
import {
  WorkerDebugSession,
  type WorkerControlMessage,
} from './debugSession';
import { WorkerRuntimeScheduler } from './runtimeScheduler';

let cachedWasmUrl: string | null = null;
let factory: LuaFactory | null = null;
let activeSession: WorkerDebugSession | null = null;
let activeScheduler: WorkerRuntimeScheduler | null = null;
let currentMockInputs: Record<string, unknown> = {};

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

package.preload["rt"] = function()
  return {
    set_run_period = __poly_rt_set_run_period,
    start_run = __poly_rt_start_run,
    stop_run = __poly_rt_stop_run,
    start_timer = __poly_rt_start_timer,
    stop_timer = __poly_rt_stop_timer,
    get_timer_value = __poly_rt_get_timer_value,
    is_timer_running = __poly_rt_is_timer_running,
  }
end
`;

self.onmessage = async (event: MessageEvent<WorkerControlMessage>) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'RESUME') {
    if (activeSession?.runId === msg.runId) activeSession.resume();
    return;
  }
  if (msg.type === 'STEP_NEXT') {
    if (activeSession?.runId === msg.runId) activeSession.stepNext();
    return;
  }
  if (msg.type === 'PAUSE') {
    if (activeSession?.runId === msg.runId) activeSession.pause();
    return;
  }
  if (msg.type === 'STOP_GRACEFUL') {
    if (activeScheduler?.runId === msg.runId) {
      activeScheduler.requestGracefulStop();
    }
    if (activeSession?.runId === msg.runId) {
      activeSession.resume();
    }
    return;
  }
  if (msg.type === 'SET_BREAKPOINTS') {
    if (activeSession?.runId === msg.runId) {
      activeSession.setBreakpoints(msg.breakpoints);
    }
    return;
  }
  if (msg.type === 'SET_SPEED') {
    if (activeSession?.runId === msg.runId) {
      activeSession.setStepDelay(msg.stepDelayMs);
    }
    return;
  }
  if (msg.type === 'UPDATE_MOCK_INPUTS') {
    const prev = currentMockInputs;
    currentMockInputs = { ...currentMockInputs, ...msg.mockInputs };
    if (activeScheduler?.runId === msg.runId) {
      activeScheduler.onMockInputsDelta(prev, currentMockInputs);
    }
    return;
  }
  if (msg.type === 'EMIT_EVENT') {
    if (activeScheduler?.runId === msg.runId) {
      activeScheduler.enqueueEvent(msg.eventName, msg.args);
    }
    return;
  }

  if (msg.type !== 'RUN') return;

  const {
    runId,
    code,
    wasmUrl,
    breakpoints,
    stepDelayMs,
    startInStepMode,
    timerCount,
    mockModules,
    mockInputs,
  } = msg;
  currentMockInputs = { ...(mockInputs ?? {}) };
  const startedAt = performance.now();
  const post = (payload: Record<string, unknown>) => self.postMessage(payload);
  const session = new WorkerDebugSession(
    { runId, breakpoints, stepDelayMs, startInStepMode },
    post,
  );
  const scheduler = new WorkerRuntimeScheduler({
    runId,
    timerCount: timerCount ?? 8,
    post,
  });
  activeSession = session;
  activeScheduler = scheduler;

  try {
    if (!factory || cachedWasmUrl !== wasmUrl) {
      factory = new LuaFactory(wasmUrl);
      cachedWasmUrl = wasmUrl;
    }

    const engine = await factory.createEngine({ openStandardLibs: true });

    try {
      const seed = Math.floor(Date.now() % 2147483647);

      engine.global.set('__poly_print', (...args: unknown[]) => {
        const line = args.map(formatLuaArg).join('\t');
        self.postMessage({ type: 'STDOUT', runId, line });
      });

      engine.global.set('__poly_step', (blockId: string, varsJson: string) => {
        return session.onStep(String(blockId), varsJson);
      });

      engine.global.set('__poly_sleep', (ms: number) => {
        return session.onSleep(ms);
      });

      engine.global.set('__poly_final_snap', (varsJson: string) => {
        session.setFinalVars(varsJson);
      });

      const qualifyKey = (packId: string | undefined, rawKey: string): string => {
        if (!packId || rawKey.startsWith('global:') || rawKey.includes('::')) {
          return rawKey;
        }
        if (rawKey === 'oled_clear' || rawKey === 'oled_show') {
          return rawKey;
        }
        return `${packId}::${rawKey}`;
      };

      const emitScopedState = (
        packId: string | undefined,
        rawKind: string,
        value: unknown,
      ) => {
        const k = qualifyKey(packId, String(rawKind));
        if (k === 'oled_clear') {
          currentMockInputs['virtual-board::oled'] = [];
        } else if (k === 'oled_show') {
          const prev = Array.isArray(currentMockInputs['virtual-board::oled'])
            ? (currentMockInputs['virtual-board::oled'] as string[])
            : [];
          currentMockInputs['virtual-board::oled'] = [...prev, String(value)].slice(-8);
        } else if (k.endsWith(':clear')) {
          currentMockInputs[k.slice(0, -6)] = [];
        } else if (k.endsWith(':append')) {
          const base = k.slice(0, -7);
          const prev = Array.isArray(currentMockInputs[base])
            ? (currentMockInputs[base] as string[])
            : [];
          currentMockInputs[base] = [...prev, String(value)].slice(-8);
        } else {
          currentMockInputs[k] = value;
        }
        self.postMessage({ type: 'DEVICE_EVENT', runId, kind: k, value });
      };

      const getScopedState = (packId: string | undefined, rawKey: string) => {
        const keyStr = String(rawKey);
        const full = qualifyKey(packId, keyStr);
        if (Object.prototype.hasOwnProperty.call(currentMockInputs, full)) {
          return currentMockInputs[full];
        }
        return currentMockInputs[keyStr];
      };

      const emitDeviceState = (kind: string, value: unknown) =>
        emitScopedState(undefined, kind, value);
      const getSimState = (key: string) => getScopedState(undefined, key);

      engine.global.set('__poly_device_emit', emitDeviceState);
      engine.global.set('__poly_sim_set', emitDeviceState);
      engine.global.set('__poly_sim_set_scoped', (packId: string, kind: string, value: unknown) =>
        emitScopedState(String(packId), kind, value),
      );
      engine.global.set('__poly_mock_input', getSimState);
      engine.global.set('__poly_sim_get', getSimState);
      engine.global.set('__poly_sim_get_scoped', (packId: string, key: string) =>
        getScopedState(String(packId), key),
      );
      engine.global.set('__poly_emit_event', (eventName: string, ...args: unknown[]) => {
        const ename = String(eventName);
        scheduler.enqueueEvent(ename, args);
        self.postMessage({ type: 'CUSTOM_EVENT', runId, eventName: ename, args });
      });
      engine.global.set('__poly_last_event_name', () => scheduler.getLastEventName());
      engine.global.set('__poly_last_event_argc', () => scheduler.getLastEventArgCount());
      engine.global.set('__poly_last_event_arg', (idx: number) =>
        scheduler.getLastEventArg(idx),
      );

      engine.global.set('__poly_now_ms', () => {
        return performance.now();
      });

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
      engine.global.set(
        '__poly_should_loop',
        (hasRun: unknown, hasTimer: unknown, hasBtn: unknown) =>
          scheduler.shouldEnterEventLoop(
            Boolean(hasRun),
            Boolean(hasTimer),
            Boolean(hasBtn),
          ),
      );
      engine.global.set('__poly_next_event', () => scheduler.nextEvent());

      await engine.doString(`math.randomseed(${seed})\n${LUA_BOOTSTRAP}`);

      // Mount sandbox extension mock modules into Lua's package.preload with automatic packId scoping
      for (const mod of mockModules ?? []) {
        if (!mod.luaSource || !mod.moduleName) continue;
        const safeModName = JSON.stringify(mod.moduleName);
        const safeSrc = JSON.stringify(mod.luaSource);
        if (mod.packId) {
          const safePackId = JSON.stringify(mod.packId);
          await engine.doString(`
            package.preload[${safeModName}] = function()
              local _pid = ${safePackId}
              local _env = setmetatable({
                __poly_sim_set = function(k, v) return __poly_sim_set_scoped(_pid, k, v) end,
                __poly_device_emit = function(k, v) return __poly_sim_set_scoped(_pid, k, v) end,
                __poly_sim_get = function(k) return __poly_sim_get_scoped(_pid, k) end,
                __poly_mock_input = function(k) return __poly_sim_get_scoped(_pid, k) end,
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

      self.postMessage({
        type: 'DONE',
        runId,
        durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
        vars: session.getLastVars(),
      });
    } finally {
      engine.global.close();
      if (activeSession === session) activeSession = null;
      if (activeScheduler === scheduler) activeScheduler = null;
    }
  } catch (err) {
    if (activeSession === session) activeSession = null;
    if (activeScheduler === scheduler) activeScheduler = null;
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({
      type: 'ERROR',
      runId,
      message,
      durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
  }
};
