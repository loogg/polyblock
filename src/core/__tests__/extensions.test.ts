import * as Blockly from 'blockly';
import { beforeAll, describe, expect, it } from 'vitest';
import { backendRegistry } from '../backends/registry';
import {
  CORE_TOOLBOX_ORDERS,
  getCoreCategoriesForCapabilities,
  getOrderedToolboxCategories,
} from '../blocks/catalog';
import { registerPolyBlocks } from '../blocks/definitions';
import {
  buildChannelDropdownOptions,
  setActiveChannelPoolConfig,
  setActiveChannelPoolConfigs,
  setActiveProjectCapabilities,
} from '../blocks/timerConfigBridge';
import {
  CAP_RT_LIFECYCLE,
  CAP_RT_TIMERS,
  CAP_VIRTUAL_BOARD,
  SAMPLE_CUSTOM_BOARD_TEMPLATE,
  targetProfileRegistry,
  validateTargetProfile,
} from '../capabilities/registry';
import {
  SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
  VIRTUAL_BOARD_PACK,
} from '../extensions/builtinPacks';
import {
  derivePackBadges,
  extensionRegistry,
  validateExtensionPack,
} from '../extensions/registry';
import {
  applySimDeviceEvent,
  buildDefaultSimState,
  buildPackResetPatch,
  qualifySimKey,
  readPackWidgetValue,
  resolveWidgetEventArgs,
} from '../extensions/simState';
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

  it('registers all 5 built-in packs by source, derives multi-attribute badges, and sorts toolbox categories by numeric toolboxOrder', () => {
    const all = extensionRegistry.listAll();
    expect(all.map((p) => p.id)).toEqual(
      expect.arrayContaining([
        'rt-lifecycle',
        'rt-timers',
        'virtual-board',
        'dict-json',
        'clock-timer',
      ]),
    );
    expect(extensionRegistry.listBySource('builtin')).toHaveLength(5);
    expect(CORE_TOOLBOX_ORDERS.map((c) => c.order)).toEqual([
      10, 20, 30, 40, 50, 60, 70, 80, 90,
    ]);

    // Multi-attribute badge derivation on mixed-capability packs
    const vbBadges = derivePackBadges(VIRTUAL_BOARD_PACK).map((b) => b.label);
    expect(vbBadges).toContain('外设模拟 · 6控件');
    expect(vbBadges).toContain('事件回调');

    // Numeric toolboxOrder slots rt-timers (#15) between 事件 (#10) and 打印 (#20),
    // and custom pack (#35) right between 控制 (#30) and 变量 (#40)!
    const midPack = extensionRegistry.validateProjectLocalPack({
      ...SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
      id: 'mid-order-pack',
      name: '中间序号测试包',
      categoryLabel: '中序',
      toolboxOrder: 35,
      tags: ['算法', '外设'],
      blocks: [
        {
          type: 'ext_mid_noop',
          kind: 'statement',
          message0: '空操作',
          lua: { template: '-- noop' },
          python: { template: 'pass' },
        },
      ],
    });
    expect(derivePackBadges(midPack).map((b) => b.label)).toEqual(
      expect.arrayContaining(['外设模拟 · 5控件', '算法', '外设']),
    );
    extensionRegistry.setActiveProjectLocalPacks([midPack]);
    const ordered = getOrderedToolboxCategories([
      CAP_RT_TIMERS,
      'mid-order-pack',
      CAP_VIRTUAL_BOARD,
    ]);
    const orderedIds = ordered.map((c) => c.id);
    expect(orderedIds.indexOf('event')).toBeLessThan(orderedIds.indexOf('timers'));
    expect(orderedIds.indexOf('timers')).toBeLessThan(orderedIds.indexOf('print'));
    expect(orderedIds.indexOf('control')).toBeLessThan(
      orderedIds.indexOf('ext_mid-order-pack'),
    );
    expect(orderedIds.indexOf('ext_mid-order-pack')).toBeLessThan(
      orderedIds.indexOf('variables'),
    );
    expect(orderedIds.indexOf('functions')).toBeLessThan(
      orderedIds.indexOf('ext_virtual-board'),
    );
    extensionRegistry.setActiveProjectLocalPacks([]);

    const cats = extensionRegistry.toCategorySpecs(['virtual-board', 'dict-json']);
    expect(cats).toHaveLength(2);
    expect(cats[0].label).toBe('硬件');
    expect(cats[0].order).toBe(100);
    expect(cats[0].blocks.length).toBeGreaterThanOrEqual(7);
    expect(cats[1].label).toBe('字典');
    expect(cats[1].order).toBe(110);

    const mocks = extensionRegistry.getSandboxMocks(['virtual-board', 'dict-json']);
    expect(mocks).toHaveLength(1);
    expect(mocks[0].moduleName).toBe('board');
    expect(mocks[0].packId).toBe('virtual-board');
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

  it('validates declarative simWidgets, isolates pack-scoped keys across colliding packs, and handles append/clear/reset', () => {
    expect(() =>
      validateExtensionPack({
        ...SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
        simWidgets: [{ kind: 'invalid_widget', key: 'x', label: 'bad' }],
      }),
    ).toThrow(/无效的模拟控件类型/);

    const validatedSample = validateExtensionPack(SAMPLE_CUSTOM_EXTENSION_TEMPLATE);
    expect(validatedSample.simWidgets).toHaveLength(5);

    const packs = [VIRTUAL_BOARD_PACK, validatedSample];
    let state = buildDefaultSimState(packs);
    expect(state['virtual-board::led']).toBe(false);
    expect(state['virtual-board::temp']).toBe(28);
    expect(state['my-robot-api::battery']).toBe(88);
    expect(state['my-robot-api::estop']).toBe(false);

    // Pack-scoped scalar set + broadcast patch
    const r1 = applySimDeviceEvent(state, 'my-robot-api::speed', 75, packs);
    state = r1.next;
    expect(state['my-robot-api::speed']).toBe(75);
    expect(r1.broadcastPatch).toEqual({ 'my-robot-api::speed': 75 });

    // Multi-line screen append respects maxLines=3
    state = applySimDeviceEvent(state, 'my-robot-api::log:clear', true, packs).next;
    expect(state['my-robot-api::log']).toEqual([]);
    state = applySimDeviceEvent(state, 'my-robot-api::log:append', 'L1', packs).next;
    state = applySimDeviceEvent(state, 'my-robot-api::log:append', 'L2', packs).next;
    state = applySimDeviceEvent(state, 'my-robot-api::log:append', 'L3', packs).next;
    state = applySimDeviceEvent(state, 'my-robot-api::log:append', 'L4', packs).next;
    expect(state['my-robot-api::log']).toEqual(['L2', 'L3', 'L4']);

    // Legacy oled_show / oled_clear aliases still route cleanly to `virtual-board::oled`
    state = applySimDeviceEvent(state, 'oled_clear', true, packs).next;
    state = applySimDeviceEvent(state, 'oled_show', 'Hello OLED', packs).next;
    expect(state['virtual-board::oled']).toEqual(['Hello OLED']);

    // Per-pack reset restores only that pack's widgets
    const resetRobot = buildPackResetPatch(validatedSample);
    expect(resetRobot['my-robot-api::speed']).toBe(0);
    expect(resetRobot['my-robot-api::battery']).toBe(88);
    expect(resetRobot).not.toHaveProperty('virtual-board::temp');

    // Explicit two-pack key collision isolation (`motor-a` & `motor-b` both use `key: 'speed'`, plus shared `global:vbus`)
    const motorA = validateExtensionPack({
      ...SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
      id: 'motor-a',
      name: '左轮电机包',
      blocks: [
        {
          type: 'ext_motor_a_set',
          kind: 'statement',
          message0: '左轮速度 %1',
          args0: [{ type: 'field_number', name: 'V', value: 30 }],
          lua: { template: 'motor_a.set({{V}})' },
          python: { template: 'motor_a.set({{V}})' },
        },
      ],
      simWidgets: [
        { kind: 'bar', key: 'speed', label: '当前转速', default: 30 },
        { kind: 'slider', key: 'global:vbus', label: '共享总线电压', default: 12 },
      ],
    });
    const motorB = validateExtensionPack({
      ...SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
      id: 'motor-b',
      name: '右轮电机包',
      blocks: [
        {
          type: 'ext_motor_b_set',
          kind: 'statement',
          message0: '右轮速度 %1',
          args0: [{ type: 'field_number', name: 'V', value: 80 }],
          lua: { template: 'motor_b.set({{V}})' },
          python: { template: 'motor_b.set({{V}})' },
        },
      ],
      simWidgets: [
        { kind: 'bar', key: 'speed', label: '当前转速', default: 80 },
        { kind: 'bar', key: 'global:vbus', label: '总线电压监测', default: 12 },
      ],
    });

    expect(qualifySimKey('motor-a', 'speed')).toBe('motor-a::speed');
    expect(qualifySimKey('motor-b', 'speed')).toBe('motor-b::speed');
    expect(qualifySimKey('motor-a', 'global:vbus')).toBe('global:vbus');

    let dualState = buildDefaultSimState([motorA, motorB]);
    expect(readPackWidgetValue(dualState, 'motor-a', motorA.simWidgets![0])).toBe(30);
    expect(readPackWidgetValue(dualState, 'motor-b', motorB.simWidgets![0])).toBe(80);
    expect(dualState['global:vbus']).toBe(12);

    // Updating motor-a::speed must NEVER touch motor-b::speed
    dualState = applySimDeviceEvent(dualState, 'motor-a::speed', 95, [motorA, motorB]).next;
    expect(readPackWidgetValue(dualState, 'motor-a', motorA.simWidgets![0])).toBe(95);
    expect(readPackWidgetValue(dualState, 'motor-b', motorB.simWidgets![0])).toBe(80);

    // Updating global:vbus shares across both packs intentionally
    dualState = applySimDeviceEvent(dualState, 'global:vbus', 24, [motorA, motorB]).next;
    expect(readPackWidgetValue(dualState, 'motor-a', motorA.simWidgets![1])).toBe(24);
    expect(readPackWidgetValue(dualState, 'motor-b', motorB.simWidgets![1])).toBe(24);
  });

  it('supports declarative kind:"hat" callbacks in custom .polyext.json packs with codegen, scope tree, duplicate diagnostics, and emitEvent arg resolution', () => {
    const imported = extensionRegistry.importCustomPack(SAMPLE_CUSTOM_EXTENSION_TEMPLATE);
    const estopWidget = imported.simWidgets!.find((w) => w.key === 'estop')!;
    expect(resolveWidgetEventArgs(imported.id, estopWidget, true, {})).toEqual([true]);

    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'ext_robot_on_estop',
              id: 'estop_press_1',
              fields: { STATE: 'press' },
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_print',
                    id: 'estop_p1',
                    inputs: {
                      VALUE: {
                        block: {
                          type: 'text',
                          id: 'estop_t1',
                          fields: { TEXT: 'E-STOP ENGAGED' },
                        },
                      },
                    },
                  },
                },
              },
            },
            {
              type: 'ext_robot_on_estop',
              id: 'estop_release',
              fields: { STATE: 'release' },
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_print',
                    id: 'estop_p2',
                    inputs: {
                      VALUE: {
                        block: {
                          type: 'text',
                          id: 'estop_t2',
                          fields: { TEXT: 'E-STOP CLEARED' },
                        },
                      },
                    },
                  },
                },
              },
            },
            {
              type: 'ext_robot_on_estop',
              id: 'estop_press_dup',
              fields: { STATE: 'press' },
            },
          ],
        },
      },
      ws,
    );

    const luaRes = backendRegistry.get('lua').generate(ws);
    expect(luaRes.isEventDriven).toBe(true);
    expect(luaRes.code).toContain('function on_robot_estop(active)');
    expect(luaRes.code).toContain('if active then');
    expect(luaRes.code).toContain('elseif not active then');
    expect(luaRes.code).toContain("print('E-STOP ENGAGED')");
    expect(luaRes.code).toContain("print('E-STOP CLEARED')");
    expect(luaRes.debugCode).toContain('_ev:sub(1, 6) == "event:"');
    expect(luaRes.debugCode).toContain('__poly_last_event_name()');
    // Must NOT be flagged as floating top-level blocks, and SHOULD warn on duplicate press branch
    expect(luaRes.diagnostics.some((d) => d.id.startsWith('floating-'))).toBe(false);
    expect(
      luaRes.diagnostics.some((d) =>
        d.id.startsWith('dup-hat-ext_robot_on_estop-press-'),
      ),
    ).toBe(true);
    expect(
      luaRes.variableScopes?.some((s) => s.label.includes('on_robot_estop')),
    ).toBe(true);

    const pyRes = backendRegistry.get('python').generate(ws);
    expect(pyRes.isEventDriven).toBe(true);
    expect(pyRes.code).toContain('def on_robot_estop(active):');
    expect(pyRes.code).toContain('if active:');
    expect(pyRes.code).toContain('elif not active:');
    expect(pyRes.debugCode).toContain('async def on_robot_estop(active):');
    expect(pyRes.debugCode).toContain("_ev.startswith('event:')");

    ws.dispose();
    extensionRegistry.removeCustomPack(imported.id);
  });

  it('flags static error diagnostics when workspace uses blocks from a disabled or removed extension pack', () => {
    const localPack = extensionRegistry.validateProjectLocalPack({
      ...SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
      id: 'diag-servo-pack',
      name: '诊断测试舵机包',
      blocks: [
        {
          type: 'ext_diag_servo_run',
          kind: 'statement',
          message0: '启动测试舵机 %1',
          args0: [{ type: 'field_number', name: 'POS', value: 45 }],
          lua: {
            imports: ['local servo = require("servo")'],
            template: 'servo.run({{POS}})',
          },
          python: {
            imports: ['import servo'],
            template: 'servo.run({{POS}})',
          },
        },
      ],
    });
    extensionRegistry.setActiveProjectLocalPacks([localPack]);

    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_start',
              id: 'diag_start',
              inputs: {
                BODY: {
                  block: {
                    type: 'ext_diag_servo_run',
                    id: 'diag_blk_1',
                    fields: { POS: 90 },
                  },
                },
              },
            },
          ],
        },
      },
      ws,
    );

    // Enabled -> 0 errors
    setActiveProjectCapabilities(['diag-servo-pack']);
    expect(backendRegistry.get('lua').generate(ws).diagnostics).toHaveLength(0);

    // Disabled -> error pointing to diag-servo-pack
    setActiveProjectCapabilities([]);
    const resDisabled = backendRegistry.get('lua').generate(ws);
    expect(
      resDisabled.diagnostics.some(
        (d) =>
          d.severity === 'error' &&
          d.id.startsWith('cap-missing-ext-diag-servo-pack') &&
          d.message.includes('诊断测试舵机包'),
      ),
    ).toBe(true);

    // Pack removed completely -> error flagging removed/uninstalled ext_* block
    extensionRegistry.setActiveProjectLocalPacks([]);
    const resRemoved = backendRegistry.get('lua').generate(ws);
    expect(
      resRemoved.diagnostics.some(
        (d) => d.severity === 'error' && d.id.startsWith('cap-missing-ext-unknown'),
      ),
    ).toBe(true);

    ws.dispose();
    setActiveProjectCapabilities(null);
  });

  it('strictly isolates multiple handleChannelPool packs by configKey across dropdowns, codegen comments, and OOB diagnostics', () => {
    const pwmPack = extensionRegistry.validateProjectLocalPack({
      format: 'polyblock-extension',
      version: 1,
      id: 'pwm-driver',
      name: 'PWM 驱动通道包',
      packVersion: '1.0.0',
      categoryLabel: 'PWM',
      color: '#14b8a6',
      toolboxOrder: 105,
      description: '每句柄独立 4 路 PWM 通道池。',
      handleChannelPool: {
        configKey: 'pwm-driver',
        label: 'PWM 通道',
        prefix: 'PWM',
        min: 1,
        max: 8,
        defaultCount: 4,
        presets: [2, 4, 8],
        fieldName: 'PWM_ID',
      },
      blocks: [
        {
          type: 'ext_pwm_duty',
          kind: 'statement',
          message0: '设置 PWM %1 占空比 %2 %%',
          args0: [
            { type: 'field_channel_id', name: 'PWM_ID' },
            { type: 'field_number', name: 'DUTY', value: 50 },
          ],
          lua: {
            imports: ['local pwm = require("pwm")'],
            template: 'pwm.duty({{PWM_ID:int}}, {{DUTY}}){{PWM_ID:channel_comment_lua}}',
          },
          python: {
            imports: ['import pwm'],
            template: 'pwm.duty({{PWM_ID:int}}, {{DUTY}}){{PWM_ID:channel_comment_py}}',
          },
        },
      ],
    });
    extensionRegistry.setActiveProjectLocalPacks([pwmPack]);

    // Configure TWO completely separate channel pools on the same active handle
    setActiveChannelPoolConfigs({
      'rt-timers': { count: 8, aliases: { '0': '心跳灯' } },
      'pwm-driver': { count: 4, aliases: { '0': '左轮油门' } },
    });

    const timerOpts = buildChannelDropdownOptions('rt-timers', 'T', '0', 8, 32, false);
    const pwmOpts = buildChannelDropdownOptions('pwm-driver', 'PWM', '0', 4, 8, false);
    expect(timerOpts).toHaveLength(8);
    expect(timerOpts[0]).toEqual(['T0 · 心跳灯', '0']);
    expect(pwmOpts).toHaveLength(4);
    expect(pwmOpts[0]).toEqual(['PWM0 · 左轮油门', '0']);

    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_start',
              id: 'pwm_s',
              inputs: {
                BODY: {
                  block: {
                    type: 'ext_pwm_duty',
                    id: 'pwm_ok',
                    fields: { PWM_ID: '0', DUTY: 60 },
                    next: {
                      block: {
                        type: 'ext_pwm_duty',
                        id: 'pwm_oob',
                        fields: { PWM_ID: '5', DUTY: 20 },
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

    setActiveProjectCapabilities([CAP_RT_TIMERS, 'pwm-driver']);
    const luaRes = backendRegistry.get('lua').generate(ws);
    // Uses pwm-driver's own alias (`PWM0: 左轮油门`), NOT rt-timers's `T0: 心跳灯`!
    expect(luaRes.code).toContain('pwm.duty(0, 60) -- PWM0: 左轮油门');
    expect(luaRes.code).not.toContain('心跳灯');
    // PWM5 exceeds pwm-driver count=4 even though rt-timers has count=8!
    expect(
      luaRes.diagnostics.some(
        (d) => d.severity === 'error' && d.id.startsWith('pool-pwm-driver-oob-5-'),
      ),
    ).toBe(true);

    // Updating pwm-driver count to 6 clears OOB without affecting rt-timers
    setActiveChannelPoolConfig('pwm-driver', { count: 6, aliases: { '0': '左轮油门' } }, 4, 1, 8);
    expect(backendRegistry.get('lua').generate(ws).diagnostics).toHaveLength(0);

    ws.dispose();
    setActiveProjectCapabilities(null);
    setActiveChannelPoolConfigs({ 'rt-timers': { count: 8, aliases: {} } });
    extensionRegistry.setActiveProjectLocalPacks([]);
  });
});
