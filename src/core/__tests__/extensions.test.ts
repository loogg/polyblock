import * as Blockly from 'blockly';
import { beforeAll, describe, expect, it } from 'vitest';
import { backendRegistry } from '../backends/registry';
import { registerPolyBlocks } from '../blocks/definitions';
import { SAMPLE_CUSTOM_EXTENSION_TEMPLATE } from '../extensions/builtinPacks';
import { extensionRegistry, validateExtensionPack } from '../extensions/registry';
import { instantiateProjectFromTemplate } from '../projects/store';

describe('Declarative Extension Pack System', () => {
  beforeAll(() => {
    registerPolyBlocks();
    extensionRegistry.ensureInitialized();
  });

  it('registers all 3 built-in packs and converts enabled packs to toolbox categories', () => {
    const all = extensionRegistry.listAll();
    expect(all.map((p) => p.id)).toEqual(
      expect.arrayContaining(['virtual-board', 'dict-json', 'clock-timer']),
    );

    const cats = extensionRegistry.toCategorySpecs(['virtual-board', 'dict-json']);
    expect(cats).toHaveLength(2);
    expect(cats[0].label).toBe('硬件');
    expect(cats[0].blocks.length).toBeGreaterThanOrEqual(6);
    expect(cats[1].label).toBe('字典');

    const mocks = extensionRegistry.getSandboxMocks(['virtual-board', 'dict-json']);
    expect(mocks).toHaveLength(1);
    expect(mocks[0].moduleName).toBe('board');
  });

  it('generates clean deduplicated Lua & Python board code for virtual_board_demo project', () => {
    const proj = instantiateProjectFromTemplate('virtual_board_demo');
    expect(proj.enabledExtensions).toContain('virtual-board');
    expect(proj.handles[0].scripts.map((s) => s.name)).toEqual([
      'led_blink',
      'temp_guard',
    ]);

    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(proj.handles[0].scripts[1].workspace, ws);

    const luaRes = backendRegistry.get('lua').generate(ws);
    expect(luaRes.code).toContain('local board = require("board")');
    // Import must be hoisted once even though multiple board blocks are used
    expect(luaRes.code.match(/require\("board"\)/g)?.length).toBe(1);
    expect(luaRes.code).toContain('board.read_temp()');
    expect(luaRes.code).toContain('board.rgb("#ef4444")');
    expect(luaRes.code).toContain('board.led(true)');
    expect(luaRes.code).not.toContain('__poly_step');

    const pyRes = backendRegistry.get('python').generate(ws);
    expect(pyRes.code).toContain('import board');
    expect(pyRes.code.match(/^import board$/gm)?.length).toBe(1);
    expect(pyRes.code).toContain('board.read_temp()');
    expect(pyRes.code).toContain('board.rgb("#ef4444")');
    expect(pyRes.code).toContain('board.led(True)');
    expect(pyRes.code).not.toContain('_poly.step');

    ws.dispose();
  });

  it('imports custom .polyext.json pack, generates Lua & Python, and removes cleanly', () => {
    expect(() => validateExtensionPack({})).toThrow();
    expect(() =>
      extensionRegistry.importCustomPack({
        ...SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
        id: 'virtual-board',
      }),
    ).toThrow(/冲突/);

    const imported = extensionRegistry.importCustomPack(
      SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
    );
    expect(imported.id).toBe('my-robot-api');
    expect(imported.builtin).toBe(false);

    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_start',
              id: 'r_start',
              inputs: {
                BODY: {
                  block: {
                    type: 'ext_robot_move',
                    id: 'r_move',
                    fields: { DIR: 'forward' },
                    inputs: {
                      SPEED: {
                        block: {
                          type: 'math_number',
                          id: 'r_spd',
                          fields: { NUM: 75 },
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

    const luaRes = backendRegistry.get('lua').generate(ws);
    expect(luaRes.code).toContain('local robot = require("robot")');
    expect(luaRes.code).toContain('robot.move("forward", 75)');

    const pyRes = backendRegistry.get('python').generate(ws);
    expect(pyRes.code).toContain('import robot');
    expect(pyRes.code).toContain('robot.move("forward", 75)');

    ws.dispose();

    expect(extensionRegistry.removeCustomPack('my-robot-api')).toBe(true);
    expect(extensionRegistry.get('my-robot-api')).toBeUndefined();
  });
});
