// @vitest-environment node
import * as Blockly from 'blockly';
import { beforeAll, describe, expect, it } from 'vitest';
import { LuaFactory } from 'wasmoon';
import { loadMicroPython } from '@micropython/micropython-webassembly-pyscript';
import { inspectWorkspaceScriptMeta } from '../backends/eventMode';
import { backendRegistry } from '../backends/registry';
import { registerPolyBlocks } from '../blocks/definitions';
import {
  SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
  VIRTUAL_BOARD_PACK,
} from '../extensions/builtinPacks';
import { extensionRegistry } from '../extensions/registry';
import {
  getHandleTimerConfig,
  instantiateProjectFromTemplate,
} from '../projects/store';
import {
  setActiveHandleScripts,
  setActiveTimerConfig,
} from '../blocks/timerConfigBridge';
import { WorkerDebugSession } from '../../workers/debugSession';
import { WorkerRuntimeScheduler } from '../../workers/runtimeScheduler';

interface HarnessOptions {
  stepDelayMs?: number;
  timeSliceMs?: number;
  callbackTimeoutMs?: number;
  preloadModules?: Array<{
    name: string;
    luaSource?: string;
    pythonSource?: string;
  }>;
  onReady?: (sched: WorkerRuntimeScheduler) => void;
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
      breakpoints: [],
      stepDelayMs: opts.stepDelayMs ?? 0,
      onClockPause: (paused, creditMs) => {
        if (paused) scheduler.pauseClock();
        else scheduler.resumeClock(creditMs ?? 0);
      },
      getTimeSliceMs: () => scheduler.getTimeSliceMs(),
    },
    () => {},
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
    lua.global.set('__poly_should_loop', (r: unknown, t: unknown, b: unknown) =>
      scheduler.shouldEnterEventLoop(Boolean(r), Boolean(t), Boolean(b)),
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
    lua.global.set('__poly_device_emit', () => {});
    lua.global.set('__poly_sim_get', (k: unknown) => (k === 'temp' ? 28 : false));
    lua.global.set('__poly_mock_input', (k: unknown) => (k === 'temp' ? 28 : false));
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
        }
      end
      __poly_event_mode = false
      __poly_start_co = nil
      function sleep_ms(ms)
        if __poly_event_mode then
          local cur, is_main = coroutine.running()
          if cur == nil or is_main or cur ~= __poly_start_co then
            error("禁止在事件回调（on_run / on_timer / on_button / on_stop）中调用 sleep_ms()；实板同步回调不可阻塞，请移至「当程序启动」协程或改用定时器。", 2)
          end
          coroutine.yield("__POLY_SLEEP__", tonumber(ms) or 0)
          return
        end
        __poly_sleep(tonumber(ms) or 0):await()
      end
      function __poly_tick(blockId, varsJson)
        if __poly_event_mode and __poly_start_co ~= nil and coroutine.running() == __poly_start_co then
          coroutine.yield("__POLY_STEP__", blockId, varsJson)
          return
        end
        __poly_step(blockId, varsJson):await()
      end
      function __poly_yield_check()
        if __poly_event_mode and __poly_start_co ~= nil and coroutine.running() == __poly_start_co then
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
      breakpoints: [],
      stepDelayMs: opts.stepDelayMs ?? 0,
      onClockPause: (paused, creditMs) => {
        if (paused) scheduler.pauseClock();
        else scheduler.resumeClock(creditMs ?? 0);
      },
      getTimeSliceMs: () => scheduler.getTimeSliceMs(),
    },
    () => {},
  );
  const mp = await loadMicroPython({
    stdout: (line) => logs.push(line),
  });
  mp.registerJsModule('_poly', {
    step: (bid: string, vars: string) => session.onStep(String(bid), vars, false),
    step_start: (bid: string, vars: string) => session.onStep(String(bid), vars, true),
    sleep: (ms: number) => {
      if (scheduler.isInCallback()) {
        throw new Error('禁止在事件回调中调用等待 (sleep)');
      }
      return session.onSleep(ms);
    },
    final_snap: (vars: string) => session.setFinalVars(vars),
    now_ms: () => performance.now(),
    logic_now_ms: () => scheduler.now(),
    rt_set_run_period: (ms: unknown) => scheduler.setRunPeriod(ms),
    rt_start_run: () => scheduler.startRun(),
    rt_stop_run: () => scheduler.stopRun(),
    rt_start_timer: (id: unknown, ms: unknown, rep: unknown) =>
      scheduler.startTimer(id, ms, rep ?? 0),
    rt_stop_timer: (id: unknown) => scheduler.stopTimer(id),
    rt_get_timer_value: (id: unknown) => scheduler.getTimerValue(id),
    rt_is_timer_running: (id: unknown) => scheduler.isTimerRunning(id),
    should_loop: (r: unknown, t: unknown, b: unknown) =>
      scheduler.shouldEnterEventLoop(Boolean(r), Boolean(t), Boolean(b)),
    init_scheduler: (s: unknown, r: unknown, t: unknown, b: unknown) =>
      scheduler.initCoroutineMode(Boolean(s), Boolean(r), Boolean(t), Boolean(b)),
    sync_handlers: (r: unknown, t: unknown, b: unknown) =>
      scheduler.syncHandlers(Boolean(r), Boolean(t), Boolean(b)),
    co_sleep: (ms: unknown) => scheduler.onStartCoSleep(ms),
    co_yield_slice: () => scheduler.onStartCoYieldSlice(),
    co_done: () => scheduler.onStartCoDone(),
    wait_start_turn: () => scheduler.waitPythonStartTurn(),
    resume_start_slice: () => scheduler.resumePythonStartSlice(),
    cb_enter: (n: unknown) => scheduler.beginCallback(String(n ?? 'cb')),
    cb_exit: () => scheduler.endCallback(),
    cb_expired: () => scheduler.isCallbackTimedOut(),
    is_in_callback: () => scheduler.isInCallback(),
    is_stop_requested: () => scheduler.isStopRequested(),
    get_time_slice_ms: () => scheduler.getTimeSliceMs(),
    next_event: () => scheduler.nextEvent(),
  });
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
sys.modules["rt"] = _Rt()
`);
  opts.onReady?.(scheduler);
  await mp.runPythonAsync(pyDebug);
  return { logs, scheduler };
}

describe('Real WASM Runtime Integration (Lua 5.4 & MicroPython + Coroutine Scheme A)', () => {
  beforeAll(() => {
    registerPolyBlocks();
    extensionRegistry.ensureInitialized();
  });

  it('executes temp_guard in real Wasmoon Lua 5.4 & MicroPython WASM with live mock temperature inputs', async () => {
    const proj = instantiateProjectFromTemplate('virtual_board_demo');
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(proj.handles[0].scripts[1].workspace, ws);

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
      lua.global.set('__poly_device_emit', emitLua);
      lua.global.set('__poly_sim_set', emitLua);
      lua.global.set('__poly_mock_input', getLua);
      lua.global.set('__poly_sim_get', getLua);
      lua.global.set('print', (...args: unknown[]) => {
        luaLogs.push(args.map(String).join(' '));
      });
      const src = JSON.stringify(VIRTUAL_BOARD_PACK.sandboxMock!.luaSource!);
      await lua.doString(`
        package.preload["board"] = function()
          local chunk, err = load(${src}, "@board")
          if not chunk then error(err) end
          return chunk()
        end
      `);
      await lua.doString(luaCode);
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
exec(${JSON.stringify(VIRTUAL_BOARD_PACK.sandboxMock!.pythonSource!)}, _ns)
class _M: pass
_m = _M()
for _k, _v in _ns.items():
  if not _k.startswith("__"): setattr(_m, _k, _v)
sys.modules["board"] = _m
`);

    await mp.runPythonAsync(pyCode);
    expect(pyEvents).toContainEqual({ kind: 'led', value: false });
    expect(pyEvents).toContainEqual({ kind: 'rgb', value: '#10b981' });
    expect(pyEvents).toContainEqual({
      kind: 'oled:append',
      value: 'TEMP NORMAL (OK)',
    });

    pyEvents.length = 0;
    mockTemp = 48;
    await mp.runPythonAsync(pyCode);
    expect(pyEvents).toContainEqual({ kind: 'led', value: true });
    expect(pyEvents).toContainEqual({ kind: 'rgb', value: '#ef4444' });
    expect(pyEvents).toContainEqual({
      kind: 'oled:append',
      value: 'ALARM: TEMP > 35C!',
    });
  });

  it('executes event-driven 3-shot timer (on_start -> on_timer(0) x3 -> on_stop) in BOTH Wasmoon Lua 5.4 and MicroPython WASM', async () => {
    const proj = instantiateProjectFromTemplate('event_timer_demo');
    const hdl = proj.handles[0];
    setActiveTimerConfig(getHandleTimerConfig(hdl));
    const oneshotScript = hdl.scripts.find((s) => s.name === 'timer_oneshot')!;
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(oneshotScript.workspace, ws);

    const luaDebug = backendRegistry.get('lua').generate(ws).debugCode;
    const pyDebug = backendRegistry.get('python').generate(ws).debugCode;
    ws.dispose();
    setActiveTimerConfig({ count: 8, aliases: {} });

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
      setTimeout(() => sched.onMockInputsDelta({ btnA: false }, { btnA: true }), 60);
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

  it('loads split timers.lua dynamically via require("timers") inside on_start and dispatches on_timer_0 / on_timer_1 in real Wasmoon Lua 5.4', async () => {
    const proj = instantiateProjectFromTemplate('event_timer_demo');
    const hdl = proj.handles[0];
    setActiveTimerConfig(getHandleTimerConfig(hdl));
    const metas = hdl.scripts.map((s) => {
      const m = inspectWorkspaceScriptMeta(s.workspace);
      return {
        id: s.id,
        name: s.name,
        isEntry: s.id === hdl.entryScriptId,
        declaredEvents: m.declaredEvents,
        requiredScripts: m.requiredScripts,
      };
    });

    const mainScript = hdl.scripts.find((s) => s.name === 'main')!;
    const timersScript = hdl.scripts.find((s) => s.name === 'timers')!;

    setActiveHandleScripts(metas, timersScript.id);
    const timersWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(timersScript.workspace, timersWs);
    const timersCleanLua = backendRegistry.get('lua').generate(timersWs).code;
    timersWs.dispose();

    setActiveHandleScripts(metas, mainScript.id);
    const mainWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(mainScript.workspace, mainWs);
    const mainDebugLua = backendRegistry.get('lua').generate(mainWs).debugCode;
    mainWs.dispose();
    setActiveHandleScripts([], null);
    setActiveTimerConfig({ count: 8, aliases: {} });

    const { logs } = await runLuaDebugInWasmoon(mainDebugLua, {
      preloadModules: [
        { name: 'board', luaSource: VIRTUAL_BOARD_PACK.sandboxMock!.luaSource },
        { name: 'timers', luaSource: timersCleanLua },
      ],
      onReady: (sched) => {
        // Press Button A -> triggers T1 (400ms x 3) handled in timers.lua's on_timer_1()
        setTimeout(() => sched.onMockInputsDelta({ btnA: false }, { btnA: true }), 80);
        setTimeout(() => sched.requestGracefulStop(), 650);
      },
    });

    expect(logs.some((l) => l.includes('已加载 timers.lua'))).toBe(true);
    expect(logs.some((l) => l.includes('按键 A 按下'))).toBe(true);
    expect(logs.some((l) => l.includes('T1 告警触发次数 = 1'))).toBe(true);
    expect(logs.some((l) => l.includes('on_stop 已安全关闭 LED 与三色灯'))).toBe(true);
  });
});
