import type {
  RuntimeCapabilitySpec,
  TargetProfile,
} from '../../types/project';

export const CAP_RT_LIFECYCLE = 'rt-lifecycle';
export const CAP_RT_TIMERS = 'rt-timers';
export const CAP_VIRTUAL_BOARD = 'virtual-board';

export const STORAGE_CUSTOM_PROFILES_KEY = 'polyblock.profiles.custom.v1';

/** Built-in pluggable runtime capabilities (decoupled from Layer 0 core!). */
export const BUILTIN_RUNTIME_CAPABILITIES: RuntimeCapabilitySpec[] = [
  {
    id: CAP_RT_LIFECYCLE,
    name: '周期事件循环 (on_run / on_stop)',
    shortLabel: '周期循环',
    color: '#e0911f',
    scope: 'project',
    description:
      '为项目启用常驻周期回调 on_run（默认 100ms，可动态调频/启停）与安全停机 on_stop 积木，对应板端 rt 周期调度。',
  },
  {
    id: CAP_RT_TIMERS,
    name: '多路编号定时器 (rt.timer)',
    shortLabel: '多路定时',
    color: '#6366f1',
    scope: 'handle',
    description:
      '为项目内每个隔离句柄提供独立的整数通道定时器池（0~31 路）、画布就地别名与顶层零闭包 on_timer(id) 分发。',
  },
];

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
    defaultTimerCount: 8,
    capabilities: [],
    builtin: true,
  },
  {
    format: 'polyblock-board',
    version: 1,
    id: 'embedded-rt',
    name: '通用嵌入式 RT 控制板',
    description:
      '多隔离句柄 + on_run 周期循环 + 每句柄独立多路定时器（0~31），不含特定演示外设，适合按需挂载自家硬件扩展包。',
    defaultLanguage: 'lua',
    maxHandles: 8,
    defaultTimerCount: 8,
    capabilities: [CAP_RT_LIFECYCLE, CAP_RT_TIMERS],
    builtin: true,
  },
  {
    format: 'polyblock-board',
    version: 1,
    id: 'virtual-board-rt',
    name: '虚拟硬件 RT 演示板',
    description:
      '完整演示多句柄并发 + 周期调度 + 多路编号定时器 + 示例虚拟板外设（LED / 三色灯 / OLED / 温度 / 按键回调）。',
    defaultLanguage: 'lua',
    maxHandles: 8,
    defaultTimerCount: 8,
    capabilities: [CAP_RT_LIFECYCLE, CAP_RT_TIMERS, CAP_VIRTUAL_BOARD],
    builtin: true,
  },
  {
    format: 'polyblock-board',
    version: 1,
    id: 'virtual-board-basic',
    name: '虚拟硬件基础演示板（无定时）',
    description:
      '仅启用示例虚拟硬件外设包与字典进阶包，不含定时器与 on_run 周期循环，演示不同项目的差异化能力装配。',
    defaultLanguage: 'python',
    maxHandles: 4,
    defaultTimerCount: 8,
    capabilities: [CAP_VIRTUAL_BOARD, 'dict-json'],
    builtin: true,
  },
];

export const SAMPLE_CUSTOM_BOARD_TEMPLATE: TargetProfile = {
  format: 'polyblock-board',
  version: 1,
  id: 'my-industrial-controller',
  name: '自定义工业控制板（示例模板）',
  description:
    '演示如何通过纯 JSON 定义自己的目标设备规格：Lua 5.4、最多 8 个隔离句柄、每句柄默认 16 路定时器。',
  defaultLanguage: 'lua',
  maxHandles: 8,
  defaultTimerCount: 16,
  capabilities: [CAP_RT_LIFECYCLE, CAP_RT_TIMERS, 'dict-json'],
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
  const timerNum = Number(obj.defaultTimerCount);
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
    defaultTimerCount: Number.isFinite(timerNum)
      ? Math.max(1, Math.min(32, Math.trunc(timerNum)))
      : 8,
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
      throw new Error(`板型 ID "${valid.id}" 与内置预设冲突，请更换自定义 ID`);
    }
    const custom: TargetProfile = { ...valid, builtin: false };
    this.profiles.set(custom.id, custom);
    this.persistCustom();
    return custom;
  }

  removeCustomProfile(id: string): boolean {
    this.ensureInitialized();
    const existing = this.profiles.get(id);
    if (!existing || existing.builtin) return false;
    this.profiles.delete(id);
    this.persistCustom();
    return true;
  }

  private persistCustom(): void {
    try {
      const customOnly = Array.from(this.profiles.values()).filter((p) => !p.builtin);
      localStorage.setItem(STORAGE_CUSTOM_PROFILES_KEY, JSON.stringify(customOnly));
    } catch {
      // ignore quota errors
    }
  }
}

export const targetProfileRegistry = new TargetProfileRegistry();

export function hasCapability(
  enabledCapabilities: string[] | undefined,
  capId: string,
): boolean {
  return Array.isArray(enabledCapabilities) && enabledCapabilities.includes(capId);
}
