/**
 * Standard PolyBlock project directory serializer & archive codec.
 *
 * Canonical directory / `.polyblock.zip` layout (100% isomorphic with `src/demos/<demoId>/`):
 *   - `project.polyblock.json`        Pure v3 project file (ZERO embedded packs or board specs!)
 *   - `extensions/<id>.polyext.json`  Standalone extension pack files (ALL referenced packs on export)
 *   - `boards/<id>.polyboard.json`    Standalone target board spec file
 *
 * Import Strategy 1 (Strict Version Pinning):
 *   Importing `.polyblock.zip` retains every bundled `extensions/*.polyext.json` and
 *   `boards/<id>.polyboard.json` inside the imported project's local scope (never mutates global
 *   libraries and remains immune to future global upgrades).
 */
import type { ProjectModel, TargetProfile } from '../../types/project';
import {
  targetProfileRegistry,
  validateTargetProfile,
} from '../capabilities/registry';
import { extensionRegistry } from '../extensions/registry';
import type { PolyExtensionPack } from '../extensions/types';
import { parseImportedProject } from '../projects/store';
import { decodeZipEntryText, readZipBytes } from './zipReader';
import { buildZipBytes, type ZipEntryInput } from './zipWriter';

/**
 * Pure serialized `.polyblock.json` file format:
 * strictly references `targetProfileId` and `enabledCapabilities` by ID with ZERO inline packs/boards.
 */
export type PureProjectFileJson = Omit<
  ProjectModel,
  'localExtensions' | 'localTargetProfile'
>;

export interface ProjectArchiveBundleResult {
  fileName: string;
  entries: ZipEntryInput[];
  zipBytes: Uint8Array;
  includedPackIds: string[];
  includedBoardId: string;
}

export interface ImportedProjectResult {
  project: ProjectModel;
  /** Pack display names strictly locked into this project's local scope (from `.polyblock.zip`). */
  lockedPackNames: string[];
  /** Target board display name locked into this project (from `.polyblock.zip`), if present. */
  lockedBoardName?: string;
  /** Referenced capability pack IDs that are missing from both project scope and global library. */
  missingPackIds: string[];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getBasePackId(capId: string): string {
  const dotIdx = capId.indexOf('.');
  return dotIdx > 0 ? capId.slice(0, dotIdx) : capId;
}

/**
 * Produces a 100% pure `.polyblock.json` payload with ZERO embedded extension packs or board specs.
 */
export function buildPureProjectJson(project: ProjectModel): PureProjectFileJson {
  const copy = cloneJson(project) as unknown as Record<string, unknown>;
  delete copy.localExtensions;
  delete copy.localTargetProfile;
  return copy as unknown as PureProjectFileJson;
}

/**
 * Finds capability pack IDs referenced by `project.enabledCapabilities` that cannot be resolved
 * from either the project's local extensions or the current global extension registry.
 */
export function findMissingProjectPackIds(
  project: ProjectModel,
  globalPacks: PolyExtensionPack[] = extensionRegistry.listAll(),
): string[] {
  const availableIds = new Set<string>([
    ...globalPacks.map((p) => p.id),
    ...(project.localExtensions ?? []).map((p) => p.id),
  ]);
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const capId of project.enabledCapabilities) {
    const packId = getBasePackId(capId);
    if (!packId || seen.has(packId)) continue;
    seen.add(packId);
    if (!availableIds.has(packId)) {
      missing.push(packId);
    }
  }
  return missing;
}

/**
 * Exports a 100% self-contained, reproducible `.polyblock.zip` project archive:
 * - `project.polyblock.json` (pure project config + blocks, zero inline pack bodies)
 * - `extensions/<id>.polyext.json` for EVERY pack referenced in `enabledCapabilities`
 *   (project-scoped override wins over global; ALL referenced packs included regardless of origin)
 *   plus any remaining project-scoped packs attached to this project
 * - `boards/<id>.polyboard.json` for the project's resolved target board profile
 */
export function buildProjectArchiveBundle(
  project: ProjectModel,
  globalPacks: PolyExtensionPack[] = extensionRegistry.listAll(),
): ProjectArchiveBundleResult {
  const pureProject = buildPureProjectJson(project);
  const entries: ZipEntryInput[] = [
    {
      path: 'project.polyblock.json',
      content: `${JSON.stringify(pureProject, null, 2)}\n`,
    },
  ];

  const localById = new Map<string, PolyExtensionPack>();
  for (const pack of project.localExtensions ?? []) {
    localById.set(pack.id, pack);
  }
  const globalById = new Map<string, PolyExtensionPack>();
  for (const pack of globalPacks) {
    globalById.set(pack.id, pack);
  }

  const collectedPacks = new Map<string, PolyExtensionPack>();
  // 1. All packs referenced in enabledCapabilities (project scope first, else global library)
  for (const capId of project.enabledCapabilities) {
    const packId = getBasePackId(capId);
    if (!packId || collectedPacks.has(packId)) continue;
    const resolved = localById.get(packId) ?? globalById.get(packId);
    if (resolved) {
      collectedPacks.set(packId, cloneJson(resolved));
    }
  }
  // 2. Any additional project-scoped packs attached to this project (even if temporarily toggled off)
  for (const [packId, pack] of localById.entries()) {
    if (!collectedPacks.has(packId)) {
      collectedPacks.set(packId, cloneJson(pack));
    }
  }

  const includedPackIds = Array.from(collectedPacks.keys()).sort((a, b) =>
    a.localeCompare(b),
  );
  for (const packId of includedPackIds) {
    const pack = collectedPacks.get(packId)!;
    entries.push({
      path: `extensions/${pack.id}.polyext.json`,
      content: `${JSON.stringify(pack, null, 2)}\n`,
    });
  }

  const resolvedProfile =
    project.localTargetProfile &&
    project.localTargetProfile.id === project.targetProfileId
      ? project.localTargetProfile
      : targetProfileRegistry.tryGet(project.targetProfileId);
  if (resolvedProfile) {
    entries.push({
      path: `boards/${resolvedProfile.id}.polyboard.json`,
      content: `${JSON.stringify(resolvedProfile, null, 2)}\n`,
    });
  }

  const safeProj = project.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'project';
  return {
    fileName: `${safeProj}.polyblock.zip`,
    entries,
    zipBytes: buildZipBytes(entries),
    includedPackIds,
    includedBoardId: resolvedProfile?.id ?? '',
  };
}

/**
 * Parses a pure `.polyblock.json` file (no inline packs) and reports any missing pack IDs.
 */
export function parseImportedPureProjectFile(
  raw: unknown,
  fallbackName: string,
  existingProjectNames: string[] = [],
): ImportedProjectResult {
  const project = parseImportedProject(raw, fallbackName, existingProjectNames);
  return {
    project,
    lockedPackNames: [],
    missingPackIds: findMissingProjectPackIds(project),
  };
}

/**
 * Imports a standard `.polyblock.zip` project archive using Strategy 1 (Strict Version Pinning):
 * - Reads pure `project.polyblock.json`
 * - Validates and locks ALL `extensions/*.polyext.json` into `project.localExtensions`
 * - Validates and locks matching `boards/*.polyboard.json` into `project.localTargetProfile`
 * - Never mutates or pollutes the user's global extension or board libraries
 */
export async function parseImportedProjectArchive(
  zipBytes: Uint8Array,
  fallbackName: string,
  existingProjectNames: string[] = [],
): Promise<ImportedProjectResult> {
  const entries = await readZipBytes(zipBytes);
  const projectEntry =
    entries.find((e) => e.path.toLowerCase() === 'project.polyblock.json') ??
    entries.find(
      (e) =>
        !e.path.includes('/') && e.path.toLowerCase().endsWith('.polyblock.json'),
    );
  if (!projectEntry) {
    throw new Error('工程压缩包中未找到 project.polyblock.json');
  }

  let rawProject: unknown;
  try {
    rawProject = JSON.parse(decodeZipEntryText(projectEntry));
  } catch (err) {
    throw new Error(
      `project.polyblock.json 解析失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const baseProject = parseImportedProject(
    rawProject,
    fallbackName,
    existingProjectNames,
  );

  // Strategy 1: validate and strictly lock every `extensions/*.polyext.json` to this project
  const lockedPacksMap = new Map<string, PolyExtensionPack>();
  const extEntries = entries
    .filter((e) => /^extensions\/[^/]+\.polyext\.json$/i.test(e.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const extEntry of extEntries) {
    let rawPack: unknown;
    try {
      rawPack = JSON.parse(decodeZipEntryText(extEntry));
    } catch (err) {
      throw new Error(
        `${extEntry.path} 解析失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const validated = extensionRegistry.validateProjectLocalPack(rawPack);
    lockedPacksMap.set(validated.id, validated);
  }
  const lockedPacks = Array.from(lockedPacksMap.values());

  // Strategy 1: validate and lock matching `boards/*.polyboard.json` to this project
  let lockedBoard: TargetProfile | undefined;
  const boardEntries = entries
    .filter((e) => /^boards\/[^/]+\.polyboard\.json$/i.test(e.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const parsedBoards: TargetProfile[] = [];
  for (const boardEntry of boardEntries) {
    let rawBoard: unknown;
    try {
      rawBoard = JSON.parse(decodeZipEntryText(boardEntry));
    } catch (err) {
      throw new Error(
        `${boardEntry.path} 解析失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    parsedBoards.push(validateTargetProfile(rawBoard));
  }
  if (parsedBoards.length > 0) {
    lockedBoard =
      parsedBoards.find((b) => b.id === baseProject.targetProfileId) ??
      parsedBoards[0];
  }

  const finalProject: ProjectModel = {
    ...baseProject,
    localExtensions: lockedPacks,
    ...(lockedBoard
      ? {
          targetProfileId: lockedBoard.id,
          localTargetProfile: lockedBoard,
        }
      : {}),
  };

  // Ensure registry knows about default profiles before missing checks
  targetProfileRegistry.ensureInitialized();

  return {
    project: finalProject,
    lockedPackNames: lockedPacks.map((p) => p.name),
    lockedBoardName: lockedBoard?.name,
    missingPackIds: findMissingProjectPackIds(finalProject),
  };
}
