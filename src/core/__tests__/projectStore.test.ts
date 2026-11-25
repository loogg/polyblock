import { describe, expect, it } from 'vitest';
import {
  addHandleToProject,
  addScriptToProject,
  deleteHandleFromProject,
  deleteProjectFromStore,
  deleteScriptFromProject,
  duplicateHandleInProject,
  duplicateProjectInStore,
  duplicateScriptInProject,
  getActiveHandle,
  instantiateProjectFromTemplate,
  parseImportedProject,
  renameHandleInProject,
  renameScriptInProject,
  sanitizeScriptName,
} from '../projects/store';
import type { WorkspaceStoreState } from '../../types/project';

describe('v3 Three-Tier Project -> Handle -> Script Store', () => {
  it('instantiates default starter_suite & multi_handle_robot with isolated handles and distinct IDs', () => {
    const p1 = instantiateProjectFromTemplate('starter_suite');
    expect(p1.version).toBe(3);
    expect(p1.language).toBe('lua');
    expect(p1.handles).toHaveLength(1);
    const h1 = getActiveHandle(p1);
    expect(h1.scripts.map((s) => s.name)).toEqual([
      'main',
      'step_debug',
      'threshold_alarm',
    ]);
    expect(h1.entryScriptId).toBe(h1.scripts[0].id);
    expect(h1.activeScriptId).toBe(h1.scripts[0].id);

    const p2 = instantiateProjectFromTemplate('starter_suite', [p1.name]);
    expect(p2.name).toBe('入门演示项目 (2)');
    expect(p2.handles[0].id).not.toBe(p1.handles[0].id);
    expect(p2.handles[0].scripts[0].id).not.toBe(p1.handles[0].scripts[0].id);

    // Multi-handle flagship template has 2 isolated handles each with independent T0 alias
    const mh = instantiateProjectFromTemplate('multi_handle_robot');
    expect(mh.handles).toHaveLength(2);
    expect(mh.handles[0].name).toBe('led_ctrl');
    expect(mh.handles[1].name).toBe('sensor_hub');
    expect(mh.handles[0].timerConfig.aliases['0']).toBe('心跳灯');
    expect(mh.handles[1].timerConfig.aliases['0']).toBe('温度巡检');
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
    proj = addScriptToProject(proj, 'helper');
    expect(getActiveHandle(proj).scripts).toHaveLength(2);
    expect(getActiveHandle(proj).scripts[1].name).toBe('helper');

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
    expect(store.projects[0].handles).toHaveLength(2);
    expect(store.projects[0].handles[0].id).not.toBe(base.handles[0].id);

    store = deleteProjectFromStore(store, store.activeProjectId);
    expect(store.projects).toHaveLength(1);
    expect(store.activeProjectId).toBe(base.id);
  });

  it('losslessly imports v3, legacy v2, and legacy v1 project JSON files', () => {
    const v1Raw = {
      format: 'polyblock-project',
      version: 1,
      name: 'demo_logger.polyblock.json',
      language: 'python',
      workspace: { blocks: { languageVersion: 0, blocks: [] } },
    };
    const migratedV1 = parseImportedProject(v1Raw, 'fallback');
    expect(migratedV1.version).toBe(3);
    expect(migratedV1.name).toBe('demo_logger');
    expect(migratedV1.language).toBe('python');
    expect(migratedV1.handles).toHaveLength(1);
    expect(migratedV1.handles[0].scripts[0].name).toBe('main');

    const v2Raw = {
      format: 'polyblock-project',
      version: 2,
      name: 'legacy_v2_proj',
      language: 'lua',
      enabledExtensions: ['virtual-board'],
      timerConfig: { count: 16, aliases: { '0': '心跳' } },
      entryScriptId: 's1',
      activeScriptId: 's1',
      scripts: [
        {
          id: 's1',
          name: 'main',
          workspace: { blocks: { languageVersion: 0, blocks: [] } },
          breakpoints: ['b1'],
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    };
    const migratedV2 = parseImportedProject(v2Raw, 'fallback');
    expect(migratedV2.version).toBe(3);
    expect(migratedV2.handles).toHaveLength(1);
    expect(migratedV2.handles[0].timerConfig.count).toBe(16);
    expect(migratedV2.handles[0].timerConfig.aliases['0']).toBe('心跳');
    expect(migratedV2.handles[0].scripts[0].breakpoints).toEqual(['b1']);

    const v3Orig = instantiateProjectFromTemplate('multi_handle_robot');
    const reimported = parseImportedProject(v3Orig, 'fallback', [v3Orig.name]);
    expect(reimported.version).toBe(3);
    expect(reimported.name).toBe('多句柄协同仿真项目 (2)');
    expect(reimported.handles).toHaveLength(2);
  });
});
