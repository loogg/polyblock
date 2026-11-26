import type { ProjectTimerConfig } from '../../types/project';
import type { ModuleConflictItem } from '../extensions/moduleResolver';

export const DEFAULT_TIMER_COUNT = 8;
export const MIN_TIMER_COUNT = 1;
export const MAX_TIMER_COUNT = 32;
export const DEFAULT_TIMER_POOL_KEY = 'rt.timers';
export const EDIT_TIMER_ALIAS_SENTINEL = '__EDIT_TIMER_ALIAS__';

export interface ChannelAliasPromptRequest {
  configKey: string;
  channelId: number;
  prefix: string;
  label: string;
}

export interface DispatchBranchMeta {
  blockType: string;
  eventName: string;
  fnPrefix: string;
  fnName: string;
  dupKey: string;
  params: string[];
  conditionLua: string;
  conditionPython: string;
  commentLua: string;
  commentPython: string;
  scriptId: string;
  scriptName: string;
}

export interface ActiveHandleScriptMeta {
  id: string;
  name: string;
  isEntry: boolean;
  /** Top-level global callback event names declared in this script (e.g. 'on_start', 'on_timer'). */
  declaredEvents: string[];
  /** Sibling script names explicitly loaded via `poly_require_script` inside this script. */
  requiredScripts: string[];
  /** Extracted dispatch branches (e.g. `on_timer_0`, `on_timer_1`) routed centrally by the entry script. */
  dispatchBranches?: DispatchBranchMeta[];
  /** Non-parameter workspace variable names actively referenced by enabled blocks in this script. */
  declaredVariables?: string[];
}

export function normalizeTimerConfig(
  raw?: Partial<ProjectTimerConfig> | null,
  fallbackCount = DEFAULT_TIMER_COUNT,
  minCount = MIN_TIMER_COUNT,
  maxCount = MAX_TIMER_COUNT,
): ProjectTimerConfig {
  const safeMin = Math.max(1, Math.trunc(minCount));
  const safeMax = Math.max(safeMin, Math.min(64, Math.trunc(maxCount)));
  const countNum = Number(raw?.count);
  const count = Number.isFinite(countNum)
    ? Math.max(safeMin, Math.min(safeMax, Math.trunc(countNum)))
    : Math.max(safeMin, Math.min(safeMax, Math.trunc(fallbackCount)));

  const aliases: Record<string, string> = {};
  if (raw?.aliases && typeof raw.aliases === 'object') {
    for (const [k, v] of Object.entries(raw.aliases)) {
      const idx = Number(k);
      if (
        Number.isInteger(idx) &&
        idx >= 0 &&
        idx < safeMax &&
        typeof v === 'string' &&
        v.trim()
      ) {
        aliases[String(idx)] = v.trim().slice(0, 16);
      }
    }
  }

  return { count, aliases };
}

/**
 * Per-configKey isolated channel pool configurations for the currently active RuntimeHandle.
 * Prevents collisions when multiple sections declare `handleConfigs` (`channel-pool`, e.g. `rt.timers` vs `pwm-driver`).
 */
const activeChannelPools = new Map<string, ProjectTimerConfig>([
  [DEFAULT_TIMER_POOL_KEY, { count: DEFAULT_TIMER_COUNT, aliases: {} }],
]);

let activeCapabilities: string[] | null = null;
let activeHandleScripts: ActiveHandleScriptMeta[] = [];
let activeHandleScriptId: string | null = null;
let activeModuleConflicts: ModuleConflictItem[] = [];

export function setActiveModuleConflicts(conflicts: ModuleConflictItem[]): void {
  activeModuleConflicts = [...conflicts];
}

export function getActiveModuleConflicts(): ModuleConflictItem[] {
  return activeModuleConflicts;
}

export function setActiveProjectCapabilities(caps: string[] | null): void {
  activeCapabilities = caps ? [...caps] : null;
}

export function getActiveProjectCapabilities(): string[] | null {
  return activeCapabilities;
}

export function setActiveHandleScripts(
  scripts: ActiveHandleScriptMeta[],
  currentScriptId: string | null,
): void {
  activeHandleScripts = scripts.map((s) => ({
    ...s,
    declaredEvents: [...s.declaredEvents],
    requiredScripts: [...s.requiredScripts],
    dispatchBranches: s.dispatchBranches
      ? s.dispatchBranches.map((b) => ({ ...b, params: [...b.params] }))
      : [],
    declaredVariables: s.declaredVariables ? [...s.declaredVariables] : [],
  }));
  activeHandleScriptId = currentScriptId;
}

export function getActiveHandleScripts(): ActiveHandleScriptMeta[] {
  return activeHandleScripts;
}

export function getActiveHandleScriptId(): string | null {
  return activeHandleScriptId;
}

/** Returns true when compiling the handle's entry script (or standalone without handle metadata). */
export function isCurrentHandleScriptEntry(): boolean {
  if (activeHandleScripts.length === 0 || !activeHandleScriptId) return true;
  const cur = activeHandleScripts.find((s) => s.id === activeHandleScriptId);
  return cur ? cur.isEntry : true;
}

/** Dynamic Blockly dropdown options listing sibling scripts in the active handle. */
export function getSiblingScriptDropdownOptions(
  fallbackName?: string,
): Array<[string, string]> {
  const siblings = activeHandleScripts.filter(
    (s) => s.id !== activeHandleScriptId,
  );
  const options: Array<[string, string]> = siblings.map((s) => [s.name, s.name]);
  const fb = (fallbackName ?? '').trim();
  if (fb && !options.some(([, v]) => v === fb)) {
    options.push([`${fb} (未找到)`, fb]);
  }
  if (options.length === 0) {
    options.push(['timers', 'timers']);
  }
  return options;
}

let channelAliasPromptHandler: ((req: ChannelAliasPromptRequest) => void) | null = null;

export function registerChannelAliasPromptHandler(
  handler: ((req: ChannelAliasPromptRequest) => void) | null,
): void {
  channelAliasPromptHandler = handler;
}

export function triggerChannelAliasPrompt(req: ChannelAliasPromptRequest): void {
  channelAliasPromptHandler?.(req);
}

/** Legacy wrapper for timer-only callers. */
export function registerTimerAliasPromptHandler(
  handler: ((timerId: number) => void) | null,
): void {
  channelAliasPromptHandler = handler ? (req) => handler(req.channelId) : null;
}

/** Legacy wrapper for timer-only callers. */
export function triggerTimerAliasPrompt(timerId: number): void {
  triggerChannelAliasPrompt({
    configKey: DEFAULT_TIMER_POOL_KEY,
    channelId: timerId,
    prefix: 'T',
    label: '定时器通道',
  });
}

export function setActiveChannelPoolConfigs(
  configs: Record<string, Partial<ProjectTimerConfig> | undefined>,
): void {
  activeChannelPools.clear();
  for (const [key, rawCfg] of Object.entries(configs)) {
    activeChannelPools.set(key, normalizeTimerConfig(rawCfg));
  }
  if (!activeChannelPools.has(DEFAULT_TIMER_POOL_KEY)) {
    activeChannelPools.set(DEFAULT_TIMER_POOL_KEY, {
      count: DEFAULT_TIMER_COUNT,
      aliases: {},
    });
  }
}

export function setActiveChannelPoolConfig(
  configKey: string,
  cfg?: Partial<ProjectTimerConfig> | null,
  fallbackCount = DEFAULT_TIMER_COUNT,
  minCount = MIN_TIMER_COUNT,
  maxCount = MAX_TIMER_COUNT,
): void {
  activeChannelPools.set(
    configKey,
    normalizeTimerConfig(cfg, fallbackCount, minCount, maxCount),
  );
}

export function getActiveChannelPoolConfig(
  configKey: string,
  fallbackCount = DEFAULT_TIMER_COUNT,
): ProjectTimerConfig {
  const found = activeChannelPools.get(configKey);
  if (found) return found;
  return { count: fallbackCount, aliases: {} };
}

export function getActiveTimerConfig(): ProjectTimerConfig {
  return getActiveChannelPoolConfig(DEFAULT_TIMER_POOL_KEY, DEFAULT_TIMER_COUNT);
}

export function setActiveTimerConfig(cfg?: Partial<ProjectTimerConfig> | null): void {
  setActiveChannelPoolConfig(DEFAULT_TIMER_POOL_KEY, cfg);
}

export function formatChannelLabel(
  id: number,
  cfg: ProjectTimerConfig,
  prefix = 'T',
): string {
  const alias = cfg.aliases[String(id)];
  if (id >= cfg.count) {
    return alias ? `${prefix}${id} · ${alias} (越界)` : `${prefix}${id} (越界)`;
  }
  return alias ? `${prefix}${id} · ${alias}` : `${prefix}${id}`;
}

export function formatTimerLabel(
  id: number,
  cfg: ProjectTimerConfig = getActiveTimerConfig(),
): string {
  return formatChannelLabel(id, cfg, 'T');
}

/**
 * Dynamic Blockly FieldDropdown option generator scoped to a specific channel-pool `configKey`.
 * Reflects the active handle's channel count (0..count-1) & handle-local aliases,
 * preserves out-of-range IDs cleanly, and appends an inline "edit alias" shortcut item.
 */
export function buildChannelDropdownOptions(
  configKey: string,
  prefix = 'T',
  currentValue?: string | null,
  defaultCount = DEFAULT_TIMER_COUNT,
  maxCount = MAX_TIMER_COUNT,
  includeEditShortcut = true,
): Array<[string, string]> {
  const cfg = getActiveChannelPoolConfig(configKey, defaultCount);
  const options: Array<[string, string]> = [];

  for (let i = 0; i < cfg.count; i++) {
    options.push([formatChannelLabel(i, cfg, prefix), String(i)]);
  }

  if (currentValue !== undefined && currentValue !== null && currentValue !== '') {
    const parsed = Number(currentValue);
    if (
      Number.isInteger(parsed) &&
      parsed >= cfg.count &&
      parsed < maxCount
    ) {
      options.push([formatChannelLabel(parsed, cfg, prefix), String(parsed)]);
    }
  }

  if (includeEditShortcut) {
    const curId =
      currentValue && /^\d+$/.test(currentValue) ? Number(currentValue) : 0;
    options.push([
      `✎ 设置 ${prefix}${curId} 通道别名...`,
      EDIT_TIMER_ALIAS_SENTINEL,
    ]);
  }

  return options;
}

export function buildTimerDropdownOptions(
  currentValue?: string | null,
  includeEditShortcut = true,
): Array<[string, string]> {
  return buildChannelDropdownOptions(
    DEFAULT_TIMER_POOL_KEY,
    'T',
    currentValue,
    DEFAULT_TIMER_COUNT,
    MAX_TIMER_COUNT,
    includeEditShortcut,
  );
}
