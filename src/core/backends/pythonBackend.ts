import * as Blockly from 'blockly';
import { Order, pythonGenerator } from 'blockly/python';
import {
  getActiveHandleSharedFunctions,
  getActiveScriptVarInitials,
} from '../blocks/workspaceContextBridge';
import {
  hoistImports,
  indentLines,
  renderExtensionTemplate,
} from '../extensions/templateRenderer';
import {
  BaseScriptBackend,
  type BlocklyGeneratorLike,
  type DebugAssemblyInput,
  type DebugPassPreparation,
  type WorkspacePassAnalysis,
} from './baseBackend';
import {
  codegenContext,
  collectNestedPolyLocalIdents,
  formatSharedVarRef,
  type CodegenPassContextOptions,
} from './codegenContext';
import { sanitizeLocalIdent } from './scopeAnalysis';
import {
  SENTINEL_END_PREFIX,
  SENTINEL_START_PREFIX,
} from './sourceMap';
import {
  formatInitialValueForLanguage,
  LANGUAGE_DIALECTS,
  type EntryDispatchBranchSpec,
  type ExtensionHatRegisterContext,
  type SharedModuleDocumentInput,
} from './types';

let pythonGeneratorsRegistered = false;

const PY_VAR_WRITE_BLOCK_TYPES = new Set<string>([
  'variables_set',
  'math_change',
  'text_append',
  'poly_for_range',
  'controls_for',
  'controls_forEach',
]);

function formatPythonVarRef(
  varId: string,
  generator: { getVariableName(id: string): string },
  block?: Blockly.Block,
): string {
  return formatSharedVarRef(varId, generator, block, {
    bareAttrInSharedModule: true,
  });
}

/**
 * Computes Python function-top `  msg = None\n` pre-declarations ONLY for nested `poly_local_set`
 * variables, matching Lua's `local msg` hoisting so missing `else` branches never throw UnboundLocalError.
 */
function buildPythonHoistedLocalsLine(
  rootBlocks: Blockly.Block[],
  bodyInputName = 'BODY',
  indent = '  ',
): string {
  const hoisted = collectNestedPolyLocalIdents(rootBlocks, bodyInputName, false);
  if (hoisted.length === 0) return '';
  return hoisted.map((ident) => `${indent}${ident} = None\n`).join('');
}

/**
 * Generates a precise Python `  global a, b\n` declaration ONLY for module-level variables
 * that are actually assigned/rebound inside the given hat/procedure block body (and strictly excludes
 * formal parameter names to prevent `SyntaxError: name 'x' is parameter and global`).
 */
function buildPythonGlobalLineForBlocks(
  rootBlocks: Blockly.Block[],
  generator: { getVariableName(id: string): string },
  excludeParams: string[] = [],
  bodyInputName = 'BODY',
): string {
  const allowedGlobals = codegenContext.compilingSharedModule
    ? Array.from(codegenContext.sharedVarIdToAttr.values())
    : codegenContext.globalVarIdents;
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
        const attr = codegenContext.sharedVarIdToAttr.get(varIdStr);
        if (attr && !paramSet.has(attr)) {
          mutatedIdents.add(attr);
        }
      } else {
        if (codegenContext.sharedVarIdToAttr.has(varIdStr)) continue;
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

/** Converts a 1-based list index expression into clean 0-based Python index (`1` -> `0`, `k` -> `int(k) - 1`). */
function formatPyZeroBasedIndex(rawIdx: string): string {
  const trimmed = rawIdx.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isInteger(n) && n >= 1) return String(n - 1);
  }
  return `int(${trimmed}) - 1`;
}

export function registerPythonBlockGenerators(): void {
  if (pythonGeneratorsRegistered) return;

  // Wrap Blockly's pythonGenerator.init so:
  // 1) Cross-file shared variables are NOT re-declared at module top level
  // 2) Unused handle-synced variables do NOT pollute top level
  // 3) Used single-file globals emit their configured `initialValue` (`step = 0`, `items = []`, `x = None`)
  const origInit = pythonGenerator.init.bind(pythonGenerator);
  pythonGenerator.init = (workspace: Blockly.Workspace) => {
    origInit(workspace);
    const sharedIdents = codegenContext.sharedVarIdents;
    const usedIdents = codegenContext.usedVarIdents;
    const scriptInitials = getActiveScriptVarInitials();
    const identToVarName = new Map<string, string>();
    for (const v of workspace.getVariableMap().getAllVariables()) {
      identToVarName.set(pythonGenerator.getVariableName(v.getId()), v.getName());
    }

    const defs = (
      pythonGenerator as unknown as { definitions_: Record<string, string> }
    ).definitions_;
    if (typeof defs.variables === 'string') {
      const kept: string[] = [];
      for (const line of defs.variables.split('\n')) {
        const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*None$/);
        if (!m) {
          if (line.trim()) kept.push(line);
          continue;
        }
        const ident = m[1];
        if (codegenContext.compilingSharedModule) continue;
        if (sharedIdents.has(ident)) continue;
        if (usedIdents !== null && !usedIdents.has(ident)) continue;
        const varName = identToVarName.get(ident) ?? ident;
        kept.push(
          `${ident} = ${formatInitialValueForLanguage(scriptInitials[varName], 'python')}`,
        );
      }
      if (kept.length > 0) {
        defs.variables = kept.join('\n');
      } else {
        delete defs.variables;
      }
    }
  };

  pythonGenerator.forBlock['variables_get'] = (block, generator) => {
    const ref = formatPythonVarRef(
      String(block.getFieldValue('VAR') || ''),
      generator,
      block,
    );
    return [ref, Order.ATOMIC];
  };

  pythonGenerator.forBlock['variables_set'] = (block, generator) => {
    const ref = formatPythonVarRef(
      String(block.getFieldValue('VAR') || ''),
      generator,
      block,
    );
    const val = generator.valueToCode(block, 'VALUE', Order.NONE) || '0';
    return `${ref} = ${val}\n`;
  };

  // Clean idiomatic Python `+=` (no hidden `isinstance` magic!)
  pythonGenerator.forBlock['math_change'] = (block, generator) => {
    const delta = generator.valueToCode(block, 'DELTA', Order.ADDITIVE) || '0';
    const varName = formatPythonVarRef(
      String(block.getFieldValue('VAR') || ''),
      generator,
      block,
    );
    return `${varName} += ${delta}\n`;
  };

  pythonGenerator.forBlock['text_append'] = (block, generator) => {
    const ref = formatPythonVarRef(
      String(block.getFieldValue('VAR') || ''),
      generator,
      block,
    );
    const val = generator.valueToCode(block, 'TEXT', Order.NONE) || "''";
    return `${ref} = str(${ref}) + str(${val})\n`;
  };

  const origControlsFor = pythonGenerator.forBlock['controls_for'];
  if (origControlsFor) {
    pythonGenerator.forBlock['controls_for'] = (block, generator) => {
      const out = origControlsFor(block, generator);
      if (typeof out !== 'string') return out;
      const varId = String(block.getFieldValue('VAR') || '');
      const ref = formatPythonVarRef(varId, generator, block);
      const ident = generator.getVariableName(varId);
      if (ref === ident) return out;
      return out.replace(
        new RegExp(`(^|\\n)for ${ident} in `),
        `$1for ${ref} in `,
      );
    };
  }

  const origControlsForEach = pythonGenerator.forBlock['controls_forEach'];
  if (origControlsForEach) {
    pythonGenerator.forBlock['controls_forEach'] = (block, generator) => {
      const out = origControlsForEach(block, generator);
      if (typeof out !== 'string') return out;
      const varId = String(block.getFieldValue('VAR') || '');
      const ref = formatPythonVarRef(varId, generator, block);
      const ident = generator.getVariableName(varId);
      if (ref === ident) return out;
      return out.replace(
        new RegExp(`(^|\\n)for ${ident} in `),
        `$1for ${ref} in `,
      );
    };
  }

  // Unified Scheme 1 single-thread coroutine ABI: `on_start` ALWAYS exports as `async def on_start():`
  pythonGenerator.forBlock['poly_on_start'] = (block, generator) => {
    const body = generator.statementToCode(block, 'BODY');
    const globalLine = buildPythonGlobalLineForBlocks([block], generator);
    const hoistedLocals = buildPythonHoistedLocalsLine([block], 'BODY', '  ');
    const safeBody = body.trim() ? body : '  pass\n';
    if (codegenContext.debugPass) {
      return `async def on_start():\n${globalLine}${hoistedLocals}${safeBody}\n`;
    }
    return (
      `${SENTINEL_START_PREFIX}'${block.id}'__\n` +
      `async def on_start():\n` +
      `${globalLine}${hoistedLocals}${safeBody}` +
      `${SENTINEL_END_PREFIX}'${block.id}'__\n`
    );
  };

  pythonGenerator.forBlock['poly_print'] = (block, generator) => {
    const value = generator.valueToCode(block, 'VALUE', Order.NONE) || '""';
    return `print(${value})\n`;
  };

  pythonGenerator.forBlock['poly_log'] = (block, generator) => {
    const level = block.getFieldValue('LEVEL') || 'INFO';
    const msg = generator.valueToCode(block, 'MESSAGE', Order.NONE) || '""';
    return `print("[${level}] " + str(${msg}))\n`;
  };

  pythonGenerator.forBlock['poly_print_kv'] = (block, generator) => {
    const rawLabel = block.getFieldValue('LABEL') || 'value';
    const label = JSON.stringify(`${rawLabel} =`);
    const value = generator.valueToCode(block, 'VALUE', Order.NONE) || 'None';
    return `print(${label}, ${value})\n`;
  };

  pythonGenerator.forBlock['poly_repeat_times'] = (block, generator) => {
    const times = generator.valueToCode(block, 'TIMES', Order.NONE) || '0';
    const rawBranch = generator.statementToCode(block, 'DO');
    const branch =
      rawBranch ||
      (codegenContext.debugPass ? '  await _poly_yield_check()\n' : generator.PASS);
    return `for _count in range(int(${times})):\n${branch}`;
  };

  pythonGenerator.forBlock['poly_for_range'] = (block, generator) => {
    const variableName = formatPythonVarRef(
      String(block.getFieldValue('VAR') || ''),
      generator,
      block,
    );
    const from = generator.valueToCode(block, 'FROM', Order.NONE) || '1';
    const to = generator.valueToCode(block, 'TO', Order.NONE) || '1';
    const by = generator.valueToCode(block, 'BY', Order.NONE) || '1';
    const rawBranch = generator.statementToCode(block, 'DO');
    const branch =
      rawBranch ||
      (codegenContext.debugPass ? '  await _poly_yield_check()\n' : generator.PASS);

    const toNum = Number(to.trim());
    const byTrim = by.trim();

    if (byTrim === '1' && Number.isInteger(toNum)) {
      return `for ${variableName} in range(int(${from}), ${toNum + 1}):\n${branch}`;
    }

    if (byTrim === '1') {
      return `for ${variableName} in range(int(${from}), int(${to}) + 1):\n${branch}`;
    }

    return `for ${variableName} in range(int(${from}), int(${to}) + (1 if int(${by}) >= 0 else -1), int(${by})):\n${branch}`;
  };

  // Unified Scheme 1 coroutine sleep ABI: IDENTICAL in clean hardware export and sandbox!
  pythonGenerator.forBlock['poly_wait_ms'] = (block, generator) => {
    const ms = generator.valueToCode(block, 'MS', Order.NONE) || '0';
    return `await sleep_ms(${ms})\n`;
  };

  const origPyWhileUntil = pythonGenerator.forBlock['controls_whileUntil'];
  if (origPyWhileUntil) {
    pythonGenerator.forBlock['controls_whileUntil'] = (block, generator) => {
      const code = origPyWhileUntil(block, generator);
      if (
        codegenContext.debugPass &&
        typeof code === 'string' &&
        !block.getInputTargetBlock('DO')
      ) {
        return code.replace(/:\n(\s*)pass\n/, ':\n$1await _poly_yield_check()\n');
      }
      return code;
    };
  }

  pythonGenerator.forBlock['poly_comment'] = (block) => {
    const text = (block.getFieldValue('TEXT') || '').replace(/\r?\n/g, ' ');
    return `# ${text}\n`;
  };

  pythonGenerator.forBlock['poly_require_script'] = (block) => {
    const raw = String(block.getFieldValue('SCRIPT') || '').trim();
    if (!raw) return `# 未选择目标脚本\n`;
    const ident = sanitizeLocalIdent(raw);
    return `import ${ident}\n`;
  };

  pythonGenerator.forBlock['poly_local_set'] = (block, generator) => {
    const rawName = String(block.getFieldValue('NAME') || 'tmp');
    const ident = sanitizeLocalIdent(rawName);
    const val = generator.valueToCode(block, 'VALUE', Order.NONE) || 'None';
    return `${ident} = ${val}\n`;
  };

  pythonGenerator.forBlock['poly_local_get'] = (block) => {
    const rawName = String(block.getFieldValue('NAME') || 'tmp');
    return [sanitizeLocalIdent(rawName), Order.ATOMIC];
  };

  pythonGenerator.forBlock['poly_to_string'] = (block, generator) => {
    const value = generator.valueToCode(block, 'VALUE', Order.NONE) || '""';
    return [`str(${value})`, Order.FUNCTION_CALL];
  };

  pythonGenerator.forBlock['poly_str_replace'] = (block, generator) => {
    const src = generator.valueToCode(block, 'SRC', Order.NONE) || '""';
    const oldStr = generator.valueToCode(block, 'OLD', Order.NONE) || '""';
    const newStr = generator.valueToCode(block, 'NEW', Order.NONE) || '""';
    return [
      `str(${src}).replace(str(${oldStr}), str(${newStr}))`,
      Order.FUNCTION_CALL,
    ];
  };

  // Pure value-slot list primitives (zero hidden helper functions!)
  pythonGenerator.forBlock['poly_list_append'] = (block, generator) => {
    const listCode = generator.valueToCode(block, 'LIST', Order.MEMBER) || '[]';
    const item = generator.valueToCode(block, 'ITEM', Order.NONE) || 'None';
    return `${listCode}.append(${item})\n`;
  };

  pythonGenerator.forBlock['poly_list_get'] = (block, generator) => {
    const listCode = generator.valueToCode(block, 'LIST', Order.MEMBER) || '[]';
    const idx = generator.valueToCode(block, 'INDEX', Order.NONE) || '1';
    return [`${listCode}[${formatPyZeroBasedIndex(idx)}]`, Order.MEMBER];
  };

  pythonGenerator.forBlock['poly_list_set'] = (block, generator) => {
    const listCode = generator.valueToCode(block, 'LIST', Order.MEMBER) || '[]';
    const idx = generator.valueToCode(block, 'INDEX', Order.NONE) || '1';
    const val = generator.valueToCode(block, 'VALUE', Order.NONE) || 'None';
    return `${listCode}[${formatPyZeroBasedIndex(idx)}] = ${val}\n`;
  };

  pythonGenerator.forBlock['poly_list_remove'] = (block, generator) => {
    const listCode = generator.valueToCode(block, 'LIST', Order.MEMBER) || '[]';
    const idx = generator.valueToCode(block, 'INDEX', Order.NONE) || '1';
    return `${listCode}.pop(${formatPyZeroBasedIndex(idx)})\n`;
  };

  // Pure value-slot dict primitives (zero hidden helpers, native Python dicts, supports nested chaining)
  pythonGenerator.forBlock['poly_dict_new'] = () => ['{}', Order.ATOMIC];

  pythonGenerator.forBlock['poly_dict_set'] = (block, generator) => {
    const dictCode = generator.valueToCode(block, 'DICT', Order.MEMBER) || '{}';
    const key = generator.valueToCode(block, 'KEY', Order.NONE) || "''";
    const val = generator.valueToCode(block, 'VAL', Order.NONE) || 'None';
    return `${dictCode}[${key}] = ${val}\n`;
  };

  pythonGenerator.forBlock['poly_dict_get'] = (block, generator) => {
    const dictCode = generator.valueToCode(block, 'DICT', Order.MEMBER) || '{}';
    const key = generator.valueToCode(block, 'KEY', Order.NONE) || "''";
    return [`${dictCode}.get(${key})`, Order.FUNCTION_CALL];
  };

  pythonGenerator.forBlock['poly_dict_has'] = (block, generator) => {
    const dictCode = generator.valueToCode(block, 'DICT', Order.RELATIONAL) || '{}';
    const key = generator.valueToCode(block, 'KEY', Order.RELATIONAL) || "''";
    return [`${key} in ${dictCode}`, Order.RELATIONAL];
  };

  pythonGenerator.forBlock['poly_dict_delete'] = (block, generator) => {
    const dictCode = generator.valueToCode(block, 'DICT', Order.MEMBER) || '{}';
    const key = generator.valueToCode(block, 'KEY', Order.NONE) || "''";
    return `${dictCode}.pop(${key}, None)\n`;
  };

  // Wrap built-in procedure defs/calls:
  // 1) Shared functions live ONLY in `shared.py` (suppressed in normal script files)
  // 2) Replace Blockly's shotgun `global ...` with our precise `buildPythonGlobalLineForBlocks`
  // 3) Hoist nested `poly_local_set` vars as `msg = None` at function top
  // 4) Emit `async def` + `await` for procedures containing `sleep_ms` (and all procs in debugPass)
  const origDefNoReturn = pythonGenerator.forBlock['procedures_defnoreturn'];
  const origDefReturn = pythonGenerator.forBlock['procedures_defreturn'];

  if (origDefReturn) {
    const wrapDef =
      (orig: typeof origDefReturn) =>
      (block: Blockly.Block, generator: typeof pythonGenerator) => {
        const rawName = String(block.getFieldValue('NAME') || '').trim();
        const sharedFnSet = new Set(getActiveHandleSharedFunctions() ?? []);
        const isSharedFn = sharedFnSet.has(rawName);
        if (isSharedFn && !codegenContext.compilingSharedModule) {
          return null;
        }

        const out = orig(block, generator);
        const procIdent = generator.getProcedureName(rawName);
        const defKey = `%${procIdent}`;
        const defs = (
          generator as unknown as { definitions_: Record<string, string> }
        ).definitions_;
        const existing = defs[defKey];
        if (typeof existing === 'string') {
          const proc = block as Blockly.Block & {
            getProcedureDef?: () => [string, string[], boolean];
          };
          const paramNames = proc.getProcedureDef?.()?.[1] ?? [];
          const varMap = block.workspace?.getVariableMap();
          const paramIdents = paramNames.map((pName) => {
            const vm = varMap?.getVariable(pName, '');
            return vm ? generator.getVariableName(vm.getId()) : sanitizeLocalIdent(pName);
          });

          // Remove Blockly's shotgun `global ...` lines completely
          let nextCode = existing.replace(/^[ \t]+global [^\n]+\n/gm, '');

          // Inject precise `global` + hoisted nested locals right after `def ...:\n`
          const preciseGlobal = buildPythonGlobalLineForBlocks(
            [block],
            generator,
            paramIdents,
            'STACK',
          );
          const hoistedLocals = buildPythonHoistedLocalsLine([block], 'STACK', '  ');
          const prefixLines = `${preciseGlobal}${hoistedLocals}`;
          if (prefixLines) {
            nextCode = nextCode.replace(
              /(^|\n)((?:async\s+)?def\s+[^\n]+:\n)/,
              `$1$2${prefixLines}`,
            );
          }

          const shouldBeAsync =
            codegenContext.debugPass ||
            codegenContext.asyncFnNames.has(rawName);
          if (shouldBeAsync) {
            nextCode = nextCode.replace(/(^|\n)def /, '$1async def ');
          }

          defs[defKey] = nextCode;
        }
        return out;
      };
    pythonGenerator.forBlock['procedures_defreturn'] = wrapDef(origDefReturn);
    if (origDefNoReturn) {
      pythonGenerator.forBlock['procedures_defnoreturn'] = wrapDef(origDefNoReturn);
    }
  }

  const formatPyProcCall = (
    rawName: string,
    fnIdent: string,
    argsStr: string,
    isShared: boolean,
    asExpr: boolean,
  ): string => {
    const isAsyncClean = codegenContext.asyncFnNames.has(rawName);
    if (isShared && !codegenContext.compilingSharedModule) {
      const modName = codegenContext.sharedModuleName || 'shared';
      codegenContext.usedSharedModule = true;
      if (codegenContext.debugPass) {
        const callArgs = argsStr
          ? `${JSON.stringify(modName)}, ${JSON.stringify(fnIdent)}, ${argsStr}`
          : `${JSON.stringify(modName)}, ${JSON.stringify(fnIdent)}`;
        return asExpr
          ? `(await _poly_call_mod(${callArgs}))`
          : `await _poly_call_mod(${callArgs})`;
      }
      const expr = `${modName}.${fnIdent}(${argsStr})`;
      if (isAsyncClean) {
        return asExpr ? `(await ${expr})` : `await ${expr}`;
      }
      return expr;
    }

    // Local call (or shared function calling another shared function inside `shared.py`)
    const expr = `${fnIdent}(${argsStr})`;
    if (codegenContext.debugPass || isAsyncClean) {
      return asExpr ? `(await ${expr})` : `await ${expr}`;
    }
    return expr;
  };

  pythonGenerator.forBlock['procedures_callnoreturn'] = (block, generator) => {
    const call = block as Blockly.Block & {
      getProcedureCall?: () => string;
      arguments_?: string[];
    };
    const rawName = call.getProcedureCall?.()?.trim() ?? '';
    const sharedFnSet = new Set(getActiveHandleSharedFunctions() ?? []);
    const isShared = Boolean(rawName && sharedFnSet.has(rawName));
    const fnIdent = generator.getProcedureName(rawName);
    const args: string[] = [];
    for (let i = 0; i < (call.arguments_?.length ?? 0); i++) {
      args.push(generator.valueToCode(block, `ARG${i}`, Order.NONE) || 'None');
    }
    return `${formatPyProcCall(rawName, fnIdent, args.join(', '), isShared, false)}\n`;
  };

  pythonGenerator.forBlock['procedures_callreturn'] = (block, generator) => {
    const call = block as Blockly.Block & {
      getProcedureCall?: () => string;
      arguments_?: string[];
    };
    const rawName = call.getProcedureCall?.()?.trim() ?? '';
    const sharedFnSet = new Set(getActiveHandleSharedFunctions() ?? []);
    const isShared = Boolean(rawName && sharedFnSet.has(rawName));
    const fnIdent = generator.getProcedureName(rawName);
    const args: string[] = [];
    for (let i = 0; i < (call.arguments_?.length ?? 0); i++) {
      args.push(generator.valueToCode(block, `ARG${i}`, Order.NONE) || 'None');
    }
    const out = formatPyProcCall(rawName, fnIdent, args.join(', '), isShared, true);
    const needsAtomic =
      codegenContext.debugPass || codegenContext.asyncFnNames.has(rawName);
    return [out, needsAtomic ? Order.ATOMIC : Order.FUNCTION_CALL];
  };

  const emitPySharedFnCall = (
    block: Blockly.Block,
    generator: typeof pythonGenerator,
    asExpr: boolean,
  ): string => {
    const meta = (
      block as Blockly.Block & {
        sharedFnMeta_?: { scriptName: string; fnName: string; params: string[] };
      }
    ).sharedFnMeta_ ?? { scriptName: 'shared', fnName: 'my_func', params: [] };
    const fnIdent = generator.getProcedureName(meta.fnName);
    const args = meta.params.map(
      (_p, idx) => generator.valueToCode(block, `ARG${idx}`, Order.NONE) || 'None',
    );
    return formatPyProcCall(meta.fnName, fnIdent, args.join(', '), true, asExpr);
  };

  pythonGenerator.forBlock['poly_call_shared_noreturn'] = (block, generator) => {
    return `${emitPySharedFnCall(block, generator, false)}\n`;
  };

  pythonGenerator.forBlock['poly_call_shared_return'] = (block, generator) => {
    const meta = (
      block as Blockly.Block & { sharedFnMeta_?: { fnName: string } }
    ).sharedFnMeta_;
    const needsAtomic =
      codegenContext.debugPass ||
      Boolean(meta?.fnName && codegenContext.asyncFnNames.has(meta.fnName));
    return [
      emitPySharedFnCall(block, generator, true),
      needsAtomic ? Order.ATOMIC : Order.FUNCTION_CALL,
    ];
  };

  pythonGeneratorsRegistered = true;
}

/** Unified single-track Python coroutine & event-loop scheduler driver (matches C single-thread host model). */
function buildPythonEventLoopDriver(keepAliveExternal: boolean): string {
  return `
_has_start = 'on_start' in globals() and callable(on_start)
_has_run = 'on_run' in globals() and callable(on_run)
_has_timer = 'on_timer' in globals() and callable(on_timer)
_has_ext = ${keepAliveExternal ? 'True' : 'False'}

async def _poly_start_runner():
  global _POLY_IN_START, _POLY_SLICE_START, _POLY_START_ERR
  try:
    _keep = await _poly.wait_start_turn()
    if not _keep:
      return
    _POLY_IN_START = True
    _POLY_SLICE_START = _poly.now_ms()
    _res = on_start()
    if hasattr(_res, 'send'):
      await _res
  except _PolyStopStart:
    pass
  except Exception as _e:
    _POLY_START_ERR = _e
  finally:
    _POLY_IN_START = False
    _poly.co_done()

async def _poly_call_cb(_cname, _fn, *_args):
  global _POLY_ACTIVE_CB
  if not callable(_fn):
    return
  _POLY_ACTIVE_CB = _cname
  _poly.cb_enter(_cname)
  try:
    _ret = _fn(*_args)
    if hasattr(_ret, 'send'):
      await _ret
  except _PolyStopCb:
    pass
  finally:
    _POLY_ACTIVE_CB = ''
    _poly.cb_exit()

def _poly_refresh_handlers():
  _poly.sync_handlers(
    'on_run' in globals() and callable(on_run),
    'on_timer' in globals() and callable(on_timer),
    _has_ext
  )

_start_task = asyncio.create_task(_poly_start_runner()) if _has_start else None
try:
  if _poly.init_scheduler(_has_start, _has_run, _has_timer, _has_ext):
    while True:
      _ev = await _poly.next_event()
      if _ev == 'start_resume':
        await _poly.resume_start_slice()
        if _POLY_START_ERR is not None:
          raise _POLY_START_ERR
        _poly_refresh_handlers()
      elif _ev == 'run':
        if 'on_run' in globals() and callable(on_run):
          await _poly_call_cb('on_run', on_run)
        _poly_refresh_handlers()
      elif isinstance(_ev, str) and _ev.startswith('timer:'):
        if 'on_timer' in globals() and callable(on_timer):
          await _poly_call_cb('on_timer', on_timer, int(_ev[6:]))
        _poly_refresh_handlers()
      elif isinstance(_ev, str) and _ev.startswith('event:'):
        _epayload = json.loads(_ev[6:])
        _ename = _epayload[0]
        _eargs = _epayload[1] if len(_epayload) > 1 else []
        _efn = globals().get(_ename)
        if callable(_efn):
          await _poly_call_cb(_ename, _efn, *_eargs)
        _poly_refresh_handlers()
      else:
        break
finally:
  if _start_task is not None:
    _poly.co_done()
    try:
      await _start_task
    except Exception:
      pass
if 'on_stop' in globals() and callable(on_stop):
  await _poly_call_cb('on_stop', on_stop)
`;
}

const PY_DEBUG_STATEMENT_PREFIX =
  `await _poly_tick(%1, _poly_snap(locals(), globals()))\n`;

export class PythonBackendAdapter extends BaseScriptBackend<void> {
  readonly id = 'python' as const;
  readonly name = 'Python';
  readonly version = '3';
  readonly extension = 'py';
  readonly fileName = 'main.py';
  readonly accentColor = '#f59e0b';
  readonly description =
    '标准 Python 3 脚本生成器，支持 Style A1 只读 shared 模块、单线程 async 协程 ABI 与伴生脚本断点调试。';
  readonly dialect = LANGUAGE_DIALECTS.python;

  protected readonly bareAttrInSharedModule = true;
  protected readonly orderNone = Order.NONE;
  protected readonly orderAtomic = Order.ATOMIC;
  protected readonly topLevelDebugTickRe = /^await _poly_tick\(/;

  protected ensureGeneratorsRegistered(): void {
    registerPythonBlockGenerators();
  }

  protected getGenerator(): BlocklyGeneratorLike {
    return pythonGenerator;
  }

  protected formatFileHeader(eventDriven: boolean): string {
    return eventDriven
      ? `# 由 PolyBlock 自动生成 (Target: Python 3 · Async Coroutine Event ABI)\n`
      : `# 由 PolyBlock 自动生成 (Target: Python 3 · Async Coroutine ABI)\n`;
  }

  protected formatSharedModuleImport(moduleName: string): string {
    return `import ${moduleName}`;
  }

  protected buildPassContextOptions(
    debugPass: boolean,
    analysis: WorkspacePassAnalysis,
  ): CodegenPassContextOptions {
    const sharedVarIdToAttr = new Map<string, string>();
    const sharedVarIdents = new Set<string>();
    const nonSharedVarIdents: string[] = [];
    const usedVarIdents = new Set<string>();

    for (const v of analysis.variables) {
      if (!v.used) continue;
      usedVarIdents.add(v.ident);
      if (v.sharedAttr && analysis.sharedModuleName) {
        sharedVarIdToAttr.set(v.id, v.sharedAttr);
        sharedVarIdents.add(v.ident);
      } else {
        nonSharedVarIdents.push(v.ident);
      }
    }

    return {
      debugPass,
      globalVarIdents: nonSharedVarIdents,
      sharedModuleName: analysis.sharedModuleName,
      sharedVarIdToAttr,
      sharedVarIdents,
      usedVarIdents,
      asyncFnNames: analysis.asyncFnNames,
    };
  }

  protected prepareDebugPass(): DebugPassPreparation<void> {
    return {
      statementPrefix: PY_DEBUG_STATEMENT_PREFIX,
      meta: undefined,
    };
  }

  protected assembleDebugOutputs(
    input: DebugAssemblyInput<void>,
  ): { debugCode: string; moduleDebugCode: string } {
    const {
      fullDebugBody,
      companionDebugBody,
      keepAliveExternal,
      usedSharedDebug,
      sharedModuleName,
      analysis,
      allLocalEntries,
    } = input;

    const activeSharedModName =
      usedSharedDebug && sharedModuleName ? sharedModuleName : '';

    const sharedVarIdents = new Set<string>();
    const sharedSnapEntries: Array<[string, string]> = [];
    for (const v of analysis.variables) {
      if (v.used && v.sharedAttr && sharedModuleName) {
        sharedVarIdents.add(v.ident);
        sharedSnapEntries.push([v.label, v.sharedAttr]);
      }
    }

    const snapVarEntries: Array<[string, string]> = analysis.variables
      .filter((v) => !sharedVarIdents.has(v.ident))
      .map((v) => [v.label, v.ident]);
    const seenPyLabels = new Set([
      ...snapVarEntries.map(([label]) => label),
      ...sharedSnapEntries.map(([label]) => label),
    ]);
    for (const loc of allLocalEntries) {
      if (!seenPyLabels.has(loc.label)) {
        seenPyLabels.add(loc.label);
        snapVarEntries.push([loc.label, loc.ident]);
      }
    }

    const snapHelperLines = [
      `def _poly_snap(_loc, _glb):`,
      `  _out = {}`,
      `  for _label, _ident in _POLY_VAR_MAP:`,
      `    if _ident in _loc:`,
      `      _v = _loc[_ident]`,
      `    elif _ident in _glb:`,
      `      _v = _glb[_ident]`,
      `    else:`,
      `      continue`,
      `    try:`,
      `      _out[_label] = repr(_v)`,
      `    except Exception:`,
      `      _out[_label] = str(_v)`,
      `  if _POLY_SHARED_MOD and _POLY_SHARED_MAP:`,
      `    _sm = sys.modules.get(_POLY_SHARED_MOD)`,
      `    if _sm is not None:`,
      `      for _label, _attr in _POLY_SHARED_MAP:`,
      `        if hasattr(_sm, _attr):`,
      `          _v = getattr(_sm, _attr)`,
      `          try:`,
      `            _out[_label] = repr(_v)`,
      `          except Exception:`,
      `            _out[_label] = str(_v)`,
      `  return json.dumps(_out)`,
    ];

    const debugPrelude = [
      `import sys, _poly, json, asyncio`,
      `_POLY_VAR_MAP = ${JSON.stringify(snapVarEntries)}`,
      `_POLY_SHARED_MOD = ${JSON.stringify(activeSharedModName)}`,
      `_POLY_SHARED_MAP = ${JSON.stringify(sharedSnapEntries)}`,
      `_POLY_IN_START = False`,
      `_POLY_ACTIVE_CB = ''`,
      `_POLY_SLICE_START = 0.0`,
      `_POLY_START_ERR = None`,
      `class _PolyStopStart(Exception):`,
      `  pass`,
      `class _PolyStopCb(Exception):`,
      `  pass`,
      `async def sleep_ms(_ms):`,
      `  global _POLY_IN_START, _POLY_SLICE_START`,
      `  if _poly.is_in_callback() or not _POLY_IN_START:`,
      `    raise RuntimeError("禁止在事件回调（on_run / on_timer / on_button / on_stop）或顶层脚本中调用等待 (sleep_ms)；请移至「当程序启动 (on_start)」协程内。")`,
      `  _POLY_IN_START = False`,
      `  _poly.co_sleep(_ms)`,
      `  _keep = await _poly.wait_start_turn()`,
      `  if not _keep:`,
      `    raise _PolyStopStart()`,
      `  _POLY_IN_START = True`,
      `  _POLY_SLICE_START = _poly.now_ms()`,
      `async def _poly_tick(_bid, _snap):`,
      `  global _POLY_IN_START, _POLY_SLICE_START`,
      `  if _POLY_IN_START and not _poly.is_in_callback():`,
      `    await _poly.step_start(_bid, _snap)`,
      `    if _poly.is_stop_requested():`,
      `      raise _PolyStopStart()`,
      `    if (_poly.now_ms() - _POLY_SLICE_START) >= _poly.get_time_slice_ms():`,
      `      _POLY_IN_START = False`,
      `      _poly.co_yield_slice()`,
      `      _keep = await _poly.wait_start_turn()`,
      `      if not _keep:`,
      `        raise _PolyStopStart()`,
      `      _POLY_IN_START = True`,
      `      _POLY_SLICE_START = _poly.now_ms()`,
      `    return`,
      `  await _poly.step(_bid, _snap)`,
      `  if _poly.is_in_callback():`,
      `    if _poly.is_stop_requested() and _POLY_ACTIVE_CB != 'on_stop':`,
      `      raise _PolyStopCb()`,
      `    if _poly.cb_expired():`,
      `      raise RuntimeError("事件回调执行超时（疑似死循环），已按单次回调超时保护中断。")`,
      `async def _poly_yield_check():`,
      `  global _POLY_IN_START, _POLY_SLICE_START`,
      `  if _POLY_IN_START and not _poly.is_in_callback():`,
      `    if _poly.is_stop_requested():`,
      `      raise _PolyStopStart()`,
      `    if (_poly.now_ms() - _POLY_SLICE_START) >= _poly.get_time_slice_ms():`,
      `      _POLY_IN_START = False`,
      `      _poly.co_yield_slice()`,
      `      _keep = await _poly.wait_start_turn()`,
      `      if not _keep:`,
      `        raise _PolyStopStart()`,
      `      _POLY_IN_START = True`,
      `      _POLY_SLICE_START = _poly.now_ms()`,
      `  elif _poly.is_in_callback():`,
      `    if _poly.is_stop_requested() and _POLY_ACTIVE_CB != 'on_stop':`,
      `      raise _PolyStopCb()`,
      `    if _poly.cb_expired():`,
      `      raise RuntimeError("事件回调执行超时（疑似死循环），已按单次回调超时保护中断。")`,
      `async def _poly_call_mod(_mname, _fname, *_args):`,
      `  _m = sys.modules.get(_mname)`,
      `  if _m is None:`,
      `    _m = __import__(_mname)`,
      `  _fn = getattr(_m, _fname)`,
      `  _ret = _fn(*_args)`,
      `  if hasattr(_ret, 'send'):`,
      `    return await _ret`,
      `  return _ret`,
      `class _PolyRtMod:`,
      `  pass`,
      `_poly_rt_mod = _PolyRtMod()`,
      `_poly_rt_mod._poly_tick = _poly_tick`,
      `_poly_rt_mod._poly_yield_check = _poly_yield_check`,
      `_poly_rt_mod.sleep_ms = sleep_ms`,
      `_poly_rt_mod._poly_call_mod = _poly_call_mod`,
      `_poly_rt_mod._PolyStopStart = _PolyStopStart`,
      `_poly_rt_mod._PolyStopCb = _PolyStopCb`,
      `sys.modules['_poly_rt'] = _poly_rt_mod`,
      ...snapHelperLines,
      ``,
    ].join('\n');

    const companionDebugPrelude = [
      `import sys, json`,
      `from _poly_rt import _poly_tick, _poly_yield_check, sleep_ms, _poly_call_mod`,
      `_POLY_VAR_MAP = ${JSON.stringify(snapVarEntries)}`,
      `_POLY_SHARED_MOD = ${JSON.stringify(activeSharedModName)}`,
      `_POLY_SHARED_MAP = ${JSON.stringify(sharedSnapEntries)}`,
      ...snapHelperLines,
      ``,
    ].join('\n');

    const driver = buildPythonEventLoopDriver(keepAliveExternal);
    const debugCode = fullDebugBody
      ? `${debugPrelude}${fullDebugBody}\n${driver}\n_poly.final_snap(_poly_snap(locals(), globals()))\n`
      : '';
    const moduleDebugCode = companionDebugBody.trim()
      ? `${companionDebugPrelude}${companionDebugBody}\n`
      : '';
    return { debugCode, moduleDebugCode };
  }

  protected getSharedProcDebugStatementPrefix(): string {
    return PY_DEBUG_STATEMENT_PREFIX;
  }

  formatDispatchRouter(
    eventName: string,
    branches: EntryDispatchBranchSpec[],
    debugPass: boolean,
  ): { autoImports: string[]; code: string } {
    if (branches.length === 0) return { autoImports: [], code: '' };
    const paramsStr = (branches[0].params ?? []).join(', ');
    const defKw = debugPass ? 'async def' : 'def';
    const hasSibling = branches.some((br) => !br.isLocal);
    const lines: string[] = [];
    branches.forEach((br, idx) => {
      const kw = idx === 0 ? 'if' : 'elif';
      const cond = br.condition.python ?? this.dialect.boolTrue;
      const comment = br.comment.python ?? '';
      const callArgs = br.passParams ? paramsStr : '';
      const srcTag = br.isLocal
        ? ''
        : comment
          ? ` (${br.scriptName}.py)`
          : `  # ${br.scriptName}.py`;
      if (br.isLocal) {
        const callExpr = debugPass
          ? `await ${br.fnName}(${callArgs})`
          : `${br.fnName}(${callArgs})`;
        lines.push(`  ${kw} ${cond}:${comment}${srcTag}\n    ${callExpr}`);
      } else {
        const modKey = JSON.stringify(sanitizeLocalIdent(br.scriptName));
        if (debugPass) {
          lines.push(
            `  ${kw} ${cond}:${comment}${srcTag}\n` +
              `    _m = sys.modules.get(${modKey})\n` +
              `    if _m and hasattr(_m, ${JSON.stringify(br.fnName)}):\n` +
              `      _ret = getattr(_m, ${JSON.stringify(br.fnName)})(${callArgs})\n` +
              `      if hasattr(_ret, 'send'):\n` +
              `        await _ret`,
          );
        } else {
          lines.push(
            `  ${kw} ${cond}:${comment}${srcTag}\n` +
              `    _m = sys.modules.get(${modKey})\n` +
              `    if _m and hasattr(_m, ${JSON.stringify(br.fnName)}):\n` +
              `      _m.${br.fnName}(${callArgs})`,
          );
        }
      }
    });
    return {
      autoImports: hasSibling ? ['import sys'] : [],
      code: `${defKw} ${eventName}(${paramsStr}):\n${lines.join('\n')}\n`,
    };
  }

  registerExtensionHat(ctx: ExtensionHatRegisterContext): void {
    const { pack, section, block: b, hat: hatSpec, shouldExtractBranches } = ctx;
    const paramsStr = (hatSpec.params ?? []).join(', ');
    const branchParamsStr = hatSpec.extractBranchFnPrefix ? '' : paramsStr;
    const renderHatTpl = (tpl: string, hatBlk: Blockly.Block) =>
      renderExtensionTemplate(
        tpl,
        b,
        hatBlk,
        'python',
        {
          resolveValueInput: (blk, argName) =>
            pythonGenerator.valueToCode(blk, argName, Order.NONE) || '""',
          resolveVarField: (blk, argName) =>
            formatPythonVarRef(
              String(blk.getFieldValue(argName) || ''),
              pythonGenerator,
              blk,
            ),
        },
        pack,
        section,
      );

    pythonGenerator.forBlock[b.type] = (block, generator) => {
      hoistImports(generator, hatSpec.imports?.python);
      const defKw = codegenContext.debugPass ? 'async def' : 'def';
      const formalParams = hatSpec.params ?? [];
      const branchFormalParams = hatSpec.extractBranchFnPrefix ? [] : formalParams;

      if (hatSpec.mode === 'singleton') {
        const body = generator.statementToCode(block, 'BODY');
        const globalLine = buildPythonGlobalLineForBlocks(
          [block],
          generator,
          formalParams,
        );
        const hoistedLocals = buildPythonHoistedLocalsLine([block], 'BODY', '  ');
        const safeBody = body.trim() ? body : '  pass\n';
        if (codegenContext.debugPass) {
          return `${defKw} ${hatSpec.eventName}(${paramsStr}):\n${globalLine}${hoistedLocals}${safeBody}\n`;
        }
        return (
          `${SENTINEL_START_PREFIX}'${block.id}'__\n` +
          `${defKw} ${hatSpec.eventName}(${paramsStr}):\n` +
          `${globalLine}${hoistedLocals}${safeBody}` +
          `${SENTINEL_END_PREFIX}'${block.id}'__\n`
        );
      }

      const dispatchKey = `${hatSpec.eventName}:${b.type}`;
      if (codegenContext.emittedDispatchEvents.has(dispatchKey)) return '';
      codegenContext.emittedDispatchEvents.add(dispatchKey);

      const matchingHats = block.workspace
        .getTopBlocks(true)
        .filter((top) => top.type === b.type && !top.isShadow() && top.isEnabled());
      if (matchingHats.length === 0) return '';

      if (shouldExtractBranches()) {
        const extracted = this.resolveExtractedHatBranches(
          matchingHats,
          hatSpec,
          renderHatTpl,
        );
        const fnDefs = extracted.map(({ block: hatBlk, fnName, comment }) => {
          const rawBody = generator.statementToCode(hatBlk, 'BODY');
          const branchGlobalLine = buildPythonGlobalLineForBlocks(
            [hatBlk],
            generator,
            branchFormalParams,
          );
          const branchHoistedLocals = buildPythonHoistedLocalsLine(
            [hatBlk],
            'BODY',
            '  ',
          );
          const safeBody = rawBody.trim() ? rawBody : '  pass\n';
          const headerComment = comment.trim() ? `${comment.trim()}\n` : '';
          if (codegenContext.debugPass) {
            return `${defKw} ${fnName}(${branchParamsStr}):\n${branchGlobalLine}${branchHoistedLocals}${safeBody}\n`;
          }
          return (
            `${SENTINEL_START_PREFIX}'${hatBlk.id}'__\n` +
            `${headerComment}` +
            `${defKw} ${fnName}(${branchParamsStr}):\n` +
            `${branchGlobalLine}${branchHoistedLocals}${safeBody}` +
            `${SENTINEL_END_PREFIX}'${hatBlk.id}'__\n`
          );
        });

        return `${fnDefs.join('\n')}`;
      }

      const dispatchGlobalLine = buildPythonGlobalLineForBlocks(
        matchingHats,
        generator,
        formalParams,
      );
      const dispatchHoistedLocals = buildPythonHoistedLocalsLine(
        matchingHats,
        'BODY',
        '  ',
      );
      const branches: string[] = [];
      matchingHats.forEach((hatBlk, idx) => {
        const kw = idx === 0 ? 'if' : 'elif';
        const cond = hatSpec.condition?.python
          ? renderHatTpl(hatSpec.condition.python, hatBlk)
          : this.dialect.boolTrue;
        const comment = hatSpec.branchComment?.python
          ? renderHatTpl(hatSpec.branchComment.python, hatBlk)
          : '';
        const rawBody = generator.statementToCode(hatBlk, 'BODY');
        const indentedBody = rawBody.trim()
          ? indentLines(rawBody, '  ')
          : '    pass\n';
        if (codegenContext.debugPass) {
          branches.push(`  ${kw} ${cond}:${comment}\n${indentedBody}`);
        } else {
          branches.push(
            `${SENTINEL_START_PREFIX}'${hatBlk.id}'__\n` +
              `  ${kw} ${cond}:${comment}\n` +
              `${indentedBody}` +
              `${SENTINEL_END_PREFIX}'${hatBlk.id}'__\n`,
          );
        }
      });

      return `${defKw} ${hatSpec.eventName}(${paramsStr}):\n${dispatchGlobalLine}${dispatchHoistedLocals}${branches.join('')}\n`;
    };
  }

  formatSharedModuleDocument(input: SharedModuleDocumentInput): {
    source: string;
    debugSource: string;
  } {
    const varLines = input.variables.map(
      (v) =>
        `${v.attr} = ${formatInitialValueForLanguage(v.initialValue, 'python')}`,
    );
    const cleanParts: string[] = [
      `# 由 PolyBlock 自动生成的同句柄跨文件共享模块（只读）`,
    ];
    if (input.importLines.length > 0) cleanParts.push(input.importLines.join('\n'));
    if (varLines.length > 0) cleanParts.push(varLines.join('\n'));
    if (input.cleanFnBlocks.length > 0) {
      cleanParts.push(input.cleanFnBlocks.join('\n\n'));
    }
    const source = `${cleanParts.join('\n\n')}\n`;

    const snapEntries = input.variables.map((v) => [v.name, v.attr]);
    const debugParts: string[] = [
      `import sys, json`,
      ...(input.debugFnBlocks.length > 0
        ? [
            `from _poly_rt import _poly_tick, _poly_yield_check, sleep_ms, _poly_call_mod`,
          ]
        : []),
      ...input.importLines,
      `_POLY_VAR_MAP = ${JSON.stringify(snapEntries)}`,
      `def _poly_snap(_loc, _glb):`,
      `  _out = {}`,
      `  for _label, _ident in _POLY_VAR_MAP:`,
      `    if _ident in _loc:`,
      `      _v = _loc[_ident]`,
      `    elif _ident in _glb:`,
      `      _v = _glb[_ident]`,
      `    else:`,
      `      continue`,
      `    try:`,
      `      _out[_label] = repr(_v)`,
      `    except Exception:`,
      `      _out[_label] = str(_v)`,
      `  return json.dumps(_out)`,
    ];
    if (varLines.length > 0) debugParts.push('', ...varLines);
    if (input.debugFnBlocks.length > 0) {
      debugParts.push('', ...input.debugFnBlocks);
    }
    const debugSource = `${debugParts.join('\n')}\n`;

    return { source, debugSource };
  }
}
