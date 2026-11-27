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
let mountedVfsFiles: string[] = [];

type MicroPythonWithFs = MicroPythonInstance & {
  FS?: {
    writeFile: (path: string, data: string) => void;
    unlink: (path: string) => void;
    mkdir: (path: string) => void;
  };
};

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

  const qualifyPyKey = (packId: string | undefined, rawKey: string): string => {
    if (!packId || rawKey.startsWith('global:') || rawKey.includes('::')) {
      return rawKey;
    }
    return `${packId}::${rawKey}`;
  };

  const emitScopedPy = (
    packId: string | undefined,
    rawKind: string,
    value: unknown,
  ) => {
    const k = qualifyPyKey(packId, String(rawKind));
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
  };

  const getScopedPy = (packId: string | undefined, rawKey: string) => {
    const keyStr = String(rawKey);
    const full = qualifyPyKey(packId, keyStr);
    if (Object.prototype.hasOwnProperty.call(currentMockInputs, full)) {
      return currentMockInputs[full];
    }
    return currentMockInputs[keyStr];
  };

  mpInstance.registerJsModule('_poly', {
    step: (blockId: string, varsJson: string) => {
      if (!activeSession) return Promise.resolve();
      return activeSession.onStep(String(blockId), varsJson, false);
    },
    step_start: (blockId: string, varsJson: string) => {
      if (!activeSession) return Promise.resolve();
      return activeSession.onStep(String(blockId), varsJson, true);
    },
    sleep: (ms: number) => {
      if (activeScheduler?.isInCallback()) {
        throw new Error(
          '禁止在事件回调（on_run / on_timer / on_button / on_stop）中调用等待 (sleep)；实板同步回调不可阻塞，请移至「当程序启动」协程或改用定时器。',
        );
      }
      if (!activeSession) return Promise.resolve();
      return activeSession.onSleep(ms);
    },
    final_snap: (varsJson: string) => {
      activeSession?.setFinalVars(varsJson);
    },
    emit_device: (kind: string, value: unknown) => emitScopedPy(undefined, kind, value),
    sim_set: (kind: string, value: unknown) => emitScopedPy(undefined, kind, value),
    sim_set_scoped: (packId: string, kind: string, value: unknown) =>
      emitScopedPy(String(packId), kind, value),
    get_input: (key: string) => getScopedPy(undefined, key),
    sim_get: (key: string) => getScopedPy(undefined, key),
    sim_get_scoped: (packId: string, key: string) =>
      getScopedPy(String(packId), key),
    emit_event: (eventName: string, argsJson?: string) => {
      const ename = String(eventName);
      let args: unknown[] = [];
      if (typeof argsJson === 'string' && argsJson.trim()) {
        try {
          const parsed = JSON.parse(argsJson);
          if (Array.isArray(parsed)) args = parsed;
        } catch {
          // ignore malformed args json
        }
      }
      activeScheduler?.enqueueEvent(ename, args);
      self.postMessage({
        type: 'CUSTOM_EVENT',
        runId: activeRunId,
        eventName: ename,
        args,
      });
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
    rt_tick: () => (activeScheduler ? activeScheduler.getTick() : 0),
    rt_ms_to_tick: (ms: unknown) =>
      activeScheduler ? activeScheduler.msToTick(ms) : 0,
    rt_is_expired: (startTick: unknown, timeoutTicks: unknown) =>
      activeScheduler ? activeScheduler.isTickExpired(startTick, timeoutTicks) : false,
    init_scheduler: (
      hasStart: unknown,
      hasRun: unknown,
      hasTimer: unknown,
      hasBtn: unknown,
    ) =>
      activeScheduler
        ? activeScheduler.initCoroutineMode(
            Boolean(hasStart),
            Boolean(hasRun),
            Boolean(hasTimer),
            Boolean(hasBtn),
          )
        : false,
    sync_handlers: (hasRun: unknown, hasTimer: unknown, hasBtn: unknown) =>
      activeScheduler?.syncHandlers(
        Boolean(hasRun),
        Boolean(hasTimer),
        Boolean(hasBtn),
      ),
    co_sleep: (ms: unknown) => activeScheduler?.onStartCoSleep(ms),
    co_yield_slice: () => activeScheduler?.onStartCoYieldSlice(),
    co_done: () => activeScheduler?.onStartCoDone(),
    wait_start_turn: () =>
      activeScheduler
        ? activeScheduler.waitPythonStartTurn()
        : Promise.resolve(false),
    resume_start_slice: () =>
      activeScheduler
        ? activeScheduler.resumePythonStartSlice()
        : Promise.resolve(),
    cb_enter: (name: unknown) =>
      activeScheduler?.beginCallback(String(name ?? 'callback')),
    cb_exit: () => activeScheduler?.endCallback(),
    cb_expired: () => (activeScheduler ? activeScheduler.isCallbackTimedOut() : false),
    is_in_callback: () => (activeScheduler ? activeScheduler.isInCallback() : false),
    is_stop_requested: () =>
      activeScheduler ? activeScheduler.isStopRequested() : false,
    get_time_slice_ms: () =>
      activeScheduler ? activeScheduler.getTimeSliceMs() : 20,
    logic_now_ms: () => (activeScheduler ? activeScheduler.now() : performance.now()),
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
      activeSession.enterGracefulStop();
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
  if (msg.type === 'SET_TIME_SLICE') {
    if (activeScheduler?.runId === msg.runId) {
      activeScheduler.setTimeSliceMs(msg.timeSliceMs);
    }
    return;
  }
  if (msg.type === 'UPDATE_MOCK_INPUTS') {
    currentMockInputs = { ...currentMockInputs, ...msg.mockInputs };
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
    timeSliceMs,
    callbackTimeoutMs,
    mockModules,
    mockInputs,
  } = msg;
  activeRunId = runId;
  stderrLines = [];
  currentMockInputs = { ...(mockInputs ?? {}) };
  const startedAt = performance.now();

  const post = (payload: Record<string, unknown>) => self.postMessage(payload);
  const scheduler = new WorkerRuntimeScheduler({
    runId,
    timerCount: timerCount ?? 8,
    timeSliceMs: timeSliceMs ?? 20,
    callbackTimeoutMs: callbackTimeoutMs ?? 5000,
    post,
  });
  const session = new WorkerDebugSession(
    {
      runId,
      breakpoints,
      stepDelayMs,
      startInStepMode,
      onClockPause: (paused, creditMs) => {
        if (paused) scheduler.pauseClock();
        else scheduler.resumeClock(creditMs ?? 0);
      },
      getTimeSliceMs: () => scheduler.getTimeSliceMs(),
    },
    post,
  );
  activeSession = session;
  activeScheduler = scheduler;

  try {
    const mp = await ensureMicroPython(wasmUrl);
    mp.runPython(RESET_GLOBALS_SNIPPET);

    // Clear previously mounted virtual extension modules & lazy VFS sibling scripts
    const mpFs = (mp as MicroPythonWithFs).FS;
    if (mpFs && mountedVfsFiles.length > 0) {
      for (const vfsPath of mountedVfsFiles) {
        try {
          mpFs.unlink(vfsPath);
        } catch {
          // ignore already-removed files
        }
      }
      mountedVfsFiles = [];
    }
    if (mountedModuleNames.length > 0) {
      mp.runPython(`
import sys
for _mn in ${JSON.stringify([...mountedModuleNames, '_poly_rt'])}:
  if _mn in sys.modules:
    del sys.modules[_mn]
`);
      mountedModuleNames = [];
    } else {
      mp.runPython(`
import sys
if '_poly_rt' in sys.modules:
  del sys.modules['_poly_rt']
`);
    }

    // Helper to register dotted module paths (`utils.crc16`) cleanly in sys.modules
    const mountOnePyModule = (mod: NonNullable<typeof mockModules>[number]) => {
      const pySrc = mod.sources?.python;
      if (!pySrc || !mod.moduleName) return;
      const parts = mod.moduleName.split('.').filter(Boolean);
      for (let pi = 0; pi < parts.length; pi++) {
        const prefix = parts.slice(0, pi + 1).join('.');
        if (!mountedModuleNames.includes(prefix)) {
          mountedModuleNames.push(prefix);
        }
      }

      // Tier 1 handle sibling scripts (`!mod.packId`) are written lazily into MicroPython's VFS
      // so conditional `if cond: import timers` truly executes on-demand (matching Lua `package.preload`!).
      if (!mod.packId && mpFs) {
        let dir = '';
        for (let pi = 0; pi < parts.length - 1; pi++) {
          dir += `/${parts[pi]}`;
          try {
            mpFs.mkdir(dir);
          } catch {
            // directory may already exist
          }
          const initPath = `${dir}/__init__.py`;
          try {
            mpFs.writeFile(initPath, '');
            if (!mountedVfsFiles.includes(initPath)) mountedVfsFiles.push(initPath);
          } catch {
            // ignore
          }
        }
        const filePath = `/${parts.join('/')}.py`;
        mpFs.writeFile(filePath, pySrc);
        if (!mountedVfsFiles.includes(filePath)) mountedVfsFiles.push(filePath);
        return;
      }

      const attachDottedPy = `
_poly_parts = ${JSON.stringify(parts)}
sys.modules[${JSON.stringify(mod.moduleName)}] = _poly_m
if len(_poly_parts) > 1:
  for _pi in range(len(_poly_parts) - 1):
    _ppath = ".".join(_poly_parts[:_pi + 1])
    if _ppath not in sys.modules:
      _pkg = _PolyVirtualMod()
      sys.modules[_ppath] = _pkg
      if _pi > 0:
        setattr(sys.modules[".".join(_poly_parts[:_pi])], _poly_parts[_pi], _pkg)
  setattr(sys.modules[".".join(_poly_parts[:-1])], _poly_parts[-1], _poly_m)
`;
      if (mod.packId) {
        const proxyModName = `_poly__${mod.packId.replace(/[^A-Za-z0-9_]/g, '_')}`;
        if (!mountedModuleNames.includes(proxyModName)) {
          mountedModuleNames.push(proxyModName);
        }
        const rewrittenSource = pySrc.replace(
          /\bimport\s+_poly\b/g,
          `import ${proxyModName} as _poly`,
        );
        mp.runPython(`
import sys, json, _poly as _poly_base
class _PolyScopedProxy:
  def __init__(self, pid):
    self._pid = pid
  def sim_set(self, k, v):
    return _poly_base.sim_set_scoped(self._pid, k, v)
  def emit_device(self, k, v):
    return _poly_base.sim_set_scoped(self._pid, k, v)
  def sim_get(self, k):
    return _poly_base.sim_get_scoped(self._pid, k)
  def get_input(self, k):
    return _poly_base.sim_get_scoped(self._pid, k)
  def emit_event(self, ename, *eargs):
    return _poly_base.emit_event(ename, json.dumps(list(eargs)))
  def now_ms(self):
    return _poly_base.now_ms()
  def rt_set_run_period(self, ms):
    return _poly_base.rt_set_run_period(ms)
  def rt_start_run(self):
    return _poly_base.rt_start_run()
  def rt_stop_run(self):
    return _poly_base.rt_stop_run()
  def rt_start_timer(self, tid, period_ms, repeat=0):
    return _poly_base.rt_start_timer(tid, period_ms, repeat)
  def rt_stop_timer(self, tid):
    return _poly_base.rt_stop_timer(tid)
  def rt_get_timer_value(self, tid):
    return _poly_base.rt_get_timer_value(tid)
  def rt_is_timer_running(self, tid):
    return _poly_base.rt_is_timer_running(tid)
  def rt_tick(self):
    return _poly_base.rt_tick()
  def rt_ms_to_tick(self, ms):
    return _poly_base.rt_ms_to_tick(ms)
  def rt_is_expired(self, start_tick, timeout_ticks):
    return _poly_base.rt_is_expired(start_tick, timeout_ticks)
sys.modules[${JSON.stringify(proxyModName)}] = _PolyScopedProxy(${JSON.stringify(mod.packId)})
_poly_mod_ns = {'_poly': sys.modules[${JSON.stringify(proxyModName)}]}
exec(${JSON.stringify(rewrittenSource)}, _poly_mod_ns)
class _PolyVirtualMod:
  pass
_poly_m = _PolyVirtualMod()
for _mk, _mv in _poly_mod_ns.items():
  if not _mk.startswith("__"):
    setattr(_poly_m, _mk, _mv)
${attachDottedPy}
`);
      } else {
        mp.runPython(`
import sys
_poly_mod_ns = {}
exec(${JSON.stringify(mod.sources?.python ?? '')}, _poly_mod_ns)
class _PolyVirtualMod:
  pass
_poly_m = _PolyVirtualMod()
for _mk, _mv in _poly_mod_ns.items():
  if not _mk.startswith("__"):
    setattr(_poly_m, _mk, _mv)
${attachDottedPy}
`);
      }
    };

    // Multi-pass mount so multi-file Python libs (`crc16.py` importing `crc16_table.py`)
    // succeed regardless of upload order, while preserving higher-tier overwrite semantics!
    let pendingMods = (mockModules ?? []).filter(
      (m) => Boolean(m.sources?.python && m.moduleName),
    );
    for (let pass = 0; pass < 4 && pendingMods.length > 0; pass++) {
      const nextPending: typeof pendingMods = [];
      let mountedAny = false;
      for (const mod of pendingMods) {
        try {
          mountOnePyModule(mod);
          mountedAny = true;
        } catch (mountErr) {
          const msg = mountErr instanceof Error ? mountErr.message : String(mountErr);
          if (pass < 3 && /ImportError|ModuleNotFoundError|no module named/i.test(msg)) {
            nextPending.push(mod);
          } else {
            throw mountErr;
          }
        }
      }
      pendingMods = nextPending;
      if (!mountedAny && pendingMods.length > 0) {
        // Final attempt to surface the exact Python ImportError cleanly
        mountOnePyModule(pendingMods[0]);
        break;
      }
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
