import type { ProjectTimerConfig } from '../../types/project';

export const DEFAULT_TIMER_COUNT = 8;
export const MIN_TIMER_COUNT = 1;
export const MAX_TIMER_COUNT = 32;
export const EDIT_TIMER_ALIAS_SENTINEL = '__EDIT_TIMER_ALIAS__';

export function normalizeTimerConfig(
  raw?: Partial<ProjectTimerConfig> | null,
  fallbackCount = DEFAULT_TIMER_COUNT,
): ProjectTimerConfig {
  const countNum = Number(raw?.count);
  const count = Number.isFinite(countNum)
    ? Math.max(MIN_TIMER_COUNT, Math.min(MAX_TIMER_COUNT, Math.trunc(countNum)))
    : Math.max(MIN_TIMER_COUNT, Math.min(MAX_TIMER_COUNT, Math.trunc(fallbackCount)));

  const aliases: Record<string, string> = {};
  if (raw?.aliases && typeof raw.aliases === 'object') {
    for (const [k, v] of Object.entries(raw.aliases)) {
      const idx = Number(k);
      if (
        Number.isInteger(idx) &&
        idx >= 0 &&
        idx < MAX_TIMER_COUNT &&
        typeof v === 'string' &&
        v.trim()
      ) {
        aliases[String(idx)] = v.trim().slice(0, 16);
      }
    }
  }

  return { count, aliases };
}

let activeTimerConfig: ProjectTimerConfig = {
  count: DEFAULT_TIMER_COUNT,
  aliases: {},
};

let aliasPromptHandler: ((timerId: number) => void) | null = null;

export function registerTimerAliasPromptHandler(
  handler: ((timerId: number) => void) | null,
): void {
  aliasPromptHandler = handler;
}

export function triggerTimerAliasPrompt(timerId: number): void {
  aliasPromptHandler?.(timerId);
}

export function getActiveTimerConfig(): ProjectTimerConfig {
  return activeTimerConfig;
}

export function setActiveTimerConfig(cfg?: Partial<ProjectTimerConfig> | null): void {
  activeTimerConfig = normalizeTimerConfig(cfg);
}

export function formatTimerLabel(
  id: number,
  cfg: ProjectTimerConfig = activeTimerConfig,
): string {
  const alias = cfg.aliases[String(id)];
  if (id >= cfg.count) {
    return alias ? `T${id} · ${alias} (越界)` : `T${id} (越界)`;
  }
  return alias ? `T${id} · ${alias}` : `T${id}`;
}

/**
 * Dynamic Blockly FieldDropdown option generator.
 * Reflects the active handle's timer channel count (0..count-1) & handle-local aliases,
 * preserves out-of-range IDs cleanly, and appends an inline "edit alias" shortcut item.
 */
export function buildTimerDropdownOptions(
  currentValue?: string | null,
  includeEditShortcut = true,
): Array<[string, string]> {
  const cfg = activeTimerConfig;
  const options: Array<[string, string]> = [];

  for (let i = 0; i < cfg.count; i++) {
    options.push([formatTimerLabel(i, cfg), String(i)]);
  }

  if (currentValue !== undefined && currentValue !== null && currentValue !== '') {
    const parsed = Number(currentValue);
    if (
      Number.isInteger(parsed) &&
      parsed >= cfg.count &&
      parsed < MAX_TIMER_COUNT
    ) {
      options.push([formatTimerLabel(parsed, cfg), String(parsed)]);
    }
  }

  if (includeEditShortcut) {
    const curId =
      currentValue && /^\d+$/.test(currentValue) ? Number(currentValue) : 0;
    options.push([
      `✎ 设置 T${curId} 通道别名...`,
      EDIT_TIMER_ALIAS_SENTINEL,
    ]);
  }

  return options;
}
