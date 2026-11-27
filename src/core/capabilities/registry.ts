import type { TargetProfile } from '../../types/project';

/** Unified built-in `rt` runtime pack & its fine-grained section capability IDs. */
export const CAP_RT = 'rt';
export const CAP_RT_LIFECYCLE = 'rt.lifecycle';
export const CAP_RT_TIMERS = 'rt.timers';
export const CAP_RT_TICK = 'rt.tick';
export const CAP_VIRTUAL_BOARD = 'virtual-board';

export const STORAGE_CUSTOM_PROFILES_KEY = 'polyblock.profiles.custom.v1';

export const BUILTIN_TARGET_PROFILES: TargetProfile[] = [
  {
    format: 'polyblock-board',
    version: 1,
    id: 'generic-script',
    name: '纯脚本环境（无硬件 / 无定时）',
    description:
      '仅启用纯语言通用积木与 on_start 入口，隐藏定时器与虚拟板模拟界面，适合算法、日志与通用逻辑编排。',
    defaultLanguage: 'lua',
    maxHandles: 4,
    capabilities: [],
    builtin: true,
  },
  {
    format: 'polyblock-board',
    version: 1,
    id: 'embedded-rt',
    name: '通用嵌入式 RT 控制板',
    description:
      '启用完整嵌入式运行时核心包 rt（周期事件 + 每句柄独立多路定时器 + 系统时钟 tick），不含演示外设，适合按需挂载自家硬件扩展包。',
    defaultLanguage: 'lua',
    maxHandles: 8,
    capabilities: [CAP_RT],
    builtin: true,
  },
  {
    format: 'polyblock-board',
    version: 1,
    id: 'virtual-board-rt',
    name: '虚拟硬件 RT 演示板',
    description:
      '完整演示多句柄并发 + 嵌入式运行时核心包 rt（周期 / 定时 / 时钟）+ 示例虚拟板外设（LED / 三色灯 / OLED / 温度 / 按键回调）。',
    defaultLanguage: 'lua',
    maxHandles: 8,
    capabilities: [CAP_RT, CAP_VIRTUAL_BOARD],
    builtin: true,
  },
  {
    format: 'polyblock-board',
    version: 1,
    id: 'virtual-board-basic',
    name: '虚拟硬件基础演示板（无定时）',
    description:
      '仅启用示例虚拟硬件外设包，不含 rt 运行时周期与定时器，演示不同项目的差异化能力装配。',
    defaultLanguage: 'python',
    maxHandles: 4,
    capabilities: [CAP_VIRTUAL_BOARD],
    builtin: true,
  },
];

export const SAMPLE_CUSTOM_BOARD_TEMPLATE: TargetProfile = {
  format: 'polyblock-board',
  version: 1,
  id: 'my-industrial-controller',
  name: '自定义工业控制板（示例模板）',
  description:
    '演示如何通过纯 JSON 定义目标设备规格：Lua 5.4、最多 8 个隔离句柄、启用 rt（也可按 rt.lifecycle / rt.timers / rt.tick 细粒度裁剪）。',
  defaultLanguage: 'lua',
  maxHandles: 8,
  defaultChannelCounts: {
    [CAP_RT_TIMERS]: 16,
  },
  capabilities: [CAP_RT],
};

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
    defaultLanguage: obj.defaultLanguage === 'python' ? 'python' : 'lua',
    maxHandles: Number.isFinite(maxHandlesNum)
      ? Math.max(1, Math.min(16, Math.trunc(maxHandlesNum)))
      : 8,
    ...(defaultChannelCounts ? { defaultChannelCounts } : {}),
    capabilities: obj.capabilities.filter((c): c is string => typeof c === 'string'),
    builtin: Boolean(obj.builtin),
  };
}

class TargetProfileRegistry {
  private readonly profiles = new Map<string, TargetProfile>();
  private initialized = false;

  ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    for (const p of BUILTIN_TARGET_PROFILES) {
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
              this.profiles.set(valid.id, { ...valid, builtin: false });
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
    const existing = this.profiles.get(valid.id);
    if (existing?.builtin) {
      throw new Error(`板型 ID "${valid.id}" 与内置板型冲突，请更换自定义 ID`);
    }
    const customProfile: TargetProfile = { ...valid, builtin: false };
    this.profiles.set(customProfile.id, customProfile);
    this.persistCustomProfiles();
    return customProfile;
  }

  removeCustomProfile(id: string): boolean {
    this.ensureInitialized();
    const existing = this.profiles.get(id);
    if (!existing || existing.builtin) return false;
    this.profiles.delete(id);
    this.persistCustomProfiles();
    return true;
  }

  private persistCustomProfiles(): void {
    try {
      const custom = Array.from(this.profiles.values()).filter((p) => !p.builtin);
      localStorage.setItem(STORAGE_CUSTOM_PROFILES_KEY, JSON.stringify(custom));
    } catch {
      // ignore quota errors
    }
  }
}

export const targetProfileRegistry = new TargetProfileRegistry();

/**
 * Checks whether a pack (`"rt"`) or specific section (`"rt.timers"`) is enabled in `enabledCapabilities`:
 * - For a section ID `"packId.sectionId"`: enabled if `"packId.sectionId"` OR whole-pack `"packId"` is present.
 * - For a pack ID `"packId"`: enabled if `"packId"` OR any `"packId.*"` section is present.
 */
export function hasCapability(
  enabledCapabilities: string[],
  capabilityId: string,
): boolean {
  if (enabledCapabilities.includes(capabilityId)) return true;
  const dotIdx = capabilityId.indexOf('.');
  if (dotIdx > 0) {
    const parentPackId = capabilityId.slice(0, dotIdx);
    return enabledCapabilities.includes(parentPackId);
  }
  const prefix = `${capabilityId}.`;
  return enabledCapabilities.some((c) => c.startsWith(prefix));
}
