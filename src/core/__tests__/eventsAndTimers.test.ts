import * as Blockly from 'blockly';
import { beforeAll, describe, expect, it } from 'vitest';
import { backendRegistry } from '../backends/registry';
import { registerPolyBlocks } from '../blocks/definitions';
import { setActiveTimerConfig } from '../blocks/timerConfigBridge';
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

  it('generates clean zero-closure Lua 5.4 & Python 3 Event-Driven ABI with local vars and scope tree', () => {
    const proj = instantiateProjectFromTemplate('event_timer_demo');
    const hdl = proj.handles[0];
    setActiveTimerConfig(getHandleTimerConfig(hdl));
    const ws = loadWs(hdl.scripts[0].workspace);

    const luaRes = backendRegistry.get('lua').generate(ws);
    expect(luaRes.isEventDriven).toBe(true);
    expect(luaRes.diagnostics).toHaveLength(0);
    expect(luaRes.code).toContain('local rt = require("rt")');
    expect(luaRes.code).toContain('local board = require("board")');
    expect(luaRes.code).toContain('function on_start()');
    expect(luaRes.code).toContain('rt.set_run_period(100)');
    expect(luaRes.code).toContain('function on_run()');
    expect(luaRes.code).toContain('local cur_temp = board.read_temp()');
    expect(luaRes.code).toContain('function on_timer(id)');
    expect(luaRes.code).toContain('if id == 0 then -- T0: 心跳灯');
    expect(luaRes.code).toContain('elseif id == 1 then -- T1: 告警倒计时');
    expect(luaRes.code).toContain('function on_button(key, pressed)');
    expect(luaRes.code).toContain('if key == "A" and pressed then');
    expect(luaRes.code).toContain('function on_stop()');
    expect(luaRes.code).toContain('rt.start_timer(0, 500, 0) -- T0: 心跳灯');
    expect(luaRes.code).toContain('rt.start_timer(1, 400, 3) -- T1: 告警倒计时');
    expect(luaRes.code).not.toContain('rt.on_timer(');
    expect(luaRes.debugCode).toContain('__poly_should_loop');
    expect(luaRes.debugCode).toContain('__poly_next_event():await()');
    expect(luaRes.sourceMap['ev_start_t0']).toBeDefined();
    expect(luaRes.sourceMap['ev_print_t1']).toBeDefined();

    // Verify Scope-Tree variable classification
    const scopes = luaRes.variableScopes ?? [];
    const sharedNode = scopes.find((s) => s.id === 'shared');
    expect(sharedNode).toBeDefined();
    expect(sharedNode!.variables.map((v) => v.name)).toContain('led_on');
    expect(sharedNode!.variables.map((v) => v.name)).toContain('ticks');
    expect(sharedNode!.variables.map((v) => v.name)).not.toContain('cur_temp');

    const runNode = scopes.find((s) => s.label.includes('on_run'));
    expect(runNode).toBeDefined();
    expect(
      runNode!.variables.some((v) => v.name === 'cur_temp' && v.kind === 'local'),
    ).toBe(true);

    const pyRes = backendRegistry.get('python').generate(ws);
    expect(pyRes.isEventDriven).toBe(true);
    expect(pyRes.diagnostics).toHaveLength(0);
    expect(pyRes.code).toContain('import rt');
    expect(pyRes.code).toContain('import board');
    expect(pyRes.code).toContain('def on_start():');
    expect(pyRes.code).toContain('global led_on, ticks');
    expect(pyRes.code).not.toContain('global cur_temp');
    expect(pyRes.code).toContain('cur_temp = board.read_temp()');
    expect(pyRes.code).toContain('rt.set_run_period(100)');
    expect(pyRes.code).toContain('def on_run():');
    expect(pyRes.code).toContain('def on_timer(id):');
    expect(pyRes.code).toContain('if id == 0:');
    expect(pyRes.code).toContain('elif id == 1:');
    expect(pyRes.code).toContain('def on_button(key, pressed):');
    expect(pyRes.code).toContain('if key == "A" and pressed:');
    expect(pyRes.code).toContain('def on_stop():');
    expect(pyRes.code).not.toContain('rt.on_timer(');
    expect(pyRes.debugCode).toContain('async def on_timer(id):');
    expect(pyRes.debugCode).toContain('await _poly.next_event()');

    ws.dispose();
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
        (d) => d.severity === 'error' && d.id.startsWith('timer-oob-9'),
      ),
    ).toBe(true);

    ws.dispose();
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
});
