import * as Blockly from 'blockly';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildHandleScriptsMeta } from '../backends/eventMode';
import { backendRegistry } from '../backends/registry';
import { analyzeWorkspaceDiagnostics } from '../backends/sourceMap';
import {
  CORE_TOOLBOX_ORDERS,
  getOrderedToolboxCategories,
} from '../blocks/catalog';
import { registerPolyBlocks } from '../blocks/definitions';
import {
  buildChannelDropdownOptions,
  setActiveChannelPoolConfig,
  setActiveChannelPoolConfigs,
  setActiveHandleScripts,
  setActiveHandleSharedFunctions,
  setActiveHandleSharedVariables,
  setActiveProjectCapabilities,
} from '../blocks/workspaceContextBridge';
import {
  applyAssetManifest,
  findUnknownManifestIds,
} from '../assets/manifestLoader';
import {
  BOARDS_MANIFEST,
  DEFAULT_TARGET_PROFILES,
  DISCOVERED_BOARD_IDS,
  SAMPLE_CUSTOM_BOARD_TEMPLATE,
  targetProfileRegistry,
  validateTargetProfile,
} from '../capabilities/registry';
import {
  DEFAULT_EXTENSION_PACKS,
  DISCOVERED_PACK_IDS,
  PACKS_MANIFEST,
  SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
} from '../extensions/defaultPacks';
import {
  DEMOS_MANIFEST,
  DISCOVERED_DEMO_IDS,
} from '../projects/defaultDemos';
import {
  resolveProjectModules,
} from '../extensions/moduleResolver';
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
  buildProjectArchiveBundle,
  buildPureProjectJson,
  parseImportedProjectArchive,
  parseImportedPureProjectFile,
} from '../export/projectArchive';
import { buildZipBytes } from '../export/zipWriter';
import {
  DEMO_PROJECTS,
  getAllHandleChannelPoolConfigs,
  instantiateProjectFromTemplate,
  resolveProjectTargetProfile,
} from '../projects/store';

describe('Declarative Extension Pack & Capability-Driven Target Profile System', () => {
  const RT_PACK_ID = 'rt';
  const RT_LIFECYCLE_ID = 'rt.lifecycle';
  const RT_TIMERS_ID = 'rt.timers';
  const RT_TICK_ID = 'rt.tick';
  const VB_PACK_ID = 'virtual-board';
  const getRtPack = () => extensionRegistry.get(RT_PACK_ID)!;
  const getVbPack = () => extensionRegistry.get(VB_PACK_ID)!;

  beforeAll(() => {
    registerPolyBlocks();
    extensionRegistry.ensureInitialized();
    targetProfileRegistry.ensureInitialized();
  });

  it('strictly gates core toolbox categories & hardware button hats by enabledCapabilities', () => {
    const pureCats = getOrderedToolboxCategories([]);
    expect(pureCats.some((c) => c.id === 'ext_rt_timers')).toBe(false);
    expect(pureCats.some((c) => c.id === 'ext_rt_tick')).toBe(false);
    const pureEventBlocks =
      pureCats.find((c) => c.id === 'event')?.blocks.map((b) => b.type) ?? [];
    expect(pureEventBlocks).toEqual([
      'poly_on_start',
      'poly_require_script',
      'poly_comment',
    ]);

    const rtCats = getOrderedToolboxCategories([RT_PACK_ID]);
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

    const vbCats = extensionRegistry.toCategorySpecs([VB_PACK_ID]);
    expect(vbCats[0].blocks.some((b) => b.type === 'poly_on_button')).toBe(true);
  });

  it('treats all .polyboard.json target profiles with equal rights (import, override default, remove except last, and reset)', () => {
    expect(() => validateTargetProfile({})).toThrow();
    try {
      // Equal rights: importing a profile with an existing default ID cleanly upgrades/overrides it
      const overridden = targetProfileRegistry.importProfile({
        ...SAMPLE_CUSTOM_BOARD_TEMPLATE,
        id: 'generic-script',
        name: '自定义纯脚本环境',
      });
      expect(overridden.name).toBe('自定义纯脚本环境');
      expect(targetProfileRegistry.get('generic-script').name).toBe('自定义纯脚本环境');
      expect(targetProfileRegistry.hasCatalogChanges()).toBe(true);

      // Equal rights: removing a default profile succeeds as long as >= 1 board remains
      expect(targetProfileRegistry.removeProfile('generic-script')).toBe(true);
      expect(
        targetProfileRegistry.listAll().some((p) => p.id === 'generic-script'),
      ).toBe(false);

      // Removing profiles stops ONLY at the last remaining board (never by ID privilege)
      for (const p of targetProfileRegistry.listAll().slice(1)) {
        expect(targetProfileRegistry.removeProfile(p.id)).toBe(true);
      }
      expect(targetProfileRegistry.listAll()).toHaveLength(1);
      const lastId = targetProfileRegistry.listAll()[0].id;
      expect(targetProfileRegistry.removeProfile(lastId)).toBe(false);
      expect(targetProfileRegistry.getDefaultProfileId()).toBe(lastId);

      // Reset restores all factory default boards cleanly
      targetProfileRegistry.resetToDefaults();
      expect(targetProfileRegistry.hasCatalogChanges()).toBe(false);
      expect(targetProfileRegistry.listAll()).toHaveLength(DEFAULT_TARGET_PROFILES.length);
      expect(targetProfileRegistry.getDefaultProfileId()).toBe('generic-script');

      // Standard custom board import & remove
      const imported = targetProfileRegistry.importProfile(
        SAMPLE_CUSTOM_BOARD_TEMPLATE,
      );
      expect(imported.id).toBe('my-industrial-controller');
      expect('builtin' in imported).toBe(false);
      expect(targetProfileRegistry.get(imported.id).defaultChannelCounts?.[RT_TIMERS_ID]).toBe(16);
      expect(targetProfileRegistry.removeProfile(imported.id)).toBe(true);
    } finally {
      targetProfileRegistry.resetToDefaults();
    }
  });

  it('registers all 3 default pure-module packs (with multi-section rt), derives badges, and sorts toolbox categories by numeric toolboxOrder', () => {
    const all = extensionRegistry.listAll();
    expect(all.map((p) => p.id)).toEqual(
      expect.arrayContaining([
        'rt',
        'virtual-board',
        'clock-timer',
      ]),
    );
    expect(DEFAULT_EXTENSION_PACKS).toHaveLength(3);
    expect(resolvePackSections(getRtPack()).map((s) => s.capId)).toEqual([
      RT_LIFECYCLE_ID,
      RT_TIMERS_ID,
      RT_TICK_ID,
    ]);
    expect(CORE_TOOLBOX_ORDERS.map((c) => c.order)).toEqual([
      10, 20, 30, 40, 50, 60, 70, 80, 85, 90,
    ]);

    const rtBadges = derivePackBadges(getRtPack()).map((b) => b.label);
    expect(rtBadges).toContain('3 组件');
    expect(rtBadges).toContain('沙箱模拟');
    expect(rtBadges).toContain('事件回调');
    expect(rtBadges).toContain('通道池 T0~31');

    const vbBadges = derivePackBadges(getVbPack()).map((b) => b.label);
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
              code: {
                lua: { template: '-- noop', imports: [] },
                python: { template: 'pass', imports: [] },
              },
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
      RT_PACK_ID,
      'mid-order-pack',
      VB_PACK_ID,
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

    const cats = extensionRegistry.toCategorySpecs(['virtual-board', 'clock-timer']);
    expect(cats).toHaveLength(2);
    expect(cats[0].label).toBe('硬件');
    expect(cats[0].order).toBe(100);
    expect(cats[0].blocks.length).toBeGreaterThanOrEqual(7);
    expect(cats[1].label).toBe('计时');
    expect(cats[1].order).toBe(120);

    const resolved = resolveProjectModules({
      handleScripts: [],
      enabledCapabilities: ['virtual-board', 'clock-timer'],
      localExtensions: [],
    });
    expect(resolved.sandboxMountOrder).toHaveLength(2);
    expect(resolved.sandboxMountOrder.map((m) => m.moduleName)).toEqual([
      'board',
      'poly_clock',
    ]);
    expect(resolved.sandboxMountOrder[0].packId).toBe('virtual-board');
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

  it('treats all .polyext.json packs with equal rights (override default, snapshot in .polyblock.zip, remove, reset, and generate code)', async () => {
    expect(() => validateExtensionPack({})).toThrow();
    try {
      // Equal rights: importing a pack with an existing default ID (`virtual-board`) upgrades/overrides it cleanly
      const originalVb = getVbPack();
      expect(extensionRegistry.isSameAsDefault(originalVb)).toBe(true);
      const upgradedVb = extensionRegistry.importPack({
        ...originalVb,
        packVersion: '2.5.0',
        description: '用户定制升级版虚拟硬件板',
      });
      expect(upgradedVb.packVersion).toBe('2.5.0');
      expect(extensionRegistry.isSameAsDefault(upgradedVb)).toBe(false);
      expect(extensionRegistry.hasCatalogChanges()).toBe(true);

      // Pure .polyblock.json MUST stay 100% reference-only (ZERO inline packs/boards)
      const vbProj = instantiateProjectFromTemplate('virtual_board_demo');
      const pureJson = buildPureProjectJson(vbProj);
      expect('localExtensions' in pureJson).toBe(false);
      expect('localTargetProfile' in pureJson).toBe(false);

      // Self-contained .polyblock.zip snapshots ALL referenced packs (incl. modified virtual-board + clock-timer) + board
      const archive = buildProjectArchiveBundle(vbProj, extensionRegistry.listAll());
      expect(archive.includedPackIds).toEqual(['clock-timer', 'virtual-board']);
      expect(archive.includedBoardId).toBe('virtual-board-basic');
      const reimported = await parseImportedProjectArchive(
        archive.zipBytes,
        'vb_archive',
        [],
      );
      expect(
        reimported.project.localExtensions?.map((p) => `${p.id}@${p.packVersion}`),
      ).toEqual(['clock-timer@1.0.0', 'virtual-board@2.5.0']);
      expect(reimported.lockedBoardName).toBeTruthy();

      // Equal rights: removing a default pack succeeds and resetToDefaults() restores it cleanly
      expect(extensionRegistry.removePack('virtual-board')).toBe(true);
      expect(extensionRegistry.get('virtual-board')).toBeUndefined();
      extensionRegistry.resetToDefaults();
      expect(extensionRegistry.get('virtual-board')?.packVersion).toBe(originalVb.packVersion);
      expect(extensionRegistry.hasCatalogChanges()).toBe(false);

      // Standard custom pack import, codegen & remove
      const imported = extensionRegistry.importPack(
        SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
      );
      expect(imported.id).toBe('my-robot-api');
      expect('builtin' in imported).toBe(false);

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

      expect(extensionRegistry.removePack('my-robot-api')).toBe(true);
      expect(extensionRegistry.get('my-robot-api')).toBeUndefined();
    } finally {
      extensionRegistry.resetToDefaults();
    }
  });

  it('isolates project-local packs from global library, exports pure .polyblock.json, and round-trips .polyblock.zip with Strategy 1 strict version locking', async () => {
    const baseSec = SAMPLE_CUSTOM_EXTENSION_TEMPLATE.sections[0];
    const globalV2 = extensionRegistry.importPack({
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
              code: {
                ...baseSec.blocks[0].code,
                lua: { template: 'robot.move_v2({{DIR:json}}, {{SPEED}})' },
              },
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
              code: {
                ...baseSec.blocks[0].code,
                lua: { template: 'robot.move_v1({{DIR:json}}, {{SPEED}})' },
              },
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
              code: {
                lua: { template: 'servo.angle({{DEG}})' },
                python: { template: 'servo.angle({{DEG}})' },
              },
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
      enabledCapabilities: [RT_PACK_ID, globalV2.id],
      localExtensions: [],
    };
    // 1. Pure .polyblock.json never embeds packs
    const pureExport = buildPureProjectJson(projUsingGlobal);
    expect('localExtensions' in pureExport).toBe(false);
    expect(pureExport.enabledCapabilities).toEqual([RT_PACK_ID, globalV2.id]);

    // 2. .polyblock.zip bundles ALL referenced packs (both rt and globalV2, zero default-pack special-casing) + board
    const archiveGlobal = buildProjectArchiveBundle(
      projUsingGlobal,
      extensionRegistry.listAll(),
    );
    expect(archiveGlobal.entries.map((e) => e.path)).toEqual([
      'project.polyblock.json',
      'extensions/my-robot-api.polyext.json',
      'extensions/rt.polyext.json',
      'boards/generic-script.polyboard.json',
    ]);

    // Strategy 1: importing .polyblock.zip strictly locks ALL bundled packs + board into the project
    // without mutating global registries, and survives subsequent removal/upgrade of global packs!
    const importedArchive = await parseImportedProjectArchive(
      archiveGlobal.zipBytes,
      'fallback',
      [],
    );
    expect(importedArchive.project.localExtensions?.map((p) => `${p.id}@${p.packVersion}`)).toEqual([
      'my-robot-api@2.0.0',
      'rt@1.0.0',
    ]);
    expect(resolveProjectTargetProfile(importedArchive.project).id).toBe('generic-script');
    expect(importedArchive.missingPackIds).toEqual([]);

    // Wrapper-directory ZIP (as created by OS Finder/Explorer "Compress Folder") also unwraps cleanly!
    const wrappedZip = buildZipBytes(
      archiveGlobal.entries.map((e) => ({
        path: `my_robot_folder/${e.path}`,
        content: e.content,
      })),
    );
    const unwrappedImport = await parseImportedProjectArchive(wrappedZip, 'wrapped', []);
    expect(unwrappedImport.project.localExtensions?.map((p) => p.id)).toEqual([
      'my-robot-api',
      'rt',
    ]);

    // Project-local pack wins over global when exporting .polyblock.zip
    const projWithLocal = {
      ...instantiateProjectFromTemplate('blank_project'),
      enabledCapabilities: [localV1.id],
      localExtensions: [localV1],
    };
    const archiveLocal = buildProjectArchiveBundle(
      projWithLocal,
      extensionRegistry.listAll(),
    );
    const importedLocal = await parseImportedProjectArchive(
      archiveLocal.zipBytes,
      'fallback',
      [],
    );
    expect(importedLocal.project.localExtensions?.map((p) => p.packVersion)).toEqual(['1.0.0']);

    // Pure .polyblock.json import flags missing packs cleanly once global pack is removed
    extensionRegistry.removePack(globalV2.id);
    const importedPureMissing = parseImportedPureProjectFile(pureExport, 'pure_missing', []);
    expect(importedPureMissing.project.localExtensions).toEqual([]);
    expect(importedPureMissing.missingPackIds).toEqual([globalV2.id]);

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

    const packs = [getVbPack(), validatedSample];
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

    state = applySimDeviceEvent(state, 'virtual-board::oled:clear', true, packs).next;
    state = applySimDeviceEvent(state, 'virtual-board::oled:append', 'Hello OLED', packs).next;
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
              code: {
                lua: { template: 'motor_a.set({{V}})' },
                python: { template: 'motor_a.set({{V}})' },
              },
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
              code: {
                lua: { template: 'motor_b.set({{V}})' },
                python: { template: 'motor_b.set({{V}})' },
              },
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

    const boardLampBlock = getAllPackBlocks(getVbPack()).find(
      (b) => b.type === 'ext_board_rgb',
    )!;
    const colorOptions = (boardLampBlock.args0![0].options as Array<[string, string]>).map(
      ([, val]) => val,
    );
    expect(colorOptions).toEqual(['#ef4444', '#10b981', '#3b82f6', '#1e293b']);
    expect(getVbPack().simWidgets!.find((w) => w.key === 'rgb')?.kind).toBe(
      'tricolor',
    );
    expect(resolveTricolorState('#ef4444')).toMatchObject({ color: 'red', active: true });
    expect(resolveTricolorState('green')).toMatchObject({ color: 'green', active: true });
    expect(resolveTricolorState('blue')).toMatchObject({ color: 'blue', active: true });
    expect(resolveTricolorState('#8b5cf6')).toMatchObject({ color: 'off', active: false });
    expect(resolveTricolorState('#f59e0b')).toMatchObject({ color: 'off', active: false });
  });

  it('supports declarative kind:"hat" callbacks in custom .polyext.json packs with codegen, scope tree, duplicate diagnostics, and emitEvent arg resolution', () => {
    const imported = extensionRegistry.importPack(SAMPLE_CUSTOM_EXTENSION_TEMPLATE);
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
    extensionRegistry.removePack(imported.id);
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
              code: {
                lua: { template: 'servo.run({{POS}})' },
                python: { template: 'servo.run({{POS}})' },
              },
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
              code: {
                lua: {
                  template: 'pwm.duty({{PWM_ID:int}}, {{DUTY}}){{PWM_ID:channel_comment}}',
                },
                python: {
                  template: 'pwm.duty({{PWM_ID:int}}, {{DUTY}}){{PWM_ID:channel_comment}}',
                },
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
      [RT_TIMERS_ID]: { count: 8, aliases: { '0': '心跳灯' } },
      'pwm-driver': { count: 4, aliases: { '0': '左轮油门' } },
    });

    const timerOpts = buildChannelDropdownOptions(RT_TIMERS_ID, 'T', '0', 8, 32, false);
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

    setActiveProjectCapabilities([RT_TIMERS_ID, 'pwm-driver']);
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
    setActiveChannelPoolConfigs({ [RT_TIMERS_ID]: { count: 8, aliases: {} } });
    extensionRegistry.setActiveProjectLocalPacks([]);
  });

  it('supports fine-grained Scheme 1 section pruning, generic core-category merging (control), block-driven simWidgetKeys filtering, libs[] vs sandboxMock separation, and generic content-based import deduplication', () => {
    let caps = [RT_PACK_ID];
    expect(getPackEnableState(getRtPack(), caps)).toMatchObject({
      status: 'full',
      enabledCount: 3,
      totalCount: 3,
    });

    const step1 = togglePackOrSectionCapability(RT_TIMERS_ID, caps);
    expect(step1.action).toBe('disabled');
    expect(step1.nextCapabilities).toEqual([RT_LIFECYCLE_ID, RT_TICK_ID]);
    caps = step1.nextCapabilities;
    expect(getPackEnableState(getRtPack(), caps)).toMatchObject({
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

    const step2 = togglePackOrSectionCapability(RT_TIMERS_ID, caps);
    expect(step2.action).toBe('enabled');
    expect(step2.nextCapabilities).toEqual([RT_PACK_ID]);

    const step3 = togglePackOrSectionCapability(RT_PACK_ID, step2.nextCapabilities);
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
              code: {
                lua: { template: 'my_sdk.yield()' },
                python: { template: 'my_sdk.yield_now()' },
              },
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
              code: {
                lua: { template: '-- hidden', imports: [] },
                python: { template: 'pass', imports: [] },
              },
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
              code: {
                lua: { template: 'my_sdk.gpio({{PIN}})' },
                python: { template: 'my_sdk.gpio({{PIN}})' },
              },
            },
            {
              type: 'ext_mcu_chip_uid',
              kind: 'value',
              outputType: 'String',
              message0: '读取芯片唯一 ID',
              sandboxRunnable: false,
              code: {
                lua: { template: 'my_sdk.chip_uid()' },
                python: { template: 'my_sdk.chip_uid()' },
              },
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
              code: {
                lua: { template: 'my_sdk.power()' },
                python: { template: 'my_sdk.power()' },
              },
            },
          ],
        },
      ],
      sandboxMock: {
        moduleName: 'my_sdk',
        sources: {
          lua: 'return { yield=function() end, gpio=function() end, power=function() return 10 end }',
        },
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
              code: {
                lua: { template: 'my_sdk.ping()' },
                python: { template: 'my_sdk.ping()' },
              },
            },
          ],
        },
      ],
      libs: [
        {
          moduleName: 'crc16',
          role: 'entry',
          sources: {
            lua: 'local M = {}; function M.calc() return 0x1234 end; return M',
          },
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
              code: {
                lua: { template: 'hw.op()' },
                python: { template: 'hw.op()' },
              },
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
    const resolvedSdk = resolveProjectModules({
      handleScripts: [],
      enabledCapabilities: ['custom-mcu-sdk', 'crc16-lib'],
      localExtensions: [sdkPackA, crcPack],
    });
    expect(resolvedSdk.sandboxMountOrder.map((m) => m.moduleName)).toEqual([
      'my_sdk',
      'crc16',
    ]);
    expect(resolvedSdk.exportLibs.map((m) => m.moduleName)).toEqual(['crc16']);

    // Scoped withLocalPacks restores prior local packs cleanly and shadows global packs in findOwnerForBlockType
    const shadowedVb = validateExtensionPack({
      ...getVbPack(),
      sections: [
        {
          id: 'main',
          label: '精简硬件',
          blocks: [getVbPack().sections[0].blocks[0]],
        },
      ],
    });
    extensionRegistry.withLocalPacks([shadowedVb], () => {
      // Block kept in local override resolves to local pack
      expect(
        extensionRegistry.findOwnerForBlockType(
          getVbPack().sections[0].blocks[0].type,
        )?.pack.id,
      ).toBe('virtual-board');
      // Block removed in local override must NOT leak from shadowed global pack
      const removedType = getVbPack().sections[0].blocks[1].type;
      expect(
        extensionRegistry.findOwnerForBlockType(removedType),
      ).toBeUndefined();
    });

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

  it('compiles every handle and script across all 4 built-in demo projects cleanly in ALL registered language backends with 0 diagnostics (including handle-wide uniqueness checks!)', () => {
    expect(DEMO_PROJECTS).toHaveLength(4);
    const allBackends = backendRegistry.list();
    expect(allBackends.length).toBeGreaterThanOrEqual(3);

    for (const demo of DEMO_PROJECTS) {
      const proj = instantiateProjectFromTemplate(demo.id);
      extensionRegistry.setActiveProjectLocalPacks(proj.localExtensions ?? []);
      setActiveProjectCapabilities(proj.enabledCapabilities);
      const pools = extensionRegistry
        .getChannelPools(proj.enabledCapabilities, proj.localExtensions)
        .map((entry) => entry.pool);

      for (const hdl of proj.handles) {
        const poolCfgs = getAllHandleChannelPoolConfigs(hdl, pools);
        setActiveChannelPoolConfigs(poolCfgs);
        setActiveHandleSharedVariables(hdl.sharedVariables ?? []);
        setActiveHandleSharedFunctions(hdl.sharedFunctions ?? []);
        const hdlScriptMetas = buildHandleScriptsMeta(hdl);

        for (const scr of hdl.scripts) {
          setActiveHandleScripts(hdlScriptMetas, scr.id);
          const ws = new Blockly.Workspace();
          Blockly.serialization.workspaces.load(scr.workspace, ws);

          for (const adapter of allBackends) {
            const res = adapter.generate(ws);
            expect(
              res.diagnostics,
              `${demo.id}/${hdl.name}/${scr.name} (${adapter.id}) diagnostics`,
            ).toHaveLength(0);

            if (
              demo.id === 'multi_handle_robot' &&
              hdl.name === 'drive_ctrl' &&
              scr.name === 'main'
            ) {
              expect(res.code).toContain('on_drive_estop(active)');
              expect(res.code).toContain('PWM0: 云台偏航');
              expect(res.code).toContain('T0: 云台扫描');
            }
          }

          ws.dispose();
        }
      }
    }

    setActiveHandleScripts([], null);
    setActiveHandleSharedVariables(null);
    setActiveHandleSharedFunctions(null);
    setActiveProjectCapabilities(null);
    setActiveChannelPoolConfigs({ [RT_TIMERS_ID]: { count: 8, aliases: {} } });
    extensionRegistry.setActiveProjectLocalPacks([]);
  });

  it('derives declarative runtime monitor summary from section runtimeMonitor metadata with zero pack-ID hardcoding', () => {
    expect(extensionRegistry.getRuntimeMonitorSummary([])).toEqual({
      hasSchedulerMonitor: false,
      hasTimerMonitor: false,
      timerPoolConfigKey: null,
    });

    expect(extensionRegistry.getRuntimeMonitorSummary([RT_PACK_ID])).toEqual({
      hasSchedulerMonitor: true,
      hasTimerMonitor: true,
      timerPoolConfigKey: RT_TIMERS_ID,
    });

    expect(extensionRegistry.getRuntimeMonitorSummary([RT_LIFECYCLE_ID])).toEqual({
      hasSchedulerMonitor: true,
      hasTimerMonitor: false,
      timerPoolConfigKey: null,
    });

    expect(extensionRegistry.getRuntimeMonitorSummary([RT_TIMERS_ID])).toEqual({
      hasSchedulerMonitor: false,
      hasTimerMonitor: true,
      timerPoolConfigKey: RT_TIMERS_ID,
    });

    expect(extensionRegistry.getRuntimeMonitorSummary([RT_TICK_ID])).toEqual({
      hasSchedulerMonitor: false,
      hasTimerMonitor: false,
      timerPoolConfigKey: null,
    });

    // Custom pack declaring runtimeMonitor: 'timers' + custom channel-pool configKey
    const customTimerPack = validateExtensionPack({
      format: 'polyblock-extension',
      version: 1,
      id: 'custom-rtos',
      name: '自定义 RTOS 扩展',
      packVersion: '1.0.0',
      iconLabel: 'RTOS',
      color: '#6366f1',
      description: '自定义定时器与调度监控',
      sections: [
        {
          id: 'sched',
          label: '调度',
          runtimeMonitor: 'scheduler',
          blocks: [
            {
              type: 'ext_custom_rtos_yield',
              kind: 'statement',
              message0: '让出调度',
              code: { lua: { template: 'rtos.yield()' } },
            },
          ],
        },
        {
          id: 'hw_timers',
          label: '硬定时',
          runtimeMonitor: 'timers',
          handleConfigs: [
            {
              kind: 'channel-pool',
              configKey: 'custom.hw_timers',
              label: '硬件定时通道',
              prefix: 'HT',
              min: 1,
              max: 16,
              defaultCount: 4,
            },
          ],
          blocks: [
            {
              type: 'ext_custom_rtos_timer',
              kind: 'statement',
              message0: '启动硬定时 %1',
              args0: [{ type: 'field_channel_id', name: 'TID' }],
              code: { lua: { template: 'rtos.timer({{TID:int}})' } },
            },
          ],
        },
      ],
    });

    expect(
      extensionRegistry.getRuntimeMonitorSummary(['custom-rtos'], [customTimerPack]),
    ).toEqual({
      hasSchedulerMonitor: true,
      hasTimerMonitor: true,
      timerPoolConfigKey: 'custom.hw_timers',
    });

    // Validator rejects invalid runtimeMonitor values
    expect(() =>
      validateExtensionPack({
        ...customTimerPack,
        sections: [
          {
            ...customTimerPack.sections[0],
            runtimeMonitor: 'invalid_kind',
          },
        ],
      }),
    ).toThrow(/runtimeMonitor/);
  });

  it('skips identical Blockly visual re-registrations and cleanly overrides modified blocks with zero overwrite warnings', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const makePack = (label: string, tpl: string) =>
        extensionRegistry.validateProjectLocalPack({
          format: 'polyblock-extension',
          version: 1,
          id: 'dedup-warn-pack',
          name: '去重测试包',
          packVersion: '1.0.0',
          iconLabel: '去重',
          color: '#0ea5e9',
          description: '验证重复同步不产生 Blockly 覆写告警',
          sections: [
            {
              id: 'main',
              label: '去重',
              blocks: [
                {
                  type: 'ext_dedup_warn_ping',
                  kind: 'statement',
                  message0: label,
                  tooltip: `tip:${label}`,
                  code: {
                    lua: { template: tpl },
                    python: { template: tpl },
                  },
                },
              ],
            },
          ],
        });

      const v1 = makePack('发送心跳 v1', 'ping_v1()');
      const v2 = makePack('发送心跳 v2', 'ping_v2()');

      // Initial mount + repeated identical mounts (e.g. theme/project switches)
      extensionRegistry.setActiveProjectLocalPacks([v1]);
      const defRefAfterFirst = Blockly.Blocks['ext_dedup_warn_ping'];
      extensionRegistry.setActiveProjectLocalPacks([v1]);
      extensionRegistry.setActiveProjectLocalPacks([v1]);
      expect(Blockly.Blocks['ext_dedup_warn_ping']).toBe(defRefAfterFirst);

      // Genuine visual + codegen override replaces cleanly with 0 overwrite warnings
      extensionRegistry.setActiveProjectLocalPacks([v2]);
      expect(Blockly.Blocks['ext_dedup_warn_ping']).not.toBe(defRefAfterFirst);

      const ws = new Blockly.Workspace();
      try {
        const blk = ws.newBlock('ext_dedup_warn_ping');
        expect(blk.getTooltip()).toBe('tip:发送心跳 v2');
        const luaOut = backendRegistry.get('lua').generate(ws).code;
        expect(luaOut).toContain('ping_v2()');
      } finally {
        ws.dispose();
      }

      const overwriteWarns = warnSpy.mock.calls.filter((args) =>
        args.some((a) => String(a).includes('overwrites previous definition')),
      );
      expect(overwriteWarns).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
      extensionRegistry.setActiveProjectLocalPacks([]);
    }
  });

  it('keeps built-in packs, target profiles, and JSON schemas consistent and enforces zero UI/hook hardcoding', async () => {
    const fsMod = 'node:fs';
    const pathMod = 'node:path';
    const procMod = 'node:process';
    const fs = (await import(/* @vite-ignore */ fsMod)) as {
      readFileSync(p: string, enc: string): string;
      readdirSync(p: string, opts: { withFileTypes: true }): Array<{
        name: string;
        isDirectory(): boolean;
        isFile(): boolean;
      }>;
    };
    const path = (await import(/* @vite-ignore */ pathMod)) as {
      join(...segments: string[]): string;
    };
    const proc = (await import(/* @vite-ignore */ procMod)) as {
      default?: { cwd(): string };
      cwd?: () => string;
    };

    const repoRoot = proc.cwd ? proc.cwd() : proc.default!.cwd();
    const polyextSchema = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'schemas/polyext.schema.json'), 'utf8'),
    ) as {
      properties: Record<string, unknown>;
      definitions: {
        ExtensionPackImports: { additionalProperties: unknown };
        ExtensionSectionSpec: {
          properties: {
            categoryTarget: { enum: string[] };
            runtimeMonitor: { enum: string[] };
          } & Record<string, unknown>;
        };
        ExtensionBlockDef: {
          properties: Record<string, unknown>;
        };
        SimWidgetSpec: {
          properties: { kind: { enum: string[] } } & Record<string, unknown>;
        };
      };
    };
    const polyboardSchema = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'schemas/polyboard.schema.json'), 'utf8'),
    ) as {
      properties: {
        defaultLanguage: { pattern?: string; enum?: unknown };
      } & Record<string, unknown>;
    };

    // 1. Verify schema stays open to future languages & covers all Layer 0 categories
    expect(polyextSchema.definitions.ExtensionPackImports.additionalProperties).not.toBe(
      false,
    );
    expect(polyboardSchema.properties.defaultLanguage.enum).toBeUndefined();
    expect(typeof polyboardSchema.properties.defaultLanguage.pattern).toBe('string');

    const schemaCategories =
      polyextSchema.definitions.ExtensionSectionSpec.properties.categoryTarget.enum;
    for (const coreCat of CORE_TOOLBOX_ORDERS) {
      expect(schemaCategories).toContain(coreCat.id);
    }

    const allowedPackKeys = new Set(Object.keys(polyextSchema.properties));
    const allowedSectionKeys = new Set(
      Object.keys(polyextSchema.definitions.ExtensionSectionSpec.properties),
    );
    const allowedBlockKeys = new Set(
      Object.keys(polyextSchema.definitions.ExtensionBlockDef.properties),
    );
    const allowedRuntimeMonitors = new Set(
      polyextSchema.definitions.ExtensionSectionSpec.properties.runtimeMonitor.enum,
    );
    const allowedWidgetKinds = new Set(
      polyextSchema.definitions.SimWidgetSpec.properties.kind.enum,
    );

    // 2. Verify all default packs + sample template conform to validator AND schema keys
    for (const pack of [...DEFAULT_EXTENSION_PACKS, SAMPLE_CUSTOM_EXTENSION_TEMPLATE]) {
      const validated = validateExtensionPack(pack);
      for (const key of Object.keys(pack)) {
        expect(allowedPackKeys.has(key), `unexpected pack key "${key}" in ${pack.id}`).toBe(
          true,
        );
      }
      for (const sec of pack.sections) {
        for (const key of Object.keys(sec)) {
          expect(
            allowedSectionKeys.has(key),
            `unexpected section key "${key}" in ${pack.id}.${sec.id}`,
          ).toBe(true);
        }
        if (sec.runtimeMonitor) {
          expect(allowedRuntimeMonitors.has(sec.runtimeMonitor)).toBe(true);
        }
        for (const blk of sec.blocks) {
          for (const key of Object.keys(blk)) {
            expect(
              allowedBlockKeys.has(key),
              `unexpected block key "${key}" in ${pack.id}.${sec.id}.${blk.type}`,
            ).toBe(true);
          }
        }
      }
      for (const widget of validated.simWidgets ?? []) {
        expect(allowedWidgetKinds.has(widget.kind)).toBe(true);
      }
    }

    // 3. Verify all built-in target profiles + sample board template conform to schema keys
    const allowedBoardKeys = new Set(Object.keys(polyboardSchema.properties));
    for (const prof of [
      ...targetProfileRegistry.listAll(),
      SAMPLE_CUSTOM_BOARD_TEMPLATE,
    ]) {
      expect(() => validateTargetProfile(prof)).not.toThrow();
      for (const key of Object.keys(prof)) {
        expect(
          allowedBoardKeys.has(key),
          `unexpected board profile key "${key}" in ${prof.id}`,
        ).toBe(true);
      }
    }

    // 4. Architecture guardrail: zero CAP_RT_*, === 'lua'|'python', or getForLanguage in UI/hooks
    const collectSourceFiles = (dir: string): string[] => {
      const files: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...collectSourceFiles(full));
        } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
          files.push(full);
        }
      }
      return files;
    };

    const uiFiles = [
      path.join(repoRoot, 'src/App.tsx'),
      ...collectSourceFiles(path.join(repoRoot, 'src/components')),
      ...collectSourceFiles(path.join(repoRoot, 'src/hooks')),
    ];
    for (const filePath of uiFiles) {
      const src = fs.readFileSync(filePath, 'utf8');
      expect(src, `${filePath} must not hardcode CAP_RT_*`).not.toMatch(/\bCAP_RT_/);
      expect(src, `${filePath} must not branch on literal 'lua'/'python'/'js'`).not.toMatch(
        /(===|!==)\s*['"](lua|python|js)['"]/,
      );
      expect(
        src,
        `${filePath} must use runnerManager.findForLanguage/hasRunnerForLanguage`,
      ).not.toContain('runnerManager.getForLanguage');
    }

    // 5. Asset manifest integrity & zero `builtin` field across packs, boards, and demos
    expect(findUnknownManifestIds(DISCOVERED_PACK_IDS, PACKS_MANIFEST)).toEqual([]);
    expect(findUnknownManifestIds(DISCOVERED_BOARD_IDS, BOARDS_MANIFEST)).toEqual([]);
    expect(findUnknownManifestIds(DISCOVERED_DEMO_IDS, DEMOS_MANIFEST)).toEqual([]);

    // Unlisted items append deterministically in ASCII ID order; excluded items are skipped
    const orderedSample = applyAssetManifest(
      [{ id: 'zeta' }, { id: 'alpha' }, { id: 'beta' }, { id: 'hidden' }],
      (x) => x.id,
      { order: ['beta'], exclude: ['hidden'] },
    );
    expect(orderedSample.map((x) => x.id)).toEqual(['beta', 'alpha', 'zeta']);

    // Portable pack/board JSON never carries a `builtin` key, and any extraneous `builtin` field is stripped
    for (const p of DEFAULT_EXTENSION_PACKS) {
      expect('builtin' in p).toBe(false);
    }
    for (const b of DEFAULT_TARGET_PROFILES) {
      expect('builtin' in b).toBe(false);
    }
    const spoofedPack = extensionRegistry.importPack({
      ...SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
      id: 'spoof-builtin-pack',
      builtin: true,
    });
    expect('builtin' in spoofedPack).toBe(false);
    extensionRegistry.removePack('spoof-builtin-pack');

    const spoofedBoard = targetProfileRegistry.importProfile({
      ...SAMPLE_CUSTOM_BOARD_TEMPLATE,
      id: 'spoof-builtin-board',
      builtin: true,
    });
    expect('builtin' in spoofedBoard).toBe(false);
    targetProfileRegistry.removeProfile('spoof-builtin-board');

    // 6. Zero native <select> elements in UI components (unified PolySelect portal)
    for (const filePath of collectSourceFiles(path.join(repoRoot, 'src/components'))) {
      const src = fs.readFileSync(filePath, 'utf8');
      expect(
        src,
        `${filePath} must use <PolySelect> instead of native <select>`,
      ).not.toMatch(/<select\b/);
    }

    // 7. Non-`ext_`-prefixed removed extension block is detected via authoritative core block catalog
    setActiveProjectCapabilities([]);
    const orphanWs = new Blockly.Workspace();
    const orphanBlock = {
      type: 'custom_relay_set',
      id: 'orphan_relay_1',
      isShadow: () => false,
      isEnabled: () => true,
      getFieldValue: () => undefined,
      getInputTargetBlock: () => null,
      getNextBlock: () => null,
      getPreviousBlock: () => null,
      getOutputShape: () => null,
      getChildren: () => [],
      getRootBlock: function () {
        return this;
      },
      getParent: () => null,
    } as unknown as Blockly.Block;
    orphanWs.getTopBlocks = () => [orphanBlock];
    orphanWs.getAllBlocks = () => [orphanBlock];
    const orphanDiags = analyzeWorkspaceDiagnostics(orphanWs, 'lua');
    setActiveProjectCapabilities(null);
    expect(
      orphanDiags.some(
        (d) =>
          d.severity === 'error' &&
          d.id === 'cap-missing-ext-unknown-orphan_relay_1',
      ),
    ).toBe(true);
    orphanWs.dispose();

    // 8. Single-entry multi-language backend guardrail: zero hardcoded language tables outside concrete backend adapters
    const languageAgnosticCoreFiles = [
      'src/core/backends/types.ts',
      'src/core/highlight.ts',
      'src/core/extensions/scriptLibScanner.ts',
      'src/core/extensions/moduleResolver.ts',
      'src/core/runners/logParser.ts',
    ];
    for (const relPath of languageAgnosticCoreFiles) {
      const src = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
      expect(
        src,
        `${relPath} must derive language dialects/scanners/extractors from backendRegistry instead of hardcoding lua/python/js`,
      ).not.toMatch(/\b(LANGUAGE_DIALECTS|SUPPORTED_LANGUAGE_IDS|ERROR_LINE_EXTRACTORS|IMPORT_MODULE_NAME_EXTRACTORS|LIB_LANGUAGE_BINDINGS|LIB_FUNCTION_SCANNERS)\b/);
      expect(
        src,
        `${relPath} must not contain hardcoded 'lua', 'python', or 'js' map keys`,
      ).not.toMatch(/^\s*(?:lua|python|js)\s*:/m);
    }

    // 9. Architecture purity guardrail: zero isBuiltin privileges, zero hardcoded pack/board IDs,
    //    zero legacy protocol aliases (emit_device/get_input), and zero single-language names in shared scheduler
    const nonTestSrcFiles = collectSourceFiles(path.join(repoRoot, 'src')).filter(
      (f) => !f.replace(/\\/g, '/').includes('/__tests__/'),
    );
    const runtimeCodeFiles = nonTestSrcFiles.filter(
      (f) => !f.replace(/\\/g, '/').endsWith('/types/project.ts'),
    );
    for (const filePath of runtimeCodeFiles) {
      const src = fs.readFileSync(filePath, 'utf8');
      expect(
        src,
        `${filePath} must not introduce privileged isBuiltin / listBySource / hardcoded default pack or board ID constants`,
      ).not.toMatch(
        /\b(isBuiltin|listBySource|RT_PACK|VIRTUAL_BOARD_PACK|CLOCK_TIMER_PACK|CAP_RT|CAP_RT_LIFECYCLE|CAP_RT_TIMERS|CAP_RT_TICK|CAP_VIRTUAL_BOARD)\b|['"]generic-script['"]/,
      );
      expect(
        src,
        `${filePath} must not reintroduce legacy worker protocol aliases emit_device / get_input`,
      ).not.toMatch(/\b(emit_device|get_input)\b/);
    }
    const schedulerSrc = fs.readFileSync(
      path.join(repoRoot, 'src/workers/runtimeScheduler.ts'),
      'utf8',
    );
    expect(
      schedulerSrc,
      'src/workers/runtimeScheduler.ts must use language-agnostic async turn naming (no Python-specific names)',
    ).not.toMatch(/\b(waitPython|resumePython|pyTurn|pySlice|resolvePySlice)\b/);

    // 10. Standard project directory & zero nested-JSON guardrail:
    //     - Zero flat `src/demos/*.polyblock.json` files
    //     - Every `src/demos/<id>/project.polyblock.json` has ZERO inline `localExtensions`/`bundledExtensions`/`localTargetProfile`
    //     - Every `src/demos/<id>/extensions/*.polyext.json` validates against polyext validator AND schema
    //     - Zero `bundledExtensions` references anywhere in runtime code
    const demosDir = path.join(repoRoot, 'src/demos');
    for (const entry of fs.readdirSync(demosDir, { withFileTypes: true })) {
      if (entry.isFile()) {
        expect(
          entry.name,
          `src/demos/${entry.name} must not be a flat .polyblock.json (use src/demos/<id>/project.polyblock.json)`,
        ).not.toMatch(/\.polyblock\.json$/i);
      } else if (entry.isDirectory()) {
        const demoSubDir = path.join(demosDir, entry.name);
        const subEntries = fs.readdirSync(demoSubDir, { withFileTypes: true });
        expect(
          subEntries.some((s) => s.isFile() && s.name === 'project.polyblock.json'),
          `${demoSubDir}/project.polyblock.json must exist`,
        ).toBe(true);
        const projPath = path.join(demoSubDir, 'project.polyblock.json');
        const projJson = JSON.parse(fs.readFileSync(projPath, 'utf8')) as Record<string, unknown>;
        expect('localExtensions' in projJson, `${projPath} must not inline localExtensions`).toBe(false);
        expect('bundledExtensions' in projJson, `${projPath} must not inline bundledExtensions`).toBe(false);
        expect('localTargetProfile' in projJson, `${projPath} must not inline localTargetProfile`).toBe(false);

        if (subEntries.some((s) => s.isDirectory() && s.name === 'extensions')) {
          const demoExtDir = path.join(demoSubDir, 'extensions');
          const extFiles = fs
            .readdirSync(demoExtDir, { withFileTypes: true })
            .filter((e) => e.isFile() && e.name.endsWith('.polyext.json'))
            .map((e) => e.name);
          for (const extFile of extFiles) {
            const rawExt = JSON.parse(
              fs.readFileSync(path.join(demoExtDir, extFile), 'utf8'),
            ) as Record<string, unknown>;
            const validated = validateExtensionPack(rawExt);
            expect('builtin' in validated).toBe(false);
            for (const key of Object.keys(rawExt)) {
              expect(
                allowedPackKeys.has(key),
                `unexpected pack key "${key}" in src/demos/${entry.name}/extensions/${extFile}`,
              ).toBe(true);
            }
          }
        }
      }
    }
    for (const filePath of nonTestSrcFiles) {
      const src = fs.readFileSync(filePath, 'utf8');
      expect(
        src,
        `${filePath} must not reintroduce legacy bundledExtensions inline snapshots`,
      ).not.toMatch(/\bbundledExtensions\b/);
    }

    // 11. Unified LanguagePlugin guardrail:
    //     - RunnerManager must NOT import concrete language runner files directly (syncs from backendRegistry)
    //     - scopeAnalysis.ts must NOT hardcode language keyword or hat-param tables
    //     - CodeInspector.tsx must NOT sniff target language syntax for breakpoints
    const runnerManagerSrc = fs.readFileSync(
      path.join(repoRoot, 'src/core/runners/manager.ts'),
      'utf8',
    );
    expect(
      runnerManagerSrc,
      'RunnerManager must sync runners from LanguagePlugins via backendRegistry instead of importing concrete language runners',
    ).not.toMatch(/wasmoonRunner|micropythonRunner|jsWorkerRunner/);

    const scopeAnalysisSrc = fs.readFileSync(
      path.join(repoRoot, 'src/core/backends/scopeAnalysis.ts'),
      'utf8',
    );
    expect(
      scopeAnalysisSrc,
      'scopeAnalysis.ts must derive reserved keywords dynamically from backendRegistry',
    ).not.toMatch(/\bRESERVED_IDENTS\b/);

    const codeInspectorSrc = fs.readFileSync(
      path.join(repoRoot, 'src/components/CodeInspector.tsx'),
      'utf8',
    );
    expect(
      codeInspectorSrc,
      'CodeInspector.tsx must use structural generated.breakpointableLines instead of syntax sniffing',
    ).not.toMatch(/function on_|def on_|elif id ==/);

    // 12. Strict physical detachment of concrete language plugins from `src/core/` & `src/workers/`:
    //     - `src/core/` (excluding `__tests__`) must contain ZERO concrete language files and ZERO imports from `src/plugins/`
    //     - `src/workers/` must contain ONLY shared Layer 0.5 host infrastructure (zero concrete language workers)
    const coreNonTestFiles = nonTestSrcFiles.filter((fp) =>
      fp.replace(/\\/g, '/').includes('/src/core/'),
    );
    for (const filePath of coreNonTestFiles) {
      const base = filePath.split(/[\\/]/).pop() ?? '';
      expect(
        base,
        `${filePath}: concrete language implementations belong under src/plugins/languages/, not src/core/`,
      ).not.toMatch(/^(lua|python|js)(Backend|Runner|Plugin)/i);
      const src = fs.readFileSync(filePath, 'utf8');
      expect(
        src,
        `${filePath}: src/core/ must never depend on src/plugins/ (plugins register inward into core)`,
      ).not.toMatch(/from\s+['"][^'"]*plugins\//);
    }

    const workerFiles = nonTestSrcFiles.filter((fp) =>
      fp.replace(/\\/g, '/').includes('/src/workers/'),
    );
    for (const filePath of workerFiles) {
      const base = filePath.split(/[\\/]/).pop() ?? '';
      expect(
        base,
        `${filePath}: language-specific workers belong under src/plugins/languages/<lang>/, not src/workers/`,
      ).not.toMatch(/^(lua|python|js)(\.worker|Sandbox)/i);
    }
  });
});
