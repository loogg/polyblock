import type { ScriptLanguageId } from '../../types/project';
import { SUPPORTED_LANGUAGE_IDS } from '../backends/types';
import { hasCapability } from '../capabilities/registry';
import { extensionRegistry } from './registry';
import type { ExtensionModuleSource, PolyExtensionPack } from './types';

/**
 * Pure 3-tier scope-based module resolution priority (highest -> lowest):
 *   1. `handle`   — Sibling scripts in the active RuntimeHandle (`handle.scripts`, e.g. `timers.lua`)
 *   2. `project`  — Enabled project-local packs (`project.localExtensions[]`, regardless of `libs[]` or `sandboxMock`)
 *   3. `global`   — Enabled global packs (preinstalled `rt` / `board` / `poly_clock` + user-imported, treated uniformly)
 *
 * Orthogonal separation of concerns:
 * - **Resolution Priority** depends SOLELY on Scope (`handle > project > global`). Project ALWAYS beats Global!
 * - **Delivery Nature** (`delivery: 'handle-script' | 'lib' | 'sandbox-mock'`) is NOT a priority tier:
 *   - Browser WASM sandbox mounts the winning provider for every `moduleName` (real script OR mock).
 *   - Target `.zip` deployment export ONLY ships real sources (`handle-script` / `lib`) and strictly strips
 *     winning `sandbox-mock` modules (so a project-level hardware `sandboxMock` cleanly suppresses a global `lib`).
 * - **Same-tier Conflict**: two enabled packs in the SAME tier declaring the same `moduleName` trigger a blocking Error.
 */
export type ModuleResolutionTier = 'handle' | 'project' | 'global';

export type ModuleDeliveryKind = 'handle-script' | 'lib' | 'sandbox-mock';

export const TIER_PRIORITY_ORDER: readonly ModuleResolutionTier[] = [
  'handle',
  'project',
  'global',
] as const;

export const TIER_LABEL_ZH: Record<ModuleResolutionTier, string> = {
  handle: '当前句柄脚本',
  project: '项目内嵌包',
  global: '全局扩展包',
};

export const DELIVERY_LABEL_ZH: Record<ModuleDeliveryKind, string> = {
  'handle-script': '句柄脚本',
  lib: '真实脚本库 (libs)',
  'sandbox-mock': '沙箱假桩 (sandboxMock)',
};

export interface ModuleProviderRecord {
  moduleName: string;
  tier: ModuleResolutionTier;
  delivery: ModuleDeliveryKind;
  isRealLib: boolean;
  ownerId: string;
  ownerLabel: string;
  source: ExtensionModuleSource;
}

export interface ModuleConflictItem {
  id: string;
  tier: ModuleResolutionTier;
  moduleName: string;
  owners: Array<{ ownerId: string; ownerLabel: string }>;
  message: string;
}

export interface ModuleOverrideItem {
  moduleName: string;
  winner: {
    tier: ModuleResolutionTier;
    delivery: ModuleDeliveryKind;
    ownerId: string;
    ownerLabel: string;
  };
  shadowed: Array<{
    tier: ModuleResolutionTier;
    delivery: ModuleDeliveryKind;
    ownerId: string;
    ownerLabel: string;
  }>;
  message: string;
}

export interface ModuleResolutionResult {
  /** Winning module entry per moduleName (keyed by moduleName). */
  resolvedByName: Map<string, ModuleProviderRecord>;
  /**
   * Modules to mount into browser WASM workers in LOWEST-to-HIGHEST priority order
   * (`global` -> `project` -> `handle`), with `helper` libs before `entry` libs inside each tier,
   * so higher-priority scopes deterministically overwrite lower scopes (including preinstalled `rt`/`board`).
   */
  sandboxMountOrder: ExtensionModuleSource[];
  /**
   * ONLY real script library files (`delivery === 'lib'`) that WON 3-tier resolution.
   * Strictly strips ALL `sandboxMock` stubs (and suppresses lower-tier libs shadowed by a higher-tier `sandboxMock`!).
   */
  exportLibs: ModuleProviderRecord[];
  /** Blocking same-tier `moduleName` collisions. */
  conflicts: ModuleConflictItem[];
  /** Intentional cross-tier overrides (provenance log for UI & manifest.json). */
  overrides: ModuleOverrideItem[];
}

export interface ResolveProjectModulesInput {
  enabledCapabilities: string[];
  localExtensions?: PolyExtensionPack[];
  globalExtensions?: PolyExtensionPack[];
  /** Compiled sibling scripts inside the active handle (excluding entry script when preloading). */
  handleScripts?: Array<{
    scriptId: string;
    scriptName: string;
    sources?: Partial<Record<ScriptLanguageId, string>>;
  }>;
}

const IMPORT_MODULE_NAME_EXTRACTORS: Record<
  ScriptLanguageId,
  (line: string) => string | null
> = {
  lua: (line) => {
    const m = /require\s*\(\s*["']([^"']+)["']\s*\)/.exec(line);
    return m?.[1]?.trim() || null;
  },
  python: (line) => {
    const m = /^\s*(?:import|from)\s+([A-Za-z_][A-Za-z0-9_.]*)/.exec(line);
    return m?.[1]?.trim() || null;
  },
};

/**
 * Extracts all module names referenced in `pack.imports` across all registered script languages
 * so editors/validators can verify hand-written JSON matches attached `libs[]` / `sandboxMock`.
 */
export function extractImportedModuleNames(pack: PolyExtensionPack): string[] {
  const names = new Set<string>();
  for (const lang of SUPPORTED_LANGUAGE_IDS) {
    const lines = pack.imports?.[lang] ?? [];
    const extract = IMPORT_MODULE_NAME_EXTRACTORS[lang];
    for (const line of lines) {
      const modName = extract(line);
      if (modName) names.add(modName);
    }
  }
  return Array.from(names);
}

/**
 * Inspects whether a pack's `imports` references modules that have matching source in `libs[]` or `sandboxMock`.
 */
export function inspectPackImportSourceMatch(pack: PolyExtensionPack): {
  importedModules: string[];
  providedModules: string[];
  unmatchedImports: string[];
} {
  const importedModules = extractImportedModuleNames(pack);
  const providedSet = new Set<string>();
  if (pack.sandboxMock?.moduleName) providedSet.add(pack.sandboxMock.moduleName);
  for (const lib of pack.libs ?? []) {
    if (lib.moduleName) providedSet.add(lib.moduleName);
  }
  return {
    importedModules,
    providedModules: Array.from(providedSet),
    unmatchedImports: importedModules.filter((m) => !providedSet.has(m)),
  };
}

/**
 * Single Source of Truth 3-tier pure-scope module resolver used identically by:
 * - Static Diagnostics (`sourceMap.ts`)
 * - Single-Handle & Multi-Handle Browser WASM Execution (`App.tsx`, `multiHandleManager.ts`)
 * - Target `.zip` Bundle Exporter (`bundleExporter.ts`)
 */
export function resolveProjectModules(
  input: ResolveProjectModulesInput,
): ModuleResolutionResult {
  const enabledCaps = input.enabledCapabilities ?? [];
  const localPacks = input.localExtensions ?? [];
  const globalPacks = input.globalExtensions ?? extensionRegistry.listAll();
  const localPackIds = new Set(localPacks.map((p) => p.id));

  const enabledLocalPacks = localPacks.filter((p) =>
    hasCapability(enabledCaps, p.id),
  );
  // Project-local pack with same pack ID cleanly shadows the global pack of that ID
  const enabledGlobalPacks = globalPacks.filter(
    (p) => !localPackIds.has(p.id) && hasCapability(enabledCaps, p.id),
  );

  const candidatesByTier: Record<ModuleResolutionTier, ModuleProviderRecord[]> = {
    handle: [],
    project: [],
    global: [],
  };

  // Tier 1: Handle sibling scripts
  for (const hs of input.handleScripts ?? []) {
    if (!hs.scriptName) continue;
    candidatesByTier.handle.push({
      moduleName: hs.scriptName,
      tier: 'handle',
      delivery: 'handle-script',
      isRealLib: true,
      ownerId: `script:${hs.scriptId}`,
      ownerLabel: `句柄脚本 ${hs.scriptName}`,
      source: {
        moduleName: hs.scriptName,
        sources: { ...(hs.sources ?? {}) },
      },
    });
  }

  // Tier 2: Enabled project-local packs (`libs[]` + `sandboxMock`, same scope tier!)
  for (const pack of enabledLocalPacks) {
    for (const lib of pack.libs ?? []) {
      candidatesByTier.project.push({
        moduleName: lib.moduleName,
        tier: 'project',
        delivery: 'lib',
        isRealLib: true,
        ownerId: `local:${pack.id}`,
        ownerLabel: `项目内嵌包「${pack.name}」`,
        source: { ...lib, packId: pack.id },
      });
    }
    if (pack.sandboxMock) {
      candidatesByTier.project.push({
        moduleName: pack.sandboxMock.moduleName,
        tier: 'project',
        delivery: 'sandbox-mock',
        isRealLib: false,
        ownerId: `local:${pack.id}`,
        ownerLabel: `项目内嵌包「${pack.name}」`,
        source: { ...pack.sandboxMock, packId: pack.id },
      });
    }
  }

  // Tier 3: Enabled global packs (uniformly treats preinstalled & user-imported global packs!)
  for (const pack of enabledGlobalPacks) {
    for (const lib of pack.libs ?? []) {
      candidatesByTier.global.push({
        moduleName: lib.moduleName,
        tier: 'global',
        delivery: 'lib',
        isRealLib: true,
        ownerId: `global:${pack.id}`,
        ownerLabel: `全局扩展包「${pack.name}」`,
        source: { ...lib, packId: pack.id },
      });
    }
    if (pack.sandboxMock) {
      candidatesByTier.global.push({
        moduleName: pack.sandboxMock.moduleName,
        tier: 'global',
        delivery: 'sandbox-mock',
        isRealLib: false,
        ownerId: `global:${pack.id}`,
        ownerLabel: `全局扩展包「${pack.name}」`,
        source: { ...pack.sandboxMock, packId: pack.id },
      });
    }
  }

  // 1. Detect same-tier `moduleName` conflicts (regardless of `lib` vs `sandbox-mock`)
  const conflicts: ModuleConflictItem[] = [];
  for (const tier of TIER_PRIORITY_ORDER) {
    const byName = new Map<string, ModuleProviderRecord[]>();
    for (const entry of candidatesByTier[tier]) {
      const list = byName.get(entry.moduleName) ?? [];
      list.push(entry);
      byName.set(entry.moduleName, list);
    }
    for (const [moduleName, entries] of byName.entries()) {
      if (entries.length > 1) {
        const ownerNames = entries
          .map((e) => `${e.ownerLabel}[${DELIVERY_LABEL_ZH[e.delivery]}]`)
          .join(' 与 ');
        conflicts.push({
          id: `module-conflict-${tier}-${moduleName}`,
          tier,
          moduleName,
          owners: entries.map((e) => ({
            ownerId: e.ownerId,
            ownerLabel: e.ownerLabel,
          })),
          message: `同层级模块名冲突（${TIER_LABEL_ZH[tier]}）：${ownerNames} 均提供了 moduleName="${moduleName}"，请停用其中一个包或修改模块名。`,
        });
      }
    }
  }

  // 2. Resolve winning provider across 3 pure scope tiers (`handle > project > global`)
  const resolvedByName = new Map<string, ModuleProviderRecord>();
  const shadowedByName = new Map<string, ModuleProviderRecord[]>();

  for (const tier of TIER_PRIORITY_ORDER) {
    const seenInTier = new Set<string>();
    for (const entry of candidatesByTier[tier]) {
      if (seenInTier.has(entry.moduleName)) continue; // already flagged as same-tier conflict
      seenInTier.add(entry.moduleName);

      if (!resolvedByName.has(entry.moduleName)) {
        resolvedByName.set(entry.moduleName, entry);
      } else {
        const list = shadowedByName.get(entry.moduleName) ?? [];
        list.push(entry);
        shadowedByName.set(entry.moduleName, list);
      }
    }
  }

  const overrides: ModuleOverrideItem[] = [];
  for (const [moduleName, shadowed] of shadowedByName.entries()) {
    const winner = resolvedByName.get(moduleName)!;
    const shadowedText = shadowed
      .map(
        (s) =>
          `${s.ownerLabel}（${TIER_LABEL_ZH[s.tier]} · ${DELIVERY_LABEL_ZH[s.delivery]}）`,
      )
      .join('、');
    overrides.push({
      moduleName,
      winner: {
        tier: winner.tier,
        delivery: winner.delivery,
        ownerId: winner.ownerId,
        ownerLabel: winner.ownerLabel,
      },
      shadowed: shadowed.map((s) => ({
        tier: s.tier,
        delivery: s.delivery,
        ownerId: s.ownerId,
        ownerLabel: s.ownerLabel,
      })),
      message: `模块 "${moduleName}" 由 ${winner.ownerLabel}（${TIER_LABEL_ZH[winner.tier]} · ${DELIVERY_LABEL_ZH[winner.delivery]}）提供，已覆盖 ${shadowedText}。`,
    });
  }

  // 3. Build sandbox mount list ordered LOWEST -> HIGHEST scope (`global` -> `project` -> `handle`),
  //    with `role === 'helper'` dependency libraries before `entry` libraries within each tier.
  const sandboxMountOrder: ExtensionModuleSource[] = [];
  for (let i = TIER_PRIORITY_ORDER.length - 1; i >= 0; i--) {
    const tier = TIER_PRIORITY_ORDER[i];
    const tierEntries = Array.from(resolvedByName.values())
      .filter(
        (entry) =>
          entry.tier === tier &&
          Object.values(entry.source.sources ?? {}).some(
            (src) => typeof src === 'string' && src.length > 0,
          ),
      )
      .sort((a, b) => {
        const ra = a.source.role === 'helper' ? 0 : 1;
        const rb = b.source.role === 'helper' ? 0 : 1;
        return ra - rb;
      });
    for (const entry of tierEntries) {
      sandboxMountOrder.push(entry.source);
    }
  }

  // 4. Build target-export real library list: ONLY winners whose delivery is `lib`!
  //    (Winning `sandbox-mock` is strictly stripped and ALSO suppresses any lower-tier `lib`!)
  const exportLibs: ModuleProviderRecord[] = [];
  for (const entry of resolvedByName.values()) {
    if (entry.delivery === 'lib') {
      exportLibs.push(entry);
    }
  }

  return {
    resolvedByName,
    sandboxMountOrder,
    exportLibs,
    conflicts,
    overrides,
  };
}
