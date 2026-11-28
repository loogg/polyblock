import boardsManifest from '../../boards/manifest.json';
import sampleBoardRaw from '../../templates/sample-board.polyboard.json';
import type { ScriptLanguageId, TargetProfile } from '../../types/project';
import {
  applyAssetManifest,
  type AssetManifest,
} from '../assets/manifestLoader';
import { backendRegistry } from '../backends/registry';

export const STORAGE_GLOBAL_PROFILES_KEY = 'polyblock.profiles.global.v2';

interface PersistedProfilesPatch {
  profiles?: unknown[];
  removedIds?: unknown[];
}

export function validateTargetProfile(raw: unknown): TargetProfile {
  if (!raw || typeof raw !== 'object') {
    throw new Error('板型规格 JSON 必须是对象');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !/^[a-zA-Z0-9_-]{2,48}$/.test(obj.id)) {
    throw new Error('板型 id 必填，且只能包含字母、数字、横线或下划线（2~48 字符）');
  }
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    throw new Error('板型 name 必填');
  }
  if (!Array.isArray(obj.capabilities)) {
    throw new Error('板型必须包含 capabilities 数组');
  }
  const maxHandlesNum = Number(obj.maxHandles);
  let defaultChannelCounts: Record<string, number> | undefined;
  if (
    obj.defaultChannelCounts &&
    typeof obj.defaultChannelCounts === 'object' &&
    !Array.isArray(obj.defaultChannelCounts)
  ) {
    const cleaned: Record<string, number> = {};
    for (const [k, v] of Object.entries(
      obj.defaultChannelCounts as Record<string, unknown>,
    )) {
      const n = Number(v);
      if (k.trim() && Number.isFinite(n)) {
        cleaned[k.trim()] = Math.max(1, Math.min(64, Math.trunc(n)));
      }
    }
    if (Object.keys(cleaned).length > 0) {
      defaultChannelCounts = cleaned;
    }
  }
  const rawLang =
    typeof obj.defaultLanguage === 'string' ? obj.defaultLanguage.trim() : '';
  const defaultLanguage: ScriptLanguageId = /^[a-z][a-z0-9_-]{0,23}$/.test(
    rawLang,
  )
    ? rawLang
    : (backendRegistry.listIds()[0] ?? 'lua');
  return {
    format: 'polyblock-board',
    version: 1,
    id: obj.id,
    name: obj.name.trim(),
    description:
      typeof obj.description === 'string' ? obj.description : '目标板型规格',
    defaultLanguage,
    maxHandles: Number.isFinite(maxHandlesNum)
      ? Math.max(1, Math.min(16, Math.trunc(maxHandlesNum)))
      : 8,
    ...(defaultChannelCounts ? { defaultChannelCounts } : {}),
    capabilities: obj.capabilities.filter((c): c is string => typeof c === 'string'),
  };
}

const rawBoardModules = import.meta.glob<unknown>('../../boards/*.polyboard.json', {
  eager: true,
  import: 'default',
});

const allDiscoveredBoards: TargetProfile[] = Object.values(rawBoardModules).map(
  (raw) => validateTargetProfile(raw),
);

export const BOARDS_MANIFEST: AssetManifest = boardsManifest as AssetManifest;
export const DISCOVERED_BOARD_IDS: string[] = allDiscoveredBoards.map((b) => b.id);

/** Default seed target profiles loaded from `src/boards/*.polyboard.json` via `manifest.json`. */
export const DEFAULT_TARGET_PROFILES: TargetProfile[] = applyAssetManifest(
  allDiscoveredBoards,
  (b) => b.id,
  BOARDS_MANIFEST,
);

const DEFAULT_PROFILE_JSON_BY_ID = new Map<string, string>(
  DEFAULT_TARGET_PROFILES.map((p) => [p.id, JSON.stringify(p)]),
);

export const SAMPLE_CUSTOM_BOARD_TEMPLATE: TargetProfile =
  validateTargetProfile(sampleBoardRaw);

class TargetProfileRegistry {
  private readonly profiles = new Map<string, TargetProfile>();
  private readonly removedDefaultIds = new Set<string>();
  private initialized = false;

  ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    for (const p of DEFAULT_TARGET_PROFILES) {
      this.profiles.set(p.id, p);
    }
    try {
      const raw = localStorage.getItem(STORAGE_GLOBAL_PROFILES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedProfilesPatch;
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.removedIds)) {
            for (const rid of parsed.removedIds) {
              if (typeof rid === 'string' && DEFAULT_PROFILE_JSON_BY_ID.has(rid)) {
                this.removedDefaultIds.add(rid);
                this.profiles.delete(rid);
              }
            }
          }
          if (Array.isArray(parsed.profiles)) {
            for (const item of parsed.profiles) {
              try {
                const valid = validateTargetProfile(item);
                this.removedDefaultIds.delete(valid.id);
                this.profiles.set(valid.id, valid);
              } catch {
                // ignore corrupted item
              }
            }
          }
        }
      }
    } catch {
      // ignore storage errors
    }
    if (this.profiles.size === 0 && DEFAULT_TARGET_PROFILES.length > 0) {
      this.removedDefaultIds.delete(DEFAULT_TARGET_PROFILES[0].id);
      this.profiles.set(DEFAULT_TARGET_PROFILES[0].id, DEFAULT_TARGET_PROFILES[0]);
    }
  }

  /** Returns the primary default profile ID (first available profile, zero hardcoded board IDs). */
  getDefaultProfileId(): string {
    this.ensureInitialized();
    const first = this.profiles.values().next().value as TargetProfile | undefined;
    return first?.id ?? DEFAULT_TARGET_PROFILES[0].id;
  }

  listAll(): TargetProfile[] {
    this.ensureInitialized();
    return Array.from(this.profiles.values());
  }

  tryGet(id: string): TargetProfile | undefined {
    this.ensureInitialized();
    return this.profiles.get(id);
  }

  get(id: string): TargetProfile {
    this.ensureInitialized();
    const found = this.profiles.get(id);
    if (found) return found;
    const first = this.profiles.values().next().value as TargetProfile | undefined;
    return first ?? DEFAULT_TARGET_PROFILES[0];
  }

  /** Imports a new board profile or updates an existing profile with the same ID (full equality). */
  importProfile(raw: unknown): TargetProfile {
    this.ensureInitialized();
    const valid = validateTargetProfile(raw);
    this.removedDefaultIds.delete(valid.id);
    this.profiles.set(valid.id, valid);
    this.persistPatch();
    return valid;
  }

  /** Removes any profile from the global catalog (requires keeping at least 1 active profile). */
  removeProfile(id: string): boolean {
    this.ensureInitialized();
    if (!this.profiles.has(id) || this.profiles.size <= 1) return false;
    this.profiles.delete(id);
    if (DEFAULT_PROFILE_JSON_BY_ID.has(id)) {
      this.removedDefaultIds.add(id);
    }
    this.persistPatch();
    return true;
  }

  /** Restores the global board catalog to factory defaults from `src/boards/`. */
  resetToDefaults(): void {
    this.ensureInitialized();
    this.profiles.clear();
    this.removedDefaultIds.clear();
    for (const p of DEFAULT_TARGET_PROFILES) {
      this.profiles.set(p.id, p);
    }
    try {
      localStorage.removeItem(STORAGE_GLOBAL_PROFILES_KEY);
    } catch {
      // ignore storage errors
    }
  }

  /** Returns true if any board profile differs from the default catalog (added, modified, or removed). */
  hasCatalogChanges(): boolean {
    this.ensureInitialized();
    if (this.removedDefaultIds.size > 0) return true;
    for (const p of this.profiles.values()) {
      if (DEFAULT_PROFILE_JSON_BY_ID.get(p.id) !== JSON.stringify(p)) {
        return true;
      }
    }
    return false;
  }

  private persistPatch(): void {
    try {
      const changedProfiles = Array.from(this.profiles.values()).filter(
        (p) => DEFAULT_PROFILE_JSON_BY_ID.get(p.id) !== JSON.stringify(p),
      );
      const removedIds = Array.from(this.removedDefaultIds);
      if (changedProfiles.length === 0 && removedIds.length === 0) {
        localStorage.removeItem(STORAGE_GLOBAL_PROFILES_KEY);
      } else {
        localStorage.setItem(
          STORAGE_GLOBAL_PROFILES_KEY,
          JSON.stringify({ profiles: changedProfiles, removedIds }),
        );
      }
    } catch {
      // ignore quota errors
    }
  }
}

export const targetProfileRegistry = new TargetProfileRegistry();

export { hasCapability } from './matching';
