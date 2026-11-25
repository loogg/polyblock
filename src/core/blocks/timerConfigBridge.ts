import type { ProjectTimerConfig } from '../../types/project';

export const DEFAULT_TIMER_COUNT = 8;
export const MIN_TIMER_COUNT = 1;
export const MAX_TIMER_COUNT = 32;

export function normalizeTimerConfig(
  raw?: Partial<ProjectTimerConfig> | null,
): ProjectTimerConfig {
  const countNum = Number(raw?.count);
  const count = Number.isFinite(countNum)
    ? Math.max(MIN_TIMER_COUNT, Math.min(MAX_TIMER_COUNT, Math.trunc(countNum)))
    : DEFAULT_TIMER_COUNT;

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
 * Always reflects the active project's timer channel count (0..count-1) & aliases.
 * If an existing block carries an out-of-range ID (e.g. after switching config),
 * keeps it selectable as "(越界)" so Blockly loads cleanly while static diagnostics warn.
 */
export function buildTimerDropdownOptions(
  currentValue?: string | null,
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

  return options;
}
