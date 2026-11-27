import type * as Blockly from 'blockly';
import { sanitizeLocalIdent } from './scopeAnalysis';

/**
 * Shared transient codegen pass context read by both core generators and
 * declarative `.polyext.json` hat/statement generators during Pass 1 (clean export)
 * and Pass 2 (instrumented async sandbox debug).
 */
export interface CodegenPassContext {
  debugPass: boolean;
  /** True when compiling shared functions directly into the read-only `shared.lua` / `shared.py` module. */
  compilingSharedModule: boolean;
  emittedDispatchEvents: Set<string>;
  /** Lua shared module name (e.g. 'shared'), empty when handle has no shared items. */
  luaSharedModuleName: string;
  luaSharedVarIdToAttr: Map<string, string>;
  luaSharedVarIdents: Set<string>;
  /** Python single-file global variable identifiers in the current workspace. */
  pythonGlobalVarIdents: string[];
  /** Auto-generated cross-file shared state module name (e.g. 'shared'), empty when unused. */
  pythonSharedModuleName: string;
  /** Map of current-workspace Blockly variable ID -> shared module attribute name. */
  pythonSharedVarIdToAttr: Map<string, string>;
  /** Sanitized local Blockly identifiers belonging to the shared module. */
  pythonSharedVarIdents: Set<string>;
  /** Sanitized identifiers of variables actively referenced by enabled blocks in the current workspace. */
  pythonUsedVarIdents: Set<string> | null;
  /** Set of custom procedure raw names (private or shared) that transitively call `sleep_ms`. */
  pythonAsyncFnNames: Set<string>;
  /** Set to true during codegen whenever the compiled script references any shared variable or shared function. */
  usedSharedModule: boolean;
  /** Per-root-block Lua `poly_local_set` idents hoisted to function top (nested in if/for/while). */
  luaHoistedLocalsByRoot: Map<string, Set<string>>;
}

export const codegenContext: CodegenPassContext = {
  debugPass: false,
  compilingSharedModule: false,
  emittedDispatchEvents: new Set<string>(),
  luaSharedModuleName: '',
  luaSharedVarIdToAttr: new Map<string, string>(),
  luaSharedVarIdents: new Set<string>(),
  pythonGlobalVarIdents: [],
  pythonSharedModuleName: '',
  pythonSharedVarIdToAttr: new Map<string, string>(),
  pythonSharedVarIdents: new Set<string>(),
  pythonUsedVarIdents: null,
  pythonAsyncFnNames: new Set<string>(),
  usedSharedModule: false,
  luaHoistedLocalsByRoot: new Map<string, Set<string>>(),
};

export function resetCodegenPassContext(opts: {
  debugPass: boolean;
  compilingSharedModule?: boolean;
  luaSharedModuleName?: string;
  luaSharedVarIdToAttr?: Map<string, string>;
  luaSharedVarIdents?: Set<string>;
  pythonGlobalVarIdents?: string[];
  pythonSharedModuleName?: string;
  pythonSharedVarIdToAttr?: Map<string, string>;
  pythonSharedVarIdents?: Set<string>;
  pythonUsedVarIdents?: Set<string> | null;
  pythonAsyncFnNames?: Set<string>;
}): void {
  codegenContext.debugPass = opts.debugPass;
  codegenContext.compilingSharedModule = Boolean(opts.compilingSharedModule);
  codegenContext.emittedDispatchEvents = new Set<string>();
  codegenContext.luaSharedModuleName = opts.luaSharedModuleName ?? '';
  codegenContext.luaSharedVarIdToAttr = new Map(opts.luaSharedVarIdToAttr ?? []);
  codegenContext.luaSharedVarIdents = new Set(opts.luaSharedVarIdents ?? []);
  codegenContext.pythonGlobalVarIdents = opts.pythonGlobalVarIdents ?? [];
  codegenContext.pythonSharedModuleName = opts.pythonSharedModuleName ?? '';
  codegenContext.pythonSharedVarIdToAttr = new Map(
    opts.pythonSharedVarIdToAttr ?? [],
  );
  codegenContext.pythonSharedVarIdents = new Set(
    opts.pythonSharedVarIdents ?? [],
  );
  codegenContext.pythonUsedVarIdents =
    opts.pythonUsedVarIdents !== undefined ? opts.pythonUsedVarIdents : null;
  codegenContext.pythonAsyncFnNames = new Set(opts.pythonAsyncFnNames ?? []);
  codegenContext.usedSharedModule = false;
  codegenContext.luaHoistedLocalsByRoot = new Map<string, Set<string>>();
}

/**
 * Shared scanner identifying `poly_local_set` variables whose first assignments occur inside nested
 * control blocks (`if`/`for`/`while`) rather than directly in the function's top statement chain.
 */
function collectNestedPolyLocalIdents(
  rootBlocks: Blockly.Block[],
  bodyInputName = 'BODY',
  recordLuaRootMap = false,
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
      if (recordLuaRootMap) {
        let rootSet = codegenContext.luaHoistedLocalsByRoot.get(root.id);
        if (!rootSet) {
          rootSet = new Set<string>();
          codegenContext.luaHoistedLocalsByRoot.set(root.id, rootSet);
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

/**
 * Computes Lua function-top `local a, b\n` hoisting ONLY for nested `poly_local_set` variables.
 */
export function buildLuaHoistedLocalsLine(
  rootBlocks: Blockly.Block[],
  bodyInputName = 'BODY',
  indent = '  ',
): string {
  const hoisted = collectNestedPolyLocalIdents(rootBlocks, bodyInputName, true);
  if (hoisted.length === 0) return '';
  return `${indent}local ${hoisted.join(', ')}\n`;
}

/**
 * Computes Python function-top `  msg = None\n` pre-declarations ONLY for nested `poly_local_set`
 * variables, matching Lua's `local msg` hoisting so missing `else` branches never throw UnboundLocalError.
 */
export function buildPythonHoistedLocalsLine(
  rootBlocks: Blockly.Block[],
  bodyInputName = 'BODY',
  indent = '  ',
): string {
  const hoisted = collectNestedPolyLocalIdents(rootBlocks, bodyInputName, false);
  if (hoisted.length === 0) return '';
  return hoisted.map((ident) => `${indent}${ident} = None\n`).join('');
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
 * Resolves a Lua variable reference under Style A1:
 * - Shadowed by enclosing procedure formal param -> bare local ident
 * - Cross-file shared variable -> `shared.<attr>` (and marks `usedSharedModule = true`)
 * - Single-file global -> bare file-top `local` ident
 */
export function formatLuaVarRef(
  varId: string,
  generator: { getVariableName(id: string): string },
  block?: Blockly.Block,
): string {
  const sharedMod = codegenContext.luaSharedModuleName;
  const sharedAttr = sharedMod
    ? codegenContext.luaSharedVarIdToAttr.get(varId)
    : undefined;
  if (sharedMod && sharedAttr && !isShadowedByProcedureParam(varId, block)) {
    if (!codegenContext.compilingSharedModule) {
      codegenContext.usedSharedModule = true;
    }
    return `${sharedMod}.${sharedAttr}`;
  }
  return generator.getVariableName(varId);
}

/**
 * Resolves a Python variable reference under Style A1:
 * - Shadowed by enclosing procedure formal param -> bare local ident
 * - Inside `shared.py` itself (`compilingSharedModule`) -> bare module-level `<attr>` (with `global` when written)
 * - In normal scripts -> `shared.<attr>` (and marks `usedSharedModule = true`)
 * - Single-file global -> standard Blockly Python variable identifier
 */
export function formatPythonVarRef(
  varId: string,
  generator: { getVariableName(id: string): string },
  block?: Blockly.Block,
): string {
  const sharedMod = codegenContext.pythonSharedModuleName;
  const sharedAttr = sharedMod
    ? codegenContext.pythonSharedVarIdToAttr.get(varId)
    : undefined;
  if (sharedMod && sharedAttr && !isShadowedByProcedureParam(varId, block)) {
    if (codegenContext.compilingSharedModule) {
      return sharedAttr;
    }
    codegenContext.usedSharedModule = true;
    return `${sharedMod}.${sharedAttr}`;
  }
  return generator.getVariableName(varId);
}

const PY_VAR_WRITE_BLOCK_TYPES = new Set<string>([
  'variables_set',
  'math_change',
  'text_append',
  'poly_for_range',
  'controls_for',
  'controls_forEach',
]);

/**
 * Generates a precise Python `  global a, b\n` declaration ONLY for module-level variables
 * that are actually assigned/rebound inside the given hat/procedure block body (and strictly excludes
 * formal parameter names to prevent `SyntaxError: name 'x' is parameter and global`).
 */
export function buildPythonGlobalLineForBlocks(
  rootBlocks: Blockly.Block[],
  generator: { getVariableName(id: string): string },
  excludeParams: string[] = [],
  bodyInputName = 'BODY',
): string {
  const allowedGlobals = codegenContext.compilingSharedModule
    ? Array.from(codegenContext.pythonSharedVarIdToAttr.values())
    : codegenContext.pythonGlobalVarIdents;
  if (allowedGlobals.length === 0) return '';
  const paramSet = new Set(excludeParams);
  const mutatedIdents = new Set<string>();

  for (const root of rootBlocks) {
    const bodyRoot = root.getInputTargetBlock(bodyInputName);
    if (!bodyRoot) continue;
    for (const blk of bodyRoot.getDescendants(false)) {
      if (blk.isShadow() || !blk.isEnabled()) continue;
      if (!PY_VAR_WRITE_BLOCK_TYPES.has(blk.type)) continue;
      const varId = blk.getFieldValue('VAR');
      if (!varId) continue;
      const varIdStr = String(varId);
      if (codegenContext.compilingSharedModule) {
        const attr = codegenContext.pythonSharedVarIdToAttr.get(varIdStr);
        if (attr && !paramSet.has(attr)) {
          mutatedIdents.add(attr);
        }
      } else {
        if (codegenContext.pythonSharedVarIdToAttr.has(varIdStr)) continue;
        const ident = generator.getVariableName(varIdStr);
        if (ident && !paramSet.has(ident)) {
          mutatedIdents.add(ident);
        }
      }
    }
  }

  const ordered = allowedGlobals.filter((ident) => mutatedIdents.has(ident));
  if (ordered.length === 0) return '';
  return `  global ${ordered.join(', ')}\n`;
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
