import type {
  ChannelPoolConfig,
  ScriptLanguageId,
  VariableInitialValue,
} from '../../types/project';
import type { ModuleConflictItem } from '../extensions/moduleResolver';

export const DEFAULT_CHANNEL_COUNT = 8;
export const MIN_CHANNEL_COUNT = 1;
export const MAX_CHANNEL_COUNT = 32;
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
  /** True when the branch function accepts the dispatch event's formal parameters (e.g. `on_button(key, pressed)`). */
  passParams?: boolean;
  /** True when this hat declares an explicit `extractBranchFnPrefix` (always routes via branch fns, e.g. `on_timer`). */
  alwaysExtract?: boolean;
  /** Per-language rendered dispatch branch condition keyed by ScriptLanguageId. */
  condition: Partial<Record<ScriptLanguageId, string>>;
  /** Per-language rendered inline branch comment keyed by ScriptLanguageId. */
  comment: Partial<Record<ScriptLanguageId, string>>;
  scriptId: string;
  scriptName: string;
}

export interface DeclaredFunctionMeta {
  name: string;
  params: string[];
  hasReturn: boolean;
  /** True when the function body directly or transitively calls `poly_wait_ms` (`sleep_ms`). */
  usesSleep?: boolean;
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
  /** True when this script declares any hat whose `hat.keepsAlive` is true (e.g. external IRQ callbacks). */
  hasExternalKeepAliveHat?: boolean;
  /** Extracted dispatch branches (e.g. `on_timer_0`, `on_button_A_press`) routed centrally by the entry script. */
  dispatchBranches?: DispatchBranchMeta[];
  /** Non-parameter workspace variable names actively referenced by enabled blocks in this script. */
  declaredVariables?: string[];
  /** Top-level custom procedures (`procedures_defnoreturn` / `procedures_defreturn`) defined in this script. */
  declaredFunctions?: DeclaredFunctionMeta[];
}

/**
 * Explicit immutable compile context passed to `ScriptBackendAdapter.generate(workspace, ctx)`.
 * Scoped via `withCompileContext(ctx, fn)` so headless compilation, ZIP export, and multi-handle
 * pre-run checks execute as pure, re-entrant passes without ever leaking mutable global state.
 */
export interface CompileContext {
  channelPoolConfigs?: Record<string, Partial<ChannelPoolConfig> | undefined>;
  enabledCapabilities?: string[] | null;
  handleScripts?: ActiveHandleScriptMeta[];
  currentScriptId?: string | null;
  sharedVariables?: string[] | null;
  sharedVarInitials?: Record<string, VariableInitialValue> | null;
  scriptVarInitials?: Record<string, VariableInitialValue> | null;
  sharedFunctions?: string[] | null;
  moduleConflicts?: ModuleConflictItem[];
}

export function normalizeChannelPoolConfig(
  raw?: Partial<ChannelPoolConfig> | null,
  fallbackCount = DEFAULT_CHANNEL_COUNT,
  minCount = MIN_CHANNEL_COUNT,
  maxCount = MAX_CHANNEL_COUNT,
): ChannelPoolConfig {
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
 * Live workspace context bridge synced to the currently active Blockly canvas
 * (read by dynamic Blockly dropdown fields, toolbox flyout builders, and scoped compile passes).
 */
const activeChannelPools = new Map<string, ChannelPoolConfig>();

let activeCapabilities: string[] | null = null;
let activeHandleScripts: ActiveHandleScriptMeta[] = [];
let activeHandleScriptId: string | null = null;
let activeHandleSharedVariables: string[] | null = null;
let activeHandleSharedVarInitials: Record<string, VariableInitialValue> = {};
let activeScriptVarInitials: Record<string, VariableInitialValue> = {};
let activeHandleSharedFunctions: string[] | null = null;
let activeModuleConflicts: ModuleConflictItem[] = [];

/**
 * Executes `fn` with an explicit `CompileContext` applied cleanly for the duration of the call,
 * unconditionally restoring the previous canvas bridge state in `finally`.
 */
export function withCompileContext<T>(
  ctx: CompileContext | undefined,
  fn: () => T,
): T {
  if (!ctx) return fn();

  const prevPools = new Map<string, ChannelPoolConfig>();
  for (const [k, v] of activeChannelPools.entries()) {
    prevPools.set(k, { count: v.count, aliases: { ...v.aliases } });
  }
  const prevCaps = activeCapabilities ? [...activeCapabilities] : null;
  const prevScripts = activeHandleScripts;
  const prevScriptId = activeHandleScriptId;
  const prevSharedVars = activeHandleSharedVariables
    ? [...activeHandleSharedVariables]
    : null;
  const prevSharedVarInitials = { ...activeHandleSharedVarInitials };
  const prevScriptVarInitials = { ...activeScriptVarInitials };
  const prevSharedFns = activeHandleSharedFunctions
    ? [...activeHandleSharedFunctions]
    : null;
  const prevConflicts = [...activeModuleConflicts];

  try {
    if (ctx.channelPoolConfigs !== undefined) {
      setActiveChannelPoolConfigs(ctx.channelPoolConfigs);
    }
    if (ctx.enabledCapabilities !== undefined) {
      setActiveProjectCapabilities(ctx.enabledCapabilities);
    }
    if (ctx.handleScripts !== undefined) {
      setActiveHandleScripts(
        ctx.handleScripts,
        ctx.currentScriptId !== undefined ? ctx.currentScriptId : prevScriptId,
      );
    } else if (ctx.currentScriptId !== undefined) {
      activeHandleScriptId = ctx.currentScriptId;
    }
    if (ctx.sharedVariables !== undefined) {
      setActiveHandleSharedVariables(ctx.sharedVariables);
    }
    if (ctx.sharedVarInitials !== undefined) {
      setActiveHandleSharedVarInitials(ctx.sharedVarInitials);
    }
    if (ctx.scriptVarInitials !== undefined) {
      setActiveScriptVarInitials(ctx.scriptVarInitials);
    }
    if (ctx.sharedFunctions !== undefined) {
      setActiveHandleSharedFunctions(ctx.sharedFunctions);
    }
    if (ctx.moduleConflicts !== undefined) {
      setActiveModuleConflicts(ctx.moduleConflicts);
    }
    return fn();
  } finally {
    activeChannelPools.clear();
    for (const [k, v] of prevPools.entries()) {
      activeChannelPools.set(k, v);
    }
    activeCapabilities = prevCaps;
    activeHandleScripts = prevScripts;
    activeHandleScriptId = prevScriptId;
    activeHandleSharedVariables = prevSharedVars;
    activeHandleSharedVarInitials = prevSharedVarInitials;
    activeScriptVarInitials = prevScriptVarInitials;
    activeHandleSharedFunctions = prevSharedFns;
    activeModuleConflicts = prevConflicts;
  }
}

export function setActiveHandleSharedVariables(names: string[] | null): void {
  activeHandleSharedVariables = names ? [...names] : null;
}

export function getActiveHandleSharedVariables(): string[] | null {
  return activeHandleSharedVariables;
}

export function setActiveHandleSharedVarInitials(
  initials?: Record<string, VariableInitialValue> | null,
): void {
  activeHandleSharedVarInitials = initials ? { ...initials } : {};
}

export function getActiveHandleSharedVarInitials(): Record<
  string,
  VariableInitialValue
> {
  return activeHandleSharedVarInitials;
}

export function setActiveScriptVarInitials(
  initials?: Record<string, VariableInitialValue> | null,
): void {
  activeScriptVarInitials = initials ? { ...initials } : {};
}

export function getActiveScriptVarInitials(): Record<
  string,
  VariableInitialValue
> {
  return activeScriptVarInitials;
}

export function setActiveHandleSharedFunctions(names: string[] | null): void {
  activeHandleSharedFunctions = names ? [...names] : null;
}

export function getActiveHandleSharedFunctions(): string[] | null {
  return activeHandleSharedFunctions;
}

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
      ? s.dispatchBranches.map((b) => ({
          ...b,
          params: [...b.params],
          condition: { ...b.condition },
          comment: { ...b.comment },
        }))
      : [],
    declaredVariables: s.declaredVariables ? [...s.declaredVariables] : [],
    declaredFunctions: s.declaredFunctions
      ? s.declaredFunctions.map((f) => ({ ...f, params: [...f.params] }))
      : [],
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

export function setActiveChannelPoolConfigs(
  configs: Record<string, Partial<ChannelPoolConfig> | undefined>,
): void {
  activeChannelPools.clear();
  for (const [key, rawCfg] of Object.entries(configs)) {
    activeChannelPools.set(key, normalizeChannelPoolConfig(rawCfg));
  }
}

export function setActiveChannelPoolConfig(
  configKey: string,
  cfg?: Partial<ChannelPoolConfig> | null,
  fallbackCount = DEFAULT_CHANNEL_COUNT,
  minCount = MIN_CHANNEL_COUNT,
  maxCount = MAX_CHANNEL_COUNT,
): void {
  activeChannelPools.set(
    configKey,
    normalizeChannelPoolConfig(cfg, fallbackCount, minCount, maxCount),
  );
}

export function getActiveChannelPoolConfig(
  configKey: string,
  fallbackCount = DEFAULT_CHANNEL_COUNT,
): ChannelPoolConfig {
  const found = activeChannelPools.get(configKey);
  if (found) return found;
  return { count: fallbackCount, aliases: {} };
}

export function formatChannelLabel(
  id: number,
  cfg: ChannelPoolConfig,
  prefix = 'CH',
): string {
  const alias = cfg.aliases[String(id)];
  if (id >= cfg.count) {
    return alias ? `${prefix}${id} · ${alias} (越界)` : `${prefix}${id} (越界)`;
  }
  return alias ? `${prefix}${id} · ${alias}` : `${prefix}${id}`;
}

/**
 * Dynamic Blockly FieldDropdown option generator scoped to a specific channel-pool `configKey`.
 * Reflects the active handle's channel count (0..count-1) & handle-local aliases,
 * preserves out-of-range IDs cleanly, and appends an inline "edit alias" shortcut item.
 */
export function buildChannelDropdownOptions(
  configKey: string,
  prefix = 'CH',
  currentValue?: string | null,
  defaultCount = DEFAULT_CHANNEL_COUNT,
  maxCount = MAX_CHANNEL_COUNT,
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
    options.push(['✎ 修改本通道别名...', EDIT_TIMER_ALIAS_SENTINEL]);
  }
  return options;
}
