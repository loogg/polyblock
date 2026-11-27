import demosManifest from '../../demos/manifest.json';
import type { ProjectModel } from '../../types/project';
import {
  applyAssetManifest,
  type AssetManifest,
} from '../assets/manifestLoader';

export interface BuiltinDemoEntry {
  /** Stable demo key derived from filename (`src/demos/<id>.polyblock.json`). */
  id: string;
  /** Standard exported v3 `.polyblock.json` project payload. */
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

const rawDemoModules = import.meta.glob<unknown>('../../demos/*.polyblock.json', {
  eager: true,
  import: 'default',
});

function extractDemoIdFromPath(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.replace(/\.polyblock\.json$/i, '');
}

const allDiscoveredDemos: BuiltinDemoEntry[] = Object.entries(rawDemoModules).map(
  ([filePath, raw]) => ({
    id: extractDemoIdFromPath(filePath),
    project: raw as ProjectModel,
  }),
);

export const DEMOS_MANIFEST: AssetManifest = demosManifest as AssetManifest;
export const DISCOVERED_DEMO_IDS: string[] = allDiscoveredDemos.map((d) => d.id);

/**
 * Built-in demo projects auto-discovered from `src/demos/*.polyblock.json`
 * (standard exported v3 project artifacts) and deterministically ordered via `src/demos/manifest.json`.
 */
export const DEMO_PROJECTS: BuiltinDemoEntry[] = applyAssetManifest(
  allDiscoveredDemos,
  (d) => d.id,
  DEMOS_MANIFEST,
);

export function getDemoProjectById(id: string): BuiltinDemoEntry | undefined {
  return DEMO_PROJECTS.find((d) => d.id === id);
}
