import {
  normalizeLanguageId,
  stripScriptExtension,
} from '../backends/registry';
import {
  DEFAULT_CHANNEL_COUNT,
  MAX_CHANNEL_COUNT,
  MIN_CHANNEL_COUNT,
  normalizeChannelPoolConfig,
} from '../blocks/workspaceContextBridge';
import { targetProfileRegistry } from '../capabilities/registry';
import {
  extensionRegistry,
  validateExtensionPack,
} from '../extensions/registry';
import type {
  PolyExtensionPack,
  ResolvedHandleChannelPoolSpec,
} from '../extensions/types';
import { normalizeVariableInitialValue } from './handleVariables';
import {
  createBlankWorkspace,
  DEMO_PROJECTS,
  getDemoProjectById,
  type BuiltinDemoEntry,
} from './builtinDemos';
import type {
  ChannelPoolConfig,
  ProjectModel,
  ProjectScript,
  RuntimeHandle,
  TargetProfile,
  VariableInitialValue,
  WorkspaceStoreState,
} from '../../types/project';

export {
  createBlankWorkspace,
  DEMO_PROJECTS,
  getDemoProjectById,
  type BuiltinDemoEntry,
};

export const STORAGE_STORE_V9_KEY = 'polyblock.store.v9';

export const HANDLE_COLOR_PALETTE = [
  '#4f46e5',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#8b5cf6',
];

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

/** Blank canvas for auxiliary module/callback scripts inside an existing handle (no duplicate `on_start`). */
export function createBlankModuleWorkspace(): Record<string, unknown> {
  return {
    blocks: {
      languageVersion: 0,
      blocks: [],
    },
  };
}

export function sanitizeScriptName(raw: string): string {
  const withoutExt = stripScriptExtension(
    raw.trim().replace(/\.(?:polyblock\.json|json)$/i, ''),
  );
  const cleaned = withoutExt
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'script';
}

export function sanitizeHandleName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'handle';
}

export function makeUniqueScriptName(
  desired: string,
  existingNames: string[],
  excludeCurrent?: string,
): string {
  const base = sanitizeScriptName(desired);
  const used = new Set(
    existingNames
      .filter((n) => n !== excludeCurrent)
      .map((n) => n.toLowerCase()),
  );
  if (!used.has(base.toLowerCase())) return base;
  let idx = 2;
  while (used.has(`${base}_${idx}`.toLowerCase())) {
    idx += 1;
  }
  return `${base}_${idx}`;
}

export function makeUniqueHandleName(
  desired: string,
  existingNames: string[],
  excludeCurrent?: string,
): string {
  const base = sanitizeHandleName(desired);
  const used = new Set(
    existingNames
      .filter((n) => n !== excludeCurrent)
      .map((n) => n.toLowerCase()),
  );
  if (!used.has(base.toLowerCase())) return base;
  let idx = 2;
  while (used.has(`${base}_${idx}`.toLowerCase())) {
    idx += 1;
  }
  return `${base}_${idx}`;
}

export function makeUniqueProjectName(
  desired: string,
  existingNames: string[],
  excludeCurrent?: string,
): string {
  const base = desired.trim() || '未命名项目';
  const used = new Set(
    existingNames
      .filter((n) => n !== excludeCurrent)
      .map((n) => n.toLowerCase()),
  );
  if (!used.has(base.toLowerCase())) return base;
  let idx = 2;
  while (used.has(`${base} (${idx})`.toLowerCase())) {
    idx += 1;
  }
  return `${base} (${idx})`;
}

export function getHandleChannelPoolConfig(
  handle: RuntimeHandle,
  configKey: string,
  fallbackCount = DEFAULT_CHANNEL_COUNT,
  minCount = MIN_CHANNEL_COUNT,
  maxCount = MAX_CHANNEL_COUNT,
): ChannelPoolConfig {
  const fromCap = handle.capabilityConfigs?.[configKey] as
    | Partial<ChannelPoolConfig>
    | undefined;
  return normalizeChannelPoolConfig(fromCap, fallbackCount, minCount, maxCount);
}

export function setHandleChannelPoolConfig(
  handle: RuntimeHandle,
  configKey: string,
  nextCfg: ChannelPoolConfig,
  minCount = MIN_CHANNEL_COUNT,
  maxCount = MAX_CHANNEL_COUNT,
): RuntimeHandle {
  return {
    ...handle,
    capabilityConfigs: {
      ...(handle.capabilityConfigs ?? {}),
      [configKey]: normalizeChannelPoolConfig(nextCfg, nextCfg.count, minCount, maxCount),
    },
    updatedAt: new Date().toISOString(),
  };
}

export function getAllHandleChannelPoolConfigs(
  handle: RuntimeHandle,
  channelPools: ResolvedHandleChannelPoolSpec[],
): Record<string, ChannelPoolConfig> {
  const out: Record<string, ChannelPoolConfig> = {};
  for (const pool of channelPools) {
    out[pool.configKey] = getHandleChannelPoolConfig(
      handle,
      pool.configKey,
      pool.defaultCount,
      pool.min,
      pool.max,
    );
  }
  return out;
}

/** Formats concise per-handle summary badges across all enabled declarative channel pools (e.g. `T0~7 · PWM0~3`). */
export function formatHandleChannelPoolsSummary(
  handle: RuntimeHandle,
  channelPools: ResolvedHandleChannelPoolSpec[],
): string {
  return channelPools
    .map((pool) => {
      const cfg = getHandleChannelPoolConfig(
        handle,
        pool.configKey,
        pool.defaultCount,
        pool.min,
        pool.max,
      );
      return `${pool.prefix}0~${cfg.count - 1}`;
    })
    .join(' · ');
}

function normalizeLocalExtensions(raw: unknown): PolyExtensionPack[] {
  if (!Array.isArray(raw)) return [];
  const map = new Map<string, PolyExtensionPack>();
  for (const item of raw) {
    try {
      const valid = validateExtensionPack(item);
      map.set(valid.id, valid);
    } catch {
      // ignore malformed extension entry
    }
  }
  return Array.from(map.values());
}

/**
 * Prepares a portable .polyblock.json export payload:
 * - Preserves project-embedded `localExtensions`.
 * - Auto-snapshots any non-builtin GLOBAL packs referenced in `enabledCapabilities`
 *   into `bundledExtensions` so recipients open the project out-of-the-box.
 */
export function buildExportableProjectJson(
  project: ProjectModel,
  globalPacks: PolyExtensionPack[] = extensionRegistry.listAll(),
): ProjectModel {
  const localPacks = project.localExtensions ?? [];
  const localIds = new Set(localPacks.map((p) => p.id));
  const seenBundled = new Set<string>();
  const bundled: PolyExtensionPack[] = [];

  for (const capId of project.enabledCapabilities) {
    const dotIdx = capId.indexOf('.');
    const basePackId = dotIdx > 0 ? capId.slice(0, dotIdx) : capId;
    if (localIds.has(basePackId) || seenBundled.has(basePackId)) continue;
    const globalPack = globalPacks.find((p) => p.id === basePackId);
    if (globalPack && !extensionRegistry.isBuiltin(globalPack.id)) {
      seenBundled.add(basePackId);
      bundled.push(cloneJson(globalPack));
    }
  }

  const base: ProjectModel = cloneJson(project);
  delete base.bundledExtensions;
  if (localPacks.length > 0) {
    base.localExtensions = cloneJson(localPacks);
  } else {
    delete base.localExtensions;
  }
  if (bundled.length > 0) {
    base.bundledExtensions = bundled;
  }
  return base;
}

/**
 * Computes which bundled global snapshots in an imported JSON should be absorbed
 * unconditionally as project-local embedded packs:
 * - Always absorb every bundled pack not already present in `localExtensions`
 *   (regardless of whether the recipient's global library has the same ID/version,
 *   because two files with the same ID+version can still have different block definitions).
 * - Guarantees 100% deterministic reproduction with zero global-library pollution;
 *   the user can remove the local override at any time to fall back to their global pack.
 */
export function getAbsorbedBundledExtensions(
  raw: unknown,
): PolyExtensionPack[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const localIds = new Set(normalizeLocalExtensions(obj.localExtensions).map((p) => p.id));
  return normalizeLocalExtensions(obj.bundledExtensions).filter(
    (p) => !localIds.has(p.id),
  );
}

export function applyTargetProfileToProject(
  project: ProjectModel,
  profile: TargetProfile,
): ProjectModel {
  const now = new Date().toISOString();
  return {
    ...project,
    targetProfileId: profile.id,
    enabledCapabilities: [...profile.capabilities],
    updatedAt: now,
  };
}

function normalizeInitialValuesMap(
  raw: unknown,
): Record<string, VariableInitialValue> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, VariableInitialValue> = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim();
    if (!key) continue;
    out[key] = normalizeVariableInitialValue(v as VariableInitialValue);
    count += 1;
  }
  return count > 0 ? out : undefined;
}

export function instantiateProjectFromTemplate(
  templateId: string,
  existingProjectNames: string[] = [],
  customName?: string,
): ProjectModel {
  if (templateId === 'blank_project') {
    const profile = targetProfileRegistry.get('generic-script');
    return instantiateProjectFromProfile(
      profile,
      existingProjectNames,
      customName ?? '空白工程',
    );
  }
  const demo = getDemoProjectById(templateId) ?? DEMO_PROJECTS[0];
  const base = parseImportedProject(
    demo.project,
    customName ?? demo.project.name,
    existingProjectNames,
  );
  if (customName) {
    return {
      ...base,
      name: makeUniqueProjectName(customName, existingProjectNames),
    };
  }
  return base;
}

/** Creates the clean initial workspace store preloaded with the built-in demos from `src/demos/`. */
export function createDefaultWorkspaceStore(): WorkspaceStoreState {
  const projects: ProjectModel[] = [];
  for (const demo of DEMO_PROJECTS) {
    projects.push(
      instantiateProjectFromTemplate(
        demo.id,
        projects.map((p) => p.name),
      ),
    );
  }
  return {
    version: 3,
    activeProjectId: projects[0].id,
    projects,
  };
}

export function instantiateProjectFromProfile(
  profile: TargetProfile,
  existingProjectNames: string[] = [],
  customName?: string,
): ProjectModel {
  const now = new Date().toISOString();
  const scriptId = createId('scr');
  const capabilityConfigs: Record<string, unknown> = {};
  if (profile.defaultChannelCounts) {
    for (const [cfgKey, cnt] of Object.entries(profile.defaultChannelCounts)) {
      capabilityConfigs[cfgKey] = normalizeChannelPoolConfig(undefined, cnt);
    }
  }
  const handle: RuntimeHandle = {
    id: createId('hdl'),
    name: 'main_vm',
    color: HANDLE_COLOR_PALETTE[0],
    autoStart: true,
    capabilityConfigs,
    sharedVariables: [],
    sharedFunctions: [],
    entryScriptId: scriptId,
    activeScriptId: scriptId,
    scripts: [
      {
        id: scriptId,
        name: 'main',
        workspace: createBlankWorkspace(),
        breakpoints: [],
        updatedAt: now,
      },
    ],
    updatedAt: now,
  };
  return {
    format: 'polyblock-project',
    version: 3,
    id: createId('proj'),
    name: makeUniqueProjectName(
      customName ?? `${profile.name.split('（')[0]}工程`,
      existingProjectNames,
    ),
    description: profile.description,
    language: profile.defaultLanguage,
    targetProfileId: profile.id,
    enabledCapabilities: [...profile.capabilities],
    localExtensions: [],
    activeHandleId: handle.id,
    handles: [handle],
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeScriptsArray(
  rawScripts: Array<Record<string, unknown>>,
  now: string,
  regenerateIds: boolean,
): { scripts: ProjectScript[]; idMap: Map<string, string> } {
  const usedNames: string[] = [];
  const idMap = new Map<string, string>();
  const scripts: ProjectScript[] = rawScripts.map((rs, idx) => {
    const rawName =
      typeof rs.name === 'string'
        ? rs.name
        : idx === 0
          ? 'main'
          : `script_${idx + 1}`;
    const name = regenerateIds ? makeUniqueScriptName(rawName, usedNames) : rawName;
    if (regenerateIds) usedNames.push(name);

    const scriptId =
      !regenerateIds && typeof rs.id === 'string' ? rs.id : createId('scr');
    if (typeof rs.id === 'string') {
      idMap.set(rs.id, scriptId);
    }
    const scriptInitials = normalizeInitialValuesMap(rs.variableInitialValues);
    const workspace =
      rs.workspace && typeof rs.workspace === 'object'
        ? regenerateIds
          ? cloneJson(rs.workspace as Record<string, unknown>)
          : (rs.workspace as Record<string, unknown>)
        : createBlankWorkspace();

    return {
      id: scriptId,
      name,
      workspace,
      breakpoints: Array.isArray(rs.breakpoints)
        ? rs.breakpoints.filter((b): b is string => typeof b === 'string')
        : [],
      ...(scriptInitials ? { variableInitialValues: scriptInitials } : {}),
      updatedAt: typeof rs.updatedAt === 'string' ? rs.updatedAt : now,
    };
  });
  return { scripts, idMap };
}

function normalizeProjectHandles(
  rawHandles: Array<Record<string, unknown>>,
  now: string,
  regenerateIds: boolean,
): { handles: RuntimeHandle[]; handleIdMap: Map<string, string> } {
  const usedHandleNames: string[] = [];
  const handleIdMap = new Map<string, string>();

  const handles: RuntimeHandle[] = rawHandles.map((rh, hIdx) => {
    const rawName = typeof rh.name === 'string' ? rh.name : `handle_${hIdx + 1}`;
    const hName = regenerateIds
      ? makeUniqueHandleName(rawName, usedHandleNames)
      : rawName;
    if (regenerateIds) usedHandleNames.push(hName);

    const rawScripts =
      Array.isArray(rh.scripts) && rh.scripts.length > 0
        ? (rh.scripts as Array<Record<string, unknown>>)
        : [{ name: 'main', workspace: createBlankWorkspace() }];
    const { scripts, idMap } = normalizeScriptsArray(rawScripts, now, regenerateIds);

    const mappedEntryId =
      typeof rh.entryScriptId === 'string' ? idMap.get(rh.entryScriptId) : undefined;
    const entryId =
      mappedEntryId && scripts.some((s) => s.id === mappedEntryId)
        ? mappedEntryId
        : scripts[0].id;

    const mappedActiveId =
      !regenerateIds && typeof rh.activeScriptId === 'string'
        ? idMap.get(rh.activeScriptId)
        : undefined;
    const activeId =
      mappedActiveId && scripts.some((s) => s.id === mappedActiveId)
        ? mappedActiveId
        : entryId;

    const handleId =
      !regenerateIds && typeof rh.id === 'string' ? rh.id : createId('hdl');
    if (typeof rh.id === 'string') {
      handleIdMap.set(rh.id, handleId);
    }

    const capCfgs =
      rh.capabilityConfigs && typeof rh.capabilityConfigs === 'object'
        ? cloneJson(rh.capabilityConfigs as Record<string, unknown>)
        : {};
    const handleInitials = normalizeInitialValuesMap(rh.variableInitialValues);

    return {
      id: handleId,
      name: hName,
      description: typeof rh.description === 'string' ? rh.description : undefined,
      color:
        typeof rh.color === 'string' && rh.color.startsWith('#')
          ? rh.color
          : HANDLE_COLOR_PALETTE[hIdx % HANDLE_COLOR_PALETTE.length],
      autoStart: rh.autoStart !== false,
      capabilityConfigs: capCfgs,
      sharedVariables: Array.isArray(rh.sharedVariables)
        ? rh.sharedVariables.filter(
            (v): v is string => typeof v === 'string' && v.trim().length > 0,
          )
        : [],
      sharedFunctions: Array.isArray(rh.sharedFunctions)
        ? rh.sharedFunctions.filter(
            (v): v is string => typeof v === 'string' && v.trim().length > 0,
          )
        : [],
      ...(handleInitials ? { variableInitialValues: handleInitials } : {}),
      entryScriptId: entryId,
      activeScriptId: activeId,
      scripts,
      updatedAt: typeof rh.updatedAt === 'string' ? rh.updatedAt : now,
    };
  });

  return { handles, handleIdMap };
}

function normalizeLoadedV3Project(raw: Record<string, unknown>): ProjectModel {
  const now = new Date().toISOString();
  const rawHandles = Array.isArray(raw.handles)
    ? (raw.handles as Array<Record<string, unknown>>)
    : [];
  const { handles } = normalizeProjectHandles(rawHandles, now, false);

  const enabledCapabilities = Array.isArray(raw.enabledCapabilities)
    ? raw.enabledCapabilities.filter((c): c is string => typeof c === 'string')
    : [];

  const profileId =
    typeof raw.targetProfileId === 'string' && raw.targetProfileId.trim()
      ? raw.targetProfileId
      : 'generic-script';

  const activeHandleId =
    typeof raw.activeHandleId === 'string' &&
    handles.some((h) => h.id === raw.activeHandleId)
      ? raw.activeHandleId
      : handles[0].id;

  return {
    format: 'polyblock-project',
    version: 3,
    id: typeof raw.id === 'string' ? raw.id : createId('proj'),
    name: typeof raw.name === 'string' ? raw.name : '未命名项目',
    description: typeof raw.description === 'string' ? raw.description : undefined,
    language: normalizeLanguageId(raw.language),
    targetProfileId: profileId,
    enabledCapabilities,
    localExtensions: normalizeLocalExtensions(raw.localExtensions),
    activeHandleId,
    handles,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
  };
}

export function parseImportedProject(
  raw: unknown,
  fallbackName: string,
  existingProjectNames: string[] = [],
): ProjectModel {
  if (!raw || typeof raw !== 'object') {
    throw new Error('工程文件格式无效');
  }
  const obj = raw as Record<string, unknown>;
  const now = new Date().toISOString();

  if (obj.version !== 3 || !Array.isArray(obj.handles) || obj.handles.length === 0) {
    throw new Error('仅支持 PolyBlock v3 工程格式（缺少 version: 3 或 handles 数据）');
  }

  const rawHandles = obj.handles as Array<Record<string, unknown>>;
  const { handles, handleIdMap } = normalizeProjectHandles(rawHandles, now, true);

  const activeHandleId =
    (typeof obj.activeHandleId === 'string' &&
      handleIdMap.get(obj.activeHandleId)) ||
    handles[0].id;

  const enabledCapabilities = Array.isArray(obj.enabledCapabilities)
    ? obj.enabledCapabilities.filter((c): c is string => typeof c === 'string')
    : [];

  const targetProfileId =
    typeof obj.targetProfileId === 'string' && obj.targetProfileId.trim()
      ? obj.targetProfileId
      : 'generic-script';

  const localPacks = normalizeLocalExtensions(obj.localExtensions);
  const absorbedBundled = getAbsorbedBundledExtensions(obj);
  const mergedLocalExtensions = [...localPacks, ...absorbedBundled];

  return {
    format: 'polyblock-project',
    version: 3,
    id: createId('proj'),
    name: makeUniqueProjectName(
      typeof obj.name === 'string' && obj.name.trim() ? obj.name : fallbackName,
      existingProjectNames,
    ),
    description: typeof obj.description === 'string' ? obj.description : undefined,
    language: normalizeLanguageId(obj.language),
    targetProfileId,
    enabledCapabilities,
    localExtensions: mergedLocalExtensions,
    activeHandleId,
    handles,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : now,
    updatedAt: now,
  };
}

export function getActiveProject(store: WorkspaceStoreState): ProjectModel {
  return (
    store.projects.find((p) => p.id === store.activeProjectId) ?? store.projects[0]
  );
}

export function getActiveHandle(project: ProjectModel): RuntimeHandle {
  return (
    project.handles.find((h) => h.id === project.activeHandleId) ??
    project.handles[0]
  );
}

export function getActiveScript(handle: RuntimeHandle): ProjectScript {
  return (
    handle.scripts.find((s) => s.id === handle.activeScriptId) ??
    handle.scripts[0]
  );
}

export function countProjectScripts(project: ProjectModel): number {
  return project.handles.reduce((acc, h) => acc + h.scripts.length, 0);
}

export function loadWorkspaceStore(): WorkspaceStoreState {
  try {
    const rawCurrent = localStorage.getItem(STORAGE_STORE_V9_KEY);
    if (rawCurrent) {
      const parsed = JSON.parse(rawCurrent) as WorkspaceStoreState;
      if (
        parsed &&
        parsed.version === 3 &&
        Array.isArray(parsed.projects) &&
        parsed.projects.length > 0 &&
        parsed.projects.every(
          (p) =>
            Array.isArray(p.handles) &&
            p.handles.length > 0 &&
            p.handles.every((h) => Array.isArray(h.scripts) && h.scripts.length > 0),
        )
      ) {
        targetProfileRegistry.ensureInitialized();
        return {
          ...parsed,
          projects: parsed.projects.map((p) =>
            normalizeLoadedV3Project(p as unknown as Record<string, unknown>),
          ),
        };
      }
    }
  } catch {
    // fall through to clean defaults
  }

  return createDefaultWorkspaceStore();
}

export function saveWorkspaceStore(store: WorkspaceStoreState): void {
  try {
    localStorage.setItem(STORAGE_STORE_V9_KEY, JSON.stringify(store));
  } catch {
    // ignore storage quota errors
  }
}

/* ============================================================================
   Pure Immutable Store Reducers (Unit-Tested · Project / Handle / Script)
   ============================================================================ */
export function updateProjectById(
  store: WorkspaceStoreState,
  projectId: string,
  updater: (project: ProjectModel) => ProjectModel,
): WorkspaceStoreState {
  return {
    ...store,
    projects: store.projects.map((p) =>
      p.id === projectId ? updater(p) : p,
    ),
  };
}

export function updateHandleById(
  project: ProjectModel,
  handleId: string,
  updater: (handle: RuntimeHandle) => RuntimeHandle,
): ProjectModel {
  return {
    ...project,
    handles: project.handles.map((h) =>
      h.id === handleId ? updater(h) : h,
    ),
    updatedAt: new Date().toISOString(),
  };
}

export function addHandleToProject(
  project: ProjectModel,
  desiredName?: string,
  initialWorkspace?: Record<string, unknown>,
): ProjectModel {
  const now = new Date().toISOString();
  const baseName = desiredName ?? `handle_${project.handles.length + 1}`;
  const uniqueName = makeUniqueHandleName(
    baseName,
    project.handles.map((h) => h.name),
  );
  const scriptId = createId('scr');
  const profile = targetProfileRegistry.get(project.targetProfileId);
  const capabilityConfigs: Record<string, unknown> = {};
  if (profile.defaultChannelCounts) {
    for (const [cfgKey, cnt] of Object.entries(profile.defaultChannelCounts)) {
      capabilityConfigs[cfgKey] = normalizeChannelPoolConfig(undefined, cnt);
    }
  }
  const newHandle: RuntimeHandle = {
    id: createId('hdl'),
    name: uniqueName,
    color: HANDLE_COLOR_PALETTE[project.handles.length % HANDLE_COLOR_PALETTE.length],
    autoStart: true,
    capabilityConfigs,
    sharedVariables: [],
    sharedFunctions: [],
    entryScriptId: scriptId,
    activeScriptId: scriptId,
    scripts: [
      {
        id: scriptId,
        name: 'main',
        workspace: initialWorkspace
          ? cloneJson(initialWorkspace)
          : createBlankWorkspace(),
        breakpoints: [],
        updatedAt: now,
      },
    ],
    updatedAt: now,
  };

  return {
    ...project,
    activeHandleId: newHandle.id,
    handles: [...project.handles, newHandle],
    updatedAt: now,
  };
}

export function renameHandleInProject(
  project: ProjectModel,
  handleId: string,
  nextName: string,
): ProjectModel {
  const target = project.handles.find((h) => h.id === handleId);
  if (!target) return project;
  const unique = makeUniqueHandleName(
    nextName,
    project.handles.map((h) => h.name),
    target.name,
  );
  const now = new Date().toISOString();
  return updateHandleById(project, handleId, (h) => ({
    ...h,
    name: unique,
    updatedAt: now,
  }));
}

export function duplicateHandleInProject(
  project: ProjectModel,
  handleId: string,
): ProjectModel {
  const target = project.handles.find((h) => h.id === handleId);
  if (!target) return project;
  const now = new Date().toISOString();
  const scriptIdMap = new Map<string, string>();
  const clonedScripts: ProjectScript[] = target.scripts.map((s) => {
    const sid = createId('scr');
    scriptIdMap.set(s.id, sid);
    return {
      ...cloneJson(s),
      id: sid,
      updatedAt: now,
    };
  });
  const copy: RuntimeHandle = {
    ...target,
    id: createId('hdl'),
    name: makeUniqueHandleName(
      `${target.name}_copy`,
      project.handles.map((h) => h.name),
    ),
    color: HANDLE_COLOR_PALETTE[project.handles.length % HANDLE_COLOR_PALETTE.length],
    capabilityConfigs: cloneJson(target.capabilityConfigs ?? {}),
    sharedVariables: Array.isArray(target.sharedVariables)
      ? [...target.sharedVariables]
      : [],
    sharedFunctions: Array.isArray(target.sharedFunctions)
      ? [...target.sharedFunctions]
      : [],
    ...(target.variableInitialValues
      ? { variableInitialValues: cloneJson(target.variableInitialValues) }
      : {}),
    entryScriptId: scriptIdMap.get(target.entryScriptId) ?? clonedScripts[0].id,
    activeScriptId: scriptIdMap.get(target.activeScriptId) ?? clonedScripts[0].id,
    scripts: clonedScripts,
    updatedAt: now,
  };
  const idx = project.handles.findIndex((h) => h.id === handleId);
  const nextHandles = [...project.handles];
  nextHandles.splice(idx + 1, 0, copy);
  return {
    ...project,
    activeHandleId: copy.id,
    handles: nextHandles,
    updatedAt: now,
  };
}

export function deleteHandleFromProject(
  project: ProjectModel,
  handleId: string,
): ProjectModel {
  if (project.handles.length <= 1) return project;
  const idx = project.handles.findIndex((h) => h.id === handleId);
  if (idx === -1) return project;
  const nextHandles = project.handles.filter((h) => h.id !== handleId);
  const fallback = nextHandles[Math.max(0, idx - 1)] ?? nextHandles[0];
  return {
    ...project,
    activeHandleId:
      project.activeHandleId === handleId ? fallback.id : project.activeHandleId,
    handles: nextHandles,
    updatedAt: new Date().toISOString(),
  };
}

export function addScriptToHandle(
  handle: RuntimeHandle,
  desiredName?: string,
  workspace?: Record<string, unknown>,
): RuntimeHandle {
  const now = new Date().toISOString();
  const baseName = desiredName ?? `script_${handle.scripts.length + 1}`;
  const uniqueName = makeUniqueScriptName(
    baseName,
    handle.scripts.map((s) => s.name),
  );
  const newScript: ProjectScript = {
    id: createId('scr'),
    name: uniqueName,
    workspace: workspace
      ? cloneJson(workspace)
      : handle.scripts.length > 0
        ? createBlankModuleWorkspace()
        : createBlankWorkspace(),
    breakpoints: [],
    updatedAt: now,
  };
  return {
    ...handle,
    activeScriptId: newScript.id,
    scripts: [...handle.scripts, newScript],
    updatedAt: now,
  };
}

export function renameScriptInHandle(
  handle: RuntimeHandle,
  scriptId: string,
  nextName: string,
): RuntimeHandle {
  const target = handle.scripts.find((s) => s.id === scriptId);
  if (!target) return handle;
  const unique = makeUniqueScriptName(
    nextName,
    handle.scripts.map((s) => s.name),
    target.name,
  );
  const now = new Date().toISOString();
  return {
    ...handle,
    scripts: handle.scripts.map((s) =>
      s.id === scriptId ? { ...s, name: unique, updatedAt: now } : s,
    ),
    updatedAt: now,
  };
}

export function duplicateScriptInHandle(
  handle: RuntimeHandle,
  scriptId: string,
): RuntimeHandle {
  const target = handle.scripts.find((s) => s.id === scriptId);
  if (!target) return handle;
  const now = new Date().toISOString();
  const unique = makeUniqueScriptName(
    `${target.name}_copy`,
    handle.scripts.map((s) => s.name),
  );
  const copy: ProjectScript = {
    id: createId('scr'),
    name: unique,
    workspace: cloneJson(target.workspace),
    breakpoints: [...target.breakpoints],
    ...(target.variableInitialValues
      ? { variableInitialValues: cloneJson(target.variableInitialValues) }
      : {}),
    updatedAt: now,
  };
  const idx = handle.scripts.findIndex((s) => s.id === scriptId);
  const nextScripts = [...handle.scripts];
  nextScripts.splice(idx + 1, 0, copy);
  return {
    ...handle,
    activeScriptId: copy.id,
    scripts: nextScripts,
    updatedAt: now,
  };
}

export function deleteScriptFromHandle(
  handle: RuntimeHandle,
  scriptId: string,
): RuntimeHandle {
  if (handle.scripts.length <= 1) return handle;
  const idx = handle.scripts.findIndex((s) => s.id === scriptId);
  if (idx === -1) return handle;

  const nextScripts = handle.scripts.filter((s) => s.id !== scriptId);
  const fallback = nextScripts[Math.max(0, idx - 1)] ?? nextScripts[0];
  const now = new Date().toISOString();

  return {
    ...handle,
    activeScriptId:
      handle.activeScriptId === scriptId ? fallback.id : handle.activeScriptId,
    entryScriptId:
      handle.entryScriptId === scriptId ? fallback.id : handle.entryScriptId,
    scripts: nextScripts,
    updatedAt: now,
  };
}

export function duplicateProjectInStore(
  store: WorkspaceStoreState,
  projectId: string,
): WorkspaceStoreState {
  const target = store.projects.find((p) => p.id === projectId);
  if (!target) return store;
  const now = new Date().toISOString();
  const handleIdMap = new Map<string, string>();
  const clonedHandles: RuntimeHandle[] = target.handles.map((h) => {
    const newHId = createId('hdl');
    handleIdMap.set(h.id, newHId);
    const scriptIdMap = new Map<string, string>();
    const clonedScripts = h.scripts.map((s) => {
      const sid = createId('scr');
      scriptIdMap.set(s.id, sid);
      return { ...cloneJson(s), id: sid, updatedAt: now };
    });
    return {
      ...h,
      id: newHId,
      capabilityConfigs: cloneJson(h.capabilityConfigs ?? {}),
      sharedVariables: [...(h.sharedVariables ?? [])],
      sharedFunctions: [...(h.sharedFunctions ?? [])],
      ...(h.variableInitialValues
        ? { variableInitialValues: cloneJson(h.variableInitialValues) }
        : {}),
      entryScriptId: scriptIdMap.get(h.entryScriptId) ?? clonedScripts[0].id,
      activeScriptId: scriptIdMap.get(h.activeScriptId) ?? clonedScripts[0].id,
      scripts: clonedScripts,
      updatedAt: now,
    };
  });

  const copy: ProjectModel = {
    ...target,
    id: createId('proj'),
    name: makeUniqueProjectName(
      `${target.name} 副本`,
      store.projects.map((p) => p.name),
    ),
    enabledCapabilities: [...target.enabledCapabilities],
    localExtensions: cloneJson(target.localExtensions ?? []),
    activeHandleId: handleIdMap.get(target.activeHandleId) ?? clonedHandles[0].id,
    handles: clonedHandles,
    createdAt: now,
    updatedAt: now,
  };

  return {
    ...store,
    activeProjectId: copy.id,
    projects: [copy, ...store.projects],
  };
}

export function deleteProjectFromStore(
  store: WorkspaceStoreState,
  projectId: string,
): WorkspaceStoreState {
  if (store.projects.length <= 1) return store;
  const nextProjects = store.projects.filter((p) => p.id !== projectId);
  const nextActive =
    store.activeProjectId === projectId
      ? nextProjects[0].id
      : store.activeProjectId;
  return {
    ...store,
    activeProjectId: nextActive,
    projects: nextProjects,
  };
}
