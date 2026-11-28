import packsManifest from '../../packs/manifest.json';
import sampleExtensionRaw from '../../templates/sample-extension.polyext.json';
import {
  applyAssetManifest,
  type AssetManifest,
} from '../assets/manifestLoader';
import type { PolyExtensionPack } from './types';
import { validateExtensionPack } from './validator';

const rawPackModules = import.meta.glob<unknown>('../../packs/*.polyext.json', {
  eager: true,
  import: 'default',
});

const allDiscoveredPacks: PolyExtensionPack[] = Object.values(rawPackModules).map(
  (raw) => validateExtensionPack(raw),
);

export const PACKS_MANIFEST: AssetManifest = packsManifest as AssetManifest;

export const DISCOVERED_PACK_IDS: string[] = allDiscoveredPacks.map((p) => p.id);

/**
 * Default seed extension packs auto-discovered from `src/packs/*.polyext.json`,
 * validated through the exact same `validateExtensionPack` pipeline as user-imported packs,
 * and deterministically ordered/filtered via `src/packs/manifest.json`.
 * Treated as equal global packs with zero privileged built-in status.
 */
export const DEFAULT_EXTENSION_PACKS: PolyExtensionPack[] = applyAssetManifest(
  allDiscoveredPacks,
  (p) => p.id,
  PACKS_MANIFEST,
);

/** Clean downloadable starter template for authoring custom `.polyext.json` packs. */
export const SAMPLE_CUSTOM_EXTENSION_TEMPLATE: PolyExtensionPack =
  validateExtensionPack(sampleExtensionRaw);
