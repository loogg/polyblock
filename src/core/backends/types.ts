import type * as Blockly from 'blockly';
import type {
  DiagnosticItem,
  ScriptLanguageId,
  SourceLineRange,
  VariableInitialValue,
  VariableScopeNode,
} from '../../types/project';
import type {
  CompileContext,
  DispatchBranchMeta,
} from '../blocks/workspaceContextBridge';
import type {
  ExtensionBlockDef,
  ExtensionHatSpec,
  PolyExtensionPack,
  ResolvedPackSection,
} from '../extensions/types';

export type { CompileContext };

/** Complete syntax, display, and highlighting dialect metadata for a target script language. */
export interface LanguageDialect {
  id: ScriptLanguageId;
  displayName: string;
  shortLabel: string;
  compactLabel: string;
  extension: string;
  boolTrue: string;
  boolFalse: string;
  nullLiteral: string;
  listLiteral: string;
  dictLiteral: string;
  notOp: string;
  commentToken: string;
  lineCommentPrefix: string;
  keywords: readonly string[];
  /** True when the language uses explicit async/await syntax for `on_start` coroutine sleep_ms. */
  explicitAsyncCoroutine?: boolean;
}

/** Single source of truth for registered target script languages & their syntax dialects. */
export const LANGUAGE_DIALECTS: Record<ScriptLanguageId, LanguageDialect> = {
  lua: {
    id: 'lua',
    displayName: 'Lua 5.4',
    shortLabel: 'Lua',
    compactLabel: 'Lua',
    extension: 'lua',
    boolTrue: 'true',
    boolFalse: 'false',
    nullLiteral: 'nil',
    listLiteral: '{}',
    dictLiteral: '{}',
    notOp: 'not ',
    commentToken: '--',
    lineCommentPrefix: ' -- ',
    keywords: [
      'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
      'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return',
      'then', 'true', 'until', 'while',
    ],
    explicitAsyncCoroutine: false,
  },
  python: {
    id: 'python',
    displayName: 'Python 3',
    shortLabel: 'Python',
    compactLabel: 'Py',
    extension: 'py',
    boolTrue: 'True',
    boolFalse: 'False',
    nullLiteral: 'None',
    listLiteral: '[]',
    dictLiteral: '{}',
    notOp: 'not ',
    commentToken: '#',
    lineCommentPrefix: '  # ',
    keywords: [
      'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
      'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
      'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
      'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
    ],
    explicitAsyncCoroutine: true,
  },
};

export const SUPPORTED_LANGUAGE_IDS: readonly ScriptLanguageId[] = Object.keys(
  LANGUAGE_DIALECTS,
) as ScriptLanguageId[];

export function isSupportedLanguageId(raw: unknown): raw is ScriptLanguageId {
  return (
    typeof raw === 'string' &&
    Object.prototype.hasOwnProperty.call(LANGUAGE_DIALECTS, raw)
  );
}

export function normalizeLanguageId(
  raw: unknown,
  fallback: ScriptLanguageId = 'lua',
): ScriptLanguageId {
  return isSupportedLanguageId(raw) ? raw : fallback;
}

/** Formats a VariableInitialValue into the exact target language literal via LANGUAGE_DIALECTS. */
export function formatInitialValueForLanguage(
  init: VariableInitialValue | null | undefined,
  lang: ScriptLanguageId,
): string {
  const dialect = LANGUAGE_DIALECTS[lang];
  if (!init || typeof init !== 'object') return dialect.nullLiteral;
  switch (init.kind) {
    case 'number':
      return String(Number.isFinite(Number(init.value)) ? Number(init.value) : 0);
    case 'boolean':
      return init.value ? dialect.boolTrue : dialect.boolFalse;
    case 'string':
      return JSON.stringify(String(init.value ?? ''));
    case 'list':
      return dialect.listLiteral;
    case 'dict':
      return dialect.dictLiteral;
    default:
      return dialect.nullLiteral;
  }
}

export interface EntryDispatchBranchSpec extends DispatchBranchMeta {
  isLocal: boolean;
}

export interface ExtensionBlockRegisterContext {
  pack: PolyExtensionPack;
  section: ResolvedPackSection;
  block: ExtensionBlockDef;
}

export interface ExtensionHatRegisterContext extends ExtensionBlockRegisterContext {
  hat: ExtensionHatSpec;
  shouldExtractBranches: () => boolean;
}

export interface SharedProcCompileInput {
  name: string;
  params: string[];
  hasReturn: boolean;
  usesSleep: boolean;
  blockJson: Record<string, unknown>;
  scriptVariables: unknown[];
  moduleName: string;
  sharedAttrByName: Map<string, string>;
  allAsyncSharedFnNames: Set<string>;
}

export interface SharedProcCompileOutput {
  ident: string;
  imports: string[];
  cleanFnCode: string;
  debugFnCode: string;
}

export interface SharedModuleVarSpec {
  name: string;
  attr: string;
  initialValue: VariableInitialValue;
}

export interface SharedModuleDocumentInput {
  moduleName: string;
  importLines: string[];
  variables: SharedModuleVarSpec[];
  cleanFnBlocks: string[];
  debugFnBlocks: string[];
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
 * Complete plugin contract for any target script backend (Lua, Python, future C/JS/DSL...).
 * Implementing and registering this adapter lets PolyBlock compile workspaces, register
 * declarative `.polyext.json` blocks/hats, format entry dispatch routers, and build Style A1
 * read-only `shared` modules with ZERO edits to extension registry, sharedModule, or UI code.
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
  registerExtensionBlock(ctx: ExtensionBlockRegisterContext): void;
  registerExtensionHat(ctx: ExtensionHatRegisterContext): void;
  compileSharedProcedure(input: SharedProcCompileInput): SharedProcCompileOutput;
  formatSharedModuleDocument(input: SharedModuleDocumentInput): {
    source: string;
    debugSource: string;
  };
}
