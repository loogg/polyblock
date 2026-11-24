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

/**
 * Declarative PolyBlock Extension Pack schema (.polyext.json).
 * A single JSON document defines UI blocks, clean Lua/Python codegen templates,
 * and optional browser WASM sandbox mocks for zero-hardware simulation.
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
  hasVirtualBoardUi?: boolean;
  blocks: ExtensionBlockDef[];
  sandboxMock?: ExtensionSandboxMock;
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
