// @vitest-environment node
import * as Blockly from 'blockly';
import { beforeAll, describe, expect, it } from 'vitest';
import { LuaFactory } from 'wasmoon';
import { loadMicroPython } from '@micropython/micropython-webassembly-pyscript';
import { backendRegistry } from '../backends/registry';
import { registerPolyBlocks } from '../blocks/definitions';
import { VIRTUAL_BOARD_PACK } from '../extensions/builtinPacks';
import { extensionRegistry } from '../extensions/registry';
import { instantiateProjectFromTemplate } from '../projects/store';

describe('Real WASM Runtime Integration (Lua 5.4 & MicroPython + Virtual Board Mocks)', () => {
  beforeAll(() => {
    registerPolyBlocks();
    extensionRegistry.ensureInitialized();
  });

  it('executes temp_guard in real Wasmoon Lua 5.4 & MicroPython WASM with live mock temperature inputs', async () => {
    const proj = instantiateProjectFromTemplate('virtual_board_demo');
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(proj.scripts[1].workspace, ws);

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
});
