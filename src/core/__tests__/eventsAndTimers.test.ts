import * as Blockly from 'blockly';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildHandleScriptsMeta } from '../backends/eventMode';
import { backendRegistry } from '../backends/registry';
import { registerPolyBlocks } from '../blocks/definitions';
import {
  setActiveHandleScripts,
  setActiveProjectCapabilities,
  setActiveTimerConfig,
} from '../blocks/timerConfigBridge';
import { extensionRegistry } from '../extensions/registry';
import {
  getHandleTimerConfig,
  instantiateProjectFromTemplate,
} from '../projects/store';
import { WorkerRuntimeScheduler } from '../../workers/runtimeScheduler';

function loadWs(json: Record<string, unknown>): Blockly.Workspace {
  const ws = new Blockly.Workspace();
  Blockly.serialization.workspaces.load(json, ws);
  return ws;
}

describe('Phase 5 & 6: Event-Driven ABI, Local Scoped Vars, Scope Tree & Multi-Channel Timers', () => {
  beforeAll(() => {
    registerPolyBlocks();
    extensionRegistry.ensureInitialized();
  });

  it('generates centralized entry-script on_timer(id) router, clean companion branch functions, import timers (no import *), and precise Python global declarations', () => {
    const proj = instantiateProjectFromTemplate('event_timer_demo');
    const hdl = proj.handles[0];
    setActiveTimerConfig(getHandleTimerConfig(hdl));
    const scriptMetas = buildHandleScriptsMeta(hdl);

    // 1. Entry script `main` (on_start with require("timers") + central on_timer(id) router, on_run, on_button, on_stop)
    const mainScript = hdl.scripts[0];
    const timersScript = hdl.scripts[1];
    expect(mainScript.name).toBe('main');
    expect(timersScript.name).toBe('timers');

    setActiveHandleScripts(scriptMetas, mainScript.id);
    const mainWs = loadWs(mainScript.workspace);
    const luaMain = backendRegistry.get('lua').generate(mainWs);
    expect(luaMain.isEventDriven).toBe(true);
    expect(luaMain.diagnostics).toHaveLength(0);
    expect(luaMain.code).toContain('local rt = require("rt")');
    expect(luaMain.code).toContain('local board = require("board")');
    expect(luaMain.code).toContain('function on_start()');
    expect(luaMain.code).toContain('require("timers")');
    expect(luaMain.code).toContain('rt.set_run_period(100)');
    expect(luaMain.code).toContain('function on_run()');
    expect(luaMain.code).toContain('local cur_temp = board.read_temp()');
    expect(luaMain.code).toContain('function on_button(key, pressed)');
    expect(luaMain.code).toContain('if key == "A" and pressed then');
    expect(luaMain.code).toContain('function on_stop()');
    expect(luaMain.code).toContain('rt.start_timer(0, 500, 0) -- T0: 心跳灯');
    expect(luaMain.code).toContain('rt.start_timer(1, 400, 3) -- T1: 告警倒计时');
    // Central router lives in main.lua and guards conditional require safely!
    expect(luaMain.code).toContain('function on_timer(id)');
    expect(luaMain.code).toContain('if on_timer_0 then on_timer_0() end');
    expect(luaMain.code).toContain('if on_timer_1 then on_timer_1() end');
    expect(luaMain.code).not.toContain('rt.on_timer(');
    expect(luaMain.debugCode).toContain('__poly_init_scheduler');
    expect(luaMain.debugCode).toContain('__poly_sync_handlers');
    expect(luaMain.debugCode).toContain('coroutine.create(on_start)');
    expect(luaMain.debugCode).toContain('__poly_next_event():await()');
    expect(luaMain.sourceMap['ev_start_t0']).toBeDefined();

    // Verify Scope-Tree variable classification on main.lua
    const scopes = luaMain.variableScopes ?? [];
    const runNode = scopes.find((s) => s.label.includes('on_run'));
    expect(runNode).toBeDefined();
    expect(
      runNode!.variables.some((v) => v.name === 'cur_temp' && v.kind === 'local'),
    ).toBe(true);

    const pyMain = backendRegistry.get('python').generate(mainWs);
    expect(pyMain.isEventDriven).toBe(true);
    expect(pyMain.diagnostics).toHaveLength(0);
    expect(pyMain.code).toContain('import rt');
    expect(pyMain.code).toContain('import board');
    expect(pyMain.code).toContain('import sys');
    // Must use legal `import timers` inside def on_start() — NEVER `from timers import *`!
    expect(pyMain.code).toContain('import timers');
    expect(pyMain.code).not.toContain('from timers import *');
    expect(pyMain.code).toContain('def on_start():');
    expect(pyMain.code).toContain('global led_on, ticks');
    expect(pyMain.code).not.toContain('global cur_temp');
    // Precise Python `global`: callbacks that don't mutate led_on/ticks emit ZERO `global` line!
    expect(pyMain.code).toMatch(/def on_run\(\):\n  cur_temp = board\.read_temp\(\)/);
    expect(pyMain.code).toMatch(/def on_button\(key, pressed\):\n  if key == "A" and pressed:/);
    expect(pyMain.code).toMatch(/def on_stop\(\):\n  board\.led\(False\)/);
    // Central router in main.py dispatches via sys.modules.get("timers") safely!
    expect(pyMain.code).toContain('def on_timer(id):');
    expect(pyMain.code).toContain('_m = sys.modules.get("timers")');
    expect(pyMain.code).toContain('_m.on_timer_0()');
    expect(pyMain.code).toContain('_m.on_timer_1()');
    expect(pyMain.debugCode).toContain('await _poly.next_event()');
    mainWs.dispose();

    // 2. Companion script `timers` emits ONLY branch functions `on_timer_0` / `on_timer_1` (ZERO duplicate `on_timer(id)`!)
    setActiveHandleScripts(scriptMetas, timersScript.id);
    const timersWs = loadWs(timersScript.workspace);
    const luaTimers = backendRegistry.get('lua').generate(timersWs);
    expect(luaTimers.diagnostics).toHaveLength(0);
    expect(luaTimers.code).toContain('function on_timer_0()');
    expect(luaTimers.code).toContain('function on_timer_1()');
    expect(luaTimers.code).not.toContain('local function on_timer_0');
    expect(luaTimers.code).not.toContain('function on_timer(id)');
    expect(luaTimers.sourceMap['ev_print_t1']).toBeDefined();

    const pyTimers = backendRegistry.get('python').generate(timersWs);
    expect(pyTimers.diagnostics).toHaveLength(0);
    expect(pyTimers.code).toContain('def on_timer_0():');
    expect(pyTimers.code).toContain('def on_timer_1():');
    expect(pyTimers.code).not.toContain('def on_timer(id):');
    // Precise per-branch global: on_timer_0 only mutates led_on; on_timer_1 only mutates ticks!
    expect(pyTimers.code).toMatch(/def on_timer_0\(\):\n  global led_on\n/);
    expect(pyTimers.code).toMatch(/def on_timer_1\(\):\n  global ticks\n/);

    timersWs.dispose();
    setActiveHandleScripts([], null);
    setActiveTimerConfig({ count: 8, aliases: {} });
  });

  it('flags duplicate timer hats and out-of-range timer channel IDs in static diagnostics', () => {
    setActiveTimerConfig({ count: 4, aliases: {} });
    const ws = loadWs({
      blocks: {
        languageVersion: 0,
        blocks: [
          { type: 'poly_on_timer', id: 'hat_t0_a', x: 10, y: 10, fields: { TIMER_ID: '0' } },
          { type: 'poly_on_timer', id: 'hat_t0_b', x: 200, y: 10, fields: { TIMER_ID: '0' } },
          { type: 'poly_on_timer', id: 'hat_t9_oob', x: 400, y: 10, fields: { TIMER_ID: '9' } },
        ],
      },
    });

    const res = backendRegistry.get('lua').generate(ws);
    expect(res.diagnostics.some((d) => d.id.startsWith('dup-timer-hat-0'))).toBe(true);
    expect(
      res.diagnostics.some(
        (d) => d.severity === 'error' && d.id.startsWith('pool-rt.timers-oob-9'),
      ),
    ).toBe(true);

    // When 'rt.timers' section is disabled (even if other rt sections are on), flag cap-missing-rt.timers diagnostic
    setActiveProjectCapabilities(['rt.lifecycle', 'rt.tick']);
    const resNoCap = backendRegistry.get('lua').generate(ws);
    expect(
      resNoCap.diagnostics.some(
        (d) => d.severity === 'error' && d.id.startsWith('cap-missing-rt.timers-'),
      ),
    ).toBe(true);

    ws.dispose();
    setActiveProjectCapabilities(null);
    setActiveTimerConfig({ count: 8, aliases: {} });
  });

  it('schedules repeat timers, elapsed values, button edges, and isolates multiple schedulers', async () => {
    const msgsA: Array<Record<string, unknown>> = [];
    const msgsB: Array<Record<string, unknown>> = [];
    const schedA = new WorkerRuntimeScheduler({
      runId: 'ctx-a',
      timerCount: 4,
      post: (m) => msgsA.push(m),
    });
    const schedB = new WorkerRuntimeScheduler({
      runId: 'ctx-b',
      timerCount: 4,
      post: (m) => msgsB.push(m),
    });

    expect(() => schedA.startTimer(5, 50, 1)).toThrow(/超出当前项目配置范围/);

    schedA.startTimer(0, 25, 2);
    expect(schedA.isTimerRunning(0)).toBe(true);
    expect(schedB.isTimerRunning(0)).toBe(false);
    expect(schedB.getTimerValue(0)).toBe(0);

    expect(schedA.shouldEnterEventLoop(false, true, false)).toBe(true);
    const ev1 = await schedA.nextEvent();
    expect(ev1).toBe('timer:0');
    expect(schedA.isTimerRunning(0)).toBe(true);

    const ev2 = await schedA.nextEvent();
    expect(ev2).toBe('timer:0');
    expect(schedA.isTimerRunning(0)).toBe(false);
    expect(schedA.getTimerValue(0)).toBe(0);

    const ev3 = await schedA.nextEvent();
    expect(ev3).toBe('done');

    expect(schedB.shouldEnterEventLoop(false, false, true)).toBe(true);
    schedB.onMockInputsDelta({ btnA: false }, { btnA: true });
    expect(await schedB.nextEvent()).toBe('button:A:1');
    schedB.requestGracefulStop();
    expect(await schedB.nextEvent()).toBe('stop');
  });

  it('flags poly_wait_ms inside event callbacks as Option A error, while allowing it in on_start', () => {
    const ws = loadWs({
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'ok_start',
            x: 20,
            y: 20,
            inputs: {
              BODY: {
                block: {
                  type: 'poly_wait_ms',
                  id: 'wait_in_start',
                  inputs: {
                    MS: { shadow: { type: 'math_number', id: 'm1', fields: { NUM: 100 } } },
                  },
                },
              },
            },
          },
          {
            type: 'poly_on_run',
            id: 'bad_run',
            x: 320,
            y: 20,
            inputs: {
              BODY: {
                block: {
                  type: 'poly_wait_ms',
                  id: 'wait_in_run',
                  inputs: {
                    MS: { shadow: { type: 'math_number', id: 'm2', fields: { NUM: 50 } } },
                  },
                },
              },
            },
          },
          {
            type: 'poly_on_timer',
            id: 'bad_timer',
            x: 620,
            y: 20,
            fields: { TIMER_ID: '0' },
            inputs: {
              BODY: {
                block: {
                  type: 'poly_wait_ms',
                  id: 'wait_in_timer',
                  inputs: {
                    MS: { shadow: { type: 'math_number', id: 'm3', fields: { NUM: 50 } } },
                  },
                },
              },
            },
          },
        ],
      },
    });

    const luaRes = backendRegistry.get('lua').generate(ws);
    expect(luaRes.code).toContain('sleep_ms(100)');
    expect(
      luaRes.diagnostics.some(
        (d) =>
          d.severity === 'error' &&
          d.id === 'wait-in-callback-on_run-wait_in_run' &&
          d.blockId === 'wait_in_run',
      ),
    ).toBe(true);
    expect(
      luaRes.diagnostics.some(
        (d) =>
          d.severity === 'error' &&
          d.id === 'wait-in-callback-on_timer-wait_in_timer' &&
          d.blockId === 'wait_in_timer',
      ),
    ).toBe(true);
    expect(luaRes.diagnostics.some((d) => d.blockId === 'wait_in_start')).toBe(false);
    ws.dispose();
  });

  it('freezes logical clock during pauseClock and dispatches overdue timers & on_run fairly without starvation', async () => {
    const sched = new WorkerRuntimeScheduler({
      runId: 'fair-test',
      timerCount: 4,
      timeSliceMs: 20,
      post: () => {},
    });

    const t0 = sched.now();
    sched.pauseClock();
    await new Promise((r) => setTimeout(r, 45));
    sched.resumeClock(0);
    const t1 = sched.now();
    // Entire 45ms pause must be frozen out of logical clock
    expect(t1 - t0).toBeLessThan(12);

    // Start T0 (20ms), T1 (20ms), and on_run (20ms) then wait 40ms so ALL THREE are overdue simultaneously
    sched.setRunPeriod(20);
    sched.startTimer(0, 20, 0);
    sched.startTimer(1, 20, 0);
    expect(sched.initCoroutineMode(false, true, true, false)).toBe(true);

    await new Promise((r) => setTimeout(r, 40));

    // Over 6 consecutive dispatches, ALL THREE sources (timer:0, timer:1, run) must get fair turns
    const dispatched: string[] = [];
    for (let i = 0; i < 6; i++) {
      dispatched.push(await sched.nextEvent());
    }
    expect(dispatched).toContain('timer:0');
    expect(dispatched).toContain('timer:1');
    expect(dispatched).toContain('run');
  });

  it('allows multi-file split timers on distinct channels with central main router + auto-require, flags same-channel cross-file collisions, and prevents Python param/global SyntaxError', async () => {
    // 1. Cross-file collision when BOTH `main` and `timers` bind the SAME channel T0 + duplicate `on_start`
    setActiveHandleScripts(
      [
        {
          id: 's_main',
          name: 'main',
          isEntry: true,
          declaredEvents: ['on_start', 'on_timer'],
          requiredScripts: ['timers'],
          dispatchBranches: [
            {
              blockType: 'poly_on_timer',
              eventName: 'on_timer',
              fnPrefix: 'on_timer_',
              fnName: 'on_timer_0',
              dupKey: '0',
              params: ['id'],
              conditionLua: 'id == 0',
              conditionPython: 'id == 0',
              commentLua: '',
              commentPython: '',
              scriptId: 's_main',
              scriptName: 'main',
            },
          ],
        },
        {
          id: 's_timers',
          name: 'timers',
          isEntry: false,
          declaredEvents: ['on_start', 'on_timer'],
          requiredScripts: [],
          dispatchBranches: [
            {
              blockType: 'poly_on_timer',
              eventName: 'on_timer',
              fnPrefix: 'on_timer_',
              fnName: 'on_timer_0',
              dupKey: '0',
              params: ['id'],
              conditionLua: 'id == 0',
              conditionPython: 'id == 0',
              commentLua: '',
              commentPython: '',
              scriptId: 's_timers',
              scriptName: 'timers',
            },
          ],
        },
      ],
      's_main',
    );
    const conflictWs = loadWs({
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'cf_s',
            inputs: {
              BODY: {
                block: {
                  type: 'poly_require_script',
                  id: 'cf_req',
                  fields: { SCRIPT: 'timers' },
                },
              },
            },
          },
          {
            type: 'poly_on_timer',
            id: 'cf_t0',
            fields: { TIMER_ID: '0' },
          },
        ],
      },
    });
    const res = backendRegistry.get('lua').generate(conflictWs);
    expect(
      res.diagnostics.some(
        (d) =>
          d.severity === 'error' &&
          d.id.startsWith('handle-dup-lifecycle-on_start-timers'),
      ),
    ).toBe(true);
    expect(
      res.diagnostics.some(
        (d) =>
          d.severity === 'error' &&
          d.id.startsWith('cross-file-branch-dup-on_timer-0-timers'),
      ),
    ).toBe(true);
    conflictWs.dispose();

    // 2. Multi-file split on DISTINCT channels (T0 in timers_a, T1 in timers_b, T2 in main):
    //    ZERO diagnostics, auto-hoists require("timers_a") & require("timers_b") when not manually required,
    //    and routes all 3 channels inside ONE sorted `on_timer(id)` in `main`!
    setActiveHandleScripts(
      [
        {
          id: 's_split_main',
          name: 'main',
          isEntry: true,
          declaredEvents: ['on_start', 'on_timer'],
          requiredScripts: [],
          dispatchBranches: [],
        },
        {
          id: 's_split_a',
          name: 'timers_a',
          isEntry: false,
          declaredEvents: ['on_timer'],
          requiredScripts: [],
          dispatchBranches: [
            {
              blockType: 'poly_on_timer',
              eventName: 'on_timer',
              fnPrefix: 'on_timer_',
              fnName: 'on_timer_0',
              dupKey: '0',
              params: ['id'],
              conditionLua: 'id == 0',
              conditionPython: 'id == 0',
              commentLua: '',
              commentPython: '',
              scriptId: 's_split_a',
              scriptName: 'timers_a',
            },
          ],
        },
        {
          id: 's_split_b',
          name: 'timers_b',
          isEntry: false,
          declaredEvents: ['on_timer'],
          requiredScripts: [],
          dispatchBranches: [
            {
              blockType: 'poly_on_timer',
              eventName: 'on_timer',
              fnPrefix: 'on_timer_',
              fnName: 'on_timer_1',
              dupKey: '1',
              params: ['id'],
              conditionLua: 'id == 1',
              conditionPython: 'id == 1',
              commentLua: '',
              commentPython: '',
              scriptId: 's_split_b',
              scriptName: 'timers_b',
            },
          ],
        },
      ],
      's_split_main',
    );
    const splitMainWs = loadWs({
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'sp_start',
            inputs: {
              BODY: {
                block: {
                  type: 'poly_print',
                  id: 'sp_pr',
                  inputs: { VALUE: { block: { type: 'text', id: 'sp_txt', fields: { TEXT: 'boot' } } } },
                },
              },
            },
          },
          {
            type: 'poly_on_timer',
            id: 'sp_t2',
            fields: { TIMER_ID: '2' },
          },
        ],
      },
    });
    const splitLua = backendRegistry.get('lua').generate(splitMainWs);
    expect(splitLua.diagnostics).toHaveLength(0);
    expect(splitLua.code).toContain('require("timers_a")');
    expect(splitLua.code).toContain('require("timers_b")');
    expect(splitLua.code).toContain('function on_timer(id)');
    expect(splitLua.code).toContain('if on_timer_0 then on_timer_0() end');
    expect(splitLua.code).toContain('if on_timer_1 then on_timer_1() end');
    expect(splitLua.code).toContain('on_timer_2()');

    const splitPy = backendRegistry.get('python').generate(splitMainWs);
    expect(splitPy.diagnostics).toHaveLength(0);
    expect(splitPy.code).toContain('import timers_a');
    expect(splitPy.code).toContain('import timers_b');
    expect(splitPy.code).toContain('import sys');
    expect(splitPy.code).toContain('_m = sys.modules.get("timers_a")');
    expect(splitPy.code).toContain('_m = sys.modules.get("timers_b")');
    expect(splitPy.code).toContain('on_timer_2()');
    splitMainWs.dispose();

    // 3. Python param/global SyntaxError regression check: global var named `key` inside `on_button(key, pressed)`
    setActiveHandleScripts([], null);
    const paramShadowWs = loadWs({
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_button',
            id: 'pb_shadow',
            fields: { KEY: 'A', EDGE: 'press' },
            inputs: {
              BODY: {
                block: {
                  type: 'variables_set',
                  id: 'vs_key',
                  fields: { VAR: { id: 'v_key' } },
                  inputs: { VALUE: { block: { type: 'text', id: 't_k', fields: { TEXT: 'X' } } } },
                },
              },
            },
          },
        ],
      },
      variables: [{ name: 'key', id: 'v_key' }],
    });
    const shadowPy = backendRegistry.get('python').generate(paramShadowWs);
    expect(shadowPy.code).not.toContain('global key');
    paramShadowWs.dispose();

    // 4. Pure hat-driven event-loop detection across the whole handle:
    setActiveHandleScripts(
      [
        {
          id: 's_main_only',
          name: 'main',
          isEntry: true,
          declaredEvents: ['on_start'],
          requiredScripts: ['timers'],
          dispatchBranches: [],
        },
        {
          id: 's_timers_hat',
          name: 'timers',
          isEntry: false,
          declaredEvents: ['on_timer'],
          requiredScripts: [],
          dispatchBranches: [
            {
              blockType: 'poly_on_timer',
              eventName: 'on_timer',
              fnPrefix: 'on_timer_',
              fnName: 'on_timer_0',
              dupKey: '0',
              params: ['id'],
              conditionLua: 'id == 0',
              conditionPython: 'id == 0',
              commentLua: '',
              commentPython: '',
              scriptId: 's_timers_hat',
              scriptName: 'timers',
            },
          ],
        },
      ],
      's_main_only',
    );
    const mainOnlyWs = loadWs({
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'mo_s',
            inputs: {
              BODY: {
                block: {
                  type: 'poly_require_script',
                  id: 'mo_req',
                  fields: { SCRIPT: 'timers' },
                  next: {
                    block: {
                      type: 'poly_start_timer',
                      id: 'mo_t0',
                      fields: { TIMER_ID: '0' },
                      inputs: {
                        PERIOD_MS: { shadow: { type: 'math_number', id: 'mo_ms', fields: { NUM: 200 } } },
                        REPEAT: { shadow: { type: 'math_number', id: 'mo_rep', fields: { NUM: 1 } } },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });
    const mainOnlyRes = backendRegistry.get('lua').generate(mainOnlyWs);
    expect(mainOnlyRes.isEventDriven).toBe(true);
    expect(mainOnlyRes.diagnostics).toHaveLength(0);
    mainOnlyWs.dispose();
    setActiveHandleScripts([], null);

    // setRunPeriod immediately re-arms next trigger (from 5000ms down to 25ms)
    const sched = new WorkerRuntimeScheduler({
      runId: 'period-rearm',
      timerCount: 4,
      post: () => {},
    });
    sched.setRunPeriod(5000);
    sched.initCoroutineMode(false, true, false, false);
    const tStart = performance.now();
    sched.setRunPeriod(25);
    const ev = await sched.nextEvent();
    const elapsed = performance.now() - tStart;
    expect(ev).toBe('run');
    expect(elapsed).toBeLessThan(250);
  });

  it('generates rt.tick / rt.ms_to_tick / rt.is_expired (Scheme A) independently and handles 32-bit uint32 wrap-around', () => {
    const ws = loadWs({
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'tk_s',
            inputs: {
              BODY: {
                block: {
                  type: 'variables_set',
                  id: 'tk_set0',
                  fields: { VAR: { id: 'v_t0' } },
                  inputs: { VALUE: { block: { type: 'poly_rt_tick', id: 'tk_get' } } },
                  next: {
                    block: {
                      type: 'poly_print',
                      id: 'tk_pr',
                      inputs: {
                        VALUE: {
                          block: {
                            type: 'poly_rt_is_expired',
                            id: 'tk_exp',
                            inputs: {
                              START: { block: { type: 'variables_get', id: 'tk_v', fields: { VAR: { id: 'v_t0' } } } },
                              TIMEOUT: {
                                block: {
                                  type: 'poly_rt_ms_to_tick',
                                  id: 'tk_conv',
                                  inputs: { MS: { shadow: { type: 'math_number', id: 'tk_500', fields: { NUM: 500 } } } },
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
    });

    const luaRes = backendRegistry.get('lua').generate(ws);
    expect(luaRes.isEventDriven).toBe(false); // independent pack does NOT force event-loop mode!
    expect(luaRes.code).toContain('local rt = require("rt")');
    expect(luaRes.code).toContain('t0 = rt.tick()');
    expect(luaRes.code).toContain('rt.is_expired(t0, rt.ms_to_tick(500))');

    const pyRes = backendRegistry.get('python').generate(ws);
    expect(pyRes.isEventDriven).toBe(false);
    expect(pyRes.code).toContain('import rt');
    expect(pyRes.code).toContain('t0 = rt.tick()');
    expect(pyRes.code).toContain('rt.is_expired(t0, rt.ms_to_tick(500))');
    ws.dispose();

    // Exact 32-bit unsigned wrap-around verification across 0xFFFFFFFF -> 0x00000000
    const sched = new WorkerRuntimeScheduler({
      runId: 'tick-wrap',
      timerCount: 4,
      tickHz: 1000,
      post: () => {},
    });
    expect(sched.msToTick(0)).toBe(0);
    expect(sched.msToTick(250)).toBe(250);

    const sched100 = new WorkerRuntimeScheduler({
      runId: 'tick-100hz',
      timerCount: 4,
      tickHz: 100,
      post: () => {},
    });
    expect(sched100.msToTick(250)).toBe(25);
    expect(sched100.msToTick(15)).toBe(2); // ceil(1.5) = 2 ticks

    const startNearMax = 0xfffffff0;
    expect(sched.isTickExpired(startNearMax, 32, 0xfffffffc)).toBe(false); // elapsed = 12
    expect(sched.isTickExpired(startNearMax, 32, 0x00000008)).toBe(false); // wrapped, elapsed = 24
    expect(sched.isTickExpired(startNearMax, 32, 0x00000010)).toBe(true); // wrapped, elapsed = 32
    expect(sched.isTickExpired(startNearMax, 32, 0x00000025)).toBe(true); // wrapped, elapsed = 53
  });
});
