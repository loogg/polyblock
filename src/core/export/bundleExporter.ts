import type { ProjectModel, RuntimeHandle } from '../../types/project';
import { buildHandleScriptsMeta } from '../backends/eventMode';
import { buildHandleSharedModule } from '../backends/sharedModule';
import { backendRegistry } from '../backends/registry';
import { collectHandleSharedVariableNames } from '../projects/handleVariables';
import {
  resolveProjectModules,
  type ModuleConflictItem,
  type ModuleOverrideItem,
} from '../extensions/moduleResolver';
import { extensionRegistry } from '../extensions/registry';
import { getAllHandleChannelPoolConfigs } from '../projects/store';
import { compileScriptHeadless } from '../runners/multiHandleManager';
import { buildZipBytes, type ZipEntryInput } from './zipWriter';

export interface TargetBundleResult {
  fileName: string;
  entries: ZipEntryInput[];
  zipBytes: Uint8Array;
  overrides: ModuleOverrideItem[];
  strippedSandboxMocks: string[];
}

export class ModuleConflictExportError extends Error {
  readonly conflicts: ModuleConflictItem[];

  constructor(conflicts: ModuleConflictItem[]) {
    super(conflicts.map((c) => c.message).join('\n'));
    this.name = 'ModuleConflictExportError';
    this.conflicts = conflicts;
  }
}

/** Converts dotted moduleName (`utils.crc16`) into target path (`utils/crc16.lua`). */
export function moduleNameToRelativeFile(
  moduleName: string,
  ext: string,
): string {
  const segments = moduleName
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '..');
  return `${segments.join('/')}.${ext}`;
}

function compileHandleAllScripts(
  project: ProjectModel,
  handle: RuntimeHandle,
): Array<{ scriptId: string; scriptName: string; code: string }> {
  const pools = extensionRegistry
    .getChannelPools(project.enabledCapabilities, project.localExtensions)
    .map((entry) => entry.pool);
  const poolCfgs = getAllHandleChannelPoolConfigs(handle, pools);
  const sharedVars = collectHandleSharedVariableNames(handle);
  const scriptMetas = buildHandleScriptsMeta(handle);

  const compiled: Array<{ scriptId: string; scriptName: string; code: string }> = [];
  const sharedMod = buildHandleSharedModule(handle, project.language, poolCfgs);
  if (sharedMod) {
    compiled.push({
      scriptId: '__poly_shared__',
      scriptName: sharedMod.moduleName,
      code: sharedMod.source,
    });
  }
  for (const scr of handle.scripts) {
    const res = compileScriptHeadless(scr.workspace, project.language, {
      channelPoolConfigs: poolCfgs,
      enabledCapabilities: project.enabledCapabilities,
      handleScripts: scriptMetas,
      currentScriptId: scr.id,
      sharedVariables: sharedVars,
      sharedVarInitials: handle.variableInitialValues,
      scriptVarInitials: scr.variableInitialValues,
      sharedFunctions: handle.sharedFunctions ?? [],
    });
    compiled.push({
      scriptId: scr.id,
      scriptName: scr.name,
      code: `${res.code}\n`,
    });
  }
  return compiled;
}

/**
 * Exports a SINGLE RuntimeHandle deployment `.zip`:
 * - Flat layout at ZIP root (`main.lua`, `timers.lua`, `crc16.lua`, `crc16_table.lua`)
 *   so target Lua `package.path = "./?.lua"` / Python works with ZERO extra path config!
 * - Strictly strips all `sandboxMock` stubs.
 * - Throws `ModuleConflictExportError` if any same-tier `moduleName` conflict exists.
 */
export function buildSingleHandleTargetBundle(
  project: ProjectModel,
  handle: RuntimeHandle,
): TargetBundleResult {
  const adapter = backendRegistry.get(project.language);
  const ext = adapter.extension;
  extensionRegistry.setActiveProjectLocalPacks(project.localExtensions ?? []);

  const compiledScripts = compileHandleAllScripts(project, handle);
  const resolution = resolveProjectModules({
    enabledCapabilities: project.enabledCapabilities,
    localExtensions: project.localExtensions,
    handleScripts: compiledScripts.map((s) => ({
      scriptId: s.scriptId,
      scriptName: s.scriptName,
      sources: { [project.language]: s.code },
    })),
  });

  if (resolution.conflicts.length > 0) {
    throw new ModuleConflictExportError(resolution.conflicts);
  }

  const entries: ZipEntryInput[] = [];
  const usedPaths = new Set<string>();

  for (const s of compiledScripts) {
    const filePath = `${s.scriptName}.${ext}`;
    usedPaths.add(filePath);
    entries.push({ path: filePath, content: s.code });
  }

  const exportedLibMeta: Array<{
    moduleName: string;
    path: string;
    owner: string;
    tier: string;
  }> = [];

  for (const lib of resolution.exportLibs) {
    const src = lib.source.sources[project.language];
    if (!src) continue;
    const relPath = moduleNameToRelativeFile(lib.moduleName, ext);
    if (usedPaths.has(relPath)) continue; // Handle script already won at Tier 1
    usedPaths.add(relPath);
    entries.push({ path: relPath, content: src.endsWith('\n') ? src : `${src}\n` });
    exportedLibMeta.push({
      moduleName: lib.moduleName,
      path: relPath,
      owner: lib.ownerLabel,
      tier: lib.tier,
    });
  }

  const strippedSandboxMocks = Array.from(resolution.resolvedByName.values())
    .filter((r) => !r.isRealLib)
    .map((r) => r.moduleName);

  const manifest = {
    format: 'polyblock-target-bundle',
    scope: 'single-handle',
    projectName: project.name,
    handleName: handle.name,
    language: project.language,
    exportedAt: new Date().toISOString(),
    entry: `${
      handle.scripts.find((s) => s.id === handle.entryScriptId)?.name ??
      handle.scripts[0]?.name ??
      'main'
    }.${ext}`,
    files: entries.map((e) => e.path),
    libs: exportedLibMeta,
    overrides: resolution.overrides.map((o) => ({
      moduleName: o.moduleName,
      winner: o.winner.ownerLabel,
      shadowed: o.shadowed.map((s) => s.ownerLabel),
    })),
    strippedSandboxMocks,
  };
  entries.push({
    path: 'manifest.json',
    content: `${JSON.stringify(manifest, null, 2)}\n`,
  });

  const safeProj = project.name.replace(/[\\/:*?"<>|\s]+/g, '_');
  const fileName = `${safeProj}_${handle.name}_bundle.zip`;

  return {
    fileName,
    entries,
    zipBytes: buildZipBytes(entries),
    overrides: resolution.overrides,
    strippedSandboxMocks,
  };
}

/**
 * Exports the ENTIRE Project deployment `.zip`:
 * - Each handle under `<handleName>/<script>.<ext>` (e.g. `drive_ctrl/main.lua`, `sensor_guard/main.lua`)
 * - Shared real `libs[]` flat under `libs/<modulePath>.<ext>` (e.g. `libs/crc16.lua`, `libs/crc16_table.lua`)
 * - Strictly strips all `sandboxMock` stubs.
 * - Throws `ModuleConflictExportError` if any same-tier `moduleName` conflict exists.
 */
export function buildProjectTargetBundle(
  project: ProjectModel,
): TargetBundleResult {
  const adapter = backendRegistry.get(project.language);
  const ext = adapter.extension;
  extensionRegistry.setActiveProjectLocalPacks(project.localExtensions ?? []);

  // Validate project-wide pack module resolution first (same-tier conflicts block export)
  const projectRes = resolveProjectModules({
    enabledCapabilities: project.enabledCapabilities,
    localExtensions: project.localExtensions,
  });
  if (projectRes.conflicts.length > 0) {
    throw new ModuleConflictExportError(projectRes.conflicts);
  }

  const entries: ZipEntryInput[] = [];
  const handleSummaries: Array<{
    name: string;
    autoStart: boolean;
    entry: string;
    files: string[];
  }> = [];

  for (const handle of project.handles) {
    const compiledScripts = compileHandleAllScripts(project, handle);
    const hdlFiles: string[] = [];
    for (const s of compiledScripts) {
      const p = `${handle.name}/${s.scriptName}.${ext}`;
      hdlFiles.push(p);
      entries.push({ path: p, content: s.code });
    }
    const entryName =
      handle.scripts.find((s) => s.id === handle.entryScriptId)?.name ??
      handle.scripts[0]?.name ??
      'main';
    handleSummaries.push({
      name: handle.name,
      autoStart: handle.autoStart,
      entry: `${handle.name}/${entryName}.${ext}`,
      files: hdlFiles,
    });
  }

  const exportedLibMeta: Array<{
    moduleName: string;
    path: string;
    owner: string;
    tier: string;
  }> = [];

  for (const lib of projectRes.exportLibs) {
    const src = lib.source.sources[project.language];
    if (!src) continue;
    const relPath = `libs/${moduleNameToRelativeFile(lib.moduleName, ext)}`;
    entries.push({ path: relPath, content: src.endsWith('\n') ? src : `${src}\n` });
    exportedLibMeta.push({
      moduleName: lib.moduleName,
      path: relPath,
      owner: lib.ownerLabel,
      tier: lib.tier,
    });
  }

  const strippedSandboxMocks = Array.from(projectRes.resolvedByName.values())
    .filter((r) => !r.isRealLib)
    .map((r) => r.moduleName);

  const manifest = {
    format: 'polyblock-target-bundle',
    scope: 'project',
    projectName: project.name,
    language: project.language,
    exportedAt: new Date().toISOString(),
    handles: handleSummaries,
    sharedLibsDir: exportedLibMeta.length > 0 ? 'libs/' : null,
    libs: exportedLibMeta,
    overrides: projectRes.overrides.map((o) => ({
      moduleName: o.moduleName,
      winner: o.winner.ownerLabel,
      shadowed: o.shadowed.map((s) => s.ownerLabel),
    })),
    strippedSandboxMocks,
  };
  entries.push({
    path: 'manifest.json',
    content: `${JSON.stringify(manifest, null, 2)}\n`,
  });

  const safeProj = project.name.replace(/[\\/:*?"<>|\s]+/g, '_');
  const fileName = `${safeProj}_project_bundle.zip`;

  return {
    fileName,
    entries,
    zipBytes: buildZipBytes(entries),
    overrides: projectRes.overrides,
    strippedSandboxMocks,
  };
}
