import * as Blockly from 'blockly';
import { describe, expect, it } from 'vitest';
import { backendRegistry } from '../backends/registry';
import { registerPolyBlocks } from '../blocks/definitions';
import { setActiveHandleSharedVariables } from '../blocks/timerConfigBridge';
import {
  applyHandleVariableMutation,
  collectHandleSharedVariableNames,
  syncHandleVariablesIntoWorkspaceJson,
  validateSharedVariableName,
} from '../projects/handleVariables';
import {
  CAP_RT,
  CAP_RT_LIFECYCLE,
  CAP_RT_TICK,
  CAP_RT_TIMERS,
  CAP_VIRTUAL_BOARD,
  hasCapability,
  targetProfileRegistry,
} from '../capabilities/registry';
import {
  addHandleToProject,
  addScriptToProject,
  applyTargetProfileToProject,
  createDefaultWorkspaceStore,
  deleteHandleFromProject,
  deleteProjectFromStore,
  deleteScriptFromProject,
  DEMO_PROJECT_TEMPLATES,
  duplicateHandleInProject,
  duplicateProjectInStore,
  duplicateScriptInProject,
  getActiveHandle,
  getHandleChannelPoolConfig,
  getHandleTimerConfig,
  instantiateProjectFromTemplate,
  parseImportedProject,
  renameHandleInProject,
  renameScriptInProject,
  sanitizeScriptName,
  setHandleTimerConfig,
} from '../projects/store';
import type { WorkspaceStoreState } from '../../types/project';

describe('v3 Three-Tier Project -> Handle -> Script Store & Target Profiles', () => {
  it('instantiates templates with differentiated target profiles and isolated per-handle capabilityConfigs', () => {
    const p1 = instantiateProjectFromTemplate('starter_suite');
    expect(p1.version).toBe(3);
    expect(p1.language).toBe('lua');
    expect(p1.targetProfileId).toBe('generic-script');
    expect(p1.enabledCapabilities).toEqual([]);
    // Each independent demo program lives in its own handle (strictly 1 on_start per handle)
    expect(p1.handles.map((h) => h.name)).toEqual([
      'main_vm',
      'step_debug_vm',
      'alarm_vm',
    ]);
    const h1 = getActiveHandle(p1);
    expect(h1.scripts.map((s) => s.name)).toEqual(['main']);
    expect(h1.entryScriptId).toBe(h1.scripts[0].id);
    expect(h1.activeScriptId).toBe(h1.scripts[0].id);

    // Virtual board basic template has virtual-board, NO timers!
    const vb = instantiateProjectFromTemplate('virtual_board_demo');
    expect(vb.targetProfileId).toBe('virtual-board-basic');
    expect(vb.enabledCapabilities).toContain(CAP_VIRTUAL_BOARD);
    expect(vb.enabledCapabilities).not.toContain(CAP_RT_TIMERS);
    expect(vb.enabledCapabilities).not.toContain(CAP_RT_LIFECYCLE);

    const p2 = instantiateProjectFromTemplate('starter_suite', [p1.name]);
    expect(p2.name).toBe('入门演示项目 (2)');
    expect(p2.handles[0].id).not.toBe(p1.handles[0].id);
    expect(p2.handles[0].scripts[0].id).not.toBe(p1.handles[0].scripts[0].id);

    // Curated demo list has exactly 4 progressive tiers (L1 -> L4)
    expect(DEMO_PROJECT_TEMPLATES.map((t) => t.difficulty?.level)).toEqual([
      'L1',
      'L2',
      'L3',
      'L4',
    ]);
    const defaultStore = createDefaultWorkspaceStore();
    expect(defaultStore.projects).toHaveLength(4);

    // L4 Multi-handle flagship template has 3 isolated handles + 2 embedded local packs + dual channel pools
    const mh = instantiateProjectFromTemplate('multi_handle_robot');
    expect(mh.targetProfileId).toBe('virtual-board-rt');
    expect(mh.enabledCapabilities).toEqual(
      expect.arrayContaining([
        CAP_RT,
        CAP_VIRTUAL_BOARD,
        'clock-timer',
        'robot-drive',
        'pwm-servo',
      ]),
    );
    expect(hasCapability(mh.enabledCapabilities, CAP_RT_LIFECYCLE)).toBe(true);
    expect(hasCapability(mh.enabledCapabilities, CAP_RT_TIMERS)).toBe(true);
    expect(hasCapability(mh.enabledCapabilities, CAP_RT_TICK)).toBe(true);
    expect(mh.localExtensions?.map((p) => p.id)).toEqual(['robot-drive', 'pwm-servo']);
    expect(mh.handles).toHaveLength(3);
    expect(mh.handles.map((h) => h.name)).toEqual([
      'drive_ctrl',
      'sensor_guard',
      'telemetry_hub',
    ]);
    expect(getHandleTimerConfig(mh.handles[0]).aliases['0']).toBe('云台扫描');
    expect(getHandleChannelPoolConfig(mh.handles[0], 'pwm-servo', 4).aliases['0']).toBe(
      '云台偏航',
    );
    expect(getHandleTimerConfig(mh.handles[1]).aliases['0']).toBe('温度巡检');
    expect(getHandleTimerConfig(mh.handles[2]).aliases['0']).toBe('遥测上报');

    // Applying a target profile updates capabilities cleanly without clobbering handles
    const switched = applyTargetProfileToProject(
      p1,
      targetProfileRegistry.get('embedded-rt'),
    );
    expect(switched.targetProfileId).toBe('embedded-rt');
    expect(switched.enabledCapabilities).toEqual([CAP_RT]);
    expect(switched.handles).toHaveLength(3);

    const updatedHandle = setHandleTimerConfig(switched.handles[0], {
      count: 16,
      aliases: { '2': '电机看门狗' },
    });
    expect(getHandleTimerConfig(updatedHandle).count).toBe(16);
    expect(getHandleTimerConfig(updatedHandle).aliases['2']).toBe('电机看门狗');
  });

  it('performs handle CRUD (add, rename, duplicate, safe delete) and script CRUD within a handle', () => {
    expect(sanitizeScriptName(' sensor_1.lua ')).toBe('sensor_1');
    expect(sanitizeScriptName('a/b:c*.py')).toBe('a_b_c');

    let proj = instantiateProjectFromTemplate('blank_project');
    expect(proj.handles).toHaveLength(1);
    expect(getActiveHandle(proj).scripts).toHaveLength(1);

    // Cannot delete last remaining handle or last remaining script
    expect(deleteHandleFromProject(proj, proj.handles[0].id).handles).toHaveLength(1);
    expect(
      getActiveHandle(deleteScriptFromProject(proj, getActiveHandle(proj).scripts[0].id))
        .scripts,
    ).toHaveLength(1);

    // Add, rename, duplicate, delete handle
    proj = addHandleToProject(proj, 'motor_vm');
    expect(proj.handles).toHaveLength(2);
    expect(getActiveHandle(proj).name).toBe('motor_vm');
    proj = renameHandleInProject(proj, proj.handles[1].id, 'main_vm');
    expect(proj.handles[1].name).toBe('main_vm_2');
    proj = duplicateHandleInProject(proj, proj.handles[1].id);
    expect(proj.handles).toHaveLength(3);
    proj = deleteHandleFromProject(proj, proj.handles[2].id);
    expect(proj.handles).toHaveLength(2);

    // Add + rename + duplicate + delete script in active handle
    // Auxiliary script added to an existing handle defaults to blank module canvas (no duplicate `on_start`)
    proj = addScriptToProject(proj, 'helper');
    expect(getActiveHandle(proj).scripts).toHaveLength(2);
    expect(getActiveHandle(proj).scripts[1].name).toBe('helper');
    const helperBlocks = (
      getActiveHandle(proj).scripts[1].workspace as {
        blocks?: { blocks?: unknown[] };
      }
    ).blocks?.blocks;
    expect(helperBlocks).toEqual([]);

    proj = renameScriptInProject(proj, getActiveHandle(proj).scripts[1].id, 'main.lua');
    expect(getActiveHandle(proj).scripts[1].name).toBe('main_2');

    getActiveHandle(proj).scripts[1].breakpoints = ['blk_1'];
    proj = duplicateScriptInProject(proj, getActiveHandle(proj).scripts[1].id);
    expect(getActiveHandle(proj).scripts).toHaveLength(3);
    expect(getActiveHandle(proj).scripts[2].name).toBe('main_2_copy');
    expect(getActiveHandle(proj).scripts[2].breakpoints).toEqual(['blk_1']);

    const oldEntry = getActiveHandle(proj).entryScriptId;
    proj = deleteScriptFromProject(proj, oldEntry);
    expect(getActiveHandle(proj).scripts).toHaveLength(2);
    expect(
      getActiveHandle(proj).scripts.some(
        (s) => s.id === getActiveHandle(proj).entryScriptId,
      ),
    ).toBe(true);
  });

  it('duplicates and safely deletes projects in v3 WorkspaceStore', () => {
    const base = instantiateProjectFromTemplate('multi_handle_robot');
    let store: WorkspaceStoreState = {
      version: 3,
      activeProjectId: base.id,
      projects: [base],
    };

    expect(deleteProjectFromStore(store, base.id).projects).toHaveLength(1);

    store = duplicateProjectInStore(store, base.id);
    expect(store.projects).toHaveLength(2);
    expect(store.projects[0].name).toContain('副本');
    expect(store.projects[0].handles).toHaveLength(3);
    expect(store.projects[0].handles[0].id).not.toBe(base.handles[0].id);

    store = deleteProjectFromStore(store, store.activeProjectId);
    expect(store.projects).toHaveLength(1);
    expect(store.activeProjectId).toBe(base.id);
  });

  it('imports v3 project JSON losslessly (including variableInitialValues) and rejects legacy v1/v2 formats', () => {
    expect(() =>
      parseImportedProject(
        { format: 'polyblock-project', version: 1, workspace: {} },
        'fallback',
      ),
    ).toThrow(/仅支持 PolyBlock v3/);
    expect(() =>
      parseImportedProject(
        { format: 'polyblock-project', version: 2, scripts: [] },
        'fallback',
      ),
    ).toThrow(/仅支持 PolyBlock v3/);

    const v3Orig = instantiateProjectFromTemplate('event_timer_demo');
    const reimported = parseImportedProject(v3Orig, 'fallback', [v3Orig.name]);
    expect(reimported.version).toBe(3);
    expect(reimported.name).toBe('事件回调与多路定时器示例 (2)');
    expect(reimported.handles).toHaveLength(2);
    expect(reimported.handles[0].sharedVariables).toEqual(['led_on', 'ticks']);
    expect(reimported.handles[0].variableInitialValues).toEqual({
      led_on: { kind: 'boolean', value: false },
      ticks: { kind: 'number', value: 0 },
    });
  });

  it('enforces explicit 3-tier variable scopes (cross-file shared vs single-file global) symmetrically across Lua & Python', () => {
    registerPolyBlocks();

    // 1. Validation rules reject leading digits (`123`), spaces, keywords, duplicates; accept ASCII & Chinese
    expect(validateSharedVariableName('', []).valid).toBe(false);
    expect(validateSharedVariableName('123', []).valid).toBe(false);
    expect(validateSharedVariableName('a b', []).valid).toBe(false);
    expect(validateSharedVariableName('global', []).valid).toBe(false);
    expect(validateSharedVariableName('total', ['total']).valid).toBe(false);
    expect(validateSharedVariableName('total', ['total'], 'total').valid).toBe(true);
    expect(validateSharedVariableName('counter_1', ['total'])).toEqual({
      valid: true,
      trimmed: 'counter_1',
    });
    expect(validateSharedVariableName('步数', ['total'])).toEqual({
      valid: true,
      trimmed: '步数',
    });

    // 2. Single-file globals (`total`, `i` in `starter_suite`) stay strictly private to `main`:
    //    adding `script_2` does NOT leak `main`'s single-file vars into `script_2`!
    let proj = instantiateProjectFromTemplate('starter_suite');
    proj = addScriptToProject(proj, 'script_2');
    let hdl = getActiveHandle(proj);
    expect(hdl.scripts.map((s) => s.name)).toEqual(['main', 'script_2']);
    expect(collectHandleSharedVariableNames(hdl)).toEqual([]);

    // In Lua, single-file `total` emits chunk-top `local total = nil` (isolated from `_G`);
    // loop counter `i` stays loop-local without noisy `local i = nil`.
    setActiveHandleSharedVariables([]);
    const mainWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(hdl.scripts[0].workspace, mainWs);
    const luaMain = backendRegistry.get('lua').generate(mainWs).code;
    const pyMain = backendRegistry.get('python').generate(mainWs).code;
    mainWs.dispose();
    expect(luaMain).toContain('local total = nil');
    expect(luaMain).not.toContain('local i = nil');
    expect(pyMain).toContain('total = None');
    expect(pyMain).not.toContain('import shared');

    // 3. Creating a single-file variable in `script_2` does NOT touch `main` or `handle.sharedVariables`
    const afterFileVar = applyHandleVariableMutation(hdl, hdl.scripts[1].id, {
      kind: 'create',
      name: 'local_only',
      scope: 'file',
    });
    expect(collectHandleSharedVariableNames(afterFileVar.handle)).toEqual([]);
    const mainVarsAfterFile = (
      (afterFileVar.handle.scripts[0].workspace.variables as Array<{ name: string }>) ?? []
    ).map((v) => v.name);
    expect(mainVarsAfterFile).not.toContain('local_only');

    // 4. Creating an explicit cross-file (`shared`) variable with initial value in `script_2`
    //    adds to `handle.sharedVariables` + `variableInitialValues` AND propagates to `main`!
    const afterCreateShared = applyHandleVariableMutation(
      afterFileVar.handle,
      hdl.scripts[1].id,
      {
        kind: 'create',
        name: 'speed',
        scope: 'shared',
        initialValue: { kind: 'number', value: 12 },
      },
    );
    expect(collectHandleSharedVariableNames(afterCreateShared.handle)).toEqual(['speed']);
    expect(afterCreateShared.handle.variableInitialValues?.speed).toEqual({
      kind: 'number',
      value: 12,
    });
    const mainVarsAfterShared = (
      (afterCreateShared.handle.scripts[0].workspace.variables as Array<{ name: string }>) ?? []
    ).map((v) => v.name);
    expect(mainVarsAfterShared).toContain('speed');

    // 5. Renaming a cross-file shared variable (`speed` -> `vel`) propagates across all scripts + initialValues
    const afterRenameShared = applyHandleVariableMutation(
      afterCreateShared.handle,
      hdl.scripts[1].id,
      { kind: 'rename', oldName: 'speed', newName: 'vel' },
    );
    expect(collectHandleSharedVariableNames(afterRenameShared.handle)).toEqual(['vel']);
    expect(afterRenameShared.handle.variableInitialValues?.vel).toEqual({
      kind: 'number',
      value: 12,
    });
    expect(afterRenameShared.handle.variableInitialValues?.speed).toBeUndefined();
    const mainVarsAfterRename = (
      (afterRenameShared.handle.scripts[0].workspace.variables as Array<{ name: string }>) ?? []
    ).map((v) => v.name);
    expect(mainVarsAfterRename).toContain('vel');
    expect(mainVarsAfterRename).not.toContain('speed');

    // 6. Deleting an unused cross-file shared variable removes it cleanly from `handle.sharedVariables` & siblings
    const afterDeleteUnused = applyHandleVariableMutation(
      afterRenameShared.handle,
      hdl.scripts[1].id,
      { kind: 'delete', name: 'vel' },
    );
    expect(afterDeleteUnused.keptInSiblings).toEqual([]);
    expect(collectHandleSharedVariableNames(afterDeleteUnused.handle)).toEqual([]);

    // 7. L3 `event_timer_demo` explicitly configures `board_vm.sharedVariables = ['led_on', 'ticks']`:
    //    BOTH Lua (`local shared = require("shared")`) & Python (`import shared`) use unified Style A1!
    const l2 = instantiateProjectFromTemplate('event_timer_demo');
    const boardVm = l2.handles.find((h) => h.name === 'board_vm')!;
    expect(collectHandleSharedVariableNames(boardVm)).toEqual(['led_on', 'ticks']);
    setActiveHandleSharedVariables(collectHandleSharedVariableNames(boardVm));
    const l2MainWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(boardVm.scripts[0].workspace, l2MainWs);
    const l2Lua = backendRegistry.get('lua').generate(l2MainWs).code;
    const l2Py = backendRegistry.get('python').generate(l2MainWs).code;
    l2MainWs.dispose();
    expect(l2Lua).toContain('local shared = require("shared")');
    expect(l2Lua).toContain('shared.led_on = false');
    expect(l2Lua).not.toContain('local led_on');
    expect(l2Lua).not.toContain('local ticks');
    expect(l2Py).toContain('import shared');
    expect(l2Py).toContain('shared.led_on = False');

    // Unused synced shared variables in an empty `script_2.py` never emit `<var> = None`
    const syncedEmpty = syncHandleVariablesIntoWorkspaceJson(
      { blocks: { languageVersion: 0, blocks: [] } },
      ['led_on', 'ticks'],
    );
    const emptyWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(syncedEmpty, emptyWs);
    const emptyPy = backendRegistry.get('python').generate(emptyWs).code;
    emptyWs.dispose();
    setActiveHandleSharedVariables(null);
    expect(emptyPy).not.toContain('led_on = None');
    expect(emptyPy).not.toContain('ticks = None');
  });
});
