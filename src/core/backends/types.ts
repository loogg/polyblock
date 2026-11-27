import type * as Blockly from 'blockly';
import type {
  DiagnosticItem,
  ScriptLanguageId,
  SourceLineRange,
  VariableScopeNode,
} from '../../types/project';
import type {
  CompileContext,
  DispatchBranchMeta,
} from '../blocks/workspaceContextBridge';

export type { CompileContext };

/** Minimal language syntax tokens used by declarative extension template formatters & UI viewers. */
export interface LanguageDialect {
  id: ScriptLanguageId;
  displayName: string;
  extension: string;
  boolTrue: string;
  boolFalse: string;
  nullLiteral: string;
  notOp: string;
  lineCommentPrefix: string;
}

/** Single source of truth for registered target script languages & their syntax dialects. */
export const LANGUAGE_DIALECTS: Record<ScriptLanguageId, LanguageDialect> = {
  lua: {
    id: 'lua',
    displayName: 'Lua 5.4',
    extension: 'lua',
    boolTrue: 'true',
    boolFalse: 'false',
    nullLiteral: 'nil',
    notOp: 'not ',
    lineCommentPrefix: ' -- ',
  },
  python: {
    id: 'python',
    displayName: 'Python 3',
    extension: 'py',
    boolTrue: 'True',
    boolFalse: 'False',
    nullLiteral: 'None',
    notOp: 'not ',
    lineCommentPrefix: '  # ',
  },
};

export const SUPPORTED_LANGUAGE_IDS: readonly ScriptLanguageId[] = Object.keys(
  LANGUAGE_DIALECTS,
) as ScriptLanguageId[];

export interface EntryDispatchBranchSpec extends DispatchBranchMeta {
  isLocal: boolean;
}

export interface GeneratedCodeResult {
  language: ScriptLanguageId;
  /** Clean runnable script for preview, export, and future device download (zero instrumentation). */
  code: string;
  /** Instrumented async runtime script used only by browser sandbox runners for stepping & breakpoints. */
  debugCode: string;
  /**
   * Instrumented module-level debug script (without top-level event-loop driver / prelude)
   * used when mounting companion sibling scripts (`timers`, `utils`, etc.) inside browser sandboxes
   * so breakpoints, single-step highlighting, and watchdog timeouts work across ALL files in a handle.
   */
  moduleDebugCode?: string;
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
 * Unified contract for any target script backend (Lua, Python, future JS/C/DSL...).
 * Implementing this interface lets PolyBlock generate code, format entry dispatch routers,
 * map lines back to blocks, and surface static diagnostics without touching UI or pack core code.
 */
export interface ScriptBackendAdapter {
  readonly id: ScriptLanguageId;
  readonly name: string;
  readonly version: string;
  readonly extension: string;
  readonly fileName: string;
  readonly accentColor: string;
  readonly description: string;
  readonly dialect: LanguageDialect;
  generate(
    workspace: Blockly.Workspace,
    context?: CompileContext,
  ): GeneratedCodeResult;
  formatDispatchRouter(
    eventName: string,
    branches: EntryDispatchBranchSpec[],
    debugPass: boolean,
  ): { autoImports: string[]; code: string };
}
