export interface ExtensionBlockShadow {
  type: 'math_number' | 'text';
  value: number | string;
}

export interface ExtensionCodeTemplate {
  /** Template string supporting {{ARG}}, {{ARG:json}}, {{ARG:bool_lua}}, {{ARG:bool_py}} */
  template: string;
  /** Deduplicated module import lines hoisted to file top (e.g. `import board` or `local board = require("board")`) */
  imports?: string[];
}

export interface ExtensionBlockDef {
  type: string;
  kind: 'statement' | 'value';
  message0: string;
  args0?: Array<Record<string, unknown>>;
  inputsInline?: boolean;
  outputType?: string | null;
  tooltip?: string;
  keywords?: string;
  shadows?: Record<string, ExtensionBlockShadow>;
  lua: ExtensionCodeTemplate;
  python: ExtensionCodeTemplate;
}

export interface ExtensionSandboxMock {
  moduleName: string;
  luaSource?: string;
  pythonSource?: string;
}

/** Built-in generic declarative simulation widget types rendered in the right-hand Simulator tab. */
export type SimWidgetKind =
  | 'led'
  | 'rgb'
  | 'bar'
  | 'screen'
  | 'slider'
  | 'toggle'
  | 'button';

/**
 * Declarative simulator widget bound to a shared state key read/written by `sandboxMock`
 * via `__poly_sim_get(key)` / `__poly_sim_set(key, val)` (Lua) or `_poly.sim_get(key)` / `_poly.sim_set(key, val)` (Python).
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
}

/** Unified shared simulator state map across all active handles and extension widget cards. */
export type SimStateMap = Record<string, unknown>;

/**
 * Declarative PolyBlock Extension Pack schema (.polyext.json).
 * A single JSON document defines UI blocks, clean Lua/Python codegen templates,
 * optional browser WASM sandbox mocks, and optional interactive simulator widgets.
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
  /** @deprecated Prefer declarative `simWidgets`; kept only for backwards compatibility. */
  hasVirtualBoardUi?: boolean;
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
