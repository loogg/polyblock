import {
  loadMicroPython,
  type MicroPythonInstance,
} from '@micropython/micropython-webassembly-pyscript';
import type { WorkerControlMessage } from './debugSession';
import { WorkerProtocolHost } from './workerProtocolHost';

let mpInstance: MicroPythonInstance | null = null;
let cachedWasmUrl: string | null = null;
let stderrLines: string[] = [];
let mountedModuleNames: string[] = [];
let mountedVfsFiles: string[] = [];

const host = new WorkerProtocolHost((payload) => self.postMessage(payload));

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
      self.postMessage({ type: 'STDOUT', runId: host.getActiveRunId(), line });
    },
    stderr: (line: string) => {
      stderrLines.push(line);
      self.postMessage({ type: 'STDERR', runId: host.getActiveRunId(), line });
    },
  });

  mpInstance.registerJsModule('_poly', {
    step: (blockId: string, varsJson: string) => {
      const sess = host.getActiveSession();
      if (!sess) return Promise.resolve();
      return sess.onStep(String(blockId), varsJson, false);
    },
    step_start: (blockId: string, varsJson: string) => {
      const sess = host.getActiveSession();
      if (!sess) return Promise.resolve();
      return sess.onStep(String(blockId), varsJson, true);
    },
    sleep: (ms: number) => {
      if (host.getActiveScheduler()?.isInCallback()) {
        throw new Error(
          '禁止在事件回调（on_run / on_timer / on_button / on_stop）中调用等待 (sleep)；实板同步回调不可阻塞，请移至「当程序启动」协程或改用定时器。',
        );
      }
      const sess = host.getActiveSession();
      if (!sess) return Promise.resolve();
      return sess.onSleep(ms);
    },
    final_snap: (varsJson: string) => {
      host.getActiveSession()?.setFinalVars(varsJson);
    },
    emit_device: (kind: string, value: unknown) =>
      host.emitScopedState(undefined, kind, value),
    sim_set: (kind: string, value: unknown) =>
      host.emitScopedState(undefined, kind, value),
    sim_set_scoped: (packId: string, kind: string, value: unknown) =>
      host.emitScopedState(String(packId), kind, value),
    get_input: (key: string) => host.getScopedState(undefined, key),
    sim_get: (key: string) => host.getScopedState(undefined, key),
    sim_get_scoped: (packId: string, key: string) =>
      host.getScopedState(String(packId), key),
    emit_event: (eventName: string, argsJson?: string) => {
      let args: unknown[] = [];
      if (typeof argsJson === 'string' && argsJson.trim()) {
        try {
          const parsed = JSON.parse(argsJson);
          if (Array.isArray(parsed)) args = parsed;
        } catch {
          // ignore malformed args json
        }
      }
      host.emitCustomEvent(eventName, args);
    },
    now_ms: () => performance.now(),
    // Phase 5 rt scheduler bindings (delegated to active isolated scheduler)
    rt_set_run_period: (ms: unknown) =>
      host.getActiveScheduler()?.setRunPeriod(ms),
    rt_start_run: () => host.getActiveScheduler()?.startRun(),
    rt_stop_run: () => host.getActiveScheduler()?.stopRun(),
    rt_start_timer: (id: unknown, periodMs: unknown, repeat: unknown) =>
      host.getActiveScheduler()?.startTimer(id, periodMs, repeat ?? 0),
    rt_stop_timer: (id: unknown) => host.getActiveScheduler()?.stopTimer(id),
    rt_get_timer_value: (id: unknown) => {
      const sched = host.getActiveScheduler();
      return sched ? sched.getTimerValue(id) : 0;
    },
    rt_is_timer_running: (id: unknown) => {
      const sched = host.getActiveScheduler();
      return sched ? sched.isTimerRunning(id) : false;
    },
    rt_tick: () => {
      const sched = host.getActiveScheduler();
      return sched ? sched.getTick() : 0;
    },
    rt_ms_to_tick: (ms: unknown) => {
      const sched = host.getActiveScheduler();
      return sched ? sched.msToTick(ms) : 0;
    },
    rt_is_expired: (startTick: unknown, timeoutTicks: unknown) => {
      const sched = host.getActiveScheduler();
      return sched ? sched.isTickExpired(startTick, timeoutTicks) : false;
    },
    init_scheduler: (
      hasStart: unknown,
      hasRun: unknown,
      hasTimer: unknown,
      hasBtn: unknown,
    ) => {
      const sched = host.getActiveScheduler();
      return sched
        ? sched.initCoroutineMode(
            Boolean(hasStart),
            Boolean(hasRun),
            Boolean(hasTimer),
            Boolean(hasBtn),
          )
        : false;
    },
    sync_handlers: (hasRun: unknown, hasTimer: unknown, hasBtn: unknown) =>
      host.getActiveScheduler()?.syncHandlers(
        Boolean(hasRun),
        Boolean(hasTimer),
        Boolean(hasBtn),
      ),
    co_sleep: (ms: unknown) => host.getActiveScheduler()?.onStartCoSleep(ms),
    co_yield_slice: () => host.getActiveScheduler()?.onStartCoYieldSlice(),
    co_done: () => host.getActiveScheduler()?.onStartCoDone(),
    wait_start_turn: () => {
      const sched = host.getActiveScheduler();
      return sched ? sched.waitPythonStartTurn() : Promise.resolve(false);
    },
    resume_start_slice: () => {
      const sched = host.getActiveScheduler();
      return sched ? sched.resumePythonStartSlice() : Promise.resolve();
    },
    cb_enter: (name: unknown) =>
      host.getActiveScheduler()?.beginCallback(String(name ?? 'callback')),
    cb_exit: () => host.getActiveScheduler()?.endCallback(),
    cb_expired: () => {
      const sched = host.getActiveScheduler();
      return sched ? sched.isCallbackTimedOut() : false;
    },
    is_in_callback: () => {
      const sched = host.getActiveScheduler();
      return sched ? sched.isInCallback() : false;
    },
    is_stop_requested: () => {
      const sched = host.getActiveScheduler();
      return sched ? sched.isStopRequested() : false;
    },
    get_time_slice_ms: () => {
      const sched = host.getActiveScheduler();
      return sched ? sched.getTimeSliceMs() : 20;
    },
    logic_now_ms: () => {
      const sched = host.getActiveScheduler();
      return sched ? sched.now() : performance.now();
    },
    next_event: () => {
      const sched = host.getActiveScheduler();
      return sched ? sched.nextEvent() : Promise.resolve('done');
    },
  });

  cachedWasmUrl = wasmUrl;
  return mpInstance;
}

const RESET_GLOBALS_SNIPPET = `
for _k in list(globals().keys()):
  if _k not in ('__name__', '__file__', '__builtins__'):
    del globals()[_k]
`;

self.onmessage = (event: MessageEvent<WorkerControlMessage>) => {
  void host.handleMessage(
    event.data,
    async ({ msg }) => {
      const { code, wasmUrl, mockModules } = msg;
      stderrLines = [];

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
            const errMsg =
              mountErr instanceof Error ? mountErr.message : String(mountErr);
            if (
              pass < 3 &&
              /ImportError|ModuleNotFoundError|no module named/i.test(errMsg)
            ) {
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
    },
    (err) => {
      const rawMsg = err instanceof Error ? err.message : String(err);
      return stderrLines.length > 0 ? stderrLines.join('\n') : rawMsg;
    },
  );
};
