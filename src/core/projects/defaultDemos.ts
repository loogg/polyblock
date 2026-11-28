import demosManifest from '../../demos/manifest.json';
import type { ProjectModel, TargetProfile } from '../../types/project';
import { validateTargetProfile } from '../capabilities/registry';
import type { PolyExtensionPack } from '../extensions/types';
import { validateExtensionPack } from '../extensions/validator';
import {
  applyAssetManifest,
  type AssetManifest,
} from '../assets/manifestLoader';

export interface DefaultDemoEntry {
  /** Stable demo key derived from directory (`src/demos/<id>/project.polyblock.json`). */
  id: string;
  /** Standard v3 project payload assembled from pure `project.polyblock.json` + sibling `extensions/` & `boards/`. */
  project: ProjectModel;
}

export function createBlankWorkspace(): Record<string, unknown> {
  return {
    blocks: {
      languageVersion: 0,
      blocks: [
        {
          type: 'poly_on_start',
          id: 'blank_start',
          x: 36,
          y: 28,
        },
      ],
    },
  };
}

const rawDemoProjectModules = import.meta.glob<unknown>(
  '../../demos/*/project.polyblock.json',
  {
    eager: true,
    import: 'default',
  },
);

const rawDemoExtensionModules = import.meta.glob<unknown>(
  '../../demos/*/extensions/*.polyext.json',
  {
    eager: true,
    import: 'default',
  },
);

const rawDemoBoardModules = import.meta.glob<unknown>(
  '../../demos/*/boards/*.polyboard.json',
  {
    eager: true,
    import: 'default',
  },
);

function extractDemoIdFromDirPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/\/demos\/([^/]+)\//);
  return match ? match[1] : normalized;
}

const extensionsByDemoId = new Map<string, PolyExtensionPack[]>();
for (const [filePath, raw] of Object.entries(rawDemoExtensionModules).sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  const demoId = extractDemoIdFromDirPath(filePath);
  const list = extensionsByDemoId.get(demoId) ?? [];
  list.push(validateExtensionPack(raw));
  extensionsByDemoId.set(demoId, list);
}

const boardByDemoId = new Map<string, TargetProfile>();
for (const [filePath, raw] of Object.entries(rawDemoBoardModules).sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  const demoId = extractDemoIdFromDirPath(filePath);
  if (!boardByDemoId.has(demoId)) {
    boardByDemoId.set(demoId, validateTargetProfile(raw));
  }
}

const allDiscoveredDemos: DefaultDemoEntry[] = Object.entries(
  rawDemoProjectModules,
).map(([filePath, raw]) => {
  const id = extractDemoIdFromDirPath(filePath);
  const baseProject = raw as ProjectModel;
  const siblingExts = extensionsByDemoId.get(id);
  const siblingBoard = boardByDemoId.get(id);
  const assembled: ProjectModel = {
    ...baseProject,
    ...(siblingExts && siblingExts.length > 0
      ? { localExtensions: siblingExts }
      : {}),
    ...(siblingBoard ? { localTargetProfile: siblingBoard } : {}),
  };
  return { id, project: assembled };
});

export const DEMOS_MANIFEST: AssetManifest = demosManifest as AssetManifest;
export const DISCOVERED_DEMO_IDS: string[] = allDiscoveredDemos.map((d) => d.id);

/**
 * Default seed demo projects auto-discovered from `src/demos/<id>/project.polyblock.json`
 * (plus sibling standalone `extensions/*.polyext.json` and optional `boards/*.polyboard.json`)
 * and deterministically ordered via `src/demos/manifest.json`.
 */
export const DEMO_PROJECTS: DefaultDemoEntry[] = applyAssetManifest(
  allDiscoveredDemos,
  (d) => d.id,
  DEMOS_MANIFEST,
);

export function getDemoProjectById(id: string): DefaultDemoEntry | undefined {
  return DEMO_PROJECTS.find((d) => d.id === id);
}
