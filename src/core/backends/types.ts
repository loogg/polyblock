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

/** Raw function signature extracted by a backend's optional native script-library scanner. */
export interface ScannedLibFunctionMeta {
  funcName: string;
  params: string[];
  inferredKind: 'statement' | 'value';
}

/** Language-owned script library import/call syntax & optional static function scanner. */
export interface ScriptLibBindingSpec {
  formatImport: (moduleName: string) => string;
  formatCall: (
    moduleName: string,
    fnName: string,
    argPlaceholders: string[],
  ) => string;
  /** Extracts the imported module name from a single top-level import statement line. */
  extractImportedModuleName?: (line: string) => string | null;
  scanFunctions?: (source: string) => ScannedLibFunctionMeta[];
}

/** Optional target toolchain metadata for compiled / export-only languages without a browser sandbox. */
export interface ExportToolchainMeta {
  /** Human-readable target IDE or compiler toolchain label (e.g. 'Arduino IDE / PlatformIO'). */
  readonly label: string;
  /** Optional guidance surfaced in UI/export READMEs when no browser WASM sandbox exists. */
  readonly notes?: string;
}

/**
 * Complete syntax, highlighting, library-binding, and export metadata owned by a single target backend.
 * Every registered `ScriptBackendAdapter` provides its own `LanguageDialect` as the single source of truth.
 */
export interface LanguageDialect<TId extends string = string> {
  readonly id: TId;
  readonly displayName: string;
  readonly shortLabel: string;
  readonly compactLabel: string;
  readonly extension: string;
  readonly accentGradient: string;
  readonly boolTrue: string;
  readonly boolFalse: string;
  readonly nullLiteral: string;
  readonly listLiteral: string;
  readonly dictLiteral: string;
  readonly notOp: string;
  readonly commentToken: string;
  readonly lineCommentPrefix: string;
  readonly keywords: readonly string[];
  /** Built-in global/standard function identifiers highlighted by the code viewer. */
  readonly builtinFuncs?: readonly string[];
  /** True when the language uses explicit async/await syntax for `on_start` coroutine sleep_ms. */
  readonly explicitAsyncCoroutine?: boolean;
  /** Optional library import/call formatter and function scanner for native script-library import. */
  readonly libBinding?: ScriptLibBindingSpec;
  /** Optional parser extracting a 1-based line number from runtime stderr/exception messages. */
  readonly extractErrorLine?: (message: string) => number | undefined;
  /** Optional toolchain hint for compiled or export-only target languages. */
  readonly exportToolchain?: ExportToolchainMeta;
}

/** Shared helper for backend library scanners to parse comma-separated parameter lists cleanly. */
export function splitLibParamList(rawParams: string): string[] {
  const cleaned = rawParams
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p !== '...' && p !== '*args' && p !== '**kwargs');
  const out: string[] = [];
  for (const part of cleaned) {
    const name = part.split('=')[0].split(':')[0].trim().replace(/^\*+/, '');
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== 'self' && name !== 'cls') {
      out.push(name);
    }
  }
  return out;
}

/** Pure stateless formatter converting a VariableInitialValue into a target dialect literal. */
export function formatInitialValueForDialect(
  init: VariableInitialValue | null | undefined,
  dialect: Pick<
    LanguageDialect,
    'boolTrue' | 'boolFalse' | 'nullLiteral' | 'listLiteral' | 'dictLiteral'
  >,
): string {
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
 * Complete plugin contract for any target script backend (Lua, Python, future JS/Arduino/DSL...).
 * Implementing and registering this adapter in `backendRegistry` lets PolyBlock compile workspaces,
 * derive dialect & file-extension metadata, highlight syntax, scan native libraries, register
 * `.polyext.json` blocks/hats, format entry dispatch routers, and build Style A1 read-only
 * `shared` modules with ZERO edits to extension registry, sharedModule, or UI code.
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
