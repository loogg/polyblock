import { LuaFactory } from 'wasmoon';
import {
  WorkerDebugSession,
  type WorkerControlMessage,
} from './debugSession';

let cachedWasmUrl: string | null = null;
let factory: LuaFactory | null = null;
let activeSession: WorkerDebugSession | null = null;

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

  if (msg.type !== 'RUN') return;

  const { runId, code, wasmUrl, breakpoints, stepDelayMs, startInStepMode } = msg;
  const startedAt = performance.now();
  const session = new WorkerDebugSession(
    { runId, breakpoints, stepDelayMs, startInStepMode },
    (payload) => self.postMessage(payload),
  );
  activeSession = session;

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

      await engine.doString(`math.randomseed(${seed})\n${LUA_BOOTSTRAP}`);
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
    }
  } catch (err) {
    if (activeSession === session) activeSession = null;
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({
      type: 'ERROR',
      runId,
      message,
      durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
  }
};
