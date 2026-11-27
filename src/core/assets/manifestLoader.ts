/**
 * Uniform pure-JSON asset manifest (`src/{packs,boards,demos}/manifest.json`).
 * Controls deterministic cross-OS ordering and optional distribution exclusions
 * without modifying any TypeScript source code.
 */
export interface AssetManifest {
  /** Explicit IDs placed first in exact array order; unlisted discovered assets append in ASCII ID order. */
  order?: string[];
  /** Asset IDs excluded from the compiled bundle (allows OEM pruning without deleting source files). */
  exclude?: string[];
}

function compareAscii(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Applies a pure-JSON `AssetManifest` to any auto-discovered asset collection:
 * 1. Excludes any asset whose ID appears in `manifest.exclude`.
 * 2. Places assets listed in `manifest.order` first in exact declared order.
 * 3. Appends any unlisted discovered assets in deterministic ASCII ID order.
 */
export function applyAssetManifest<T>(
  items: T[],
  getId: (item: T) => string,
  manifest?: AssetManifest,
): T[] {
  const excluded = new Set(manifest?.exclude ?? []);
  const byId = new Map<string, T>();
  for (const item of items) {
    const id = getId(item);
    if (!excluded.has(id)) {
      byId.set(id, item);
    }
  }

  const ordered: T[] = [];
  const placed = new Set<string>();

  for (const id of manifest?.order ?? []) {
    if (excluded.has(id) || placed.has(id)) continue;
    const found = byId.get(id);
    if (found) {
      ordered.push(found);
      placed.add(id);
    }
  }

  const unlisted = Array.from(byId.entries())
    .filter(([id]) => !placed.has(id))
    .sort(([a], [b]) => compareAscii(a, b))
    .map(([, item]) => item);

  return [...ordered, ...unlisted];
}

/** Returns any IDs referenced in `manifest.order` or `manifest.exclude` that do not exist in `discoveredIds`. */
export function findUnknownManifestIds(
  discoveredIds: Iterable<string>,
  manifest?: AssetManifest,
): string[] {
  const known = new Set(discoveredIds);
  const unknown: string[] = [];
  for (const id of [...(manifest?.order ?? []), ...(manifest?.exclude ?? [])]) {
    if (!known.has(id)) unknown.push(id);
  }
  return unknown;
}
