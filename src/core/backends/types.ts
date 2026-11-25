import type * as Blockly from 'blockly';
import type {
  DiagnosticItem,
  ScriptLanguageId,
  SourceLineRange,
  VariableScopeNode,
} from '../../types/project';

export interface GeneratedCodeResult {
  language: ScriptLanguageId;
  /** Clean runnable script for preview, export, and future device download (zero instrumentation). */
  code: string;
  /** Instrumented async runtime script used only by browser sandbox runners for stepping & breakpoints. */
  debugCode: string;
  sourceMap: Record<string, SourceLineRange>;
  lineToBlock: Record<number, string>;
  diagnostics: DiagnosticItem[];
  blockCount: number;
  variableNames: string[];
  /** Scope-tree grouping of shared globals, per-callback vars, locals, and procedure params. */
  variableScopes?: VariableScopeNode[];
  /** True when the script uses on_run, timers, on_stop, or hardware event callbacks. */
  isEventDriven?: boolean;
}

/**
 * Unified contract for any target script backend (Lua, Python, future JS/Shell/DSL...).
 * Implementing this interface lets PolyBlock generate code, map lines back to blocks,
 * and surface static diagnostics without touching UI components.
 */
export interface ScriptBackendAdapter {
  readonly id: ScriptLanguageId;
  readonly name: string;
  readonly version: string;
  readonly extension: string;
  readonly fileName: string;
  readonly accentColor: string;
  readonly description: string;
  generate(workspace: Blockly.Workspace): GeneratedCodeResult;
}
