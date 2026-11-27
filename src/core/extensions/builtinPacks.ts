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
 * Built-in extension packs auto-discovered from `src/packs/*.polyext.json`,
 * validated through the exact same `validateExtensionPack` pipeline as user-imported packs,
 * and deterministically ordered/filtered via `src/packs/manifest.json`.
 */
export const BUILTIN_EXTENSION_PACKS: PolyExtensionPack[] = applyAssetManifest(
  allDiscoveredPacks,
  (p) => p.id,
  PACKS_MANIFEST,
);

/** Clean downloadable starter template for authoring custom `.polyext.json` packs. */
export const SAMPLE_CUSTOM_EXTENSION_TEMPLATE: PolyExtensionPack =
  validateExtensionPack(sampleExtensionRaw);

function requireBuiltinPack(id: string): PolyExtensionPack {
  const found = BUILTIN_EXTENSION_PACKS.find((p) => p.id === id);
  if (!found) {
    throw new Error(`Required built-in extension pack "${id}" missing from src/packs/`);
  }
  return found;
}

export const RT_PACK: PolyExtensionPack = requireBuiltinPack('rt');
export const VIRTUAL_BOARD_PACK: PolyExtensionPack =
  requireBuiltinPack('virtual-board');
export const CLOCK_TIMER_PACK: PolyExtensionPack =
  requireBuiltinPack('clock-timer');
