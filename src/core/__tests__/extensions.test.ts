import * as Blockly from 'blockly';
import { beforeAll, describe, expect, it } from 'vitest';
import { backendRegistry } from '../backends/registry';
import { getCoreCategoriesForCapabilities } from '../blocks/catalog';
import { registerPolyBlocks } from '../blocks/definitions';
import {
  CAP_RT_LIFECYCLE,
  CAP_RT_TIMERS,
  CAP_VIRTUAL_BOARD,
  SAMPLE_CUSTOM_BOARD_TEMPLATE,
  targetProfileRegistry,
  validateTargetProfile,
} from '../capabilities/registry';
import { SAMPLE_CUSTOM_EXTENSION_TEMPLATE } from '../extensions/builtinPacks';
import { extensionRegistry, validateExtensionPack } from '../extensions/registry';
import {
  buildExportableProjectJson,
  instantiateProjectFromTemplate,
  parseImportedProject,
} from '../projects/store';

describe('Declarative Extension Pack & Capability-Driven Target Profile System', () => {
  beforeAll(() => {
    registerPolyBlocks();
    extensionRegistry.ensureInitialized();
    targetProfileRegistry.ensureInitialized();
  });

  it('strictly gates core toolbox categories & hardware button hats by enabledCapabilities', () => {
    const pureCats = getCoreCategoriesForCapabilities([]);
    expect(pureCats.some((c) => c.id === 'timers')).toBe(false);
    const pureEventBlocks =
      pureCats.find((c) => c.id === 'event')?.blocks.map((b) => b.type) ?? [];
    expect(pureEventBlocks).toEqual(['poly_on_start', 'poly_comment']);

    const rtCats = getCoreCategoriesForCapabilities([
      CAP_RT_LIFECYCLE,
      CAP_RT_TIMERS,
    ]);
    expect(rtCats.some((c) => c.id === 'timers')).toBe(true);
    const rtEventBlocks =
      rtCats.find((c) => c.id === 'event')?.blocks.map((b) => b.type) ?? [];
    expect(rtEventBlocks).toContain('poly_on_run');
    expect(rtEventBlocks).toContain('poly_on_stop');
    expect(rtEventBlocks).not.toContain('poly_on_button');

    const vbCats = extensionRegistry.toCategorySpecs([CAP_VIRTUAL_BOARD]);
    expect(vbCats[0].blocks.some((b) => b.type === 'poly_on_button')).toBe(true);
  });

  it('validates, imports, and removes custom .polyboard.json target profiles', () => {
    expect(() => validateTargetProfile({})).toThrow();
    expect(() =>
      targetProfileRegistry.importCustomProfile({
        ...SAMPLE_CUSTOM_BOARD_TEMPLATE,
        id: 'generic-script',
      }),
    ).toThrow(/冲突/);

    const imported = targetProfileRegistry.importCustomProfile(
      SAMPLE_CUSTOM_BOARD_TEMPLATE,
    );
    expect(imported.id).toBe('my-industrial-controller');
    expect(imported.builtin).toBe(false);
    expect(targetProfileRegistry.get(imported.id).defaultTimerCount).toBe(16);
    expect(targetProfileRegistry.removeCustomProfile(imported.id)).toBe(true);
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
    expect(proj.enabledCapabilities).toContain('virtual-board');
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

  it('isolates project-local packs from global library, overrides same-ID global packs, and auto-bundles on export', () => {
    // 1. Register a global custom pack v2.0.0
    const globalV2 = extensionRegistry.importCustomPack({
      ...SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
      packVersion: '2.0.0',
      blocks: [
        {
          ...SAMPLE_CUSTOM_EXTENSION_TEMPLATE.blocks[0],
          lua: {
            imports: ['local robot = require("robot_v2")'],
            template: 'robot.move_v2({{DIR:json}}, {{SPEED}})',
          },
        },
      ],
    });
    expect(extensionRegistry.listAll().some((p) => p.id === globalV2.id)).toBe(true);

    // 2. Create a project-local pack with SAME ID (v1.0.0) + a pure local-only pack
    const localV1 = extensionRegistry.validateProjectLocalPack({
      ...SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
      packVersion: '1.0.0',
      blocks: [
        {
          ...SAMPLE_CUSTOM_EXTENSION_TEMPLATE.blocks[0],
          lua: {
            imports: ['local robot = require("robot_v1")'],
            template: 'robot.move_v1({{DIR:json}}, {{SPEED}})',
          },
        },
      ],
    });
    const privatePack = extensionRegistry.validateProjectLocalPack({
      ...SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
      id: 'proj-only-servo',
      name: '项目专属舵机包',
      categoryLabel: '舵机',
      blocks: [
        {
          type: 'ext_servo_angle',
          kind: 'statement',
          message0: '设置舵机角度 %1',
          args0: [{ type: 'field_number', name: 'DEG', value: 90 }],
          lua: {
            imports: ['local servo = require("servo")'],
            template: 'servo.angle({{DEG}})',
          },
          python: {
            imports: ['import servo'],
            template: 'servo.angle({{DEG}})',
          },
        },
      ],
    });

    // Project-local pack must NOT pollute global listAll()
    extensionRegistry.setActiveProjectLocalPacks([localV1, privatePack]);
    expect(extensionRegistry.listAll().some((p) => p.id === 'proj-only-servo')).toBe(
      false,
    );
    expect(
      extensionRegistry
        .toCategorySpecs(['my-robot-api', 'proj-only-servo'], [localV1, privatePack])
        .map((c) => c.label),
    ).toEqual(['机器人', '舵机']);

    // Local v1 must override global v2 in codegen when active
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_start',
              id: 's_ovr',
              inputs: {
                BODY: {
                  block: {
                    type: 'ext_robot_move',
                    id: 'm_ovr',
                    fields: { DIR: 'forward' },
                    inputs: {
                      SPEED: {
                        block: {
                          type: 'math_number',
                          id: 'sp_ovr',
                          fields: { NUM: 50 },
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
    expect(backendRegistry.get('lua').generate(ws).code).toContain(
      'robot.move_v1("forward", 50)',
    );

    // Switching to another project with NO local packs must restore global v2 cleanly
    extensionRegistry.setActiveProjectLocalPacks([]);
    expect(backendRegistry.get('lua').generate(ws).code).toContain(
      'robot.move_v2("forward", 50)',
    );
    ws.dispose();

    // 3. Exporting a project using a global custom pack auto-attaches bundledExtensions
    const projUsingGlobal = {
      ...instantiateProjectFromTemplate('blank_project'),
      enabledCapabilities: [globalV2.id],
      localExtensions: [],
    };
    const exported = buildExportableProjectJson(
      projUsingGlobal,
      extensionRegistry.listAll(),
    );
    expect(exported.bundledExtensions).toHaveLength(1);
    expect(exported.bundledExtensions![0].id).toBe(globalV2.id);

    // 3a. Recipient with NO global pack -> unconditionally absorbed into localExtensions
    const importedClean = parseImportedProject(exported, 'fallback', []);
    expect(importedClean.localExtensions?.map((p) => p.id)).toEqual([globalV2.id]);
    expect(importedClean.localExtensions?.map((p) => p.packVersion)).toEqual(['2.0.0']);

    // 3b. Even when recipient already has a global pack with the EXACT same ID & version
    //     (which may have different block definitions!), bundled pack is still unconditionally
    //     absorbed as project-local override so imported project always behaves identically.
    expect(extensionRegistry.get(globalV2.id)?.packVersion).toBe('2.0.0');
    const importedWithExistingGlobal = parseImportedProject(exported, 'fallback', []);
    expect(importedWithExistingGlobal.localExtensions?.map((p) => p.id)).toEqual([
      globalV2.id,
    ]);

    // 4. Project-local pack always remains local (and does not duplicate into bundledExtensions)
    const projWithLocal = {
      ...instantiateProjectFromTemplate('blank_project'),
      enabledCapabilities: [localV1.id],
      localExtensions: [localV1],
    };
    const exportedLocal = buildExportableProjectJson(
      projWithLocal,
      extensionRegistry.listAll(),
    );
    expect(exportedLocal.bundledExtensions).toBeUndefined();
    const importedLocal = parseImportedProject(exportedLocal, 'fallback', []);
    expect(importedLocal.localExtensions?.map((p) => p.packVersion)).toEqual(['1.0.0']);

    extensionRegistry.removeCustomPack(globalV2.id);
    extensionRegistry.setActiveProjectLocalPacks([]);
  });
});
