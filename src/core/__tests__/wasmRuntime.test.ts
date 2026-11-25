// @vitest-environment node
import * as Blockly from 'blockly';
import { beforeAll, describe, expect, it } from 'vitest';
import { LuaFactory } from 'wasmoon';
import { loadMicroPython } from '@micropython/micropython-webassembly-pyscript';
import { backendRegistry } from '../backends/registry';
import { registerPolyBlocks } from '../blocks/definitions';
import { VIRTUAL_BOARD_PACK } from '../extensions/builtinPacks';
import { extensionRegistry } from '../extensions/registry';
import {
  getHandleTimerConfig,
  instantiateProjectFromTemplate,
} from '../projects/store';
import { setActiveTimerConfig } from '../blocks/timerConfigBridge';
import { WorkerDebugSession } from '../../workers/debugSession';
import { WorkerRuntimeScheduler } from '../../workers/runtimeScheduler';

describe('Real WASM Runtime Integration (Lua 5.4 & MicroPython + Virtual Board Mocks)', () => {
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

    // 1. Real Wasmoon Lua 5.4 at 48°C -> triggers >35°C red RGB alarm
    const luaEvents: Array<{ kind: string; value: unknown }> = [];
    const luaLogs: string[] = [];
    const factory = new LuaFactory();
    const lua = await factory.createEngine({ openStandardLibs: true });
    try {
      lua.global.set('__poly_device_emit', (kind: string, value: unknown) => {
        luaEvents.push({ kind: String(kind), value });
      });
      lua.global.set('__poly_mock_input', (key: string) =>
        key === 'temp' ? 48 : false,
      );
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
      kind: 'oled_show',
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
    mp.registerJsModule('_poly', {
      emit_device: (kind: string, value: unknown) =>
        pyEvents.push({ kind: String(kind), value }),
      get_input: (key: string) => (key === 'temp' ? mockTemp : false),
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
      kind: 'oled_show',
      value: 'TEMP NORMAL (OK)',
    });

    pyEvents.length = 0;
    mockTemp = 48;
    await mp.runPythonAsync(pyCode);
    expect(pyEvents).toContainEqual({ kind: 'led', value: true });
    expect(pyEvents).toContainEqual({ kind: 'rgb', value: '#ef4444' });
    expect(pyEvents).toContainEqual({
      kind: 'oled_show',
      value: 'ALARM: TEMP > 35C!',
    });
  });

  it('executes event-driven 3-shot timer (on_start -> on_timer(0) x3 -> on_stop) in BOTH Wasmoon Lua 5.4 and MicroPython WASM', async () => {
    const proj = instantiateProjectFromTemplate('event_timer_demo');
    const hdl = proj.handles[0];
    setActiveTimerConfig(getHandleTimerConfig(hdl));
    const ws = new Blockly.Workspace();
    // scripts[1] is timer_oneshot (120ms x3 triggers -> auto exit -> on_stop)
    Blockly.serialization.workspaces.load(hdl.scripts[1].workspace, ws);

    const luaDebug = backendRegistry.get('lua').generate(ws).debugCode;
    const pyDebug = backendRegistry.get('python').generate(ws).debugCode;
    ws.dispose();
    setActiveTimerConfig({ count: 8, aliases: {} });

    // 1. Wasmoon Lua 5.4 cooperative event loop
    const luaLogs: string[] = [];
    const luaFactory = new LuaFactory();
    const lua = await luaFactory.createEngine({ openStandardLibs: true });
    const luaSession = new WorkerDebugSession(
      { runId: 't-lua', breakpoints: [], stepDelayMs: 0 },
      () => {},
    );
    const luaSched = new WorkerRuntimeScheduler({
      runId: 't-lua',
      timerCount: 8,
      post: () => {},
    });
    try {
      lua.global.set('__poly_print', (...args: unknown[]) =>
        luaLogs.push(args.map(String).join(' ')),
      );
      lua.global.set('__poly_step', (bid: string, vars: string) =>
        luaSession.onStep(String(bid), vars),
      );
      lua.global.set('__poly_sleep', (ms: number) => luaSession.onSleep(ms));
      lua.global.set('__poly_final_snap', (vars: string) =>
        luaSession.setFinalVars(vars),
      );
      lua.global.set('__poly_rt_set_run_period', (ms: unknown) =>
        luaSched.setRunPeriod(ms),
      );
      lua.global.set('__poly_rt_start_run', () => luaSched.startRun());
      lua.global.set('__poly_rt_stop_run', () => luaSched.stopRun());
      lua.global.set('__poly_rt_start_timer', (id: unknown, ms: unknown, rep: unknown) =>
        luaSched.startTimer(id, ms, rep ?? 0),
      );
      lua.global.set('__poly_rt_stop_timer', (id: unknown) =>
        luaSched.stopTimer(id),
      );
      lua.global.set('__poly_rt_get_timer_value', (id: unknown) =>
        luaSched.getTimerValue(id),
      );
      lua.global.set('__poly_rt_is_timer_running', (id: unknown) =>
        luaSched.isTimerRunning(id),
      );
      lua.global.set('__poly_should_loop', (r: unknown, t: unknown, b: unknown) =>
        luaSched.shouldEnterEventLoop(Boolean(r), Boolean(t), Boolean(b)),
      );
      lua.global.set('__poly_next_event', () => luaSched.nextEvent());

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
      `);
      await lua.doString(luaDebug);
    } finally {
      lua.global.close();
    }

    expect(luaLogs.some((l) => l.includes('T0 运行中 = true'))).toBe(true);
    expect(luaLogs.some((l) => l.includes('T0 触发次数 = 1'))).toBe(true);
    expect(luaLogs.some((l) => l.includes('T0 触发次数 = 2'))).toBe(true);
    expect(luaLogs.some((l) => l.includes('T0 触发次数 = 3'))).toBe(true);
    expect(luaLogs.some((l) => l.includes('3 次定时任务全部完成'))).toBe(true);

    // 2. MicroPython WASM cooperative event loop
    const pyLogs: string[] = [];
    const pySession = new WorkerDebugSession(
      { runId: 't-py', breakpoints: [], stepDelayMs: 0 },
      () => {},
    );
    const pySched = new WorkerRuntimeScheduler({
      runId: 't-py',
      timerCount: 8,
      post: () => {},
    });
    const mp = await loadMicroPython({
      stdout: (line) => pyLogs.push(line),
    });
    mp.registerJsModule('_poly', {
      step: (bid: string, vars: string) => pySession.onStep(String(bid), vars),
      sleep: (ms: number) => pySession.onSleep(ms),
      final_snap: (vars: string) => pySession.setFinalVars(vars),
      rt_set_run_period: (ms: unknown) => pySched.setRunPeriod(ms),
      rt_start_run: () => pySched.startRun(),
      rt_stop_run: () => pySched.stopRun(),
      rt_start_timer: (id: unknown, ms: unknown, rep: unknown) =>
        pySched.startTimer(id, ms, rep ?? 0),
      rt_stop_timer: (id: unknown) => pySched.stopTimer(id),
      rt_get_timer_value: (id: unknown) => pySched.getTimerValue(id),
      rt_is_timer_running: (id: unknown) => pySched.isTimerRunning(id),
      should_loop: (r: unknown, t: unknown, b: unknown) =>
        pySched.shouldEnterEventLoop(Boolean(r), Boolean(t), Boolean(b)),
      next_event: () => pySched.nextEvent(),
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
    await mp.runPythonAsync(pyDebug);

    expect(pyLogs.some((l) => l.includes('T0 运行中 = True'))).toBe(true);
    expect(pyLogs.some((l) => l.includes('T0 触发次数 = 1'))).toBe(true);
    expect(pyLogs.some((l) => l.includes('T0 触发次数 = 2'))).toBe(true);
    expect(pyLogs.some((l) => l.includes('T0 触发次数 = 3'))).toBe(true);
    expect(pyLogs.some((l) => l.includes('3 次定时任务全部完成'))).toBe(true);
  });
});
