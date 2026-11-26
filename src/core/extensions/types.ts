export interface ExtensionBlockShadow {
  type: 'math_number' | 'text';
  value: number | string;
}

export interface ExtensionCodeTemplate {
  /** Template string supporting {{ARG}}, {{ARG:json}}, {{ARG:int}}, {{ARG:bool_lua}}, {{ARG:bool_py}}, {{ARG:channel_comment_lua}}, {{ARG:channel_comment_py}} */
  template: string;
  /** Deduplicated module import lines hoisted to file top (e.g. `import board` or `local board = require("board")`) */
  imports?: string[];
}

/**
 * Declarative top-level event callback ("hat") block specification inside `.polyext.json`.
 * Supports both singleton callbacks (e.g. `on_run`, `on_stop`) and zero-closure
 * aggregated dispatch callbacks (e.g. `on_timer(id)`, `on_button(key, pressed)`, `on_can_rx(id, data)`).
 */
export interface ExtensionHatSpec {
  /** Generated top-level callback function name (e.g. "on_button", "on_timer", "on_can_rx"). */
  eventName: string;
  /** Formal parameters of the generated top-level callback (e.g. ["key", "pressed"]). */
  params?: string[];
  /**
   * - 'singleton': generates a single top-level callback (`function on_run() ... end`).
   * - 'dispatch': aggregates all enabled hats of this block type into ONE top-level function
   *   with `if / elseif` (Lua) or `if / elif` (Python) branches.
   */
  mode: 'singleton' | 'dispatch';
  /** Optional statement emitted right before the callback definition (e.g. `rt.set_run_period({{PERIOD_MS}})`). */
  preludeLua?: string;
  preludePython?: string;
  /** Module imports hoisted to file top when this hat is present. */
  importsLua?: string[];
  importsPython?: string[];
  /** Branch condition template for mode='dispatch'. */
  conditionLua?: string;
  conditionPython?: string;
  /** Optional inline comment suffix on each dispatch branch (e.g. `{{TIMER_ID:channel_comment_lua}}`). */
  branchCommentLua?: string;
  branchCommentPython?: string;
  /**
   * Optional Scheme A extraction prefix for mode='dispatch'.
   * When set (e.g. `'on_timer_'`), each hat block generates a standalone global function
   * `function on_timer_<key>() ... end`, and the top-level dispatcher only calls those functions.
   */
  extractBranchFnPrefix?: string;
  /** Template producing a uniqueness key to warn on duplicate dispatch branches (e.g. "{{KEY}}:{{EDGE}}"). */
  duplicateKeyTemplate?: string;
  /** Scope-tree display label template (e.g. "on_button · 按键 {{KEY}} {{EDGE}}"). */
  scopeLabelTemplate?: string;
  scopeShortTemplate?: string;
  scopeCategory?: 'lifecycle' | 'timer' | 'button' | 'function';
  /** Whether defining this callback keeps the browser sandbox event loop alive waiting for events (default: true). */
  keepsAlive?: boolean;
}

export interface ExtensionBlockDef {
  type: string;
  kind: 'statement' | 'value' | 'hat';
  message0: string;
  args0?: Array<Record<string, unknown>>;
  inputsInline?: boolean;
  outputType?: string | null;
  tooltip?: string;
  keywords?: string;
  /** Optional Blockly theme style override (e.g. 'event_blocks', 'timer_hat_blocks', 'timer_blocks'). */
  blockStyle?: string;
  fields?: Record<string, unknown>;
  shadows?: Record<string, ExtensionBlockShadow>;
  /** Required for kind='statement' and kind='value'; optional for kind='hat'. */
  lua?: ExtensionCodeTemplate;
  python?: ExtensionCodeTemplate;
  /** Required when kind='hat'. */
  hat?: ExtensionHatSpec;
}

export interface ExtensionSandboxMock {
  moduleName: string;
  luaSource?: string;
  pythonSource?: string;
  /** Auto-populated by registry when resolving mocks for pack-scoped simState isolation. */
  packId?: string;
}

/**
 * Built-in generic declarative simulation widget types rendered in the right-hand Simulator tab:
 * - `led`: single-color on/off LED
 * - `tricolor`: 3-color discrete indicator lamp (ONLY Red / Green / Blue + OFF)
 * - `rgb`: full-color RGB LED (arbitrary #RRGGBB color, e.g. WS2812 / PWM RGB)
 */
export type SimWidgetKind =
  | 'led'
  | 'tricolor'
  | 'rgb'
  | 'bar'
  | 'screen'
  | 'slider'
  | 'toggle'
  | 'button';

/** Event emission rule attached to interactive input widgets (`button` / `toggle`). */
export interface SimWidgetEventTrigger {
  /** Top-level event callback name to invoke (e.g. "on_button", "on_can_rx"). */
  eventName: string;
  /**
   * Arguments passed to the callback. Special placeholders:
   * - "$value": current boolean/number/string value of this widget
   * - "$state:<key>": current value of another widget key in the same pack
   */
  args?: Array<string | number | boolean>;
  /** 'change' fires on every toggle/press/release (default); 'rising' fires only when transitioning to true. */
  trigger?: 'change' | 'rising';
}

/**
 * Declarative simulator widget bound to a pack-scoped state key (or `global:<key>` for
 * explicit cross-pack sharing) read/written by `sandboxMock` via `__poly_sim_get` / `__poly_sim_set`.
 */
export interface SimWidgetSpec {
  kind: SimWidgetKind;
  key: string;
  label: string;
  default?: boolean | number | string | string[];
  color?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  maxLines?: number;
  hint?: string;
  marks?: string[];
  activeLabel?: string;
  idleLabel?: string;
  /** Optional asynchronous event trigger dispatched to all running handles when interacted with. */
  emitEvent?: SimWidgetEventTrigger;
}

/**
 * Declarative per-handle integer channel pool configuration schema (e.g. 0..N-1 timers, PWM, CAN slots).
 * Enables automatic per-handle channel count & alias UI in ProjectSettingsModal plus OOB static checks.
 */
export interface HandleChannelPoolSpec {
  /** Key in RuntimeHandle.capabilityConfigs (e.g. 'rt.timers'). */
  configKey: string;
  /** Display name (e.g. '定时器通道'). */
  label: string;
  /** Short channel prefix (e.g. 'T' -> T0, T1...). */
  prefix: string;
  min: number;
  max: number;
  defaultCount: number;
  presets?: number[];
  hint?: string;
  /** Field name on blocks that references this channel pool (default 'TIMER_ID'). */
  fieldName?: string;
}

/** Unified shared simulator state map across all active handles and extension widget cards. */
export type SimStateMap = Record<string, unknown>;

/** Objective multi-attribute badge rendered on extension pack cards in UI. */
export interface PackAttributeBadge {
  id: string;
  label: string;
  tone: 'sim' | 'event' | 'pool' | 'lib' | 'tag';
}

/** Layer 0 core Blockly toolbox category IDs that any pack section can declaratively merge into. */
export type CoreCategoryTarget =
  | 'event'
  | 'print'
  | 'control'
  | 'variables'
  | 'math'
  | 'logic'
  | 'text'
  | 'lists'
  | 'functions';

/** Where a pack (or section) places its blocks in the left toolbox: standalone tab or merged into a core category. */
export type CategoryTargetSpec = 'own' | CoreCategoryTarget;

/**
 * Declarative sub-section inside a multi-section extension pack (1 Pack = 1 logical module/SDK).
 * Each section independently controls sidebar visibility, target category (`'own'` or any core category),
 * sort order, color, flyout button, optional channel pool, and which blocks belong to it.
 * Projects can toggle the entire pack (`"rt"`) or finely prune individual sections (`"rt.timers"`).
 */
export interface ExtensionSectionSpec {
  /** Section ID unique within its pack (e.g. 'lifecycle', 'timers', 'tick'). Capability ID is `<pack.id>.<section.id>`. */
  id: string;
  /** Display label in the sidebar tab (when categoryTarget === 'own') and pack section chips. */
  label: string;
  description?: string;
  /** Whether this section is displayed in the left Blockly toolbox (default: true). */
  visible?: boolean;
  /** 'own' creates a standalone toolbox tab (default); or any core category ID to merge blocks into that core tab. */
  categoryTarget?: CategoryTargetSpec;
  /** Numeric sort order in the left toolbox when categoryTarget === 'own' (default: pack.toolboxOrder ?? 100). */
  toolboxOrder?: number;
  /** Category accent color (default: pack.color). */
  color?: string;
  /** Optional toolbox header button inside this section's flyout. */
  flyoutButton?: { text: string; callbackKey: string };
  /** Whether this section enables the per-handle RT scheduler monitor card in Simulator tab & event-driven ABI. */
  hasRtMonitorUi?: boolean;
  /** Optional per-handle channel pool config owned by this section (e.g. 0..N-1 timer, PWM, or CAN channels). */
  handleChannelPool?: HandleChannelPoolSpec;
  /** Ordered list of block `type` IDs from `pack.blocks` belonging to this section. */
  blocks: string[];
}

/** Normalized runtime view of a pack section (single-section packs synthesize one default section). */
export interface ResolvedPackSection {
  /** Full capability ID: `<pack.id>` for single-section packs, `<pack.id>.<section.id>` for multi-section packs. */
  capId: string;
  sectionId: string;
  label: string;
  description?: string;
  visible: boolean;
  categoryTarget: CategoryTargetSpec;
  toolboxOrder: number;
  color: string;
  flyoutButton?: { text: string; callbackKey: string };
  hasRtMonitorUi: boolean;
  handleChannelPool?: HandleChannelPoolSpec;
  blocks: ExtensionBlockDef[];
  isMultiSection: boolean;
}

/**
 * Unified Declarative PolyBlock Extension Pack schema (.polyext.json).
 * 1 Pack = 1 logical module / SDK; optional `sections[]` splits a large SDK into independently
 * placed, ordered, visible, and prunable toolbox sections without splitting the pack itself.
 */
export interface PolyExtensionPack {
  format: 'polyblock-extension';
  version: 1;
  id: string;
  name: string;
  packVersion: string;
  categoryLabel: string;
  color: string;
  description: string;
  builtin?: boolean;
  /** Whether this pack is shown in the left toolbox when single-section (default: true). */
  visible?: boolean;
  /**
   * Continuous numeric sort order in the left Blockly toolbox.
   * Core categories occupy 10..90 (事件=10, 打印=20, ..., 函数=90);
   * extension packs default to 100 (appearing in the extension section below 函数).
   */
  toolboxOrder?: number;
  /** Optional custom attribute tags displayed as pills on pack cards (e.g. ["电机", "CAN"]). */
  tags?: string[];
  /** Where blocks appear in the left toolbox for single-section packs: 'own' (default) or any core category ID. */
  categoryTarget?: CategoryTargetSpec;
  /** Optional toolbox header button inside this pack's category flyout (single-section packs). */
  flyoutButton?: { text: string; callbackKey: string };
  /** Whether this pack enables the per-handle RT scheduler monitor card & event-driven ABI (single-section packs). */
  hasRtMonitorUi?: boolean;
  /** @deprecated Prefer declarative `simWidgets`. */
  hasVirtualBoardUi?: boolean;
  /** Optional per-handle channel pool config (single-section packs; multi-section packs declare this per section). */
  handleChannelPool?: HandleChannelPoolSpec;
  /** Optional multi-section layout & fine-grained pruning definitions referencing block types in `blocks`. */
  sections?: ExtensionSectionSpec[];
  blocks: ExtensionBlockDef[];
  sandboxMock?: ExtensionSandboxMock;
  /** Optional declarative widgets rendered as a dedicated peripheral card in the Simulator tab. */
  simWidgets?: SimWidgetSpec[];
}

export interface VirtualBoardState {
  led: boolean;
  rgb: string;
  oledLines: string[];
}

export interface VirtualBoardInputs {
  temp: number;
  btnA: boolean;
  btnB: boolean;
}
