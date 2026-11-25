import {
  loadMicroPython,
  type MicroPythonInstance,
} from '@micropython/micropython-webassembly-pyscript';
import {
  WorkerDebugSession,
  type WorkerControlMessage,
} from './debugSession';
import { WorkerRuntimeScheduler } from './runtimeScheduler';

let activeRunId = '';
let activeSession: WorkerDebugSession | null = null;
let activeScheduler: WorkerRuntimeScheduler | null = null;
let mpInstance: MicroPythonInstance | null = null;
let cachedWasmUrl: string | null = null;
let stderrLines: string[] = [];
let currentMockInputs: Record<string, unknown> = {};
let mountedModuleNames: string[] = [];

async function ensureMicroPython(wasmUrl: string): Promise<MicroPythonInstance> {
  if (mpInstance && cachedWasmUrl === wasmUrl) {
    return mpInstance;
  }

  mpInstance = await loadMicroPython({
    url: wasmUrl,
    linebuffer: true,
    stdout: (line: string) => {
      self.postMessage({ type: 'STDOUT', runId: activeRunId, line });
    },
    stderr: (line: string) => {
      stderrLines.push(line);
      self.postMessage({ type: 'STDERR', runId: activeRunId, line });
    },
  });

  mpInstance.registerJsModule('_poly', {
    step: (blockId: string, varsJson: string) => {
      if (!activeSession) return Promise.resolve();
      return activeSession.onStep(String(blockId), varsJson);
    },
    sleep: (ms: number) => {
      if (!activeSession) return Promise.resolve();
      return activeSession.onSleep(ms);
    },
    final_snap: (varsJson: string) => {
      activeSession?.setFinalVars(varsJson);
    },
    emit_device: (kind: string, value: unknown) => {
      const k = String(kind);
      if (k === 'oled_clear') {
        currentMockInputs.oled = [];
      } else if (k === 'oled_show') {
        const prev = Array.isArray(currentMockInputs.oled)
          ? (currentMockInputs.oled as string[])
          : [];
        currentMockInputs.oled = [...prev, String(value)].slice(-8);
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
      self.postMessage({
        type: 'DEVICE_EVENT',
        runId: activeRunId,
        kind: k,
        value,
      });
    },
    sim_set: (kind: string, value: unknown) => {
      const k = String(kind);
      if (k.endsWith(':clear')) {
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
      self.postMessage({
        type: 'DEVICE_EVENT',
        runId: activeRunId,
        kind: k,
        value,
      });
    },
    get_input: (key: string) => {
      return currentMockInputs[String(key)];
    },
    sim_get: (key: string) => {
      return currentMockInputs[String(key)];
    },
    now_ms: () => {
      return performance.now();
    },
    // Phase 5 rt scheduler bindings (delegated to active isolated scheduler)
    rt_set_run_period: (ms: unknown) => activeScheduler?.setRunPeriod(ms),
    rt_start_run: () => activeScheduler?.startRun(),
    rt_stop_run: () => activeScheduler?.stopRun(),
    rt_start_timer: (id: unknown, periodMs: unknown, repeat: unknown) =>
      activeScheduler?.startTimer(id, periodMs, repeat ?? 0),
    rt_stop_timer: (id: unknown) => activeScheduler?.stopTimer(id),
    rt_get_timer_value: (id: unknown) =>
      activeScheduler ? activeScheduler.getTimerValue(id) : 0,
    rt_is_timer_running: (id: unknown) =>
      activeScheduler ? activeScheduler.isTimerRunning(id) : false,
    should_loop: (hasRun: unknown, hasTimer: unknown, hasBtn: unknown) =>
      activeScheduler
        ? activeScheduler.shouldEnterEventLoop(
            Boolean(hasRun),
            Boolean(hasTimer),
            Boolean(hasBtn),
          )
        : false,
    next_event: () =>
      activeScheduler ? activeScheduler.nextEvent() : Promise.resolve('done'),
  });

  cachedWasmUrl = wasmUrl;
  return mpInstance;
}

const RESET_GLOBALS_SNIPPET = `
for _k in list(globals().keys()):
  if _k not in ('__name__', '__file__', '__builtins__'):
    del globals()[_k]
`;

const MOUNT_RT_MODULE_SNIPPET = `
import sys, _poly
class _PolyRtModule:
  def set_run_period(self, ms):
    return _poly.rt_set_run_period(ms)
  def start_run(self):
    return _poly.rt_start_run()
  def stop_run(self):
    return _poly.rt_stop_run()
  def start_timer(self, tid, period_ms, repeat=0):
    return _poly.rt_start_timer(tid, period_ms, repeat)
  def stop_timer(self, tid):
    return _poly.rt_stop_timer(tid)
  def get_timer_value(self, tid):
    return _poly.rt_get_timer_value(tid)
  def is_timer_running(self, tid):
    return _poly.rt_is_timer_running(tid)
sys.modules["rt"] = _PolyRtModule()
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
  activeRunId = runId;
  stderrLines = [];
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
    const mp = await ensureMicroPython(wasmUrl);
    mp.runPython(RESET_GLOBALS_SNIPPET);

    // Clear previously mounted virtual extension modules & register fresh ones
    if (mountedModuleNames.length > 0) {
      mp.runPython(`
import sys
for _mn in ${JSON.stringify(mountedModuleNames)}:
  if _mn in sys.modules:
    del sys.modules[_mn]
`);
      mountedModuleNames = [];
    }

    // Mount core rt scheduler module
    mp.runPython(MOUNT_RT_MODULE_SNIPPET);

    for (const mod of mockModules ?? []) {
      if (!mod.pythonSource || !mod.moduleName) continue;
      mountedModuleNames.push(mod.moduleName);
      mp.runPython(`
import sys
_poly_mod_ns = {}
exec(${JSON.stringify(mod.pythonSource)}, _poly_mod_ns)
class _PolyVirtualMod:
  pass
_poly_m = _PolyVirtualMod()
for _mk, _mv in _poly_mod_ns.items():
  if not _mk.startswith("__"):
    setattr(_poly_m, _mk, _mv)
sys.modules[${JSON.stringify(mod.moduleName)}] = _poly_m
`);
    }

    await mp.runPythonAsync(code);

    self.postMessage({
      type: 'DONE',
      runId,
      durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
      vars: session.getLastVars(),
    });
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const combined = stderrLines.length > 0 ? stderrLines.join('\n') : rawMsg;
    self.postMessage({
      type: 'ERROR',
      runId,
      message: combined,
      durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
  } finally {
    if (activeSession === session) activeSession = null;
    if (activeScheduler === scheduler) activeScheduler = null;
  }
};
