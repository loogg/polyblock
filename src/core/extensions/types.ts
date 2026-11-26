export interface ExtensionBlockShadow {
  type: 'math_number' | 'text';
  value: number | string;
}

export interface ExtensionPackImports {
  lua?: string[];
  python?: string[];
}

export interface ExtensionCodeTemplate {
  /** Template string supporting {{ARG}}, {{ARG:json}}, {{ARG:int}}, {{ARG:bool_lua}}, {{ARG:bool_py}}, {{ARG:channel_comment_lua}}, {{ARG:channel_comment_py}} */
  template: string;
  /** Optional override of pack-level default imports (pass `[]` to suppress default import for a pure-syntax block). */
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
  /** Optional module imports hoisted when this hat is present (hats do not auto-hoist pack imports). */
  imports?: ExtensionPackImports;
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
  /** Scope-tree display label template (e.g. "on_button · 按键 {{KEY}} {{EDGE:edge_zh}}"). */
  scopeLabelTemplate?: string;
  scopeShortTemplate?: string;
  scopeCategory?: 'lifecycle' | 'event' | 'function';
  /** Whether defining this callback keeps the browser sandbox event loop alive waiting for events (default: true). */
  keepsAlive?: boolean;
}

export interface ExtensionBlockDef {
  type: string;
  /**
   * - 'statement': action block with top/bottom connectors (returns nothing, e.g. LED set, variable assign).
   * - 'value': expression block with output connector plugged into another block's input slot.
   * - 'hat': top-level event callback wrapper generating `function on_xxx(...)`.
   */
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
  /**
   * References widget `key`s from `pack.simWidgets` driven or observed by this block.
   * When a section is enabled, Simulator panel automatically loads only widgets referenced by enabled blocks.
   */
  simWidgetKeys?: string[];
  /**
   * Whether this block can run inside the browser WASM sandbox (default: true).
   * Set to `false` for export-only blocks (e.g. direct chip registers / private C APIs with no sandbox mock).
   */
  sandboxRunnable?: boolean;
}

/**
 * Script module source mounted into Lua `package.preload` / Python `sys.modules`.
 * Used by BOTH:
 * - `sandboxMock`: fake stub for real-hardware C firmware APIs (browser sandbox ONLY, stripped on target export).
 * - `libs[]`: real pure-script library files like `crc16.lua` + `crc16_table.lua` (runs in sandbox AND bundled on target export).
 */
export interface ExtensionModuleSource {
  moduleName: string;
  luaSource?: string;
  pythonSource?: string;
  /** Optional display hint distinguishing entry library files from internal helper dependencies inside `libs[]`. */
  role?: 'entry' | 'helper';
  /** Auto-populated by registry/resolver when mounting modules for pack-scoped simState isolation. */
  packId?: string;
}

/**
 * Built-in generic declarative simulation widget types rendered in the right-hand Simulator tab:
 * - `led`: single-color on/off LED (OFF state uses uniform theme-styled dark bulb)
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
 * Extensible per-handle resource configuration spec (`kind: 'channel-pool'`, extensible to `'fields'` etc.).
 * Automatically drives:
 * 1. Per-handle channel count & alias management UI in ProjectSettingsModal
 * 2. Automatic flyout shortcut button (`⚙ 配置本句柄<label>`) on standalone toolbox sections
 * 3. Dynamic `field_channel_id` dropdown labels & static out-of-range checks
 */
export interface HandleChannelPoolConfigSpec {
  kind: 'channel-pool';
  /** Optional override for `RuntimeHandle.capabilityConfigs` storage key (defaults to section `capId`). */
  configKey?: string;
  /** Resource type name (e.g. '定时器通道', 'PWM 舵机通道'). */
  label: string;
  /** Short human-readable prefix (e.g. 'T' -> T0, 'PWM' -> PWM0; defaults to 'CH'). */
  prefix?: string;
  min: number;
  max: number;
  defaultCount: number;
  presets?: number[];
  hint?: string;
}

/** Extensible discriminated union for per-handle resource configuration types (channel pools, future UART/CAN fields, etc.). */
export type HandleConfigSpec = HandleChannelPoolConfigSpec;

/** Normalized channel-pool config with guaranteed derived `configKey` and `prefix`. */
export interface ResolvedHandleChannelPoolSpec {
  kind: 'channel-pool';
  configKey: string;
  label: string;
  prefix: string;
  min: number;
  max: number;
  defaultCount: number;
  presets?: number[];
  hint?: string;
}

/** Unified shared simulator state map across all active handles and extension widget cards. */
export type SimStateMap = Record<string, unknown>;

/** Objective multi-attribute badge rendered on extension pack cards in UI. */
export interface PackAttributeBadge {
  id: string;
  label: string;
  tone: 'sim' | 'event' | 'pool' | 'lib' | 'tag';
}

/** Layer 0 core Blockly toolbox category IDs that any section can declaratively merge into. */
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

/** Where a section places its blocks in the left toolbox: `'own'` (standalone tab, default) or any core category ID. */
export type CategoryTargetSpec = 'own' | CoreCategoryTarget;

/**
 * Single-track declarative section inside a PolyBlock extension pack (1 Pack = 1 logical module/SDK).
 * Every pack has at least 1 section, with blocks nested directly inside their owning section.
 * Projects can toggle the entire pack (`"rt"`) or finely prune individual sections (`"rt.timers"`).
 */
export interface ExtensionSectionSpec {
  /** Section ID unique within its pack (e.g. 'lifecycle', 'timers', 'tick', or 'main'). */
  id: string;
  /** Display label in the sidebar tab (when categoryTarget === 'own') and pack section checkboxes. */
  label: string;
  description?: string;
  /** Whether this section is displayed in the left Blockly toolbox (default: true). */
  visible?: boolean;
  /** `'own'` creates a standalone toolbox tab (default); or any core category ID to merge into that tab. */
  categoryTarget?: CategoryTargetSpec;
  /** Numeric sort order in the left toolbox when categoryTarget === 'own' (default: 100). */
  toolboxOrder?: number;
  /** Category accent color (default: pack.color). */
  color?: string;
  /** Extensible per-handle resource configs owned by this section (e.g. channel-pool, future UART/CAN fields). */
  handleConfigs?: HandleConfigSpec[];
  /** Blocks belonging to this section (defined directly inline — zero duplicate ID lists). */
  blocks: ExtensionBlockDef[];
}

/** Normalized runtime view of a section with all defaults and derived keys resolved. */
export interface ResolvedPackSection {
  /** Full capability ID: `<pack.id>` for 1-section packs, `<pack.id>.<section.id>` for multi-section packs. */
  capId: string;
  sectionId: string;
  label: string;
  description?: string;
  visible: boolean;
  categoryTarget: CategoryTargetSpec;
  toolboxOrder: number;
  color: string;
  handleConfigs: ResolvedHandleChannelPoolSpec[];
  /** Convenience reference to the primary `kind: 'channel-pool'` entry in `handleConfigs`, if any. */
  channelPool?: ResolvedHandleChannelPoolSpec;
  blocks: ExtensionBlockDef[];
  isMultiSection: boolean;
}

/**
 * Unified Single-Track Declarative PolyBlock Extension Pack schema (.polyext.json).
 * 1 Pack = 1 logical module / SDK; all blocks and sidebar placements live cleanly inside `sections[]`.
 */
export interface PolyExtensionPack {
  $schema?: string;
  format: 'polyblock-extension';
  version: 1;
  id: string;
  name: string;
  packVersion: string;
  /** Short 1-4 character badge text shown on pack icon tiles (e.g. '运行', '硬件', 'MCU'). */
  iconLabel: string;
  color: string;
  description: string;
  builtin?: boolean;
  /** Optional custom attribute tags displayed as pills on pack cards (e.g. ["RTOS", "CAN"]). */
  tags?: string[];
  /** Optional pack-level default imports inherited by statement/value blocks (deduplicated globally by content). */
  imports?: ExtensionPackImports;
  /** One or more declarative sections owning sidebar layout, per-handle configs, and inline block definitions. */
  sections: ExtensionSectionSpec[];
  /** Optional shared widget asset catalog; only widgets referenced by enabled blocks' `simWidgetKeys` are shown. */
  simWidgets?: SimWidgetSpec[];
  /** Browser-sandbox-ONLY stub simulating C firmware APIs (stripped when exporting target device code). */
  sandboxMock?: ExtensionModuleSource;
  /** Real pure-script library source files (e.g. crc16.lua + crc16_table.lua) used in BOTH sandbox and target device export. */
  libs?: ExtensionModuleSource[];
}
