import type * as Blockly from 'blockly';
import { sanitizeLocalIdent } from './scopeAnalysis';

/**
 * Shared language-agnostic transient codegen pass context read by core generators
 * and declarative `.polyext.json` hat/statement generators during Pass 1 (clean export)
 * and Pass 2 (instrumented async sandbox debug).
 */
export interface CodegenPassContext {
  debugPass: boolean;
  /** True when compiling shared functions directly into the read-only `shared.<ext>` module. */
  compilingSharedModule: boolean;
  emittedDispatchEvents: Set<string>;
  /** Auto-generated cross-file shared state module name (e.g. 'shared'), empty when unused. */
  sharedModuleName: string;
  /** Map of current-workspace Blockly variable ID -> shared module attribute name. */
  sharedVarIdToAttr: Map<string, string>;
  /** Sanitized local Blockly identifiers belonging to the shared module. */
  sharedVarIdents: Set<string>;
  /** Single-file global variable identifiers in the current workspace (for languages needing `global` declarations). */
  globalVarIdents: string[];
  /** Sanitized identifiers of variables actively referenced by enabled blocks in the current workspace. */
  usedVarIdents: Set<string> | null;
  /** Set of custom procedure raw names (private or shared) that transitively call `sleep_ms`. */
  asyncFnNames: Set<string>;
  /** Set to true during codegen whenever the compiled script references any shared variable or shared function. */
  usedSharedModule: boolean;
  /** Per-root-block `poly_local_set` idents hoisted to function top (when first assigned in nested branches/loops). */
  hoistedLocalsByRoot: Map<string, Set<string>>;
}

export interface CodegenPassContextOptions {
  debugPass: boolean;
  compilingSharedModule?: boolean;
  sharedModuleName?: string;
  sharedVarIdToAttr?: Map<string, string>;
  sharedVarIdents?: Set<string>;
  globalVarIdents?: string[];
  usedVarIdents?: Set<string> | null;
  asyncFnNames?: Set<string>;
}

export const codegenContext: CodegenPassContext = {
  debugPass: false,
  compilingSharedModule: false,
  emittedDispatchEvents: new Set<string>(),
  sharedModuleName: '',
  sharedVarIdToAttr: new Map<string, string>(),
  sharedVarIdents: new Set<string>(),
  globalVarIdents: [],
  usedVarIdents: null,
  asyncFnNames: new Set<string>(),
  usedSharedModule: false,
  hoistedLocalsByRoot: new Map<string, Set<string>>(),
};

export function resetCodegenPassContext(opts: CodegenPassContextOptions): void {
  codegenContext.debugPass = opts.debugPass;
  codegenContext.compilingSharedModule = Boolean(opts.compilingSharedModule);
  codegenContext.emittedDispatchEvents = new Set<string>();
  codegenContext.sharedModuleName = opts.sharedModuleName ?? '';
  codegenContext.sharedVarIdToAttr = new Map(opts.sharedVarIdToAttr ?? []);
  codegenContext.sharedVarIdents = new Set(opts.sharedVarIdents ?? []);
  codegenContext.globalVarIdents = opts.globalVarIdents ?? [];
  codegenContext.usedVarIdents =
    opts.usedVarIdents !== undefined ? opts.usedVarIdents : null;
  codegenContext.asyncFnNames = new Set(opts.asyncFnNames ?? []);
  codegenContext.usedSharedModule = false;
  codegenContext.hoistedLocalsByRoot = new Map<string, Set<string>>();
}

/**
 * Language-agnostic AST scanner identifying `poly_local_set` variables whose first assignments
 * occur inside nested control blocks (`if`/`for`/`while`) rather than directly in the function's
 * top statement chain. Optionally records per-root hoisted sets into `codegenContext.hoistedLocalsByRoot`.
 */
export function collectNestedPolyLocalIdents(
  rootBlocks: Blockly.Block[],
  bodyInputName = 'BODY',
  recordHoistedMap = false,
): string[] {
  const hoisted: string[] = [];
  const seen = new Set<string>();

  for (const root of rootBlocks) {
    const bodyRoot = root.getInputTargetBlock(bodyInputName);
    if (!bodyRoot) continue;

    const directAssignedBeforeNested = new Set<string>();
    const needsHoist = new Set<string>();

    const walkChain = (blk: Blockly.Block | null, nested: boolean) => {
      let cur = blk;
      while (cur) {
        if (!cur.isShadow() && cur.isEnabled()) {
          if (cur.type === 'poly_local_set') {
            const ident = sanitizeLocalIdent(
              String(cur.getFieldValue('NAME') || 'tmp'),
            );
            if (!nested && !needsHoist.has(ident)) {
              directAssignedBeforeNested.add(ident);
            } else if (nested && !directAssignedBeforeNested.has(ident)) {
              needsHoist.add(ident);
            }
          }
          for (const inp of cur.inputList) {
            if (inp.connection?.type === 3 /* NEXT_STATEMENT */) {
              const target = inp.connection.targetBlock();
              if (target) walkChain(target, true);
            }
          }
        }
        cur = cur.getNextBlock();
      }
    };
    walkChain(bodyRoot, false);

    if (needsHoist.size > 0) {
      if (recordHoistedMap) {
        let rootSet = codegenContext.hoistedLocalsByRoot.get(root.id);
        if (!rootSet) {
          rootSet = new Set<string>();
          codegenContext.hoistedLocalsByRoot.set(root.id, rootSet);
        }
        for (const ident of needsHoist) rootSet.add(ident);
      }
      for (const ident of needsHoist) {
        if (!seen.has(ident)) {
          seen.add(ident);
          hoisted.push(ident);
        }
      }
    }
  }

  return hoisted;
}

function isShadowedByProcedureParam(
  varId: string,
  block?: Blockly.Block,
): boolean {
  if (!block) return false;
  const model = block.workspace?.getVariableMap()?.getVariableById(varId);
  const rawName = model?.getName();
  if (!rawName) return false;
  let cur: Blockly.Block | null = block;
  while (cur) {
    if (
      cur.type === 'procedures_defnoreturn' ||
      cur.type === 'procedures_defreturn'
    ) {
      const proc = cur as Blockly.Block & {
        getProcedureDef?: () => [string, string[], boolean];
      };
      const def = proc.getProcedureDef?.();
      if (def && Array.isArray(def[1]) && def[1].includes(rawName)) {
        return true;
      }
    }
    cur = cur.getSurroundParent();
  }
  return false;
}

/**
 * Language-agnostic variable reference resolver under Style A1:
 * - Shadowed by enclosing procedure formal param -> bare local ident
 * - Cross-file shared variable:
 *   - Inside `shared.<ext>` (`compilingSharedModule`): returns bare `<attr>` when
 *     `bareAttrInSharedModule` is true (e.g. Python module-level globals), or `<mod>.<attr>`
 *     when false (e.g. Lua module table fields).
 *   - In normal scripts: returns `<mod>.<attr>` and marks `usedSharedModule = true`.
 * - Single-file global -> target generator's standard variable identifier.
 */
export function formatSharedVarRef(
  varId: string,
  generator: { getVariableName(id: string): string },
  block?: Blockly.Block,
  opts?: { bareAttrInSharedModule?: boolean },
): string {
  const sharedMod = codegenContext.sharedModuleName;
  const sharedAttr = sharedMod
    ? codegenContext.sharedVarIdToAttr.get(varId)
    : undefined;
  if (sharedMod && sharedAttr && !isShadowedByProcedureParam(varId, block)) {
    if (codegenContext.compilingSharedModule) {
      return opts?.bareAttrInSharedModule
        ? sharedAttr
        : `${sharedMod}.${sharedAttr}`;
    }
    codegenContext.usedSharedModule = true;
    return `${sharedMod}.${sharedAttr}`;
  }
  return generator.getVariableName(varId);
}

/**
 * Computes the fixed-point set of custom procedure raw names in `workspace` (plus any external
 * shared async functions) that directly or transitively call `poly_wait_ms` (`sleep_ms`).
 */
export function computeAsyncFunctionNames(
  workspace: Blockly.Workspace,
  externalAsyncFns: Iterable<string> = [],
): Set<string> {
  const asyncSet = new Set<string>(externalAsyncFns);
  const procs: Array<{ name: string; calls: Set<string>; directWait: boolean }> = [];

  for (const top of workspace.getTopBlocks(false)) {
    if (top.isShadow() || !top.isEnabled()) continue;
    if (
      top.type !== 'procedures_defnoreturn' &&
      top.type !== 'procedures_defreturn'
    ) {
      continue;
    }
    const name = String(top.getFieldValue('NAME') || '').trim();
    if (!name) continue;
    let directWait = false;
    const calls = new Set<string>();
    for (const blk of top.getDescendants(false)) {
      if (blk.isShadow() || !blk.isEnabled()) continue;
      if (blk.type === 'poly_wait_ms') {
        directWait = true;
      } else if (
        blk.type === 'procedures_callnoreturn' ||
        blk.type === 'procedures_callreturn'
      ) {
        const call = blk as Blockly.Block & { getProcedureCall?: () => string };
        const target = call.getProcedureCall?.()?.trim();
        if (target) calls.add(target);
      } else if (
        blk.type === 'poly_call_shared_noreturn' ||
        blk.type === 'poly_call_shared_return'
      ) {
        const meta = (
          blk as Blockly.Block & { sharedFnMeta_?: { fnName: string } }
        ).sharedFnMeta_;
        if (meta?.fnName) calls.add(meta.fnName.trim());
      }
    }
    if (directWait) asyncSet.add(name);
    procs.push({ name, calls, directWait });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const p of procs) {
      if (asyncSet.has(p.name)) continue;
      for (const callee of p.calls) {
        if (asyncSet.has(callee)) {
          asyncSet.add(p.name);
          changed = true;
          break;
        }
      }
    }
  }

  return asyncSet;
}
