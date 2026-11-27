// @vitest-environment node
import * as Blockly from 'blockly';
import { beforeAll, describe, expect, it } from 'vitest';
import { LuaFactory } from 'wasmoon';
import { loadMicroPython } from '@micropython/micropython-webassembly-pyscript';
import { buildHandleScriptsMeta } from '../backends/eventMode';
import { buildHandleSharedModule } from '../backends/sharedModule';
import { backendRegistry } from '../backends/registry';
import { registerPolyBlocks } from '../blocks/definitions';
import { CAP_RT_TIMERS } from '../capabilities/registry';
import {
  SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
  VIRTUAL_BOARD_PACK,
} from '../extensions/builtinPacks';
import { extensionRegistry } from '../extensions/registry';
import {
  getAllHandleChannelPoolConfigs,
  getHandleChannelPoolConfig,
  instantiateProjectFromTemplate,
} from '../projects/store';
import {
  setActiveChannelPoolConfig,
  setActiveHandleScripts,
  setActiveHandleSharedFunctions,
  setActiveHandleSharedVariables,
} from '../blocks/workspaceContextBridge';
import { WorkerDebugSession } from '../../workers/debugSession';
import { runJsInSandbox } from '../../workers/jsSandboxCore';
import { WorkerRuntimeScheduler } from '../../workers/runtimeScheduler';
import { RT_PACK } from '../extensions/builtinPacks';
import type { ExtensionModuleSource } from '../extensions/types';

interface HarnessOptions {
  stepDelayMs?: number;
  timeSliceMs?: number;
  callbackTimeoutMs?: number;
  breakpoints?: string[];
  onPaused?: (blockId: string, session: WorkerDebugSession) => void;
  preloadModules?: Array<{
    name: string;
    luaSource?: string;
    pythonSource?: string;
    jsSource?: string;
    packId?: string;
    /** When true, mount Python module lazily into MicroPython VFS (`/name.py`) just like Tier 1 handle scripts in python.worker.ts. */
    lazyVfs?: boolean;
  }>;
  onReady?: (sched: WorkerRuntimeScheduler) => void;
}

async function runJsDebugInSandbox(
  jsDebug: string,
  opts: HarnessOptions = {},
): Promise<{
  logs: string[];
  scheduler: WorkerRuntimeScheduler;
  simState: Record<string, unknown>;
}> {
  const logs: string[] = [];
  const simState: Record<string, unknown> = { 'virtual-board::temp': 28 };
  const scheduler = new WorkerRuntimeScheduler({
    runId: 'test-js',
    timerCount: 8,
    timeSliceMs: opts.timeSliceMs ?? 20,
    callbackTimeoutMs: opts.callbackTimeoutMs ?? 5000,
    post: () => {},
  });
  const session = new WorkerDebugSession(
    {
      runId: 'test-js',
      breakpoints: opts.breakpoints ?? [],
      stepDelayMs: opts.stepDelayMs ?? 0,
      onClockPause: (paused, creditMs) => {
        if (paused) scheduler.pauseClock();
        else scheduler.resumeClock(creditMs ?? 0);
      },
      getTimeSliceMs: () => scheduler.getTimeSliceMs(),
    },
    (msg) => {
      if (msg.type === 'PAUSED' && typeof msg.blockId === 'string') {
        opts.onPaused?.(msg.blockId, session);
      }
    },
  );

  const mockModules: ExtensionModuleSource[] = [];
  if (RT_PACK.sandboxMock) {
    mockModules.push({ ...RT_PACK.sandboxMock, packId: RT_PACK.id });
  }
  if (VIRTUAL_BOARD_PACK.sandboxMock) {
    mockModules.push({ ...VIRTUAL_BOARD_PACK.sandboxMock, packId: VIRTUAL_BOARD_PACK.id });
  }
  for (const mod of opts.preloadModules ?? []) {
    if (mod.jsSource) {
      mockModules.push({
        moduleName: mod.name,
        sources: { js: mod.jsSource },
        ...(mod.packId ? { packId: mod.packId } : {}),
      });
    }
  }

  opts.onReady?.(scheduler);
  await runJsInSandbox({
    code: jsDebug,
    mockModules,
    scheduler,
    session,
    postStdout: (line) => logs.push(line),
    emitScopedState: (packId, kind, value) => {
      const qualified = packId ? `${packId}::${kind}` : kind;
      simState[qualified] = value;
    },
    getScopedState: (packId, key) => {
      const qualified = packId ? `${packId}::${key}` : key;
      return simState[qualified] ?? simState[key];
    },
    emitCustomEvent: (eventName, args) => {
      scheduler.enqueueEvent(eventName, args);
    },
  });

  return { logs, scheduler, simState };
}

async function runLuaDebugInWasmoon(
  luaDebug: string,
  opts: HarnessOptions = {},
): Promise<{ logs: string[]; scheduler: WorkerRuntimeScheduler }> {
  const logs: string[] = [];
  const luaFactory = new LuaFactory();
  const lua = await luaFactory.createEngine({ openStandardLibs: true });
  const scheduler = new WorkerRuntimeScheduler({
    runId: 'test-lua',
    timerCount: 8,
    timeSliceMs: opts.timeSliceMs ?? 20,
    callbackTimeoutMs: opts.callbackTimeoutMs ?? 5000,
    post: () => {},
  });
  const session = new WorkerDebugSession(
    {
      runId: 'test-lua',
      breakpoints: opts.breakpoints ?? [],
      stepDelayMs: opts.stepDelayMs ?? 0,
      onClockPause: (paused, creditMs) => {
        if (paused) scheduler.pauseClock();
        else scheduler.resumeClock(creditMs ?? 0);
      },
      getTimeSliceMs: () => scheduler.getTimeSliceMs(),
    },
    (msg) => {
      if (msg.type === 'PAUSED' && typeof msg.blockId === 'string') {
        opts.onPaused?.(msg.blockId, session);
      }
    },
  );

  try {
    lua.global.set('__poly_print', (...args: unknown[]) =>
      logs.push(args.map(String).join(' ')),
    );
    lua.global.set('__poly_step', (bid: string, vars: string) =>
      session.onStep(String(bid), vars, false),
    );
    lua.global.set('__poly_step_start', (bid: string, vars: string) =>
      session.onStep(String(bid), vars, true),
    );
    lua.global.set('__poly_sleep', (ms: number) => session.onSleep(ms));
    lua.global.set('__poly_final_snap', (vars: string) =>
      session.setFinalVars(vars),
    );
    lua.global.set('__poly_now_ms', () => performance.now());
    lua.global.set('__poly_logic_now_ms', () => scheduler.now());
    lua.global.set('__poly_rt_set_run_period', (ms: unknown) =>
      scheduler.setRunPeriod(ms),
    );
    lua.global.set('__poly_rt_start_run', () => scheduler.startRun());
    lua.global.set('__poly_rt_stop_run', () => scheduler.stopRun());
    lua.global.set('__poly_rt_start_timer', (id: unknown, ms: unknown, rep: unknown) =>
      scheduler.startTimer(id, ms, rep ?? 0),
    );
    lua.global.set('__poly_rt_stop_timer', (id: unknown) =>
      scheduler.stopTimer(id),
    );
    lua.global.set('__poly_rt_get_timer_value', (id: unknown) =>
      scheduler.getTimerValue(id),
    );
    lua.global.set('__poly_rt_is_timer_running', (id: unknown) =>
      scheduler.isTimerRunning(id),
    );
    lua.global.set('__poly_rt_tick', () => scheduler.getTick());
    lua.global.set('__poly_rt_ms_to_tick', (ms: unknown) =>
      scheduler.msToTick(ms),
    );
    lua.global.set('__poly_rt_is_expired', (s: unknown, t: unknown) =>
      scheduler.isTickExpired(s, t),
    );
    lua.global.set(
      '__poly_init_scheduler',
      (s: unknown, r: unknown, t: unknown, b: unknown) =>
        scheduler.initCoroutineMode(Boolean(s), Boolean(r), Boolean(t), Boolean(b)),
    );
    lua.global.set(
      '__poly_sync_handlers',
      (r: unknown, t: unknown, b: unknown) =>
        scheduler.syncHandlers(Boolean(r), Boolean(t), Boolean(b)),
    );
    lua.global.set('__poly_sim_set', () => {});
    lua.global.set('__poly_sim_get', (k: unknown) => (k === 'temp' ? 28 : false));
    lua.global.set('__poly_co_sleep', (ms: unknown) =>
      scheduler.onStartCoSleep(ms),
    );
    lua.global.set('__poly_co_yield_slice', () =>
      scheduler.onStartCoYieldSlice(),
    );
    lua.global.set('__poly_co_done', () => scheduler.onStartCoDone());
    lua.global.set('__poly_get_time_slice_ms', () => scheduler.getTimeSliceMs());
    lua.global.set('__poly_is_stop_requested', () => scheduler.isStopRequested());
    lua.global.set('__poly_cb_enter', (n: unknown) =>
      scheduler.beginCallback(String(n ?? 'cb')),
    );
    lua.global.set('__poly_cb_exit', () => scheduler.endCallback());
    lua.global.set('__poly_cb_expired', () => scheduler.isCallbackTimedOut());
    lua.global.set('__poly_next_event', () => scheduler.nextEvent());
    lua.global.set('__poly_last_event_name', () => scheduler.getLastEventName());
    lua.global.set('__poly_last_event_argc', () => scheduler.getLastEventArgCount());
    lua.global.set('__poly_last_event_arg', (idx: number) =>
      scheduler.getLastEventArg(idx),
    );

    await lua.doString(`
      function __poly_snap() return "{}" end
      print = function(...) __poly_print(...) end
      package.preload["rt"] = function()
        return {
          set_run_period = __poly_rt_set_run_period,
          start_run = __poly_rt_start_run,
          stop_run = __poly_rt_stop_run,
          start_timer = __poly_rt_start_timer,
          stop_timer = __poly_rt_stop_timer,
          get_timer_value = __poly_rt_get_timer_value,
          is_timer_running = __poly_rt_is_timer_running,
          tick = __poly_rt_tick,
          ms_to_tick = __poly_rt_ms_to_tick,
          is_expired = __poly_rt_is_expired,
        }
      end
      __poly_start_co = nil
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
          error("禁止在事件回调（on_run / on_timer / on_button / on_stop）或顶层脚本中调用 sleep_ms()；请移至「当程序启动 (on_start)」协程内。", 2)
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
    `);

    for (const mod of opts.preloadModules ?? []) {
      if (!mod.luaSource) continue;
      await lua.doString(`
        package.preload[${JSON.stringify(mod.name)}] = function()
          local chunk, err = load(${JSON.stringify(mod.luaSource)}, "@" .. ${JSON.stringify(mod.name)})
          if not chunk then error(err) end
          return chunk()
        end
      `);
    }

    opts.onReady?.(scheduler);
    await lua.doString(luaDebug);
    return { logs, scheduler };
  } finally {
    lua.global.close();
  }
}

let sharedMpPromise: Promise<Awaited<ReturnType<typeof loadMicroPython>>> | null =
  null;
let activePyLogs: string[] = [];
let activePyScheduler: WorkerRuntimeScheduler | null = null;
let activePySession: WorkerDebugSession | null = null;
let mountedTestModules: string[] = [];
let mountedTestVfsFiles: string[] = [];

async function getSharedTestMicroPython() {
  if (!sharedMpPromise) {
    sharedMpPromise = loadMicroPython({
      stdout: (line) => activePyLogs.push(line),
    }).then((mp) => {
      mp.registerJsModule('_poly', {
        step: (bid: string, vars: string) =>
          activePySession
            ? activePySession.onStep(String(bid), vars, false)
            : Promise.resolve(),
        step_start: (bid: string, vars: string) =>
          activePySession
            ? activePySession.onStep(String(bid), vars, true)
            : Promise.resolve(),
        sleep: (ms: number) => {
          if (activePyScheduler?.isInCallback()) {
            throw new Error('禁止在事件回调中调用等待 (sleep)');
          }
          return activePySession ? activePySession.onSleep(ms) : Promise.resolve();
        },
        final_snap: (vars: string) => activePySession?.setFinalVars(vars),
        emit_device: () => {},
        sim_set: () => {},
        get_input: (k: unknown) => (k === 'temp' ? 28 : false),
        sim_get: (k: unknown) => (k === 'temp' ? 28 : false),
        now_ms: () => performance.now(),
        logic_now_ms: () => activePyScheduler?.now() ?? performance.now(),
        rt_set_run_period: (ms: unknown) => activePyScheduler?.setRunPeriod(ms),
        rt_start_run: () => activePyScheduler?.startRun(),
        rt_stop_run: () => activePyScheduler?.stopRun(),
        rt_start_timer: (id: unknown, ms: unknown, rep: unknown) =>
          activePyScheduler?.startTimer(id, ms, rep ?? 0),
        rt_stop_timer: (id: unknown) => activePyScheduler?.stopTimer(id),
        rt_get_timer_value: (id: unknown) =>
          activePyScheduler?.getTimerValue(id) ?? 0,
        rt_is_timer_running: (id: unknown) =>
          activePyScheduler?.isTimerRunning(id) ?? false,
        rt_tick: () => activePyScheduler?.getTick() ?? 0,
        rt_ms_to_tick: (ms: unknown) => activePyScheduler?.msToTick(ms) ?? 0,
        rt_is_expired: (s: unknown, t: unknown) =>
          activePyScheduler?.isTickExpired(s, t) ?? false,
        init_scheduler: (s: unknown, r: unknown, t: unknown, b: unknown) =>
          activePyScheduler?.initCoroutineMode(
            Boolean(s),
            Boolean(r),
            Boolean(t),
            Boolean(b),
          ) ?? false,
        sync_handlers: (r: unknown, t: unknown, b: unknown) =>
          activePyScheduler?.syncHandlers(Boolean(r), Boolean(t), Boolean(b)),
        co_sleep: (ms: unknown) => activePyScheduler?.onStartCoSleep(ms),
        co_yield_slice: () => activePyScheduler?.onStartCoYieldSlice(),
        co_done: () => activePyScheduler?.onStartCoDone(),
        wait_start_turn: () =>
          activePyScheduler?.waitPythonStartTurn() ?? Promise.resolve(false),
        resume_start_slice: () =>
          activePyScheduler?.resumePythonStartSlice() ?? Promise.resolve(),
        cb_enter: (n: unknown) =>
          activePyScheduler?.beginCallback(String(n ?? 'cb')),
        cb_exit: () => activePyScheduler?.endCallback(),
        cb_expired: () => activePyScheduler?.isCallbackTimedOut() ?? false,
        is_in_callback: () => activePyScheduler?.isInCallback() ?? false,
        is_stop_requested: () => activePyScheduler?.isStopRequested() ?? false,
        get_time_slice_ms: () => activePyScheduler?.getTimeSliceMs() ?? 20,
        next_event: () =>
          activePyScheduler?.nextEvent() ?? Promise.resolve('done'),
      });
      return mp;
    });
  }
  return sharedMpPromise;
}

async function runPyDebugInMicroPython(
  pyDebug: string,
  opts: HarnessOptions = {},
): Promise<{ logs: string[]; scheduler: WorkerRuntimeScheduler }> {
  const logs: string[] = [];
  const scheduler = new WorkerRuntimeScheduler({
    runId: 'test-py',
    timerCount: 8,
    timeSliceMs: opts.timeSliceMs ?? 20,
    callbackTimeoutMs: opts.callbackTimeoutMs ?? 5000,
    post: () => {},
  });
  const session = new WorkerDebugSession(
    {
      runId: 'test-py',
      breakpoints: opts.breakpoints ?? [],
      stepDelayMs: opts.stepDelayMs ?? 0,
      onClockPause: (paused, creditMs) => {
        if (paused) scheduler.pauseClock();
        else scheduler.resumeClock(creditMs ?? 0);
      },
      getTimeSliceMs: () => scheduler.getTimeSliceMs(),
    },
    (msg) => {
      if (msg.type === 'PAUSED' && typeof msg.blockId === 'string') {
        opts.onPaused?.(msg.blockId, session);
      }
    },
  );
  const mp = await getSharedTestMicroPython();
  activePyLogs = logs;
  activePyScheduler = scheduler;
  activePySession = session;

  const mpFs = (
    mp as unknown as {
      FS?: { writeFile: (path: string, data: string) => void; unlink: (path: string) => void };
    }
  ).FS;
  if (mpFs && mountedTestVfsFiles.length > 0) {
    for (const p of mountedTestVfsFiles) {
      try {
        mpFs.unlink(p);
      } catch {
        // ignore
      }
    }
    mountedTestVfsFiles = [];
  }

  mp.runPython(`
for _k in list(globals().keys()):
  if _k not in ('__name__', '__file__', '__builtins__'):
    del globals()[_k]
import sys
for _mn in ${JSON.stringify([...mountedTestModules, '_poly_rt'])}:
  if _mn in sys.modules:
    del sys.modules[_mn]
`);
  mountedTestModules = [];

  mp.runPython(`
import sys, _poly
class _Rt:
  def set_run_period(self, ms): return _poly.rt_set_run_period(ms)
  def start_run(self): return _poly.rt_start_run()
  def stop_run(self): return _poly.rt_stop_run()
  def start_timer(self, tid, ms, rep=0): return _poly.rt_start_timer(tid, ms, rep)
  def stop_timer(self, tid): return _poly.rt_stop_timer(tid)
  def get_timer_value(self, tid): return _poly.rt_get_timer_value(tid)
  def is_timer_running(self, tid): return _poly.rt_is_timer_running(tid)
  def tick(self): return _poly.rt_tick()
  def ms_to_tick(self, ms): return _poly.rt_ms_to_tick(ms)
  def is_expired(self, s, t): return _poly.rt_is_expired(s, t)
sys.modules["rt"] = _Rt()
`);
  for (const mod of opts.preloadModules ?? []) {
    if (!mod.pythonSource) continue;
    mountedTestModules.push(mod.name);
    if (mod.lazyVfs && mpFs) {
      const vfsPath = `/${mod.name}.py`;
      mpFs.writeFile(vfsPath, mod.pythonSource);
      mountedTestVfsFiles.push(vfsPath);
    } else {
      mp.runPython(`
import sys
_ns = {}
exec(${JSON.stringify(mod.pythonSource)}, _ns)
class _M: pass
_m = _M()
for _k, _v in _ns.items():
  if not _k.startswith("__"): setattr(_m, _k, _v)
sys.modules[${JSON.stringify(mod.name)}] = _m
`);
    }
  }
  opts.onReady?.(scheduler);
  try {
    await mp.runPythonAsync(pyDebug);
  } finally {
    scheduler.requestGracefulStop();
  }
  return { logs, scheduler };
}

describe('Real WASM Runtime Integration (Lua 5.4 & MicroPython + Coroutine Scheme A)', () => {
  beforeAll(() => {
    registerPolyBlocks();
    extensionRegistry.ensureInitialized();
  });

  it('executes temp_guard in real Wasmoon Lua 5.4 & MicroPython WASM with live mock temperature inputs', async () => {
    const proj = instantiateProjectFromTemplate('virtual_board_demo');
    const tempHdl = proj.handles.find((h) => h.name === 'temp_guard_vm')!;
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(tempHdl.scripts[0].workspace, ws);

    const luaCode = backendRegistry.get('lua').generate(ws).code;
    const pyCode = backendRegistry.get('python').generate(ws).code;
    ws.dispose();

    // 1. Real Wasmoon Lua 5.4 at 48°C -> triggers >35°C red lamp alarm
    const luaEvents: Array<{ kind: string; value: unknown }> = [];
    const luaLogs: string[] = [];
    const factory = new LuaFactory();
    const lua = await factory.createEngine({ openStandardLibs: true });
    try {
      const emitLua = (kind: string, value: unknown) => {
        luaEvents.push({ kind: String(kind), value });
      };
      const getLua = (key: string) => (key === 'temp' ? 48 : false);
      lua.global.set('__poly_sim_set', emitLua);
      lua.global.set('__poly_sim_get', getLua);
      lua.global.set('print', (...args: unknown[]) => {
        luaLogs.push(args.map(String).join(' '));
      });
      const src = JSON.stringify(VIRTUAL_BOARD_PACK.sandboxMock!.sources.lua!);
      await lua.doString(`
        package.preload["board"] = function()
          local chunk, err = load(${src}, "@board")
          if not chunk then error(err) end
          return chunk()
        end
      `);
      // Scheme B unified ABI: clean code defines `function on_start()`; C host invokes `on_start()`.
      expect(luaCode).toContain('function on_start()');
      await lua.doString(`${luaCode}\nif type(on_start) == "function" then on_start() end`);
    } finally {
      lua.global.close();
    }

    expect(luaEvents).toContainEqual({ kind: 'led', value: true });
    expect(luaEvents).toContainEqual({ kind: 'rgb', value: '#ef4444' });
    expect(luaEvents).toContainEqual({
      kind: 'oled:append',
      value: 'ALARM: TEMP > 35C!',
    });
    expect(luaLogs.some((l) => l.includes('高温告警'))).toBe(true);

    // 2. Real MicroPython WASM at 28°C (normal green) and 48°C (alarm red)
    const pyEvents: Array<{ kind: string; value: unknown }> = [];
    const pyLogs: string[] = [];
    let mockTemp = 28;
    const mp = await loadMicroPython({
      stdout: (line) => pyLogs.push(line),
    });
    const emitPy = (kind: string, value: unknown) =>
      pyEvents.push({ kind: String(kind), value });
    const getPy = (key: string) => (key === 'temp' ? mockTemp : false);
    mp.registerJsModule('_poly', {
      emit_device: emitPy,
      sim_set: emitPy,
      get_input: getPy,
      sim_get: getPy,
      now_ms: () => performance.now(),
    });
    mp.runPython(`
import sys
_ns = {}
exec(${JSON.stringify(VIRTUAL_BOARD_PACK.sandboxMock!.sources.python!)}, _ns)
class _M: pass
_m = _M()
for _k, _v in _ns.items():
  if not _k.startswith("__"): setattr(_m, _k, _v)
sys.modules["board"] = _m
`);

    expect(pyCode).toContain('async def on_start():');
    await mp.runPythonAsync(`${pyCode}\nif 'on_start' in globals(): await on_start()\n`);
    expect(pyEvents).toContainEqual({ kind: 'led', value: false });
    expect(pyEvents).toContainEqual({ kind: 'rgb', value: '#10b981' });
    expect(pyEvents).toContainEqual({
      kind: 'oled:append',
      value: 'TEMP NORMAL (OK)',
    });

    pyEvents.length = 0;
    mockTemp = 48;
    await mp.runPythonAsync(`${pyCode}\nif 'on_start' in globals(): await on_start()\n`);
    expect(pyEvents).toContainEqual({ kind: 'led', value: true });
    expect(pyEvents).toContainEqual({ kind: 'rgb', value: '#ef4444' });
    expect(pyEvents).toContainEqual({
      kind: 'oled:append',
      value: 'ALARM: TEMP > 35C!',
    });
  });

  it('executes event-driven 3-shot timer (on_start -> on_timer(0) x3 -> on_stop) in BOTH Wasmoon Lua 5.4 and MicroPython WASM', async () => {
    const proj = instantiateProjectFromTemplate('event_timer_demo');
    const hdl = proj.handles.find((h) => h.name === 'oneshot_vm')!;
    setActiveChannelPoolConfig(
      CAP_RT_TIMERS,
      getHandleChannelPoolConfig(hdl, CAP_RT_TIMERS),
    );
    const oneshotScript = hdl.scripts[0];
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(oneshotScript.workspace, ws);

    const luaDebug = backendRegistry.get('lua').generate(ws).debugCode;
    const pyDebug = backendRegistry.get('python').generate(ws).debugCode;
    ws.dispose();
    setActiveChannelPoolConfig(CAP_RT_TIMERS, { count: 8, aliases: {} });

    const { logs: luaLogs } = await runLuaDebugInWasmoon(luaDebug);
    expect(luaLogs.some((l) => l.includes('T0 运行中 = true'))).toBe(true);
    expect(luaLogs.some((l) => l.includes('T0 触发次数 = 1'))).toBe(true);
    expect(luaLogs.some((l) => l.includes('T0 触发次数 = 2'))).toBe(true);
    expect(luaLogs.some((l) => l.includes('T0 触发次数 = 3'))).toBe(true);
    expect(luaLogs.some((l) => l.includes('3 次定时任务全部完成'))).toBe(true);

    const { logs: pyLogs } = await runPyDebugInMicroPython(pyDebug);
    expect(pyLogs.some((l) => l.includes('T0 运行中 = True'))).toBe(true);
    expect(pyLogs.some((l) => l.includes('T0 触发次数 = 1'))).toBe(true);
    expect(pyLogs.some((l) => l.includes('T0 触发次数 = 2'))).toBe(true);
    expect(pyLogs.some((l) => l.includes('T0 触发次数 = 3'))).toBe(true);
    expect(pyLogs.some((l) => l.includes('3 次定时任务全部完成'))).toBe(true);
  });

  it('runs infinite on_start coroutine WITH sleep_ms concurrently with on_run, on_timer, and on_button in BOTH Lua 5.4 & MicroPython', async () => {
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_start',
              id: 'co_s',
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_set_run_period',
                    id: 'co_set_rp',
                    inputs: {
                      MS: { shadow: { type: 'math_number', id: 'm_rp30', fields: { NUM: 30 } } },
                    },
                    next: {
                      block: {
                        type: 'poly_start_timer',
                        id: 'co_t0_start',
                        fields: { TIMER_ID: '0' },
                        inputs: {
                          PERIOD_MS: { shadow: { type: 'math_number', id: 'm_t0', fields: { NUM: 35 } } },
                          REPEAT: { shadow: { type: 'math_number', id: 'm_rep', fields: { NUM: 0 } } },
                        },
                        next: {
                          block: {
                            type: 'controls_whileUntil',
                            id: 'co_loop',
                            fields: { MODE: 'WHILE' },
                            inputs: {
                              BOOL: { block: { type: 'logic_boolean', id: 'co_true', fields: { BOOL: 'TRUE' } } },
                              DO: {
                                block: {
                                  type: 'poly_print',
                                  id: 'co_p_loop',
                                  inputs: {
                                    VALUE: { block: { type: 'text', id: 'co_txt', fields: { TEXT: 'START_LOOP_TICK' } } },
                                  },
                                  next: {
                                    block: {
                                      type: 'poly_wait_ms',
                                      id: 'co_wait',
                                      inputs: {
                                        MS: { shadow: { type: 'math_number', id: 'm_w', fields: { NUM: 45 } } },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            {
              type: 'poly_on_run',
              id: 'co_run',
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_print',
                    id: 'co_p_run',
                    inputs: {
                      VALUE: { block: { type: 'text', id: 'co_rtxt', fields: { TEXT: 'ON_RUN_FIRED' } } },
                    },
                  },
                },
              },
            },
            {
              type: 'poly_on_timer',
              id: 'co_ont0',
              fields: { TIMER_ID: '0' },
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_print',
                    id: 'co_p_t0',
                    inputs: {
                      VALUE: { block: { type: 'text', id: 'co_t0txt', fields: { TEXT: 'T0_FIRED' } } },
                    },
                  },
                },
              },
            },
            {
              type: 'poly_on_button',
              id: 'co_btn',
              fields: { KEY: 'A', EDGE: 'press' },
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_print',
                    id: 'co_p_btn',
                    inputs: {
                      VALUE: { block: { type: 'text', id: 'co_btxt', fields: { TEXT: 'BTN_A_FIRED' } } },
                    },
                  },
                },
              },
            },
            {
              type: 'poly_on_stop',
              id: 'co_stop',
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_print',
                    id: 'co_p_stop',
                    inputs: {
                      VALUE: { block: { type: 'text', id: 'co_stxt', fields: { TEXT: 'ON_STOP_CLEAN' } } },
                    },
                  },
                },
              },
            },
          ],
        },
      },
      ws,
    );

    const luaGen = backendRegistry.get('lua').generate(ws);
    const pyGen = backendRegistry.get('python').generate(ws);
    ws.dispose();

    expect(luaGen.diagnostics).toHaveLength(0);
    expect(luaGen.code).toContain('sleep_ms(45)');

    const triggerButtonAndStop = (sched: WorkerRuntimeScheduler) => {
      setTimeout(() => sched.enqueueEvent('on_button', ['A', true]), 60);
      setTimeout(() => sched.requestGracefulStop(), 160);
    };

    const { logs: luaLogs } = await runLuaDebugInWasmoon(luaGen.debugCode, {
      timeSliceMs: 15,
      onReady: triggerButtonAndStop,
    });
    expect(luaLogs.filter((l) => l === 'START_LOOP_TICK').length).toBeGreaterThanOrEqual(2);
    expect(luaLogs.filter((l) => l === 'ON_RUN_FIRED').length).toBeGreaterThanOrEqual(2);
    expect(luaLogs.filter((l) => l === 'T0_FIRED').length).toBeGreaterThanOrEqual(2);
    expect(luaLogs).toContain('BTN_A_FIRED');
    expect(luaLogs).toContain('ON_STOP_CLEAN');

    const { logs: pyLogs } = await runPyDebugInMicroPython(pyGen.debugCode, {
      timeSliceMs: 15,
      onReady: triggerButtonAndStop,
    });
    expect(pyLogs.filter((l) => l === 'START_LOOP_TICK').length).toBeGreaterThanOrEqual(2);
    expect(pyLogs.filter((l) => l === 'ON_RUN_FIRED').length).toBeGreaterThanOrEqual(2);
    expect(pyLogs.filter((l) => l === 'T0_FIRED').length).toBeGreaterThanOrEqual(2);
    expect(pyLogs).toContain('BTN_A_FIRED');
    expect(pyLogs).toContain('ON_STOP_CLEAN');
  });

  it('preempts tight infinite on_start loop WITHOUT sleep_ms via time-slice so on_run & on_timer still fire', async () => {
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_start',
              id: 'tight_s',
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_set_run_period',
                    id: 'tight_set_rp',
                    inputs: {
                      MS: { shadow: { type: 'math_number', id: 'tm30', fields: { NUM: 30 } } },
                    },
                    next: {
                      block: {
                        type: 'variables_set',
                        id: 'tight_init',
                        fields: { VAR: { id: 'v_cnt' } },
                        inputs: {
                          VALUE: { block: { type: 'math_number', id: 'm0', fields: { NUM: 0 } } },
                        },
                        next: {
                          block: {
                            type: 'controls_whileUntil',
                            id: 'tight_loop',
                            fields: { MODE: 'WHILE' },
                            inputs: {
                              BOOL: { block: { type: 'logic_boolean', id: 'tb', fields: { BOOL: 'TRUE' } } },
                              DO: {
                                block: {
                                  type: 'math_change',
                                  id: 'tight_inc',
                                  fields: { VAR: { id: 'v_cnt' } },
                                  inputs: {
                                    DELTA: { shadow: { type: 'math_number', id: 'm1', fields: { NUM: 1 } } },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            {
              type: 'poly_on_run',
              id: 'tight_run',
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_print_kv',
                    id: 'tight_pr',
                    fields: { LABEL: 'RUN_CNT' },
                    inputs: {
                      VALUE: {
                        block: { type: 'variables_get', id: 'vg', fields: { VAR: { id: 'v_cnt' } } },
                      },
                    },
                  },
                },
              },
            },
            {
              type: 'poly_on_stop',
              id: 'tight_stop',
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_print',
                    id: 'tight_ps',
                    inputs: {
                      VALUE: { block: { type: 'text', id: 'ts', fields: { TEXT: 'TIGHT_STOPPED' } } },
                    },
                  },
                },
              },
            },
          ],
        },
        variables: [{ name: 'cnt', id: 'v_cnt' }],
      },
      ws,
    );

    const luaDebug = backendRegistry.get('lua').generate(ws).debugCode;
    ws.dispose();

    const { logs } = await runLuaDebugInWasmoon(luaDebug, {
      timeSliceMs: 12,
      onReady: (sched) => {
        setTimeout(() => sched.requestGracefulStop(), 150);
      },
    });

    const runCounts = logs
      .filter((l) => l.startsWith('RUN_CNT = '))
      .map((l) => Number(l.replace('RUN_CNT = ', '')));
    expect(runCounts.length).toBeGreaterThanOrEqual(2);
    expect(runCounts[runCounts.length - 1]).toBeGreaterThan(runCounts[0]);
    expect(logs).toContain('TIGHT_STOPPED');
  });

  it('enforces Option A runtime error for sleep_ms inside on_run and timeout guard for infinite loop in on_run', async () => {
    // 1. sleep_ms inside on_run -> immediate strict runtime error
    const wsSleepInRun = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_start',
              id: 'err_s',
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_set_run_period',
                    id: 'err_rp',
                    inputs: {
                      MS: { shadow: { type: 'math_number', id: 'em20', fields: { NUM: 20 } } },
                    },
                  },
                },
              },
            },
            {
              type: 'poly_on_run',
              id: 'err_run',
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_wait_ms',
                    id: 'err_wait',
                    inputs: {
                      MS: { shadow: { type: 'math_number', id: 'm10', fields: { NUM: 10 } } },
                    },
                  },
                },
              },
            },
          ],
        },
      },
      wsSleepInRun,
    );
    const luaErrDebug = backendRegistry.get('lua').generate(wsSleepInRun).debugCode;
    const pyErrDebug = backendRegistry.get('python').generate(wsSleepInRun).debugCode;
    wsSleepInRun.dispose();

    await expect(runLuaDebugInWasmoon(luaErrDebug)).rejects.toThrow(/禁止在事件回调/);
    await expect(runPyDebugInMicroPython(pyErrDebug)).rejects.toThrow(/禁止在事件回调/);

    // 2. Infinite loop inside on_run -> caught by main-L callback timeout hook!
    const wsInfRun = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_start',
              id: 'inf_s',
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_set_run_period',
                    id: 'inf_rp',
                    inputs: {
                      MS: { shadow: { type: 'math_number', id: 'im20', fields: { NUM: 20 } } },
                    },
                  },
                },
              },
            },
            {
              type: 'poly_on_run',
              id: 'inf_run',
              inputs: {
                BODY: {
                  block: {
                    type: 'controls_whileUntil',
                    id: 'inf_loop',
                    fields: { MODE: 'WHILE' },
                    inputs: {
                      BOOL: { block: { type: 'logic_boolean', id: 'ib', fields: { BOOL: 'TRUE' } } },
                    },
                  },
                },
              },
            },
          ],
        },
      },
      wsInfRun,
    );
    const luaInfDebug = backendRegistry.get('lua').generate(wsInfRun).debugCode;
    wsInfRun.dispose();

    await expect(
      runLuaDebugInWasmoon(luaInfDebug, { callbackTimeoutMs: 500 }),
    ).rejects.toThrow(/执行超时/);
  });

  it('dispatches custom declarative kind:"hat" callbacks via enqueueEvent in BOTH Wasmoon Lua 5.4 and MicroPython WASM', async () => {
    const imported = extensionRegistry.importCustomPack(SAMPLE_CUSTOM_EXTENSION_TEMPLATE);
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'ext_robot_on_estop',
              id: 'w_estop_on',
              fields: { STATE: 'press' },
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_print',
                    id: 'w_p1',
                    inputs: {
                      VALUE: {
                        block: {
                          type: 'text',
                          id: 'w_t1',
                          fields: { TEXT: 'CUSTOM_HAT:ESTOP_ON' },
                        },
                      },
                    },
                  },
                },
              },
            },
            {
              type: 'ext_robot_on_estop',
              id: 'w_estop_off',
              fields: { STATE: 'release' },
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_print',
                    id: 'w_p2',
                    inputs: {
                      VALUE: {
                        block: {
                          type: 'text',
                          id: 'w_t2',
                          fields: { TEXT: 'CUSTOM_HAT:ESTOP_OFF' },
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      },
      ws,
    );

    const luaDebug = backendRegistry.get('lua').generate(ws).debugCode;
    const pyDebug = backendRegistry.get('python').generate(ws).debugCode;
    ws.dispose();
    extensionRegistry.removeCustomPack(imported.id);

    const dispatchEvents = (sched: WorkerRuntimeScheduler) => {
      setTimeout(() => {
        sched.enqueueEvent('on_robot_estop', [true]);
        sched.enqueueEvent('on_robot_estop', [false]);
      }, 20);
      setTimeout(() => {
        sched.requestGracefulStop();
      }, 90);
    };

    const { logs: luaLogs } = await runLuaDebugInWasmoon(luaDebug, {
      onReady: dispatchEvents,
    });
    expect(luaLogs).toContain('CUSTOM_HAT:ESTOP_ON');
    expect(luaLogs).toContain('CUSTOM_HAT:ESTOP_OFF');

    const { logs: pyLogs } = await runPyDebugInMicroPython(pyDebug, {
      onReady: dispatchEvents,
    });
    expect(pyLogs).toContain('CUSTOM_HAT:ESTOP_ON');
    expect(pyLogs).toContain('CUSTOM_HAT:ESTOP_OFF');
  });

  it('loads split timers.lua/py + Style A1 shared.lua/py and dispatches on_timer_0 / on_timer_1 in BOTH Wasmoon Lua 5.4 & MicroPython WASM', async () => {
    const proj = instantiateProjectFromTemplate('event_timer_demo');
    const hdl = proj.handles[0];
    setActiveChannelPoolConfig(
      CAP_RT_TIMERS,
      getHandleChannelPoolConfig(hdl, CAP_RT_TIMERS),
    );
    setActiveHandleSharedVariables(hdl.sharedVariables ?? []);
    const metas = buildHandleScriptsMeta(hdl);

    const mainScript = hdl.scripts.find((s) => s.name === 'main')!;
    const timersScript = hdl.scripts.find((s) => s.name === 'timers')!;

    const sharedLuaMod = buildHandleSharedModule(hdl, 'lua')!;
    const sharedPyMod = buildHandleSharedModule(hdl, 'python')!;
    expect(sharedLuaMod.moduleName).toBe('shared');
    expect(sharedLuaMod.source).toContain('shared.led_on = false');
    expect(sharedLuaMod.source).toContain('shared.ticks = 0');
    expect(sharedPyMod.moduleName).toBe('shared');
    expect(sharedPyMod.source).toContain('led_on = False');
    expect(sharedPyMod.source).toContain('ticks = 0');

    setActiveHandleScripts(metas, timersScript.id);
    const timersWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(timersScript.workspace, timersWs);
    const timersModDebugLua = backendRegistry.get('lua').generate(timersWs).moduleDebugCode!;
    const timersModDebugPy = backendRegistry.get('python').generate(timersWs).moduleDebugCode!;
    timersWs.dispose();

    setActiveHandleScripts(metas, mainScript.id);
    const mainWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(mainScript.workspace, mainWs);
    const mainDebugLua = backendRegistry.get('lua').generate(mainWs).debugCode;
    const mainDebugPy = backendRegistry.get('python').generate(mainWs).debugCode;
    mainWs.dispose();
    setActiveHandleScripts([], null);
    setActiveHandleSharedVariables(null);
    setActiveChannelPoolConfig(CAP_RT_TIMERS, { count: 8, aliases: {} });

    // 1. Real Wasmoon Lua 5.4: main.lua & timers.lua (moduleDebugCode!) share `shared.lua` AND central router dispatches on_timer_0/1!
    const { logs } = await runLuaDebugInWasmoon(mainDebugLua, {
      preloadModules: [
        { name: 'board', luaSource: VIRTUAL_BOARD_PACK.sandboxMock!.sources.lua },
        { name: sharedLuaMod.moduleName, luaSource: sharedLuaMod.debugSource },
        { name: 'timers', luaSource: timersModDebugLua },
      ],
      onReady: (sched) => {
        // Press Button A -> triggers T1 (400ms x 3) handled in timers.lua's on_timer_1()
        setTimeout(() => sched.enqueueEvent('on_button', ['A', true]), 80);
        setTimeout(() => sched.requestGracefulStop(), 650);
      },
    });

    expect(logs.some((l) => l.includes('已加载 timers.lua'))).toBe(true);
    expect(logs.some((l) => l.includes('按键 A 按下'))).toBe(true);
    expect(logs.some((l) => l.includes('T1 告警触发次数 = 1'))).toBe(true);
    expect(logs.some((l) => l.includes('on_stop 已安全关闭 LED 与三色灯'))).toBe(true);

    // 2. Real MicroPython WASM: main.py & timers.py (moduleDebugCode!) share `shared.py` state AND main.py central router dispatches timers.py!
    const { logs: pyLogs } = await runPyDebugInMicroPython(mainDebugPy, {
      preloadModules: [
        { name: 'board', pythonSource: VIRTUAL_BOARD_PACK.sandboxMock!.sources.python },
        { name: sharedPyMod.moduleName, pythonSource: sharedPyMod.debugSource, lazyVfs: true },
        { name: 'timers', pythonSource: timersModDebugPy, lazyVfs: true },
      ],
      onReady: (sched) => {
        setTimeout(() => sched.enqueueEvent('on_button', ['A', true]), 80);
        setTimeout(() => sched.requestGracefulStop(), 650);
      },
    });
    expect(pyLogs.some((l) => l.includes('按键 A 按下'))).toBe(true);
    expect(pyLogs.some((l) => l.includes('T1 告警触发次数 = 1'))).toBe(true);
    expect(pyLogs.some((l) => l.includes('on_stop 已安全关闭 LED 与三色灯'))).toBe(true);

    // 3. Prove TRUE cross-file state synchronization in BOTH Lua 5.4 & MicroPython via `shared.lua` / `shared.py`:
    //    main sets `shared.ticks = 100` in on_start() -> timers increments `shared.ticks` to 101 -> main reads 101 in on_stop()!
    const syncMainWs = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'sync_s',
            inputs: {
              BODY: {
                block: {
                  type: 'variables_set',
                  id: 'sync_init',
                  fields: { VAR: { id: 'v_sync_main' } },
                  inputs: { VALUE: { block: { type: 'math_number', id: 'n_100', fields: { NUM: 100 } } } },
                  next: {
                    block: {
                      type: 'poly_require_script',
                      id: 'sync_req',
                      fields: { SCRIPT: 'timers' },
                      next: {
                        block: {
                          type: 'poly_start_timer',
                          id: 'sync_t0',
                          fields: { TIMER_ID: '0' },
                          inputs: {
                            PERIOD_MS: { shadow: { type: 'math_number', id: 's_ms', fields: { NUM: 25 } } },
                            REPEAT: { shadow: { type: 'math_number', id: 's_rep', fields: { NUM: 1 } } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          {
            type: 'poly_on_stop',
            id: 'sync_stop',
            inputs: {
              BODY: {
                block: {
                  type: 'poly_print_kv',
                  id: 'sync_p_stop',
                  fields: { LABEL: 'STOP_TICKS' },
                  inputs: {
                    VALUE: { block: { type: 'variables_get', id: 'sync_g_stop', fields: { VAR: { id: 'v_sync_main' } } } },
                  },
                },
              },
            },
          },
        ],
      },
      variables: [{ name: 'ticks', id: 'v_sync_main' }],
    };
    const syncTimersWs = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_timer',
            id: 'sync_on_t0',
            fields: { TIMER_ID: '0' },
            inputs: {
              BODY: {
                block: {
                  type: 'math_change',
                  id: 'sync_inc',
                  fields: { VAR: { id: 'v_sync_timers' } },
                  inputs: { DELTA: { shadow: { type: 'math_number', id: 's_1', fields: { NUM: 1 } } } },
                  next: {
                    block: {
                      type: 'poly_print_kv',
                      id: 'sync_p_t0',
                      fields: { LABEL: 'TIMER_TICKS' },
                      inputs: {
                        VALUE: { block: { type: 'variables_get', id: 'sync_g_t0', fields: { VAR: { id: 'v_sync_timers' } } } },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
      variables: [{ name: 'ticks', id: 'v_sync_timers' }],
    };
    const syncHdl = {
      id: 'h_sync',
      name: 'sync_vm',
      color: '#10b981',
      autoStart: true,
      capabilityConfigs: {},
      sharedVariables: ['ticks'],
      variableInitialValues: { ticks: { kind: 'number' as const, value: 0 } },
      entryScriptId: 'ss_main',
      activeScriptId: 'ss_main',
      updatedAt: '',
      scripts: [
        { id: 'ss_main', name: 'main', workspace: syncMainWs, breakpoints: [], updatedAt: '' },
        { id: 'ss_timers', name: 'timers', workspace: syncTimersWs, breakpoints: [], updatedAt: '' },
      ],
    };
    setActiveChannelPoolConfig(CAP_RT_TIMERS, { count: 4, aliases: {} });
    setActiveHandleSharedVariables(['ticks']);
    const syncMetas = buildHandleScriptsMeta(syncHdl);
    const syncSharedLua = buildHandleSharedModule(syncHdl, 'lua')!;
    const syncSharedPy = buildHandleSharedModule(syncHdl, 'python')!;
    expect(syncSharedLua.moduleName).toBe('shared');
    expect(syncSharedPy.moduleName).toBe('shared');

    setActiveHandleScripts(syncMetas, 'ss_timers');
    const stWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(syncTimersWs, stWs);
    const syncTimersLua = backendRegistry.get('lua').generate(stWs).code;
    const syncTimersPy = backendRegistry.get('python').generate(stWs).code;
    stWs.dispose();

    setActiveHandleScripts(syncMetas, 'ss_main');
    const smWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(syncMainWs, smWs);
    const syncMainLuaDebug = backendRegistry.get('lua').generate(smWs).debugCode;
    const syncMainPyDebug = backendRegistry.get('python').generate(smWs).debugCode;
    smWs.dispose();
    setActiveHandleScripts([], null);
    setActiveHandleSharedVariables(null);
    setActiveChannelPoolConfig(CAP_RT_TIMERS, { count: 8, aliases: {} });

    const { logs: syncLuaLogs } = await runLuaDebugInWasmoon(syncMainLuaDebug, {
      preloadModules: [
        { name: syncSharedLua.moduleName, luaSource: syncSharedLua.debugSource },
        { name: 'timers', luaSource: syncTimersLua },
      ],
    });
    expect(syncLuaLogs).toContain('TIMER_TICKS = 101');
    expect(syncLuaLogs).toContain('STOP_TICKS = 101');

    const { logs: syncLogs } = await runPyDebugInMicroPython(syncMainPyDebug, {
      preloadModules: [
        { name: syncSharedPy.moduleName, pythonSource: syncSharedPy.debugSource, lazyVfs: true },
        { name: 'timers', pythonSource: syncTimersPy, lazyVfs: true },
      ],
    });
    expect(syncLogs).toContain('TIMER_TICKS = 101');
    expect(syncLogs).toContain('STOP_TICKS = 101');
  });

  it('executes top-level floating blocks before on_start() and keeps conditional sibling import lazy in Lua 5.4 & MicroPython', async () => {
    // 1. Top-level floating print executes BEFORE on_start() in both Lua & Python debugCode
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_print',
              id: 'top_p',
              inputs: {
                VALUE: { block: { type: 'text', id: 'top_t', fields: { TEXT: '1_TOP_LEVEL' } } },
              },
            },
            {
              type: 'poly_on_start',
              id: 's_b',
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_print',
                    id: 'st_p',
                    inputs: {
                      VALUE: { block: { type: 'text', id: 'st_t', fields: { TEXT: '2_ON_START' } } },
                    },
                  },
                },
              },
            },
          ],
        },
      },
      ws,
    );
    const luaDebugOrder = backendRegistry.get('lua').generate(ws).debugCode;
    const pyDebugOrder = backendRegistry.get('python').generate(ws).debugCode;
    ws.dispose();

    const { logs: luaOrder } = await runLuaDebugInWasmoon(luaDebugOrder);
    expect(luaOrder).toEqual(['1_TOP_LEVEL', '2_ON_START']);
    const { logs: pyOrder } = await runPyDebugInMicroPython(pyDebugOrder);
    expect(pyOrder).toEqual(['1_TOP_LEVEL', '2_ON_START']);

    // 2. Conditional lazy import: when `if False:` prevents `require("timers")` / `import timers`,
    //    timers module top-level NEVER executes and `on_timer(0)` skips cleanly without error!
    const timersWsJson = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_print',
            id: 'sib_load_p',
            inputs: {
              VALUE: {
                block: { type: 'text', id: 'sib_load_t', fields: { TEXT: 'SHOULD_NOT_LOAD' } },
              },
            },
          },
          {
            type: 'poly_on_timer',
            id: 'sib_t0',
            fields: { TIMER_ID: '0' },
            inputs: {
              BODY: {
                block: {
                  type: 'poly_print',
                  id: 'sib_t0_p',
                  inputs: {
                    VALUE: {
                      block: { type: 'text', id: 'sib_t0_t', fields: { TEXT: 'SHOULD_NOT_FIRE' } },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    };
    const mainWsJson = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'cond_s',
            inputs: {
              BODY: {
                block: {
                  type: 'controls_if',
                  id: 'cond_if',
                  inputs: {
                    IF0: { block: { type: 'logic_boolean', id: 'cond_f', fields: { BOOL: 'FALSE' } } },
                    DO0: {
                      block: {
                        type: 'poly_require_script',
                        id: 'cond_req',
                        fields: { SCRIPT: 'timers' },
                      },
                    },
                  },
                  next: {
                    block: {
                      type: 'poly_start_timer',
                      id: 'cond_st',
                      fields: { TIMER_ID: '0' },
                      inputs: {
                        PERIOD_MS: { shadow: { type: 'math_number', id: 'c_ms', fields: { NUM: 30 } } },
                        REPEAT: { shadow: { type: 'math_number', id: 'c_rep', fields: { NUM: 1 } } },
                      },
                      next: {
                        block: {
                          type: 'poly_print',
                          id: 'cond_done',
                          inputs: {
                            VALUE: { block: { type: 'text', id: 'c_d', fields: { TEXT: 'COND_OK' } } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    };
    const fakeHdl = {
      id: 'h_cond',
      name: 'cond_vm',
      color: '#4f46e5',
      autoStart: true,
      capabilityConfigs: {},
      entryScriptId: 's_main',
      activeScriptId: 's_main',
      updatedAt: '',
      scripts: [
        { id: 's_main', name: 'main', workspace: mainWsJson, breakpoints: [], updatedAt: '' },
        { id: 's_timers', name: 'timers', workspace: timersWsJson, breakpoints: [], updatedAt: '' },
      ],
    };
    setActiveChannelPoolConfig(CAP_RT_TIMERS, { count: 4, aliases: {} });
    const metas = buildHandleScriptsMeta(fakeHdl);
    setActiveHandleScripts(metas, 's_timers');
    const tWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(timersWsJson, tWs);
    const tLua = backendRegistry.get('lua').generate(tWs).code;
    const tPy = backendRegistry.get('python').generate(tWs).code;
    tWs.dispose();

    setActiveHandleScripts(metas, 's_main');
    const mWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(mainWsJson, mWs);
    const mLuaDebug = backendRegistry.get('lua').generate(mWs).debugCode;
    const mPyDebug = backendRegistry.get('python').generate(mWs).debugCode;
    mWs.dispose();
    setActiveHandleScripts([], null);
    setActiveChannelPoolConfig(CAP_RT_TIMERS, { count: 8, aliases: {} });

    const { logs: cLuaLogs } = await runLuaDebugInWasmoon(mLuaDebug, {
      preloadModules: [{ name: 'timers', luaSource: tLua }],
    });
    expect(cLuaLogs).toContain('COND_OK');
    expect(cLuaLogs).not.toContain('SHOULD_NOT_LOAD');
    expect(cLuaLogs).not.toContain('SHOULD_NOT_FIRE');

    const { logs: cPyLogs } = await runPyDebugInMicroPython(mPyDebug, {
      preloadModules: [{ name: 'timers', pythonSource: tPy, lazyVfs: true }],
    });
    expect(cPyLogs).toContain('COND_OK');
    expect(cPyLogs).not.toContain('SHOULD_NOT_LOAD');
    expect(cPyLogs).not.toContain('SHOULD_NOT_FIRE');
  });

  it('executes rt.tick(), rt.ms_to_tick(), and rt.is_expired(start, timeout) in BOTH Wasmoon Lua 5.4 and MicroPython WASM', async () => {
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_start',
              id: 'rt_tk_start',
              inputs: {
                BODY: {
                  block: {
                    type: 'variables_set',
                    id: 'rt_tk_t0',
                    fields: { VAR: { id: 'v_t0' } },
                    inputs: { VALUE: { block: { type: 'poly_rt_tick', id: 'rt_tk_now' } } },
                    next: {
                      block: {
                        type: 'poly_print_kv',
                        id: 'rt_tk_p1',
                        fields: { LABEL: 'BEFORE' },
                        inputs: {
                          VALUE: {
                            block: {
                              type: 'poly_rt_is_expired',
                              id: 'rt_tk_exp1',
                              inputs: {
                                START: { block: { type: 'variables_get', id: 'rt_tk_g1', fields: { VAR: { id: 'v_t0' } } } },
                                TIMEOUT: {
                                  block: {
                                    type: 'poly_rt_ms_to_tick',
                                    id: 'rt_tk_ms1',
                                    inputs: { MS: { shadow: { type: 'math_number', id: 'rt_tk_40a', fields: { NUM: 40 } } } },
                                  },
                                },
                              },
                            },
                          },
                        },
                        next: {
                          block: {
                            type: 'poly_wait_ms',
                            id: 'rt_tk_sleep',
                            inputs: { MS: { shadow: { type: 'math_number', id: 'rt_tk_55', fields: { NUM: 55 } } } },
                            next: {
                              block: {
                                type: 'poly_print_kv',
                                id: 'rt_tk_p2',
                                fields: { LABEL: 'AFTER' },
                                inputs: {
                                  VALUE: {
                                    block: {
                                      type: 'poly_rt_is_expired',
                                      id: 'rt_tk_exp2',
                                      inputs: {
                                        START: { block: { type: 'variables_get', id: 'rt_tk_g2', fields: { VAR: { id: 'v_t0' } } } },
                                        TIMEOUT: {
                                          block: {
                                            type: 'poly_rt_ms_to_tick',
                                            id: 'rt_tk_ms2',
                                            inputs: { MS: { shadow: { type: 'math_number', id: 'rt_tk_40b', fields: { NUM: 40 } } } },
                                          },
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
        variables: [{ name: 't0', id: 'v_t0' }],
      },
      ws,
    );

    const luaDebug = backendRegistry.get('lua').generate(ws).debugCode;
    const pyDebug = backendRegistry.get('python').generate(ws).debugCode;
    ws.dispose();

    const { logs: luaLogs } = await runLuaDebugInWasmoon(luaDebug);
    expect(luaLogs).toContain('BEFORE = false');
    expect(luaLogs).toContain('AFTER = true');

    const { logs: pyLogs } = await runPyDebugInMicroPython(pyDebug);
    expect(pyLogs).toContain('BEFORE = False');
    expect(pyLogs).toContain('AFTER = True');
  });

  it('executes cross-file shared functions, companion breakpoints (moduleDebugCode), Lua hoisted nested locals, and companion Python callback watchdog in real WASM', async () => {
    // 1. Cross-file shared function `utils.double_val(21)` -> 42 + companion breakpoint inside `utils`
    const utilsWsJson = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'procedures_defreturn',
            id: 'u_def',
            fields: { NAME: 'double_val' },
            extraState: { params: [{ name: 'n', id: 'u_pn' }] },
            inputs: {
              STACK: {
                block: {
                  type: 'poly_print',
                  id: 'u_bp_block',
                  inputs: { VALUE: { block: { type: 'text', id: 'u_t', fields: { TEXT: 'IN_UTILS' } } } },
                },
              },
              RETURN: {
                block: {
                  type: 'math_arithmetic',
                  id: 'u_mul',
                  fields: { OP: 'MULTIPLY' },
                  inputs: {
                    A: { block: { type: 'variables_get', id: 'u_gn', fields: { VAR: { id: 'u_pn' } } } },
                    B: { block: { type: 'math_number', id: 'u_2', fields: { NUM: 2 } } },
                  },
                },
              },
            },
          },
        ],
      },
      variables: [{ name: 'n', id: 'u_pn' }],
    };
    const mainWsJson = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'm_s',
            inputs: {
              BODY: {
                block: {
                  type: 'controls_if',
                  id: 'm_if',
                  extraState: { hasElse: true },
                  inputs: {
                    IF0: { block: { type: 'logic_boolean', id: 'm_true', fields: { BOOL: 'TRUE' } } },
                    DO0: {
                      block: {
                        type: 'poly_local_set',
                        id: 'm_loc1',
                        fields: { NAME: 'tag' },
                        inputs: { VALUE: { block: { type: 'text', id: 'm_hot', fields: { TEXT: 'HOT' } } } },
                      },
                    },
                    ELSE: {
                      block: {
                        type: 'poly_local_set',
                        id: 'm_loc2',
                        fields: { NAME: 'tag' },
                        inputs: { VALUE: { block: { type: 'text', id: 'm_cold', fields: { TEXT: 'COLD' } } } },
                      },
                    },
                  },
                  next: {
                    block: {
                      type: 'poly_print_kv',
                      id: 'm_ptag',
                      fields: { LABEL: 'TAG' },
                      inputs: { VALUE: { block: { type: 'poly_local_get', id: 'm_gtag', fields: { NAME: 'tag' } } } },
                      next: {
                        block: {
                          type: 'poly_print_kv',
                          id: 'm_pres',
                          fields: { LABEL: 'ANS' },
                          inputs: {
                            VALUE: {
                              block: {
                                type: 'poly_call_shared_return',
                                id: 'm_call',
                                extraState: { scriptName: 'utils', fnName: 'double_val', params: ['n'] },
                                inputs: {
                                  ARG0: { block: { type: 'math_number', id: 'm_21', fields: { NUM: 21 } } },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    };
    const hdl = {
      id: 'h_sf',
      name: 'sf_vm',
      color: '#4f46e5',
      autoStart: true,
      capabilityConfigs: {},
      sharedFunctions: ['double_val'],
      entryScriptId: 'sf_main',
      activeScriptId: 'sf_main',
      updatedAt: '',
      scripts: [
        { id: 'sf_main', name: 'main', workspace: mainWsJson, breakpoints: [], updatedAt: '' },
        { id: 'sf_utils', name: 'utils', workspace: utilsWsJson, breakpoints: ['u_bp_block'], updatedAt: '' },
      ],
    };
    const metas = buildHandleScriptsMeta(hdl);
    setActiveHandleSharedFunctions(['double_val']);

    const sharedLua = buildHandleSharedModule(hdl, 'lua')!;
    const sharedPy = buildHandleSharedModule(hdl, 'python')!;

    setActiveHandleScripts(metas, 'sf_main');
    const mWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(mainWsJson, mWs);
    const mLuaDebug = backendRegistry.get('lua').generate(mWs).debugCode;
    const mPyDebug = backendRegistry.get('python').generate(mWs).debugCode;
    mWs.dispose();
    setActiveHandleScripts([], null);
    setActiveHandleSharedFunctions(null);

    const luaPausedBlocks: string[] = [];
    const { logs: luaLogs } = await runLuaDebugInWasmoon(mLuaDebug, {
      breakpoints: ['u_bp_block'],
      onPaused: (bid, session) => {
        luaPausedBlocks.push(bid);
        session.resume();
      },
      preloadModules: [{ name: 'shared', luaSource: sharedLua.debugSource }],
    });
    expect(luaPausedBlocks).toContain('u_bp_block');
    expect(luaLogs).toContain('TAG = HOT');
    expect(luaLogs).toContain('IN_UTILS');
    expect(luaLogs).toContain('ANS = 42');

    const pyPausedBlocks: string[] = [];
    const { logs: pyLogs } = await runPyDebugInMicroPython(mPyDebug, {
      breakpoints: ['u_bp_block'],
      onPaused: (bid, session) => {
        pyPausedBlocks.push(bid);
        session.resume();
      },
      preloadModules: [{ name: 'shared', pythonSource: sharedPy.debugSource, lazyVfs: true }],
    });
    expect(pyPausedBlocks).toContain('u_bp_block');
    expect(pyLogs).toContain('TAG = HOT');
    expect(pyLogs).toContain('IN_UTILS');
    expect(pyLogs).toContain('ANS = 42');

    // 2. Infinite loop inside companion `timers.py` (`on_timer_0`) MUST trip Python callback watchdog via `moduleDebugCode`!
    const infTimersWsJson = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_timer',
            id: 'inf_t0',
            fields: { TIMER_ID: '0' },
            inputs: {
              BODY: {
                block: {
                  type: 'controls_whileUntil',
                  id: 'inf_loop',
                  fields: { MODE: 'WHILE' },
                  inputs: {
                    BOOL: { block: { type: 'logic_boolean', id: 'inf_true', fields: { BOOL: 'TRUE' } } },
                  },
                },
              },
            },
          },
        ],
      },
    };
    const infMainWsJson = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'inf_start',
            inputs: {
              BODY: {
                block: {
                  type: 'poly_require_script',
                  id: 'inf_req',
                  fields: { SCRIPT: 'timers' },
                  next: {
                    block: {
                      type: 'poly_start_timer',
                      id: 'inf_st0',
                      fields: { TIMER_ID: '0' },
                      inputs: {
                        PERIOD_MS: { shadow: { type: 'math_number', id: 'inf_20', fields: { NUM: 20 } } },
                        REPEAT: { shadow: { type: 'math_number', id: 'inf_1', fields: { NUM: 1 } } },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    };
    const infHdl = {
      id: 'h_inf_comp',
      name: 'inf_vm',
      color: '#ef4444',
      autoStart: true,
      capabilityConfigs: {},
      entryScriptId: 'ic_main',
      activeScriptId: 'ic_main',
      updatedAt: '',
      scripts: [
        { id: 'ic_main', name: 'main', workspace: infMainWsJson, breakpoints: [], updatedAt: '' },
        { id: 'ic_timers', name: 'timers', workspace: infTimersWsJson, breakpoints: [], updatedAt: '' },
      ],
    };
    setActiveChannelPoolConfig(CAP_RT_TIMERS, { count: 4, aliases: {} });
    const infMetas = buildHandleScriptsMeta(infHdl);
    setActiveHandleScripts(infMetas, 'ic_timers');
    const itWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(infTimersWsJson, itWs);
    const infTimersModDebug = backendRegistry.get('python').generate(itWs).moduleDebugCode!;
    itWs.dispose();

    setActiveHandleScripts(infMetas, 'ic_main');
    const imWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(infMainWsJson, imWs);
    const infMainPyDebug = backendRegistry.get('python').generate(imWs).debugCode;
    imWs.dispose();
    setActiveHandleScripts([], null);
    setActiveChannelPoolConfig(CAP_RT_TIMERS, { count: 8, aliases: {} });

    await expect(
      runPyDebugInMicroPython(infMainPyDebug, {
        callbackTimeoutMs: 120,
        preloadModules: [
          { name: 'timers', pythonSource: infTimersModDebug, lazyVfs: true },
        ],
      }),
    ).rejects.toThrow(/事件回调执行超时/);
  }, 15_000);

  it('executes value-slot dict & list blocks AND transitive async sleep_ms inside shared module in BOTH Wasmoon Lua 5.4 & MicroPython WASM', async () => {
    const wsJson = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'procedures_defnoreturn',
            id: 'as_def',
            fields: { NAME: 'pulse_wait' },
            inputs: {
              STACK: {
                block: {
                  type: 'poly_wait_ms',
                  id: 'as_w',
                  inputs: { MS: { shadow: { type: 'math_number', id: 'as_25', fields: { NUM: 25 } } } },
                  next: {
                    block: {
                      type: 'poly_print',
                      id: 'as_p',
                      inputs: { VALUE: { block: { type: 'text', id: 'as_t', fields: { TEXT: 'SHARED_SLEPT' } } } },
                    },
                  },
                },
              },
            },
          },
          {
            type: 'poly_on_start',
            id: 'dl_s',
            inputs: {
              BODY: {
                block: {
                  type: 'poly_dict_set',
                  id: 'dl_dset',
                  inputs: {
                    DICT: { block: { type: 'variables_get', id: 'dl_dg1', fields: { VAR: { id: 'v_cfg' } } } },
                    KEY: { block: { type: 'text', id: 'dl_dk', fields: { TEXT: 'mode' } } },
                    VAL: { block: { type: 'text', id: 'dl_dv', fields: { TEXT: 'TURBO' } } },
                  },
                  next: {
                    block: {
                      type: 'poly_list_append',
                      id: 'dl_lapp',
                      inputs: {
                        LIST: { block: { type: 'variables_get', id: 'dl_lg1', fields: { VAR: { id: 'v_arr' } } } },
                        ITEM: { block: { type: 'math_number', id: 'dl_n7', fields: { NUM: 7 } } },
                      },
                      next: {
                        block: {
                          type: 'poly_list_set',
                          id: 'dl_lset',
                          inputs: {
                            LIST: { block: { type: 'variables_get', id: 'dl_lg2', fields: { VAR: { id: 'v_arr' } } } },
                            INDEX: { shadow: { type: 'math_number', id: 'dl_i1', fields: { NUM: 1 } } },
                            VALUE: { block: { type: 'math_number', id: 'dl_n42', fields: { NUM: 42 } } },
                          },
                          next: {
                            block: {
                              type: 'poly_print_kv',
                              id: 'dl_pd',
                              fields: { LABEL: 'CFG' },
                              inputs: {
                                VALUE: {
                                  block: {
                                    type: 'poly_dict_get',
                                    id: 'dl_dget',
                                    inputs: {
                                      DICT: { block: { type: 'variables_get', id: 'dl_dg2', fields: { VAR: { id: 'v_cfg' } } } },
                                      KEY: { block: { type: 'text', id: 'dl_dk2', fields: { TEXT: 'mode' } } },
                                    },
                                  },
                                },
                              },
                              next: {
                                block: {
                                  type: 'poly_print_kv',
                                  id: 'dl_pl',
                                  fields: { LABEL: 'ARR1' },
                                  inputs: {
                                    VALUE: {
                                      block: {
                                        type: 'poly_list_get',
                                        id: 'dl_lget',
                                        inputs: {
                                          LIST: { block: { type: 'variables_get', id: 'dl_lg3', fields: { VAR: { id: 'v_arr' } } } },
                                          INDEX: { shadow: { type: 'math_number', id: 'dl_i2', fields: { NUM: 1 } } },
                                        },
                                      },
                                    },
                                  },
                                  next: {
                                    block: {
                                      type: 'procedures_callnoreturn',
                                      id: 'dl_call_sleep',
                                      extraState: { name: 'pulse_wait' },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
      variables: [
        { name: 'cfg', id: 'v_cfg' },
        { name: 'arr', id: 'v_arr' },
      ],
    };

    const hdl = {
      id: 'h_dl',
      name: 'dl_vm',
      color: '#8b5cf6',
      autoStart: true,
      capabilityConfigs: {},
      sharedVariables: ['cfg', 'arr'],
      sharedFunctions: ['pulse_wait'],
      variableInitialValues: {
        cfg: { kind: 'dict' as const },
        arr: { kind: 'list' as const },
      },
      entryScriptId: 'dl_main',
      activeScriptId: 'dl_main',
      updatedAt: '',
      scripts: [
        { id: 'dl_main', name: 'main', workspace: wsJson, breakpoints: [], updatedAt: '' },
      ],
    };

    setActiveHandleSharedVariables(['cfg', 'arr']);
    setActiveHandleSharedFunctions(['pulse_wait']);
    const metas = buildHandleScriptsMeta(hdl);
    setActiveHandleScripts(metas, 'dl_main');

    const sharedLua = buildHandleSharedModule(hdl, 'lua')!;
    const sharedPy = buildHandleSharedModule(hdl, 'python')!;
    expect(sharedPy.source).toContain('cfg = {}');
    expect(sharedPy.source).toContain('arr = []');
    expect(sharedPy.source).toContain('async def pulse_wait():');
    expect(sharedPy.source).toContain('await sleep_ms(25)');

    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(wsJson, ws);
    const luaRes = backendRegistry.get('lua').generate(ws);
    const pyRes = backendRegistry.get('python').generate(ws);
    ws.dispose();
    setActiveHandleScripts([], null);
    setActiveHandleSharedVariables(null);
    setActiveHandleSharedFunctions(null);

    expect(luaRes.diagnostics).toHaveLength(0);
    expect(pyRes.diagnostics).toHaveLength(0);
    expect(pyRes.code).toContain('await shared.pulse_wait()');

    const { logs: luaLogs } = await runLuaDebugInWasmoon(luaRes.debugCode, {
      preloadModules: [{ name: 'shared', luaSource: sharedLua.debugSource }],
    });
    expect(luaLogs).toContain('CFG = TURBO');
    expect(luaLogs).toContain('ARR1 = 42');
    expect(luaLogs).toContain('SHARED_SLEPT');

    const { logs: pyLogs } = await runPyDebugInMicroPython(pyRes.debugCode, {
      preloadModules: [{ name: 'shared', pythonSource: sharedPy.debugSource, lazyVfs: true }],
    });
    expect(pyLogs).toContain('CFG = TURBO');
    expect(pyLogs).toContain('ARR1 = 42');
    expect(pyLogs).toContain('SHARED_SLEPT');
  });

  it('executes Layer 0 Core nested dict (new/set/get/has/delete) and str_replace identically in Wasmoon Lua 5.4 & MicroPython', async () => {
    // a = {}; a["b"] = {}; a["b"]["val"] = 99;
    // print("VAL", a["b"]["val"]); print("HAS1", has(a["b"], "val"));
    // delete(a["b"], "val"); delete(a["b"], "missing"); print("HAS2", has(a["b"], "val"));
    // print("REP", replace("hi {X}", "{X}", "Poly"))
    const wsJson = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'nd_start',
            inputs: {
              BODY: {
                block: {
                  type: 'variables_set',
                  id: 'nd_init',
                  fields: { VAR: { id: 'v_a' } },
                  inputs: { VALUE: { block: { type: 'poly_dict_new', id: 'nd_new1' } } },
                  next: {
                    block: {
                      type: 'poly_dict_set',
                      id: 'nd_set_b',
                      inputs: {
                        DICT: { block: { type: 'variables_get', id: 'nd_a1', fields: { VAR: { id: 'v_a' } } } },
                        KEY: { block: { type: 'text', id: 'nd_kb1', fields: { TEXT: 'b' } } },
                        VAL: { block: { type: 'poly_dict_new', id: 'nd_new2' } },
                      },
                      next: {
                        block: {
                          type: 'poly_dict_set',
                          id: 'nd_set_val',
                          inputs: {
                            DICT: {
                              block: {
                                type: 'poly_dict_get',
                                id: 'nd_get_b1',
                                inputs: {
                                  DICT: { block: { type: 'variables_get', id: 'nd_a2', fields: { VAR: { id: 'v_a' } } } },
                                  KEY: { block: { type: 'text', id: 'nd_kb2', fields: { TEXT: 'b' } } },
                                },
                              },
                            },
                            KEY: { block: { type: 'text', id: 'nd_kv1', fields: { TEXT: 'val' } } },
                            VAL: { block: { type: 'math_number', id: 'nd_99', fields: { NUM: 99 } } },
                          },
                          next: {
                            block: {
                              type: 'poly_print_kv',
                              id: 'nd_p_val',
                              fields: { LABEL: 'VAL' },
                              inputs: {
                                VALUE: {
                                  block: {
                                    type: 'poly_dict_get',
                                    id: 'nd_get_val',
                                    inputs: {
                                      DICT: {
                                        block: {
                                          type: 'poly_dict_get',
                                          id: 'nd_get_b2',
                                          inputs: {
                                            DICT: { block: { type: 'variables_get', id: 'nd_a3', fields: { VAR: { id: 'v_a' } } } },
                                            KEY: { block: { type: 'text', id: 'nd_kb3', fields: { TEXT: 'b' } } },
                                          },
                                        },
                                      },
                                      KEY: { block: { type: 'text', id: 'nd_kv2', fields: { TEXT: 'val' } } },
                                    },
                                  },
                                },
                              },
                              next: {
                                block: {
                                  type: 'poly_print_kv',
                                  id: 'nd_p_has1',
                                  fields: { LABEL: 'HAS1' },
                                  inputs: {
                                    VALUE: {
                                      block: {
                                        type: 'poly_dict_has',
                                        id: 'nd_has1',
                                        inputs: {
                                          DICT: {
                                            block: {
                                              type: 'poly_dict_get',
                                              id: 'nd_get_b3',
                                              inputs: {
                                                DICT: { block: { type: 'variables_get', id: 'nd_a4', fields: { VAR: { id: 'v_a' } } } },
                                                KEY: { block: { type: 'text', id: 'nd_kb4', fields: { TEXT: 'b' } } },
                                              },
                                            },
                                          },
                                          KEY: { block: { type: 'text', id: 'nd_kv3', fields: { TEXT: 'val' } } },
                                        },
                                      },
                                    },
                                  },
                                  next: {
                                    block: {
                                      type: 'poly_dict_delete',
                                      id: 'nd_del1',
                                      inputs: {
                                        DICT: {
                                          block: {
                                            type: 'poly_dict_get',
                                            id: 'nd_get_b4',
                                            inputs: {
                                              DICT: { block: { type: 'variables_get', id: 'nd_a5', fields: { VAR: { id: 'v_a' } } } },
                                              KEY: { block: { type: 'text', id: 'nd_kb5', fields: { TEXT: 'b' } } },
                                            },
                                          },
                                        },
                                        KEY: { block: { type: 'text', id: 'nd_kv4', fields: { TEXT: 'val' } } },
                                      },
                                      next: {
                                        block: {
                                          type: 'poly_dict_delete',
                                          id: 'nd_del_missing',
                                          inputs: {
                                            DICT: {
                                              block: {
                                                type: 'poly_dict_get',
                                                id: 'nd_get_b5',
                                                inputs: {
                                                  DICT: { block: { type: 'variables_get', id: 'nd_a6', fields: { VAR: { id: 'v_a' } } } },
                                                  KEY: { block: { type: 'text', id: 'nd_kb6', fields: { TEXT: 'b' } } },
                                                },
                                              },
                                            },
                                            KEY: { block: { type: 'text', id: 'nd_km', fields: { TEXT: 'missing' } } },
                                          },
                                          next: {
                                            block: {
                                              type: 'poly_print_kv',
                                              id: 'nd_p_has2',
                                              fields: { LABEL: 'HAS2' },
                                              inputs: {
                                                VALUE: {
                                                  block: {
                                                    type: 'poly_dict_has',
                                                    id: 'nd_has2',
                                                    inputs: {
                                                      DICT: {
                                                        block: {
                                                          type: 'poly_dict_get',
                                                          id: 'nd_get_b6',
                                                          inputs: {
                                                            DICT: { block: { type: 'variables_get', id: 'nd_a7', fields: { VAR: { id: 'v_a' } } } },
                                                            KEY: { block: { type: 'text', id: 'nd_kb7', fields: { TEXT: 'b' } } },
                                                          },
                                                        },
                                                      },
                                                      KEY: { block: { type: 'text', id: 'nd_kv5', fields: { TEXT: 'val' } } },
                                                    },
                                                  },
                                                },
                                              },
                                              next: {
                                                block: {
                                                  type: 'poly_print_kv',
                                                  id: 'nd_p_rep',
                                                  fields: { LABEL: 'REP' },
                                                  inputs: {
                                                    VALUE: {
                                                      block: {
                                                        type: 'poly_str_replace',
                                                        id: 'nd_rep',
                                                        inputs: {
                                                          SRC: { block: { type: 'text', id: 'nd_r1', fields: { TEXT: 'hi {X}' } } },
                                                          OLD: { block: { type: 'text', id: 'nd_r2', fields: { TEXT: '{X}' } } },
                                                          NEW: { block: { type: 'text', id: 'nd_r3', fields: { TEXT: 'Poly' } } },
                                                        },
                                                      },
                                                    },
                                                  },
                                                },
                                              },
                                            },
                                          },
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
      variables: [{ name: 'a', id: 'v_a' }],
    };

    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(wsJson, ws);
    const luaRes = backendRegistry.get('lua').generate(ws);
    const pyRes = backendRegistry.get('python').generate(ws);
    ws.dispose();

    expect(luaRes.diagnostics).toHaveLength(0);
    expect(pyRes.diagnostics).toHaveLength(0);
    // Clean nested chaining without parens or extra imports
    expect(luaRes.code).toContain("a['b']['val'] = 99");
    expect(luaRes.code).toContain("a['b']['val'] = nil");
    expect(luaRes.code).not.toContain('require(');
    expect(pyRes.code).toContain("a.get('b')['val'] = 99");
    expect(pyRes.code).toContain("a.get('b').pop('val', None)");
    expect(pyRes.code).not.toContain('import ');

    const { logs: luaLogs } = await runLuaDebugInWasmoon(luaRes.debugCode);
    expect(luaLogs).toContain('VAL = 99');
    expect(luaLogs).toContain('HAS1 = true');
    expect(luaLogs).toContain('HAS2 = false');
    expect(luaLogs).toContain('REP = hi Poly');

    const { logs: pyLogs } = await runPyDebugInMicroPython(pyRes.debugCode);
    expect(pyLogs).toContain('VAL = 99');
    expect(pyLogs).toContain('HAS1 = True');
    expect(pyLogs).toContain('HAS2 = False');
    expect(pyLogs).toContain('REP = hi Poly');
  });

  it('supports native Blockly controls_flow_statements (continue & break) inside poly_for_range and poly_repeat_times in Wasmoon Lua 5.4 & MicroPython', async () => {
    // for i = 1..6: if i == 2 -> continue; if i == 5 -> break; print(i) => outputs 1, 3, 4
    // plus repeat 3 times with continue -> verifies ::continue:: label on poly_repeat_times too!
    const wsJson = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'cf_start',
            inputs: {
              BODY: {
                block: {
                  type: 'poly_for_range',
                  id: 'cf_for',
                  fields: { VAR: { id: 'v_i' } },
                  inputs: {
                    FROM: { block: { type: 'math_number', id: 'cf_f', fields: { NUM: 1 } } },
                    TO: { block: { type: 'math_number', id: 'cf_t', fields: { NUM: 6 } } },
                    BY: { block: { type: 'math_number', id: 'cf_b', fields: { NUM: 1 } } },
                    DO: {
                      block: {
                        type: 'controls_if',
                        id: 'cf_if2',
                        inputs: {
                          IF0: {
                            block: {
                              type: 'logic_compare',
                              id: 'cf_cmp2',
                              fields: { OP: 'EQ' },
                              inputs: {
                                A: { block: { type: 'variables_get', id: 'cf_gi1', fields: { VAR: { id: 'v_i' } } } },
                                B: { block: { type: 'math_number', id: 'cf_n2', fields: { NUM: 2 } } },
                              },
                            },
                          },
                          DO0: {
                            block: {
                              type: 'controls_flow_statements',
                              id: 'cf_cont',
                              fields: { FLOW: 'CONTINUE' },
                            },
                          },
                        },
                        next: {
                          block: {
                            type: 'controls_if',
                            id: 'cf_if5',
                            inputs: {
                              IF0: {
                                block: {
                                  type: 'logic_compare',
                                  id: 'cf_cmp5',
                                  fields: { OP: 'EQ' },
                                  inputs: {
                                    A: { block: { type: 'variables_get', id: 'cf_gi2', fields: { VAR: { id: 'v_i' } } } },
                                    B: { block: { type: 'math_number', id: 'cf_n5', fields: { NUM: 5 } } },
                                  },
                                },
                              },
                              DO0: {
                                block: {
                                  type: 'controls_flow_statements',
                                  id: 'cf_brk',
                                  fields: { FLOW: 'BREAK' },
                                },
                              },
                            },
                            next: {
                              block: {
                                type: 'poly_print_kv',
                                id: 'cf_pr',
                                fields: { LABEL: 'I' },
                                inputs: {
                                  VALUE: { block: { type: 'variables_get', id: 'cf_gi3', fields: { VAR: { id: 'v_i' } } } },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  next: {
                    block: {
                      type: 'poly_repeat_times',
                      id: 'cf_rep',
                      inputs: {
                        TIMES: { block: { type: 'math_number', id: 'cf_rn', fields: { NUM: 2 } } },
                        DO: {
                          block: {
                            type: 'controls_flow_statements',
                            id: 'cf_rep_cont',
                            fields: { FLOW: 'CONTINUE' },
                          },
                        },
                      },
                      next: {
                        block: {
                          type: 'poly_print',
                          id: 'cf_done',
                          inputs: { VALUE: { block: { type: 'text', id: 'cf_dt', fields: { TEXT: 'LOOP_OK' } } } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
      variables: [{ name: 'i', id: 'v_i' }],
    };

    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(wsJson, ws);

    // Verify Blockly's native validator recognizes `poly_for_range` & `poly_repeat_times` as loops!
    const contBlk = ws.getBlockById('cf_cont') as Blockly.Block & {
      getSurroundLoop?: () => Blockly.Block | null;
    };
    const repContBlk = ws.getBlockById('cf_rep_cont') as Blockly.Block & {
      getSurroundLoop?: () => Blockly.Block | null;
    };
    expect(contBlk.getSurroundLoop?.()?.id).toBe('cf_for');
    expect(repContBlk.getSurroundLoop?.()?.id).toBe('cf_rep');

    const luaRes = backendRegistry.get('lua').generate(ws);
    const pyRes = backendRegistry.get('python').generate(ws);
    ws.dispose();

    expect(luaRes.diagnostics).toHaveLength(0);
    expect(pyRes.diagnostics).toHaveLength(0);
    expect(luaRes.code).toContain('goto continue');
    expect(luaRes.code).toContain('::continue::');
    expect(luaRes.code).toContain('break');
    expect(pyRes.code).toContain('continue');
    expect(pyRes.code).toContain('break');

    const { logs: luaLogs } = await runLuaDebugInWasmoon(luaRes.debugCode);
    expect(luaLogs).toEqual(['I = 1', 'I = 3', 'I = 4', 'LOOP_OK']);

    const { logs: pyLogs } = await runPyDebugInMicroPython(pyRes.debugCode);
    expect(pyLogs).toEqual(['I = 1', 'I = 3', 'I = 4', 'LOOP_OK']);
  });

  it('executes a 5-shot 10ms timer swiftly in realtime (0ms) mode AND throttles 0ms STEP posts while preserving 100% exact breakpoints', async () => {
    // 1. Unit-verify WorkerDebugSession 0ms STEP throttling + exact breakpoint hit
    const posted: Array<Record<string, unknown>> = [];
    const session = new WorkerDebugSession(
      {
        runId: 'throttle-test',
        breakpoints: ['blk_57'],
        stepDelayMs: 0,
      },
      (msg) => {
        posted.push(msg);
        if (msg.type === 'PAUSED') {
          session.resume();
        }
      },
    );
    for (let i = 1; i <= 100; i++) {
      await session.onStep(`blk_${i}`, `{"i":${i}}`, false);
    }
    const pausedMsgs = posted.filter((m) => m.type === 'PAUSED');
    const stepMsgs = posted.filter((m) => m.type === 'STEP');
    expect(pausedMsgs).toHaveLength(1);
    expect(pausedMsgs[0].blockId).toBe('blk_57');
    expect((pausedMsgs[0].vars as Record<string, string>).i).toBe('57');
    // 99 non-paused rapid steps must be throttled heavily (< 10 posts)
    expect(stepMsgs.length).toBeGreaterThanOrEqual(1);
    expect(stepMsgs.length).toBeLessThan(10);

    // 2. Real 10ms x 5 timer in BOTH Wasmoon Lua 5.4 & MicroPython WASM at 0ms realtime speed
    const wsJson = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 't10_start',
            inputs: {
              BODY: {
                block: {
                  type: 'variables_set',
                  id: 't10_init',
                  fields: { VAR: { id: 'v_cnt' } },
                  inputs: { VALUE: { block: { type: 'math_number', id: 't10_z', fields: { NUM: 0 } } } },
                  next: {
                    block: {
                      type: 'poly_start_timer',
                      id: 't10_arm',
                      fields: { TIMER_ID: '0' },
                      inputs: {
                        PERIOD_MS: { block: { type: 'math_number', id: 't10_ms', fields: { NUM: 10 } } },
                        REPEAT: { block: { type: 'math_number', id: 't10_rep', fields: { NUM: 5 } } },
                      },
                    },
                  },
                },
              },
            },
          },
          {
            type: 'poly_on_timer',
            id: 't10_hat',
            fields: { TIMER_ID: '0' },
            inputs: {
              BODY: {
                block: {
                  type: 'math_change',
                  id: 't10_inc',
                  fields: { VAR: { id: 'v_cnt' } },
                  inputs: { DELTA: { block: { type: 'math_number', id: 't10_one', fields: { NUM: 1 } } } },
                  next: {
                    block: {
                      type: 'poly_print_kv',
                      id: 't10_log',
                      fields: { LABEL: 'T10' },
                      inputs: {
                        VALUE: {
                          block: {
                            type: 'variables_get',
                            id: 't10_get',
                            fields: { VAR: { id: 'v_cnt' } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
      variables: [{ name: 'cnt', id: 'v_cnt' }],
    };

    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(wsJson, ws);
    const luaRes = backendRegistry.get('lua').generate(ws);
    const pyRes = backendRegistry.get('python').generate(ws);
    ws.dispose();

    const luaT0 = performance.now();
    const { logs: luaLogs } = await runLuaDebugInWasmoon(luaRes.debugCode, {
      stepDelayMs: 0,
    });
    const luaElapsed = performance.now() - luaT0;
    expect(luaLogs).toEqual(['T10 = 1', 'T10 = 2', 'T10 = 3', 'T10 = 4', 'T10 = 5']);
    expect(luaElapsed).toBeLessThan(1500);

    const pyT0 = performance.now();
    const { logs: pyLogs } = await runPyDebugInMicroPython(pyRes.debugCode, {
      stepDelayMs: 0,
    });
    const pyElapsed = performance.now() - pyT0;
    expect(pyLogs).toEqual(['T10 = 1', 'T10 = 2', 'T10 = 3', 'T10 = 4', 'T10 = 5']);
    expect(pyElapsed).toBeLessThan(2000);

    // 3. Same 5-shot 10ms timer in real JS sandbox at 0ms realtime speed
    const jsWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(wsJson, jsWs);
    const jsRes = backendRegistry.get('js').generate(jsWs);
    jsWs.dispose();
    const jsT0 = performance.now();
    const { logs: jsLogs } = await runJsDebugInSandbox(jsRes.debugCode, {
      stepDelayMs: 0,
    });
    const jsElapsed = performance.now() - jsT0;
    expect(jsLogs).toEqual(['T10 = 1', 'T10 = 2', 'T10 = 3', 'T10 = 4', 'T10 = 5']);
    expect(jsElapsed).toBeLessThan(1500);
  });

  it('executes full JavaScript (ES2023) parity suite: coroutines, timers, split timers.js + shared.js, shared functions, companion breakpoints, hoisted locals, dict/list ops, callback watchdog, and all 4 demos compile with 0 errors', async () => {
    // 1. All 4 built-in demo projects compile cleanly across EVERY handle and script in JavaScript with 0 diagnostics!
    for (const demoId of [
      'starter_suite',
      'virtual_board_demo',
      'event_timer_demo',
      'multi_handle_robot',
    ]) {
      const proj = instantiateProjectFromTemplate(demoId);
      extensionRegistry.setActiveProjectLocalPacks(proj.localExtensions ?? []);
      const jsAdapter = backendRegistry.get('js');
      const projPools = extensionRegistry
        .getChannelPools(proj.enabledCapabilities)
        .map((p) => p.pool);
      for (const hdl of proj.handles) {
        const handleMetas = buildHandleScriptsMeta(hdl);
        const sharedVars = hdl.sharedVariables ?? [];
        const sharedFns = hdl.sharedFunctions ?? [];
        const poolConfigs = getAllHandleChannelPoolConfigs(hdl, projPools);
        for (const scr of hdl.scripts) {
          const ws = new Blockly.Workspace();
          Blockly.serialization.workspaces.load(scr.workspace, ws);
          const res = jsAdapter.generate(ws, {
            enabledCapabilities: proj.enabledCapabilities,
            channelPoolConfigs: poolConfigs,
            handleScripts: handleMetas,
            currentScriptId: scr.id,
            sharedVariables: sharedVars,
            sharedVarInitials: hdl.variableInitialValues,
            scriptVarInitials: scr.variableInitialValues,
            sharedFunctions: sharedFns,
          });
          expect(
            res.diagnostics.filter((d) => d.severity === 'error'),
            `${demoId}/${hdl.name}/${scr.name}.js should have 0 errors`,
          ).toEqual([]);
          ws.dispose();
        }
      }
    }
    extensionRegistry.setActiveProjectLocalPacks([]);

    // 2. Run real split multi-file `event_timer_demo` (main.js + timers.js + shared.js) in JS sandbox!
    const evProj = instantiateProjectFromTemplate('event_timer_demo');
    const evPools = extensionRegistry
      .getChannelPools(evProj.enabledCapabilities)
      .map((p) => p.pool);
    const boardHandle = evProj.handles[0];
    const oneshotHandle = evProj.handles[1];
    const oneshotPoolCfgs = getAllHandleChannelPoolConfigs(oneshotHandle, evPools);
    const boardPoolCfgs = getAllHandleChannelPoolConfigs(boardHandle, evPools);

    // 2a. oneshot_vm handle: 1-shot timer fires once and exits cleanly with board LED / print
    const oneshotMeta = buildHandleScriptsMeta(oneshotHandle);
    const oneshotWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(oneshotHandle.scripts[0].workspace, oneshotWs);
    const oneshotJs = backendRegistry.get('js').generate(oneshotWs, {
      enabledCapabilities: evProj.enabledCapabilities,
      channelPoolConfigs: oneshotPoolCfgs,
      handleScripts: oneshotMeta,
      currentScriptId: oneshotHandle.scripts[0].id,
      sharedVariables: oneshotHandle.sharedVariables ?? [],
      sharedVarInitials: oneshotHandle.variableInitialValues,
      scriptVarInitials: oneshotHandle.scripts[0].variableInitialValues,
      sharedFunctions: oneshotHandle.sharedFunctions ?? [],
    });
    oneshotWs.dispose();
    const { logs: oneshotLogs } = await runJsDebugInSandbox(oneshotJs.debugCode, {
      stepDelayMs: 0,
      onReady: (sched) => {
        setTimeout(() => sched.requestGracefulStop(), 900);
      },
    });
    expect(oneshotLogs.some((l) => l.includes('[INFO]') || l.includes('[OK]'))).toBe(true);

    // 2b. board_vm split handle: main.js requires timers.js + shared.js, dispatches T0 & T1, pauses on companion breakpoint!
    const boardMeta = buildHandleScriptsMeta(boardHandle);
    const sharedMod = buildHandleSharedModule(boardHandle, 'js', boardPoolCfgs);
    expect(sharedMod).not.toBeNull();
    expect(sharedMod!.source).toContain('module.exports = shared;');

    const mainScript = boardHandle.scripts.find((s) => s.id === boardHandle.entryScriptId)!;
    const timersScript = boardHandle.scripts.find((s) => s.id !== boardHandle.entryScriptId)!;

    const mainWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(mainScript.workspace, mainWs);
    const mainJs = backendRegistry.get('js').generate(mainWs, {
      enabledCapabilities: evProj.enabledCapabilities,
      channelPoolConfigs: boardPoolCfgs,
      handleScripts: boardMeta,
      currentScriptId: mainScript.id,
      sharedVariables: boardHandle.sharedVariables ?? [],
      sharedVarInitials: boardHandle.variableInitialValues,
      scriptVarInitials: mainScript.variableInitialValues,
      sharedFunctions: boardHandle.sharedFunctions ?? [],
    });
    mainWs.dispose();

    const timersWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(timersScript.workspace, timersWs);
    const timersJs = backendRegistry.get('js').generate(timersWs, {
      enabledCapabilities: evProj.enabledCapabilities,
      channelPoolConfigs: boardPoolCfgs,
      handleScripts: boardMeta,
      currentScriptId: timersScript.id,
      sharedVariables: boardHandle.sharedVariables ?? [],
      sharedVarInitials: boardHandle.variableInitialValues,
      scriptVarInitials: timersScript.variableInitialValues,
      sharedFunctions: boardHandle.sharedFunctions ?? [],
    });
    timersWs.dispose();

    // Find a statement block inside timers.js to test companion breakpoint hitting across files
    const timerBpId = Object.keys(timersJs.sourceMap).find(
      (id) => timersJs.moduleDebugCode?.includes(`'${id}'`) && !id.startsWith('ev_on_'),
    );
    const hitBreakpoints: string[] = [];
    const { logs: splitLogs, simState } = await runJsDebugInSandbox(mainJs.debugCode, {
      stepDelayMs: 0,
      breakpoints: timerBpId ? [timerBpId] : [],
      onPaused: (bid, sess) => {
        hitBreakpoints.push(bid);
        sess.resume();
      },
      preloadModules: [
        { name: sharedMod!.moduleName, jsSource: sharedMod!.debugSource },
        { name: timersScript.name, jsSource: timersJs.moduleDebugCode! },
      ],
      onReady: (sched) => {
        // Trigger Button A press to start T1 in timers.js, then gracefully stop after T0/T1 fire
        setTimeout(() => sched.enqueueEvent('on_button', ['A', true]), 120);
        setTimeout(() => sched.requestGracefulStop(), 950);
      },
    });
    if (timerBpId) {
      expect(hitBreakpoints).toContain(timerBpId);
    }
    expect(splitLogs.some((l) => l.includes('T1'))).toBe(true);
    expect(simState['virtual-board::led']).toBeDefined();

    // 3. Enforce Option A runtime error when calling sleep_ms inside on_run + watchdog timeout for infinite loop in on_run
    const illegalSleepWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_run',
              id: 'js_bad_run',
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_wait_ms',
                    id: 'js_bad_wait',
                    inputs: { MS: { block: { type: 'math_number', id: 'js_n10', fields: { NUM: 10 } } } },
                  },
                },
              },
            },
          ],
        },
      },
      illegalSleepWs,
    );
    const illegalJs = backendRegistry.get('js').generate(illegalSleepWs);
    illegalSleepWs.dispose();
    await expect(runJsDebugInSandbox(illegalJs.debugCode)).rejects.toThrow(/禁止在事件回调/);

    const infRunWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_run',
              id: 'js_inf_run',
              inputs: {
                BODY: {
                  block: {
                    type: 'controls_whileUntil',
                    id: 'js_inf_while',
                    fields: { MODE: 'WHILE' },
                    inputs: {
                      BOOL: { block: { type: 'logic_boolean', id: 'js_inf_t', fields: { BOOL: 'TRUE' } } },
                    },
                  },
                },
              },
            },
          ],
        },
      },
      infRunWs,
    );
    const infJs = backendRegistry.get('js').generate(infRunWs);
    infRunWs.dispose();
    await expect(
      runJsDebugInSandbox(infJs.debugCode, { callbackTimeoutMs: 120 }),
    ).rejects.toThrow(/超时/);

    // 4. Nested hoisted poly_local_set + dict/list/string/break/continue runtime verification in JS
    const richWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_start',
              id: 'js_rich_start',
              inputs: {
                BODY: {
                  block: {
                    type: 'controls_if',
                    id: 'js_if',
                    inputs: {
                      IF0: { block: { type: 'logic_boolean', id: 'js_t', fields: { BOOL: 'TRUE' } } },
                      DO0: {
                        block: {
                          type: 'poly_local_set',
                          id: 'js_loc_nested',
                          fields: { NAME: 'msg' },
                          inputs: {
                            VALUE: {
                              block: {
                                type: 'poly_str_replace',
                                id: 'js_rep',
                                inputs: {
                                  SRC: { block: { type: 'text', id: 'js_s1', fields: { TEXT: 'a-b-a' } } },
                                  OLD: { block: { type: 'text', id: 'js_s2', fields: { TEXT: 'a' } } },
                                  NEW: { block: { type: 'text', id: 'js_s3', fields: { TEXT: 'X' } } },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                    next: {
                      block: {
                        type: 'poly_print',
                        id: 'js_p_msg',
                        inputs: {
                          VALUE: { block: { type: 'poly_local_get', id: 'js_loc_get', fields: { NAME: 'msg' } } },
                        },
                        next: {
                          block: {
                            type: 'variables_set',
                            id: 'js_d_init',
                            fields: { VAR: { id: 'v_cfg' } },
                            inputs: { VALUE: { block: { type: 'poly_dict_new', id: 'js_d_new' } } },
                            next: {
                              block: {
                                type: 'poly_dict_set',
                                id: 'js_d_set',
                                inputs: {
                                  DICT: { block: { type: 'variables_get', id: 'js_dg1', fields: { VAR: { id: 'v_cfg' } } } },
                                  KEY: { block: { type: 'text', id: 'js_dk', fields: { TEXT: 'mode' } } },
                                  VAL: { block: { type: 'text', id: 'js_dv', fields: { TEXT: 'fast' } } },
                                },
                                next: {
                                  block: {
                                    type: 'poly_print',
                                    id: 'js_p_dict',
                                    inputs: {
                                      VALUE: {
                                        block: {
                                          type: 'poly_dict_get',
                                          id: 'js_d_get',
                                          inputs: {
                                            DICT: { block: { type: 'variables_get', id: 'js_dg2', fields: { VAR: { id: 'v_cfg' } } } },
                                            KEY: { block: { type: 'text', id: 'js_dk2', fields: { TEXT: 'mode' } } },
                                          },
                                        },
                                      },
                                    },
                                    next: {
                                      block: {
                                        type: 'poly_print',
                                        id: 'js_p_miss',
                                        inputs: {
                                          VALUE: {
                                            block: {
                                              type: 'logic_compare',
                                              id: 'js_cmp_null',
                                              fields: { OP: 'EQ' },
                                              inputs: {
                                                A: {
                                                  block: {
                                                    type: 'poly_dict_get',
                                                    id: 'js_d_miss',
                                                    inputs: {
                                                      DICT: { block: { type: 'variables_get', id: 'js_dg3', fields: { VAR: { id: 'v_cfg' } } } },
                                                      KEY: { block: { type: 'text', id: 'js_dk3', fields: { TEXT: 'nope' } } },
                                                    },
                                                  },
                                                },
                                                B: { block: { type: 'logic_null', id: 'js_null' } },
                                              },
                                            },
                                          },
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
        variables: [{ name: 'cfg', id: 'v_cfg' }],
      },
      richWs,
    );
    const richJs = backendRegistry.get('js').generate(richWs);
    richWs.dispose();
    const { logs: richLogs } = await runJsDebugInSandbox(richJs.debugCode);
    expect(richLogs).toEqual(['X-b-X', 'fast', 'true']);
  });
});
