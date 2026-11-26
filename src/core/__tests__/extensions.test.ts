import * as Blockly from 'blockly';
import { beforeAll, describe, expect, it } from 'vitest';
import { inspectWorkspaceScriptMeta } from '../backends/eventMode';
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
  setActiveHandleScripts,
  setActiveProjectCapabilities,
} from '../blocks/timerConfigBridge';
import {
  CAP_RT,
  CAP_RT_LIFECYCLE,
  CAP_RT_TICK,
  CAP_RT_TIMERS,
  CAP_VIRTUAL_BOARD,
  SAMPLE_CUSTOM_BOARD_TEMPLATE,
  targetProfileRegistry,
  validateTargetProfile,
} from '../capabilities/registry';
import {
  RT_PACK,
  SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
  VIRTUAL_BOARD_PACK,
} from '../extensions/builtinPacks';
import {
  derivePackBadges,
  extensionRegistry,
  getAllPackBlocks,
  getPackEnableState,
  OPEN_HANDLE_CHANNEL_CONFIG_CALLBACK,
  resolvePackSections,
  togglePackOrSectionCapability,
  validateExtensionPack,
} from '../extensions/registry';
import {
  applySimDeviceEvent,
  buildDefaultSimState,
  buildPackResetPatch,
  qualifySimKey,
  readPackWidgetValue,
  resolveTricolorState,
  resolveWidgetEventArgs,
} from '../extensions/simState';
import {
  buildExportableProjectJson,
  DEMO_PROJECT_TEMPLATES,
  getAllHandleChannelPoolConfigs,
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
    expect(pureCats.some((c) => c.id === 'ext_rt_timers')).toBe(false);
    expect(pureCats.some((c) => c.id === 'ext_rt_tick')).toBe(false);
    const pureEventBlocks =
      pureCats.find((c) => c.id === 'event')?.blocks.map((b) => b.type) ?? [];
    expect(pureEventBlocks).toEqual([
      'poly_on_start',
      'poly_require_script',
      'poly_comment',
    ]);

    const rtCats = getCoreCategoriesForCapabilities([CAP_RT]);
    const timersCat = rtCats.find((c) => c.id === 'ext_rt_timers');
    expect(timersCat).toBeDefined();
    // Auto-derived flyout button directly from `handleConfigs[kind='channel-pool']`
    expect(timersCat?.flyoutButton).toEqual({
      text: '⚙ 配置本句柄定时器通道',
      callbackKey: OPEN_HANDLE_CHANNEL_CONFIG_CALLBACK,
    });
    expect(rtCats.some((c) => c.id === 'ext_rt_tick')).toBe(true);
    const rtEventBlocks =
      rtCats.find((c) => c.id === 'event')?.blocks.map((b) => b.type) ?? [];
    expect(rtEventBlocks).toContain('poly_on_start');
    expect(rtEventBlocks).toContain('poly_require_script');
    expect(rtEventBlocks).toContain('poly_comment');
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

  it('registers all 4 built-in packs (with multi-section rt), derives badges, and sorts toolbox categories by numeric toolboxOrder', () => {
    const all = extensionRegistry.listAll();
    expect(all.map((p) => p.id)).toEqual(
      expect.arrayContaining([
        'rt',
        'virtual-board',
        'dict-json',
        'clock-timer',
      ]),
    );
    expect(extensionRegistry.listBySource('builtin')).toHaveLength(4);
    expect(resolvePackSections(RT_PACK).map((s) => s.capId)).toEqual([
      CAP_RT_LIFECYCLE,
      CAP_RT_TIMERS,
      CAP_RT_TICK,
    ]);
    expect(CORE_TOOLBOX_ORDERS.map((c) => c.order)).toEqual([
      10, 20, 30, 40, 50, 60, 70, 80, 90,
    ]);

    const rtBadges = derivePackBadges(RT_PACK).map((b) => b.label);
    expect(rtBadges).toContain('3 组件');
    expect(rtBadges).toContain('事件回调');
    expect(rtBadges).toContain('通道池 T0~31');

    const vbBadges = derivePackBadges(VIRTUAL_BOARD_PACK).map((b) => b.label);
    expect(vbBadges).toContain('外设模拟 · 6控件');
    expect(vbBadges).toContain('事件回调');

    const midPack = extensionRegistry.validateProjectLocalPack({
      ...SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
      id: 'mid-order-pack',
      name: '中间序号测试包',
      iconLabel: '中序',
      tags: ['算法', '外设'],
      sections: [
        {
          id: 'main',
          label: '中序',
          toolboxOrder: 35,
          blocks: [
            {
              type: 'ext_mid_noop',
              kind: 'statement',
              message0: '空操作',
              lua: { template: '-- noop', imports: [] },
              python: { template: 'pass', imports: [] },
            },
          ],
        },
      ],
    });
    expect(derivePackBadges(midPack).map((b) => b.label)).toEqual(
      expect.arrayContaining(['外设模拟 · 5控件', '算法', '外设']),
    );
    extensionRegistry.setActiveProjectLocalPacks([midPack]);
    const ordered = getOrderedToolboxCategories([
      CAP_RT,
      'mid-order-pack',
      CAP_VIRTUAL_BOARD,
    ]);
    const orderedIds = ordered.map((c) => c.id);
    expect(orderedIds.indexOf('event')).toBeLessThan(
      orderedIds.indexOf('ext_rt_timers'),
    );
    expect(orderedIds.indexOf('ext_rt_timers')).toBeLessThan(
      orderedIds.indexOf('ext_rt_tick'),
    );
    expect(orderedIds.indexOf('ext_rt_tick')).toBeLessThan(
      orderedIds.indexOf('print'),
    );
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
    expect(proj.handles.map((h) => h.name)).toEqual([
      'board_vm',
      'temp_guard_vm',
      'dict_config_vm',
    ]);

    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(proj.handles[1].scripts[0].workspace, ws);

    const luaRes = backendRegistry.get('lua').generate(ws);
    expect(luaRes.code).toContain('local board = require("board")');
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

  it('imports custom .polyext.json pack, generates Lua & Python with pack-level default imports, and removes cleanly', () => {
    expect(() => validateExtensionPack({})).toThrow();
    expect(() =>
      extensionRegistry.importCustomPack({
        ...SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
        id: 'virtual-board',
      }),
    ).toThrow(/不允许覆盖预装包/);

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
    const baseSec = SAMPLE_CUSTOM_EXTENSION_TEMPLATE.sections[0];
    const globalV2 = extensionRegistry.importCustomPack({
      ...SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
      packVersion: '2.0.0',
      imports: {
        lua: ['local robot = require("robot_v2")'],
        python: ['import robot'],
      },
      sections: [
        {
          ...baseSec,
          blocks: [
            {
              ...baseSec.blocks[0],
              lua: { template: 'robot.move_v2({{DIR:json}}, {{SPEED}})' },
            },
          ],
        },
      ],
    });
    expect(extensionRegistry.listAll().some((p) => p.id === globalV2.id)).toBe(true);

    const localV1 = extensionRegistry.validateProjectLocalPack({
      ...SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
      packVersion: '1.0.0',
      imports: {
        lua: ['local robot = require("robot_v1")'],
        python: ['import robot'],
      },
      sections: [
        {
          ...baseSec,
          blocks: [
            {
              ...baseSec.blocks[0],
              lua: { template: 'robot.move_v1({{DIR:json}}, {{SPEED}})' },
            },
          ],
        },
      ],
    });
    const privatePack = extensionRegistry.validateProjectLocalPack({
      format: 'polyblock-extension',
      version: 1,
      id: 'proj-only-servo',
      name: '项目专属舵机包',
      packVersion: '1.0.0',
      iconLabel: '舵机',
      color: '#14b8a6',
      description: '项目内嵌舵机包',
      imports: {
        lua: ['local servo = require("servo")'],
        python: ['import servo'],
      },
      sections: [
        {
          id: 'main',
          label: '舵机',
          blocks: [
            {
              type: 'ext_servo_angle',
              kind: 'statement',
              message0: '设置舵机角度 %1',
              args0: [{ type: 'field_number', name: 'DEG', value: 90 }],
              lua: { template: 'servo.angle({{DEG}})' },
              python: { template: 'servo.angle({{DEG}})' },
            },
          ],
        },
      ],
    });

    extensionRegistry.setActiveProjectLocalPacks([localV1, privatePack]);
    expect(extensionRegistry.listAll().some((p) => p.id === 'proj-only-servo')).toBe(
      false,
    );
    expect(
      extensionRegistry
        .toCategorySpecs(['my-robot-api', 'proj-only-servo'], [localV1, privatePack])
        .map((c) => c.label),
    ).toEqual(['机器人', '舵机']);

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

    extensionRegistry.setActiveProjectLocalPacks([]);
    expect(backendRegistry.get('lua').generate(ws).code).toContain(
      'robot.move_v2("forward", 50)',
    );
    ws.dispose();

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

    const importedClean = parseImportedProject(exported, 'fallback', []);
    expect(importedClean.localExtensions?.map((p) => p.id)).toEqual([globalV2.id]);
    expect(importedClean.localExtensions?.map((p) => p.packVersion)).toEqual(['2.0.0']);

    expect(extensionRegistry.get(globalV2.id)?.packVersion).toBe('2.0.0');
    const importedWithExistingGlobal = parseImportedProject(exported, 'fallback', []);
    expect(importedWithExistingGlobal.localExtensions?.map((p) => p.id)).toEqual([
      globalV2.id,
    ]);

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

    const r1 = applySimDeviceEvent(state, 'my-robot-api::speed', 75, packs);
    state = r1.next;
    expect(state['my-robot-api::speed']).toBe(75);
    expect(r1.broadcastPatch).toEqual({ 'my-robot-api::speed': 75 });

    state = applySimDeviceEvent(state, 'my-robot-api::log:clear', true, packs).next;
    expect(state['my-robot-api::log']).toEqual([]);
    state = applySimDeviceEvent(state, 'my-robot-api::log:append', 'L1', packs).next;
    state = applySimDeviceEvent(state, 'my-robot-api::log:append', 'L2', packs).next;
    state = applySimDeviceEvent(state, 'my-robot-api::log:append', 'L3', packs).next;
    state = applySimDeviceEvent(state, 'my-robot-api::log:append', 'L4', packs).next;
    expect(state['my-robot-api::log']).toEqual(['L2', 'L3', 'L4']);

    state = applySimDeviceEvent(state, 'oled_clear', true, packs).next;
    state = applySimDeviceEvent(state, 'oled_show', 'Hello OLED', packs).next;
    expect(state['virtual-board::oled']).toEqual(['Hello OLED']);

    const resetRobot = buildPackResetPatch(validatedSample);
    expect(resetRobot['my-robot-api::speed']).toBe(0);
    expect(resetRobot['my-robot-api::battery']).toBe(88);
    expect(resetRobot).not.toHaveProperty('virtual-board::temp');

    const motorA = validateExtensionPack({
      format: 'polyblock-extension',
      version: 1,
      id: 'motor-a',
      name: '左轮电机包',
      packVersion: '1.0.0',
      iconLabel: '左轮',
      color: '#0ea5e9',
      description: '左轮电机',
      sections: [
        {
          id: 'main',
          label: '左轮',
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
        },
      ],
      simWidgets: [
        { kind: 'bar', key: 'speed', label: '当前转速', default: 30 },
        { kind: 'slider', key: 'global:vbus', label: '共享总线电压', default: 12 },
      ],
    });
    const motorB = validateExtensionPack({
      format: 'polyblock-extension',
      version: 1,
      id: 'motor-b',
      name: '右轮电机包',
      packVersion: '1.0.0',
      iconLabel: '右轮',
      color: '#ec4899',
      description: '右轮电机',
      sections: [
        {
          id: 'main',
          label: '右轮',
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

    dualState = applySimDeviceEvent(dualState, 'motor-a::speed', 95, [motorA, motorB]).next;
    expect(readPackWidgetValue(dualState, 'motor-a', motorA.simWidgets![0])).toBe(95);
    expect(readPackWidgetValue(dualState, 'motor-b', motorB.simWidgets![0])).toBe(80);

    dualState = applySimDeviceEvent(dualState, 'global:vbus', 24, [motorA, motorB]).next;
    expect(readPackWidgetValue(dualState, 'motor-a', motorA.simWidgets![1])).toBe(24);
    expect(readPackWidgetValue(dualState, 'motor-b', motorB.simWidgets![1])).toBe(24);

    const boardLampBlock = getAllPackBlocks(VIRTUAL_BOARD_PACK).find(
      (b) => b.type === 'ext_board_rgb',
    )!;
    const colorOptions = (boardLampBlock.args0![0].options as Array<[string, string]>).map(
      ([, val]) => val,
    );
    expect(colorOptions).toEqual(['#ef4444', '#10b981', '#3b82f6', '#1e293b']);
    expect(VIRTUAL_BOARD_PACK.simWidgets!.find((w) => w.key === 'rgb')?.kind).toBe(
      'tricolor',
    );
    expect(resolveTricolorState('#ef4444')).toMatchObject({ color: 'red', active: true });
    expect(resolveTricolorState('green')).toMatchObject({ color: 'green', active: true });
    expect(resolveTricolorState('blue')).toMatchObject({ color: 'blue', active: true });
    expect(resolveTricolorState('#8b5cf6')).toMatchObject({ color: 'off', active: false });
    expect(resolveTricolorState('#f59e0b')).toMatchObject({ color: 'off', active: false });
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
      format: 'polyblock-extension',
      version: 1,
      id: 'diag-servo-pack',
      name: '诊断测试舵机包',
      packVersion: '1.0.0',
      iconLabel: '舵机',
      color: '#14b8a6',
      description: '诊断测试',
      imports: {
        lua: ['local servo = require("servo")'],
        python: ['import servo'],
      },
      sections: [
        {
          id: 'main',
          label: '舵机',
          blocks: [
            {
              type: 'ext_diag_servo_run',
              kind: 'statement',
              message0: '启动测试舵机 %1',
              args0: [{ type: 'field_number', name: 'POS', value: 45 }],
              lua: { template: 'servo.run({{POS}})' },
              python: { template: 'servo.run({{POS}})' },
            },
          ],
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

    setActiveProjectCapabilities(['diag-servo-pack']);
    expect(backendRegistry.get('lua').generate(ws).diagnostics).toHaveLength(0);

    setActiveProjectCapabilities([]);
    const resDisabled = backendRegistry.get('lua').generate(ws);
    expect(
      resDisabled.diagnostics.some(
        (d) =>
          d.severity === 'error' &&
          d.id.startsWith('cap-missing-diag-servo-pack-') &&
          d.message.includes('诊断测试舵机包'),
      ),
    ).toBe(true);

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

  it('strictly isolates multiple handleConfigs(channel-pool) packs with auto-derived configKey, auto-detected field_channel_id, and auto flyout buttons', () => {
    const pwmPack = extensionRegistry.validateProjectLocalPack({
      format: 'polyblock-extension',
      version: 1,
      id: 'pwm-driver',
      name: 'PWM 驱动通道包',
      packVersion: '1.0.0',
      iconLabel: 'PWM',
      color: '#14b8a6',
      description: '每句柄独立 4 路 PWM 通道池。',
      imports: {
        lua: ['local pwm = require("pwm")'],
        python: ['import pwm'],
      },
      sections: [
        {
          id: 'main',
          label: 'PWM',
          toolboxOrder: 105,
          handleConfigs: [
            {
              kind: 'channel-pool',
              label: 'PWM 通道',
              prefix: 'PWM',
              min: 1,
              max: 8,
              defaultCount: 4,
              presets: [2, 4, 8],
            },
          ],
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
                template: 'pwm.duty({{PWM_ID:int}}, {{DUTY}}){{PWM_ID:channel_comment_lua}}',
              },
              python: {
                template: 'pwm.duty({{PWM_ID:int}}, {{DUTY}}){{PWM_ID:channel_comment_py}}',
              },
            },
          ],
        },
      ],
    });
    extensionRegistry.setActiveProjectLocalPacks([pwmPack]);

    // Auto-derived flyout button for custom channel-pool pack (zero manual flyoutButton field!)
    const pwmCat = extensionRegistry
      .toCategorySpecs(['pwm-driver'], [pwmPack])
      .find((c) => c.id === 'ext_pwm-driver');
    expect(pwmCat?.flyoutButton).toEqual({
      text: '⚙ 配置本句柄PWM 通道',
      callbackKey: OPEN_HANDLE_CHANNEL_CONFIG_CALLBACK,
    });

    setActiveChannelPoolConfigs({
      [CAP_RT_TIMERS]: { count: 8, aliases: { '0': '心跳灯' } },
      'pwm-driver': { count: 4, aliases: { '0': '左轮油门' } },
    });

    const timerOpts = buildChannelDropdownOptions(CAP_RT_TIMERS, 'T', '0', 8, 32, false);
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
    expect(luaRes.code).toContain('pwm.duty(0, 60) -- PWM0: 左轮油门');
    expect(luaRes.code).not.toContain('心跳灯');
    // OOB detected automatically by scanning `args0` for `field_channel_id` (zero manual fieldName!)
    expect(
      luaRes.diagnostics.some(
        (d) => d.severity === 'error' && d.id.startsWith('pool-pwm-driver-oob-5-'),
      ),
    ).toBe(true);

    setActiveChannelPoolConfig(
      'pwm-driver',
      { count: 6, aliases: { '0': '左轮油门' } },
      4,
      1,
      8,
    );
    expect(backendRegistry.get('lua').generate(ws).diagnostics).toHaveLength(0);

    ws.dispose();
    setActiveProjectCapabilities(null);
    setActiveChannelPoolConfigs({ [CAP_RT_TIMERS]: { count: 8, aliases: {} } });
    extensionRegistry.setActiveProjectLocalPacks([]);
  });

  it('supports fine-grained Scheme 1 section pruning, generic core-category merging (control), block-driven simWidgetKeys filtering, libs[] vs sandboxMock separation, and generic content-based import deduplication', () => {
    let caps = [CAP_RT];
    expect(getPackEnableState(RT_PACK, caps)).toMatchObject({
      status: 'full',
      enabledCount: 3,
      totalCount: 3,
    });

    const step1 = togglePackOrSectionCapability(CAP_RT_TIMERS, caps);
    expect(step1.action).toBe('disabled');
    expect(step1.nextCapabilities).toEqual([CAP_RT_LIFECYCLE, CAP_RT_TICK]);
    caps = step1.nextCapabilities;
    expect(getPackEnableState(RT_PACK, caps)).toMatchObject({
      status: 'partial',
      enabledCount: 2,
      totalCount: 3,
    });

    const partialCats = getOrderedToolboxCategories(caps);
    expect(partialCats.some((c) => c.id === 'ext_rt_timers')).toBe(false);
    expect(partialCats.some((c) => c.id === 'ext_rt_tick')).toBe(true);
    expect(
      partialCats
        .find((c) => c.id === 'event')
        ?.blocks.some((b) => b.type === 'poly_on_run'),
    ).toBe(true);

    const step2 = togglePackOrSectionCapability(CAP_RT_TIMERS, caps);
    expect(step2.action).toBe('enabled');
    expect(step2.nextCapabilities).toEqual([CAP_RT]);

    const step3 = togglePackOrSectionCapability(CAP_RT, step2.nextCapabilities);
    expect(step3.action).toBe('disabled');
    expect(step3.nextCapabilities).toEqual([]);

    // Multi-section SDK pack verifying:
    // - section 1 merges into core `'control'`
    // - section 2 is hidden (`visible: false`)
    // - section 3 has `simWidgetKeys: ['led_a']` + an export-only `sandboxRunnable: false` block
    // - section 4 has `simWidgetKeys: ['bar_b']`
    const sdkPackA = extensionRegistry.validateProjectLocalPack({
      format: 'polyblock-extension',
      version: 1,
      id: 'custom-mcu-sdk',
      name: '自定义 MCU SDK',
      packVersion: '1.0.0',
      iconLabel: 'MCU',
      color: '#ec4899',
      description: '验证单轨 sections[]、控制分类注入、按积木聚合 simWidgetKeys 与 sandboxRunnable。',
      imports: {
        lua: ['local my_sdk = require("my_sdk")'],
        python: ['import my_sdk'],
      },
      sections: [
        {
          id: 'ctrl_ext',
          label: '流程控制扩展',
          visible: true,
          categoryTarget: 'control',
          blocks: [
            {
              type: 'ext_mcu_yield',
              kind: 'statement',
              message0: 'MCU 让出控制权',
              lua: { template: 'my_sdk.yield()' },
              python: { template: 'my_sdk.yield_now()' },
            },
          ],
        },
        {
          id: 'internal',
          label: '内部隐藏',
          visible: false,
          toolboxOrder: 34,
          blocks: [
            {
              type: 'ext_mcu_hidden',
              kind: 'statement',
              message0: '内部调试调用',
              lua: { template: '-- hidden', imports: [] },
              python: { template: 'pass', imports: [] },
            },
          ],
        },
        {
          id: 'io',
          label: '板级IO',
          visible: true,
          toolboxOrder: 35,
          color: '#06b6d4',
          blocks: [
            {
              type: 'ext_mcu_gpio',
              kind: 'statement',
              message0: '设置 GPIO %1',
              args0: [{ type: 'field_number', name: 'PIN', value: 1 }],
              simWidgetKeys: ['led_a'],
              lua: { template: 'my_sdk.gpio({{PIN}})' },
              python: { template: 'my_sdk.gpio({{PIN}})' },
            },
            {
              type: 'ext_mcu_chip_uid',
              kind: 'value',
              outputType: 'String',
              message0: '读取芯片唯一 ID',
              sandboxRunnable: false,
              lua: { template: 'my_sdk.chip_uid()' },
              python: { template: 'my_sdk.chip_uid()' },
            },
          ],
        },
        {
          id: 'meter',
          label: '功率计',
          visible: true,
          toolboxOrder: 36,
          blocks: [
            {
              type: 'ext_mcu_power',
              kind: 'value',
              outputType: 'Number',
              message0: '读取功率',
              simWidgetKeys: ['bar_b'],
              lua: { template: 'my_sdk.power()' },
              python: { template: 'my_sdk.power()' },
            },
          ],
        },
      ],
      sandboxMock: {
        moduleName: 'my_sdk',
        luaSource: 'return { yield=function() end, gpio=function() end, power=function() return 10 end }',
      },
      simWidgets: [
        { kind: 'led', key: 'led_a', label: 'IO 指示灯', default: false },
        { kind: 'bar', key: 'bar_b', label: '实时功率', min: 0, max: 100, default: 10 },
      ],
    });

    // Real pure-script library pack (`libs[]`, e.g. crc16.lua) + no sandboxMock
    const crcPack = extensionRegistry.validateProjectLocalPack({
      format: 'polyblock-extension',
      version: 1,
      id: 'crc16-lib',
      name: 'CRC16 算法库',
      packVersion: '1.0.0',
      iconLabel: 'CRC',
      color: '#10b981',
      description: '纯 Lua 库，既在沙箱运行又随真机打包导出',
      imports: {
        lua: ['local my_sdk = require("my_sdk")'],
        python: ['import my_sdk'],
      },
      sections: [
        {
          id: 'main',
          label: '校验',
          blocks: [
            {
              type: 'ext_mcu_addon_ping',
              kind: 'statement',
              message0: 'MCU Ping',
              lua: { template: 'my_sdk.ping()' },
              python: { template: 'my_sdk.ping()' },
            },
          ],
        },
      ],
      libs: [
        {
          moduleName: 'crc16',
          role: 'entry',
          luaSource: 'local M = {}; function M.calc() return 0x1234 end; return M',
        },
      ],
    });

    // Export-only pack with simWidgets but NO sandboxMock/libs -> must NOT show fake sim card!
    const noDriverPack = extensionRegistry.validateProjectLocalPack({
      format: 'polyblock-extension',
      version: 1,
      id: 'no-driver-pack',
      name: '无驱动仅导出包',
      packVersion: '1.0.0',
      iconLabel: '硬件',
      color: '#64748b',
      description: '验证没有 sandboxMock/libs 时不渲染模拟面板',
      sections: [
        {
          id: 'main',
          label: '无驱动',
          blocks: [
            {
              type: 'ext_nodrv_op',
              kind: 'statement',
              message0: '仅导出操作',
              simWidgetKeys: ['ghost_led'],
              lua: { template: 'hw.op()' },
              python: { template: 'hw.op()' },
            },
          ],
        },
      ],
      simWidgets: [{ kind: 'led', key: 'ghost_led', label: '幽灵灯', default: false }],
    });

    extensionRegistry.setActiveProjectLocalPacks([sdkPackA, crcPack, noDriverPack]);
    const sdkCats = getOrderedToolboxCategories(['custom-mcu-sdk', 'crc16-lib']);
    expect(
      sdkCats
        .find((c) => c.id === 'control')
        ?.blocks.some((b) => b.type === 'ext_mcu_yield'),
    ).toBe(true);
    expect(sdkCats.some((c) => c.id === 'ext_custom-mcu-sdk_internal')).toBe(false);
    const ids = sdkCats.map((c) => c.id);
    expect(ids.indexOf('control')).toBeLessThan(ids.indexOf('ext_custom-mcu-sdk_io'));
    expect(ids.indexOf('ext_custom-mcu-sdk_io')).toBeLessThan(ids.indexOf('variables'));

    // Selective block-driven simWidgets aggregation:
    // Enabling ONLY `custom-mcu-sdk.io` shows ONLY `led_a` (NOT `bar_b`)!
    const ioSim = extensionRegistry.getActiveSimPacks(
      ['custom-mcu-sdk.io'],
      [sdkPackA],
    );
    expect(ioSim).toHaveLength(1);
    expect(ioSim[0].simWidgets?.map((w) => w.key)).toEqual(['led_a']);

    // Enabling ONLY `custom-mcu-sdk.ctrl_ext` (which has 0 simWidgetKeys) shows 0 sim cards!
    expect(
      extensionRegistry.getActiveSimPacks(['custom-mcu-sdk.ctrl_ext'], [sdkPackA]),
    ).toHaveLength(0);

    // Pack with simWidgets but NO sandboxMock/libs shows 0 sim cards!
    expect(
      extensionRegistry.getActiveSimPacks(['no-driver-pack'], [noDriverPack]),
    ).toHaveLength(0);

    // Sandbox runs BOTH sandboxMock & libs[]; target export bundles ONLY libs[]!
    const sandboxMods = extensionRegistry.getSandboxMocks(
      ['custom-mcu-sdk', 'crc16-lib'],
      [sdkPackA, crcPack],
    );
    expect(sandboxMods.map((m) => m.moduleName)).toEqual(['my_sdk', 'crc16']);
    const exportBundleMods = extensionRegistry.getBundleModules(
      ['custom-mcu-sdk', 'crc16-lib'],
      [sdkPackA, crcPack],
    );
    expect(exportBundleMods.map((m) => m.moduleName)).toEqual(['crc16']);

    // Generic content-based import deduplication across two distinct packs
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_start',
              id: 'dedup_s',
              inputs: {
                BODY: {
                  block: {
                    type: 'ext_mcu_yield',
                    id: 'dedup_1',
                    next: {
                      block: {
                        type: 'ext_mcu_gpio',
                        id: 'dedup_2',
                        fields: { PIN: 4 },
                        next: {
                          block: {
                            type: 'ext_mcu_addon_ping',
                            id: 'dedup_3',
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
      },
      ws,
    );
    const luaDedup = backendRegistry.get('lua').generate(ws);
    expect(luaDedup.code.match(/local my_sdk = require\("my_sdk"\)/g)?.length).toBe(1);
    const pyDedup = backendRegistry.get('python').generate(ws);
    expect(pyDedup.code.match(/^import my_sdk$/gm)?.length).toBe(1);

    ws.dispose();
    extensionRegistry.setActiveProjectLocalPacks([]);
  });

  it('compiles every handle and script across all 4 progressive demo projects (L1-L4) cleanly in BOTH Lua 5.4 and Python 3 with 0 diagnostics (including handle-wide uniqueness checks!)', () => {
    expect(DEMO_PROJECT_TEMPLATES).toHaveLength(4);

    for (const tpl of DEMO_PROJECT_TEMPLATES) {
      const proj = instantiateProjectFromTemplate(tpl.id);
      extensionRegistry.setActiveProjectLocalPacks(proj.localExtensions ?? []);
      setActiveProjectCapabilities(proj.enabledCapabilities);
      const pools = extensionRegistry
        .getChannelPools(proj.enabledCapabilities, proj.localExtensions)
        .map((entry) => entry.pool);

      for (const hdl of proj.handles) {
        const poolCfgs = getAllHandleChannelPoolConfigs(
          hdl,
          pools,
          proj.defaultTimerCount,
        );
        setActiveChannelPoolConfigs(poolCfgs);
        const hdlScriptMetas = hdl.scripts.map((s) => {
          const m = inspectWorkspaceScriptMeta(s.workspace);
          return {
            id: s.id,
            name: s.name,
            isEntry: s.id === hdl.entryScriptId,
            declaredEvents: m.declaredEvents,
            requiredScripts: m.requiredScripts,
          };
        });

        for (const scr of hdl.scripts) {
          setActiveHandleScripts(hdlScriptMetas, scr.id);
          const ws = new Blockly.Workspace();
          Blockly.serialization.workspaces.load(scr.workspace, ws);

          const luaRes = backendRegistry.get('lua').generate(ws);
          const pyRes = backendRegistry.get('python').generate(ws);

          expect(
            luaRes.diagnostics,
            `${tpl.id}/${hdl.name}/${scr.name} Lua diagnostics`,
          ).toHaveLength(0);
          expect(
            pyRes.diagnostics,
            `${tpl.id}/${hdl.name}/${scr.name} Python diagnostics`,
          ).toHaveLength(0);

          if (
            tpl.id === 'multi_handle_robot' &&
            hdl.name === 'drive_ctrl' &&
            scr.name === 'main'
          ) {
            expect(luaRes.code).toContain('function on_drive_estop(active)');
            expect(luaRes.code).toContain('-- PWM0: 云台偏航');
            expect(luaRes.code).toContain('-- T0: 云台扫描');
            expect(pyRes.code).toContain('def on_drive_estop(active):');
            expect(pyRes.code).toContain('# PWM0: 云台偏航');
          }

          ws.dispose();
        }
      }
    }

    setActiveHandleScripts([], null);
    setActiveProjectCapabilities(null);
    setActiveChannelPoolConfigs({ [CAP_RT_TIMERS]: { count: 8, aliases: {} } });
    extensionRegistry.setActiveProjectLocalPacks([]);
  });
});
