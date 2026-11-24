import { describe, expect, it } from 'vitest';
import {
  addScriptToProject,
  deleteProjectFromStore,
  deleteScriptFromProject,
  duplicateProjectInStore,
  duplicateScriptInProject,
  instantiateProjectFromTemplate,
  parseImportedProject,
  renameScriptInProject,
  sanitizeScriptName,
} from '../projects/store';
import type { WorkspaceStoreState } from '../../types/project';

describe('v2 Project-Rooted Multi-Script Store', () => {
  it('instantiates default starter_suite with 3 isolated scripts and main as entry', () => {
    const p1 = instantiateProjectFromTemplate('starter_suite');
    expect(p1.version).toBe(2);
    expect(p1.language).toBe('lua');
    expect(p1.scripts.map((s) => s.name)).toEqual([
      'main',
      'step_debug',
      'threshold_alarm',
    ]);
    expect(p1.entryScriptId).toBe(p1.scripts[0].id);
    expect(p1.activeScriptId).toBe(p1.scripts[0].id);

    // Second instantiation gets deduplicated project name & distinct script IDs
    const p2 = instantiateProjectFromTemplate('starter_suite', [p1.name]);
    expect(p2.name).toBe('入门演示项目 (2)');
    expect(p2.scripts[0].id).not.toBe(p1.scripts[0].id);
  });

  it('sanitizes names and performs script add, rename, duplicate, and safe delete', () => {
    expect(sanitizeScriptName(' sensor_1.lua ')).toBe('sensor_1');
    expect(sanitizeScriptName('a/b:c*.py')).toBe('a_b_c');

    let proj = instantiateProjectFromTemplate('blank_project');
    expect(proj.scripts).toHaveLength(1);

    // Cannot delete last remaining script
    const untouched = deleteScriptFromProject(proj, proj.scripts[0].id);
    expect(untouched.scripts).toHaveLength(1);

    // Add + rename with collision deduplication
    proj = addScriptToProject(proj, 'helper');
    expect(proj.scripts).toHaveLength(2);
    expect(proj.scripts[1].name).toBe('helper');
    expect(proj.activeScriptId).toBe(proj.scripts[1].id);

    proj = renameScriptInProject(proj, proj.scripts[1].id, 'main.lua');
    expect(proj.scripts[1].name).toBe('main_2');

    // Duplicate preserves breakpoints and workspace
    proj.scripts[1].breakpoints = ['blk_1'];
    proj = duplicateScriptInProject(proj, proj.scripts[1].id);
    expect(proj.scripts).toHaveLength(3);
    expect(proj.scripts[2].name).toBe('main_2_copy');
    expect(proj.scripts[2].breakpoints).toEqual(['blk_1']);

    // Deleting entry script promotes fallback cleanly
    const oldEntry = proj.entryScriptId;
    proj = deleteScriptFromProject(proj, oldEntry);
    expect(proj.scripts).toHaveLength(2);
    expect(proj.scripts.some((s) => s.id === proj.entryScriptId)).toBe(true);
  });

  it('duplicates and safely deletes projects in WorkspaceStore', () => {
    const base = instantiateProjectFromTemplate('starter_suite');
    let store: WorkspaceStoreState = {
      version: 2,
      activeProjectId: base.id,
      projects: [base],
    };

    // Guard last project
    expect(deleteProjectFromStore(store, base.id).projects).toHaveLength(1);

    store = duplicateProjectInStore(store, base.id);
    expect(store.projects).toHaveLength(2);
    expect(store.projects[0].name).toContain('副本');
    expect(store.projects[0].scripts[0].id).not.toBe(base.scripts[0].id);

    store = deleteProjectFromStore(store, store.activeProjectId);
    expect(store.projects).toHaveLength(1);
    expect(store.activeProjectId).toBe(base.id);
  });

  it('imports both v2 multi-script JSON and legacy v1 single-canvas JSON', () => {
    const v1Raw = {
      format: 'polyblock-project',
      version: 1,
      name: 'demo_logger.polyblock.json',
      language: 'python',
      workspace: { blocks: { languageVersion: 0, blocks: [] } },
    };
    const migrated = parseImportedProject(v1Raw, 'fallback');
    expect(migrated.version).toBe(2);
    expect(migrated.name).toBe('demo_logger');
    expect(migrated.language).toBe('python');
    expect(migrated.scripts).toHaveLength(1);
    expect(migrated.scripts[0].name).toBe('main');

    const v2Orig = instantiateProjectFromTemplate('starter_suite');
    const reimported = parseImportedProject(v2Orig, 'fallback', [v2Orig.name]);
    expect(reimported.version).toBe(2);
    expect(reimported.name).toBe('入门演示项目 (2)');
    expect(reimported.scripts).toHaveLength(3);
  });
});
