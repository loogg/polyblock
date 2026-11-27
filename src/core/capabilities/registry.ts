import boardsManifest from '../../boards/manifest.json';
import sampleBoardRaw from '../../templates/sample-board.polyboard.json';
import type { TargetProfile } from '../../types/project';
import {
  applyAssetManifest,
  type AssetManifest,
} from '../assets/manifestLoader';
import { normalizeLanguageId } from '../backends/registry';

/** Built-in capability ID constants (referenced by tests & board specs; UI uses declarative metadata). */
export const CAP_RT = 'rt';
export const CAP_RT_LIFECYCLE = 'rt.lifecycle';
export const CAP_RT_TIMERS = 'rt.timers';
export const CAP_RT_TICK = 'rt.tick';
export const CAP_VIRTUAL_BOARD = 'virtual-board';

export const STORAGE_CUSTOM_PROFILES_KEY = 'polyblock.profiles.custom.v1';

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
  return {
    format: 'polyblock-board',
    version: 1,
    id: obj.id,
    name: obj.name.trim(),
    description:
      typeof obj.description === 'string' ? obj.description : '用户自定义目标板型规格',
    defaultLanguage: normalizeLanguageId(obj.defaultLanguage),
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

export const BUILTIN_TARGET_PROFILES: TargetProfile[] = applyAssetManifest(
  allDiscoveredBoards,
  (b) => b.id,
  BOARDS_MANIFEST,
);

export const SAMPLE_CUSTOM_BOARD_TEMPLATE: TargetProfile =
  validateTargetProfile(sampleBoardRaw);

class TargetProfileRegistry {
  private readonly profiles = new Map<string, TargetProfile>();
  private readonly builtinIds = new Set<string>();
  private initialized = false;

  ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    for (const p of BUILTIN_TARGET_PROFILES) {
      this.builtinIds.add(p.id);
      this.profiles.set(p.id, p);
    }
    try {
      const raw = localStorage.getItem(STORAGE_CUSTOM_PROFILES_KEY);
      if (raw) {
        const list = JSON.parse(raw) as unknown[];
        if (Array.isArray(list)) {
          for (const item of list) {
            try {
              const valid = validateTargetProfile(item);
              if (!this.builtinIds.has(valid.id)) {
                this.profiles.set(valid.id, valid);
              }
            } catch {
              // ignore corrupted item
            }
          }
        }
      }
    } catch {
      // ignore storage errors
    }
  }

  /** Returns true ONLY for profiles bundled from `src/boards/` at build time (never spoofable via JSON). */
  isBuiltin(id: string): boolean {
    this.ensureInitialized();
    return this.builtinIds.has(id);
  }

  listAll(): TargetProfile[] {
    this.ensureInitialized();
    return Array.from(this.profiles.values());
  }

  get(id: string): TargetProfile {
    this.ensureInitialized();
    return this.profiles.get(id) ?? BUILTIN_TARGET_PROFILES[0];
  }

  importCustomProfile(raw: unknown): TargetProfile {
    this.ensureInitialized();
    const valid = validateTargetProfile(raw);
    if (this.builtinIds.has(valid.id)) {
      throw new Error(`板型 ID "${valid.id}" 与内置板型冲突，请更换自定义 ID`);
    }
    this.profiles.set(valid.id, valid);
    this.persistCustomProfiles();
    return valid;
  }

  removeCustomProfile(id: string): boolean {
    this.ensureInitialized();
    if (!this.profiles.has(id) || this.builtinIds.has(id)) return false;
    this.profiles.delete(id);
    this.persistCustomProfiles();
    return true;
  }

  private persistCustomProfiles(): void {
    try {
      const custom = Array.from(this.profiles.values()).filter(
        (p) => !this.builtinIds.has(p.id),
      );
      localStorage.setItem(STORAGE_CUSTOM_PROFILES_KEY, JSON.stringify(custom));
    } catch {
      // ignore quota errors
    }
  }
}

export const targetProfileRegistry = new TargetProfileRegistry();

export { hasCapability } from './matching';
