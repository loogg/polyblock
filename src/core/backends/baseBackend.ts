import * as Blockly from 'blockly';
import type {
  ScriptLanguageId,
  VariableInitialValue,
} from '../../types/project';
import {
  getActiveHandleScripts,
  getActiveHandleSharedFunctions,
  getActiveScriptVarInitials,
  withCompileContext,
  type ActiveHandleScriptMeta,
} from '../blocks/workspaceContextBridge';
import {
  hoistImports,
  renderExtensionTemplate,
} from '../extensions/templateRenderer';
import type { ExtensionHatSpec } from '../extensions/types';
import {
  codegenContext,
  computeAsyncFunctionNames,
  formatSharedVarRef,
  isShadowedByEnclosingForLoop,
  isShadowedByProcedureParam,
  LOOP_SCOPED_FOR_TYPES,
  resetCodegenPassContext,
  type CodegenPassContextOptions,
} from './codegenContext';
import {
  buildEntryDispatchRouters,
  hasExternalKeepAliveHat,
  isEventDrivenWorkspace,
  resolveHandleSharedInfo,
  type HandleSharedInfo,
} from './eventMode';
import {
  analyzeWorkspaceScopes,
  getBlockVariableFieldIds,
  resolveSharedFnIdent,
  sanitizeLocalIdent,
} from './scopeAnalysis';
import {
  analyzeWorkspaceDiagnostics,
  extractSourceMap,
  SENTINEL_END_PREFIX,
  SENTINEL_START_PREFIX,
} from './sourceMap';
import type {
  CompileContext,
  EntryDispatchBranchSpec,
  ExtensionBlockRegisterContext,
  ExtensionHatRegisterContext,
  GeneratedCodeResult,
  LanguageDialect,
  ScriptBackendAdapter,
  SharedModuleDocumentInput,
  SharedProcCompileInput,
  SharedProcCompileOutput,
} from './types';

export interface BlocklyGeneratorLike {
  STATEMENT_PREFIX: string | null;
  STATEMENT_SUFFIX: string | null;
  init(workspace: Blockly.Workspace): void;
  finish(code: string): string;
  workspaceToCode(workspace?: Blockly.Workspace): string;
  blockToCode(
    block: Blockly.Block | null,
    opt_thisOnly?: boolean,
  ): string | [string, number];
  getVariableName(nameOrId: string): string;
  getProcedureName(name: string): string;
  valueToCode(block: Blockly.Block, name: string, outerOrder: number): string;
  forBlock: Record<
    string,
    (
      block: Blockly.Block,
      generator: never,
    ) => string | [string, number] | null
  >;
}

export interface WorkspaceVarEntry {
  id: string;
  label: string;
  ident: string;
  sharedAttr?: string;
  used: boolean;
  /** True when a non-shared variable is ONLY used as a `for`-loop counter (safe to keep function/block-local). */
  loopOnly?: boolean;
}

export interface WorkspacePassAnalysis {
  sharedModuleName: string;
  sharedAttrByName: Map<string, string>;
  sharedNames: Set<string>;
  sharedFnSet: Set<string>;
  variables: WorkspaceVarEntry[];
  varIdToIdent: Map<string, string>;
  asyncFnNames: Set<string>;
}

export interface DebugPassPreparation<TDebugMeta> {
  statementPrefix: string;
  meta: TDebugMeta;
}

export interface DebugAssemblyInput<TDebugMeta> {
  fullDebugBody: string;
  companionDebugBody: string;
  keepAliveExternal: boolean;
  usedSharedDebug: boolean;
  sharedModuleName: string;
  analysis: WorkspacePassAnalysis;
  allLocalEntries: Array<{ label: string; ident: string }>;
  debugMeta: TDebugMeta;
}

/**
 * Abstract template-method base class encapsulating PolyBlock's shared 2-pass compile pipeline:
 *   `withCompileContext` -> `resolveHandleSharedInfo` -> variable/scope pre-analysis ->
 *   Pass 1 clean generation + `extractSourceMap` -> Pass 2 instrumented debug generation +
 *   `moduleDebugCode` assembly + `analyzeWorkspaceDiagnostics`, plus shared-procedure compilation
 *   and declarative `.polyext.json` statement/value block registration.
 *
 * New target language backends (e.g. C / JS / DSL) only implement language-specific syntax hooks.
 */
export abstract class BaseScriptBackend<TDebugMeta = void>
  implements ScriptBackendAdapter
{
  abstract readonly id: ScriptLanguageId;
  abstract readonly name: string;
  abstract readonly version: string;
  abstract readonly extension: string;
  abstract readonly fileName: string;
  abstract readonly accentColor: string;
  abstract readonly description: string;
  abstract readonly dialect: LanguageDialect;

  /** True when shared variables inside `shared.<ext>` are referenced as bare `<attr>` rather than `<mod>.<attr>`. */
  protected readonly bareAttrInSharedModule: boolean = false;
  /** True when `for` loop header variables shadow outer globals/shared variables (e.g. Lua). */
  protected readonly loopScopedForVars: boolean = false;
  protected abstract readonly orderNone: number;
  protected abstract readonly orderAtomic: number;
  /** Regex matching top-level debug heartbeat lines stripped when building companion `moduleDebugCode`. */
  protected abstract readonly topLevelDebugTickRe: RegExp;

  protected abstract ensureGeneratorsRegistered(): void;
  protected abstract getGenerator(): BlocklyGeneratorLike;
  protected abstract formatFileHeader(eventDriven: boolean): string;
  protected abstract formatSharedModuleImport(moduleName: string): string;
  protected abstract buildPassContextOptions(
    debugPass: boolean,
    analysis: WorkspacePassAnalysis,
  ): CodegenPassContextOptions;
  protected abstract prepareDebugPass(
    analysis: WorkspacePassAnalysis,
    allLocalEntries: Array<{ label: string; ident: string }>,
    usedSharedClean: boolean,
  ): DebugPassPreparation<TDebugMeta>;
  protected abstract assembleDebugOutputs(
    input: DebugAssemblyInput<TDebugMeta>,
  ): { debugCode: string; moduleDebugCode: string };
  protected abstract getSharedProcDebugStatementPrefix(
    input: SharedProcCompileInput,
    snapEntries: Array<{ label: string; attr: string }>,
  ): string;

  abstract formatDispatchRouter(
    eventName: string,
    branches: EntryDispatchBranchSpec[],
    debugPass: boolean,
  ): { autoImports: string[]; code: string };

  abstract registerExtensionHat(ctx: ExtensionHatRegisterContext): void;

  abstract formatSharedModuleDocument(input: SharedModuleDocumentInput): {
    source: string;
    debugSource: string;
  };

  /** Optional per-pass hook (e.g. resetting Lua's per-root `local` declaration tracker). */
  protected beforePass(_debugPass: boolean): void {
    // default no-op
  }

  /** Optional body post-processor applied after merging prepended imports, body, and routers. */
  protected postProcessBody(
    body: string,
    _debugPass: boolean,
    _workspace: Blockly.Workspace,
    _analysis: WorkspacePassAnalysis,
    _scriptInitials: Record<string, VariableInitialValue>,
  ): string {
    return body;
  }

  protected formatEmptyPlaceholder(): string {
    return `${this.dialect.commentToken} 请从左侧拖入积木开始编排`;
  }

  protected formatMissingTemplateValueExpr(_blockType: string): string {
    return this.dialect.nullLiteral;
  }

  protected formatMissingTemplateStatement(blockType: string): string {
    return `${this.dialect.commentToken} [PolyBlock] 积木 "${blockType}" 未提供 code.${this.id}.template\n`;
  }

  protected formatVarRef(
    varId: string,
    generator: { getVariableName(id: string): string },
    block?: Blockly.Block,
  ): string {
    return formatSharedVarRef(varId, generator, block, {
      bareAttrInSharedModule: this.bareAttrInSharedModule,
      loopScopedForVars: this.loopScopedForVars,
    });
  }

  protected collectResultVariableNames(
    analysis: WorkspacePassAnalysis,
  ): string[] {
    return analysis.variables.map((v) => v.label);
  }

  protected buildPrependLines(
    usedShared: boolean,
    sharedModuleName: string,
    bodyCode: string,
    autoImports: string[],
  ): string[] {
    const lines: string[] = [];
    if (usedShared && sharedModuleName) {
      lines.push(this.formatSharedModuleImport(sharedModuleName));
    }
    for (const imp of autoImports) {
      if (!bodyCode.includes(imp) && !lines.includes(imp)) {
        lines.push(imp);
      }
    }
    return lines;
  }

  protected stripTopLevelDebugTicks(fullDebugBody: string): string {
    return fullDebugBody
      .split('\n')
      .filter((line) => !this.topLevelDebugTickRe.test(line))
      .join('\n');
  }

  protected resolveExtractedHatBranches(
    matchingHats: Blockly.Block[],
    hatSpec: ExtensionHatSpec,
    renderTpl: (tpl: string, hatBlk: Blockly.Block) => string,
  ): Array<{ block: Blockly.Block; fnName: string; comment: string }> {
    const fnPrefix = hatSpec.extractBranchFnPrefix ?? `${hatSpec.eventName}_`;
    const usedFnNames = new Set<string>();
    const commentTpl = hatSpec.branchComment?.[this.id];

    return matchingHats.map((hatBlk, idx) => {
      const comment = commentTpl ? renderTpl(commentTpl, hatBlk) : '';
      const rawKey = hatSpec.duplicateKeyTemplate
        ? renderTpl(hatSpec.duplicateKeyTemplate, hatBlk)
        : String(idx);
      const safeSuffix = rawKey.replace(/[^A-Za-z0-9_]+/g, '_') || String(idx);
      let fnName = `${fnPrefix}${safeSuffix}`;
      let dupIdx = 2;
      while (usedFnNames.has(fnName)) {
        fnName = `${fnPrefix}${safeSuffix}_${dupIdx}`;
        dupIdx += 1;
      }
      usedFnNames.add(fnName);
      return { block: hatBlk, fnName, comment };
    });
  }

  private computeWorkspaceAsyncFunctions(
    workspace: Blockly.Workspace,
    handleScripts: ActiveHandleScriptMeta[],
    sharedFnSet: Set<string>,
  ): Set<string> {
    if (!this.dialect.explicitAsyncCoroutine) {
      return new Set<string>();
    }
    const externalAsyncSharedFns = new Set<string>();
    for (const s of handleScripts) {
      for (const fn of s.declaredFunctions ?? []) {
        if (fn.usesSleep && sharedFnSet.has(fn.name)) {
          externalAsyncSharedFns.add(fn.name);
        }
      }
    }
    return computeAsyncFunctionNames(workspace, externalAsyncSharedFns);
  }

  private analyzeWorkspaceVariables(
    workspace: Blockly.Workspace,
    generator: BlocklyGeneratorLike,
    sharedInfo: HandleSharedInfo,
    sharedFnSet: Set<string>,
    asyncFnNames: Set<string>,
  ): WorkspacePassAnalysis {
    const sharedAttrByName = new Map(
      sharedInfo.entries.map((e) => [e.name, e.attr]),
    );
    const sharedNames = new Set(sharedInfo.entries.map((e) => e.name));
    const variables: WorkspaceVarEntry[] = [];
    const varIdToIdent = new Map<string, string>();

    const isInsideSharedFunction = (blk: Blockly.Block): boolean => {
      const root = blk.getRootBlock();
      if (
        root.type === 'procedures_defnoreturn' ||
        root.type === 'procedures_defreturn'
      ) {
        return sharedFnSet.has(String(root.getFieldValue('NAME') || '').trim());
      }
      return false;
    };

    const usedVarIds = new Set<string>();
    const nonLoopVarIds = new Set<string>();
    for (const blk of workspace.getAllBlocks(false)) {
      if (blk.isShadow() || !blk.isEnabled()) continue;
      if (isInsideSharedFunction(blk)) continue;
      for (const vId of getBlockVariableFieldIds(blk)) {
        if (isShadowedByProcedureParam(vId, blk)) continue;
        usedVarIds.add(vId);
        if (
          !LOOP_SCOPED_FOR_TYPES.has(blk.type) &&
          !isShadowedByEnclosingForLoop(vId, blk)
        ) {
          nonLoopVarIds.add(vId);
        }
      }
    }

    try {
      resetCodegenPassContext({ debugPass: false });
      generator.init(workspace);
      for (const v of workspace.getVariableMap().getAllVariables()) {
        const id = v.getId();
        const label = v.getName();
        const ident = generator.getVariableName(id);
        varIdToIdent.set(id, ident);
        const sharedAttr = sharedInfo.moduleName
          ? sharedAttrByName.get(label)
          : undefined;
        const used = usedVarIds.has(id);
        const loopOnly = used && !sharedAttr && !nonLoopVarIds.has(id);
        variables.push({
          id,
          label,
          ident,
          ...(sharedAttr ? { sharedAttr } : {}),
          used,
          ...(loopOnly ? { loopOnly: true } : {}),
        });
      }
    } finally {
      resetCodegenPassContext({ debugPass: false });
    }

    return {
      sharedModuleName: sharedInfo.moduleName,
      sharedAttrByName,
      sharedNames,
      sharedFnSet,
      variables,
      varIdToIdent,
      asyncFnNames,
    };
  }

  generate(
    workspace: Blockly.Workspace,
    context?: CompileContext,
  ): GeneratedCodeResult {
    return withCompileContext(context, () => {
      this.ensureGeneratorsRegistered();
      const generator = this.getGenerator();
      const prevPrefix = generator.STATEMENT_PREFIX;
      const prevSuffix = generator.STATEMENT_SUFFIX;

      const eventDriven = isEventDrivenWorkspace(workspace);
      const keepAliveExternal = hasExternalKeepAliveHat(workspace);
      const handleScripts = getActiveHandleScripts();
      const sharedInfo = resolveHandleSharedInfo(handleScripts);
      const sharedFnSet = new Set(getActiveHandleSharedFunctions() ?? []);
      const scriptInitials = getActiveScriptVarInitials();
      const asyncFnNames = this.computeWorkspaceAsyncFunctions(
        workspace,
        handleScripts,
        sharedFnSet,
      );

      // --- Pre-pass: Variable & scope inventory ---
      const analysis = this.analyzeWorkspaceVariables(
        workspace,
        generator,
        sharedInfo,
        sharedFnSet,
        asyncFnNames,
      );

      // --- Pass 1: Clean display / export / device-download code + SourceMap ---
      let rawClean = '';
      let usedSharedClean = false;
      try {
        this.beforePass(false);
        generator.STATEMENT_PREFIX = `${SENTINEL_START_PREFIX}%1__\n`;
        generator.STATEMENT_SUFFIX = `${SENTINEL_END_PREFIX}%1__\n`;
        resetCodegenPassContext(this.buildPassContextOptions(false, analysis));
        rawClean = generator.workspaceToCode(workspace);
        usedSharedClean = codegenContext.usedSharedModule;
      } finally {
        resetCodegenPassContext({ debugPass: false });
        generator.STATEMENT_PREFIX = prevPrefix;
        generator.STATEMENT_SUFFIX = prevSuffix;
      }

      const { scopes: variableScopes, allLocalEntries } = analyzeWorkspaceScopes(
        workspace,
        analysis.varIdToIdent,
      );

      const cleanRouter = buildEntryDispatchRouters(workspace, this, false);
      const cleanPrependLines = this.buildPrependLines(
        usedSharedClean,
        sharedInfo.moduleName,
        rawClean,
        cleanRouter.autoImports,
      );
      const baseCleanBody = [
        cleanPrependLines.join('\n'),
        rawClean.trim(),
        cleanRouter.routerCode.trim(),
      ]
        .filter(Boolean)
        .join('\n\n');
      const mergedCleanBody = this.postProcessBody(
        baseCleanBody,
        false,
        workspace,
        analysis,
        scriptInitials,
      );

      const header = this.formatFileHeader(eventDriven);
      const combinedClean = mergedCleanBody
        ? `${header}${mergedCleanBody}\n`
        : `${header}${this.formatEmptyPlaceholder()}`;
      const { code, sourceMap, lineToBlock } = extractSourceMap(combinedClean);
      const breakpointableLineSet = new Set<number>();
      for (const blk of workspace.getAllBlocks(false)) {
        if (blk.isShadow() || !blk.isEnabled()) continue;
        if (!blk.previousConnection) continue;
        if (blk.type === 'poly_comment' || blk.type === 'poly_require_script') {
          continue;
        }
        const range = sourceMap[blk.id];
        if (range && lineToBlock[range.startLine] === blk.id) {
          breakpointableLineSet.add(range.startLine);
        }
      }
      const breakpointableLines = Array.from(breakpointableLineSet).sort(
        (a, b) => a - b,
      );

      // --- Pass 2: Instrumented single-track coroutine sandbox debug code ---
      const debugPrep = this.prepareDebugPass(
        analysis,
        allLocalEntries,
        usedSharedClean,
      );
      let debugBody = '';
      let usedSharedDebug = false;
      try {
        this.beforePass(true);
        resetCodegenPassContext(this.buildPassContextOptions(true, analysis));
        generator.STATEMENT_PREFIX = debugPrep.statementPrefix;
        generator.STATEMENT_SUFFIX = null;
        debugBody = generator.workspaceToCode(workspace);
        usedSharedDebug = codegenContext.usedSharedModule;
      } finally {
        resetCodegenPassContext({ debugPass: false });
        generator.STATEMENT_PREFIX = prevPrefix;
        generator.STATEMENT_SUFFIX = prevSuffix;
      }

      const debugRouter = buildEntryDispatchRouters(workspace, this, true);
      const debugPrependLines = this.buildPrependLines(
        usedSharedDebug,
        sharedInfo.moduleName,
        debugBody,
        debugRouter.autoImports,
      );
      const baseDebugBody = [
        debugPrependLines.join('\n'),
        debugBody.trim(),
        debugRouter.routerCode.trim(),
      ]
        .filter(Boolean)
        .join('\n\n');
      const fullDebugBody = this.postProcessBody(
        baseDebugBody,
        true,
        workspace,
        analysis,
        scriptInitials,
      );

      const companionDebugBody = this.stripTopLevelDebugTicks(fullDebugBody);
      const { debugCode, moduleDebugCode } = this.assembleDebugOutputs({
        fullDebugBody,
        companionDebugBody,
        keepAliveExternal,
        usedSharedDebug,
        sharedModuleName: sharedInfo.moduleName,
        analysis,
        allLocalEntries,
        debugMeta: debugPrep.meta,
      });

      return {
        language: this.id,
        code,
        debugCode,
        moduleDebugCode,
        sourceMap,
        lineToBlock,
        breakpointableLines,
        diagnostics: analyzeWorkspaceDiagnostics(workspace, this.id),
        blockCount: workspace
          .getAllBlocks(false)
          .filter((b) => !b.isShadow()).length,
        variableNames: this.collectResultVariableNames(analysis),
        variableScopes,
        isEventDriven: eventDriven,
      };
    });
  }

  registerExtensionBlock(ctx: ExtensionBlockRegisterContext): void {
    const { pack, section, block: b } = ctx;
    const generator = this.getGenerator();
    const spec = b.code?.[this.id];
    if (spec) {
      const imports =
        spec.imports !== undefined ? spec.imports : pack.imports?.[this.id];
      generator.forBlock[b.type] = (
        block: Blockly.Block,
        gen: BlocklyGeneratorLike,
      ) => {
        hoistImports(gen, imports);
        const rendered = renderExtensionTemplate(
          spec.template,
          b,
          block,
          this.id,
          {
            resolveValueInput: (blk, argName) => {
              const expr = gen.valueToCode(blk, argName, this.orderNone);
              if (expr) return expr;
              const shadowType = b.shadows?.[argName]?.type;
              const argDef = b.args0?.find((a) => a.name === argName);
              const check = argDef?.check;
              if (shadowType === 'math_number' || check === 'Number') return '0';
              if (check === 'Boolean') return this.dialect.boolFalse;
              return '""';
            },
            resolveVarField: (blk, argName) =>
              this.formatVarRef(
                String(blk.getFieldValue(argName) || ''),
                gen,
                blk,
              ),
          },
          pack,
          section,
        );
        if (b.kind === 'value') {
          return [rendered, this.orderAtomic];
        }
        return `${rendered}\n`;
      };
    } else {
      generator.forBlock[b.type] = () => {
        if (b.kind === 'value') {
          return [this.formatMissingTemplateValueExpr(b.type), this.orderAtomic];
        }
        return this.formatMissingTemplateStatement(b.type);
      };
    }
  }

  compileSharedProcedure(input: SharedProcCompileInput): SharedProcCompileOutput {
    this.ensureGeneratorsRegistered();
    const generator = this.getGenerator();
    const ws = new Blockly.Workspace();
    const isolatedJson: Record<string, unknown> = {
      blocks: {
        languageVersion: 0,
        blocks: [input.blockJson],
      },
      variables: input.scriptVariables,
    };

    try {
      Blockly.serialization.workspaces.load(isolatedJson, ws);
      const topBlock = ws.getTopBlocks(false)[0];
      if (!topBlock) {
        return {
          ident: sanitizeLocalIdent(input.name),
          imports: [],
          cleanFnCode: '',
          debugFnCode: '',
        };
      }

      const prevPrefix = generator.STATEMENT_PREFIX;
      const prevSuffix = generator.STATEMENT_SUFFIX;
      const sharedVarIdToAttr = new Map<string, string>();
      const sharedVarIdents = new Set<string>();
      const snapEntries: Array<{ label: string; attr: string }> = [];

      let cleanFnCode = '';
      let debugFnCode = '';
      let imports: string[] = [];
      let blocklyProcIdent = sanitizeLocalIdent(input.name);
      const sharedFnIdent = resolveSharedFnIdent(input.name);

      try {
        resetCodegenPassContext({ debugPass: false, compilingSharedModule: true });
        generator.init(ws);
        for (const v of ws.getVariableMap().getAllVariables()) {
          const ident = generator.getVariableName(v.getId());
          const attr = input.sharedAttrByName.get(v.getName());
          if (attr) {
            sharedVarIdToAttr.set(v.getId(), attr);
            sharedVarIdents.add(ident);
            snapEntries.push({ label: v.getName(), attr });
          }
        }
        blocklyProcIdent = generator.getProcedureName(input.name);
        generator.finish('');

        const asyncNames = this.dialect.explicitAsyncCoroutine
          ? computeAsyncFunctionNames(ws, input.allAsyncSharedFnNames)
          : new Set<string>();

        // Clean shared procedure pass
        this.beforePass(false);
        resetCodegenPassContext({
          debugPass: false,
          compilingSharedModule: true,
          sharedModuleName: input.moduleName,
          sharedVarIdToAttr,
          sharedVarIdents,
          asyncFnNames: asyncNames,
        });
        generator.STATEMENT_PREFIX = null;
        generator.STATEMENT_SUFFIX = null;
        generator.init(ws);
        generator.blockToCode(topBlock);
        const defs = (
          generator as unknown as { definitions_: Record<string, string> }
        ).definitions_;
        imports = Object.entries(defs)
          .filter(
            ([k]) =>
              !k.startsWith('%') &&
              k !== 'variables' &&
              k !== 'import_poly_shared',
          )
          .map(([, v]) => v.trim())
          .filter(Boolean);
        cleanFnCode = (defs[`%${blocklyProcIdent}`] ?? '').trim();
        generator.finish('');

        // Debug shared procedure pass
        this.beforePass(true);
        resetCodegenPassContext({
          debugPass: true,
          compilingSharedModule: true,
          sharedModuleName: input.moduleName,
          sharedVarIdToAttr,
          sharedVarIdents,
          asyncFnNames: asyncNames,
        });
        generator.STATEMENT_PREFIX = this.getSharedProcDebugStatementPrefix(
          input,
          snapEntries,
        );
        generator.STATEMENT_SUFFIX = null;
        generator.init(ws);
        generator.blockToCode(topBlock);
        const debugDefs = (
          generator as unknown as { definitions_: Record<string, string> }
        ).definitions_;
        debugFnCode = (debugDefs[`%${blocklyProcIdent}`] ?? cleanFnCode).trim();
        generator.finish('');
      } finally {
        resetCodegenPassContext({
          debugPass: false,
          compilingSharedModule: false,
        });
        generator.STATEMENT_PREFIX = prevPrefix;
        generator.STATEMENT_SUFFIX = prevSuffix;
      }

      return { ident: sharedFnIdent, imports, cleanFnCode, debugFnCode };
    } finally {
      ws.dispose();
    }
  }
}
