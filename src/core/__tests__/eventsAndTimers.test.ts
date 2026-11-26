import * as Blockly from 'blockly';
import { beforeAll, describe, expect, it } from 'vitest';
import { inspectWorkspaceScriptMeta } from '../backends/eventMode';
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

  it('generates clean zero-closure Lua 5.4 & Python 3 Event-Driven ABI with Scheme A on_timer_N functions and multi-file require("timers")', () => {
    const proj = instantiateProjectFromTemplate('event_timer_demo');
    const hdl = proj.handles[0];
    setActiveTimerConfig(getHandleTimerConfig(hdl));
    const scriptMetas = hdl.scripts.map((s) => {
      const m = inspectWorkspaceScriptMeta(s.workspace);
      return {
        id: s.id,
        name: s.name,
        isEntry: s.id === hdl.entryScriptId,
        declaredEvents: m.declaredEvents,
        requiredScripts: m.requiredScripts,
      };
    });

    // 1. Entry script `main` (on_start with require("timers") + rt.set_run_period(100), on_run, on_button, on_stop)
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
    expect(pyMain.code).toContain('from timers import *');
    expect(pyMain.code).toContain('def on_start():');
    expect(pyMain.code).toContain('global led_on, ticks');
    expect(pyMain.code).not.toContain('global cur_temp');
    expect(pyMain.code).toContain('cur_temp = board.read_temp()');
    expect(pyMain.code).toContain('rt.set_run_period(100)');
    expect(pyMain.code).toContain('def on_run():');
    expect(pyMain.code).toContain('def on_button(key, pressed):');
    expect(pyMain.code).toContain('if key == "A" and pressed:');
    expect(pyMain.code).toContain('def on_stop():');
    expect(pyMain.debugCode).toContain('await _poly.next_event()');
    mainWs.dispose();

    // 2. Companion script `timers` (Scheme A: global function on_timer_0/1 + clean on_timer(id) router)
    setActiveHandleScripts(scriptMetas, timersScript.id);
    const timersWs = loadWs(timersScript.workspace);
    const luaTimers = backendRegistry.get('lua').generate(timersWs);
    expect(luaTimers.diagnostics).toHaveLength(0);
    expect(luaTimers.code).toContain('function on_timer_0()');
    expect(luaTimers.code).toContain('function on_timer_1()');
    expect(luaTimers.code).not.toContain('local function on_timer_0');
    expect(luaTimers.code).toContain('function on_timer(id)');
    expect(luaTimers.code).toContain('if id == 0 then -- T0: 心跳灯\n    on_timer_0()');
    expect(luaTimers.code).toContain('elseif id == 1 then -- T1: 告警倒计时\n    on_timer_1()');
    expect(luaTimers.sourceMap['ev_print_t1']).toBeDefined();

    const pyTimers = backendRegistry.get('python').generate(timersWs);
    expect(pyTimers.diagnostics).toHaveLength(0);
    expect(pyTimers.code).toContain('def on_timer_0():');
    expect(pyTimers.code).toContain('def on_timer_1():');
    expect(pyTimers.code).toContain('def on_timer(id):');
    expect(pyTimers.code).toContain('if id == 0:');
    expect(pyTimers.code).toContain('on_timer_0()');
    expect(pyTimers.code).toContain('elif id == 1:');
    expect(pyTimers.code).toContain('on_timer_1()');
    expect(pyTimers.debugCode).toContain('async def on_timer(id):');
    expect(pyTimers.debugCode).toContain('await on_timer_0()');

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

  it('flags cross-file global callback conflicts when linked scripts both define on_timer, and re-arms setRunPeriod immediately', async () => {
    setActiveHandleScripts(
      [
        {
          id: 's_main',
          name: 'main',
          isEntry: true,
          declaredEvents: ['on_start', 'on_timer'],
          requiredScripts: ['timers'],
        },
        {
          id: 's_timers',
          name: 'timers',
          isEntry: false,
          declaredEvents: ['on_timer'],
          requiredScripts: [],
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
          d.id.startsWith('cross-file-cb-conflict-on_timer-timers'),
      ),
    ).toBe(true);
    conflictWs.dispose();
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
