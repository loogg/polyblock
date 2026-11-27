import * as Blockly from 'blockly';
import { Order, pythonGenerator } from 'blockly/python';
import {
  buildPythonGlobalLineForBlocks,
  buildPythonHoistedLocalsLine,
  codegenContext,
  computeAsyncFunctionNames,
  formatPythonVarRef,
  resetCodegenPassContext,
} from './codegenContext';
import {
  buildEntryDispatchRouters,
  hasExternalKeepAliveHat,
  isEventDrivenWorkspace,
  resolveHandleSharedInfo,
} from './eventMode';
import {
  getActiveHandleScripts,
  getActiveHandleSharedFunctions,
  getActiveScriptVarInitials,
  withCompileContext,
} from '../blocks/workspaceContextBridge';
import { formatInitialValuePython } from '../projects/handleVariables';
import {
  analyzeWorkspaceScopes,
  sanitizeLocalIdent,
} from './scopeAnalysis';
import {
  analyzeWorkspaceDiagnostics,
  extractSourceMap,
  SENTINEL_END_PREFIX,
  SENTINEL_START_PREFIX,
} from './sourceMap';
import {
  LANGUAGE_DIALECTS,
  type CompileContext,
  type EntryDispatchBranchSpec,
  type GeneratedCodeResult,
  type ScriptBackendAdapter,
} from './types';

let pythonGeneratorsRegistered = false;

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
    const sharedIdents = codegenContext.pythonSharedVarIdents;
    const usedIdents = codegenContext.pythonUsedVarIdents;
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
        kept.push(`${ident} = ${formatInitialValuePython(scriptInitials[varName])}`);
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
    const raw = String(block.getFieldValue('SCRIPT') || 'timers').trim() || 'timers';
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
            codegenContext.pythonAsyncFnNames.has(rawName);
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
    const isAsyncClean = codegenContext.pythonAsyncFnNames.has(rawName);
    if (isShared && !codegenContext.compilingSharedModule) {
      const modName = codegenContext.pythonSharedModuleName || 'shared';
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
      codegenContext.debugPass || codegenContext.pythonAsyncFnNames.has(rawName);
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
      Boolean(meta?.fnName && codegenContext.pythonAsyncFnNames.has(meta.fnName));
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

export class PythonBackendAdapter implements ScriptBackendAdapter {
  readonly id = 'python' as const;
  readonly name = 'Python';
  readonly version = '3';
  readonly extension = 'py';
  readonly fileName = 'main.py';
  readonly accentColor = '#f59e0b';
  readonly description =
    '标准 Python 3 脚本生成器，支持 Style A1 只读 shared 模块、单线程 async 协程 ABI 与伴生脚本断点调试。';
  readonly dialect = LANGUAGE_DIALECTS.python;

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

  generate(
    workspace: Blockly.Workspace,
    context?: CompileContext,
  ): GeneratedCodeResult {
    return withCompileContext(context, () => {
    registerPythonBlockGenerators();

    const prevPrefix = pythonGenerator.STATEMENT_PREFIX;
    const prevSuffix = pythonGenerator.STATEMENT_SUFFIX;
    const eventDriven = isEventDrivenWorkspace(workspace);
    const keepAliveExternal = hasExternalKeepAliveHat(workspace);

    // --- Pass 1: Clean display/export/board-download code + SourceMap ---
    pythonGenerator.STATEMENT_PREFIX = `${SENTINEL_START_PREFIX}%1__\n`;
    pythonGenerator.STATEMENT_SUFFIX = `${SENTINEL_END_PREFIX}%1__\n`;

    const handleScripts = getActiveHandleScripts();
    const sharedInfo = resolveHandleSharedInfo(handleScripts);
    const sharedAttrByName = new Map(
      sharedInfo.entries.map((e) => [e.name, e.attr]),
    );
    const sharedFnSet = new Set(getActiveHandleSharedFunctions() ?? []);
    const externalAsyncSharedFns = new Set<string>();
    for (const s of handleScripts) {
      for (const fn of s.declaredFunctions ?? []) {
        if (fn.usesSleep) externalAsyncSharedFns.add(fn.name);
      }
    }
    const asyncFnNames = computeAsyncFunctionNames(
      workspace,
      externalAsyncSharedFns,
    );

    let rawClean = '';
    let usedSharedClean = false;
    const varEntries: Array<[string, string]> = [];
    const varIdToIdent = new Map<string, string>();
    const sharedVarIdToAttr = new Map<string, string>();
    const sharedVarIdents = new Set<string>();
    const sharedSnapEntries: Array<[string, string]> = [];
    const nonSharedVarIdents: string[] = [];
    const usedVarIdents = new Set<string>();

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

    try {
      resetCodegenPassContext({ debugPass: false });
      pythonGenerator.init(workspace);
      const usedVarIds = new Set<string>();
      for (const blk of workspace.getAllBlocks(false)) {
        if (blk.isShadow() || !blk.isEnabled()) continue;
        if (isInsideSharedFunction(blk)) continue;
        if (blk.getField('VAR')) {
          const vId = blk.getFieldValue('VAR');
          if (vId) usedVarIds.add(String(vId));
        }
      }
      for (const v of workspace.getVariableMap().getAllVariables()) {
        const ident = pythonGenerator.getVariableName(v.getId());
        varEntries.push([v.getName(), ident]);
        varIdToIdent.set(v.getId(), ident);
        if (usedVarIds.has(v.getId())) {
          usedVarIdents.add(ident);
        }
        const sharedAttr = sharedAttrByName.get(v.getName());
        if (sharedAttr && sharedInfo.moduleName && usedVarIds.has(v.getId())) {
          sharedVarIdToAttr.set(v.getId(), sharedAttr);
          sharedVarIdents.add(ident);
          sharedSnapEntries.push([v.getName(), sharedAttr]);
        } else if (usedVarIds.has(v.getId())) {
          nonSharedVarIdents.push(ident);
        }
      }
      resetCodegenPassContext({
        debugPass: false,
        pythonGlobalVarIdents: nonSharedVarIdents,
        pythonSharedModuleName: sharedInfo.moduleName,
        pythonSharedVarIdToAttr: sharedVarIdToAttr,
        pythonSharedVarIdents: sharedVarIdents,
        pythonUsedVarIdents: usedVarIdents,
        pythonAsyncFnNames: asyncFnNames,
      });
      rawClean = pythonGenerator.workspaceToCode(workspace);
      usedSharedClean = codegenContext.usedSharedModule;
    } finally {
      resetCodegenPassContext({ debugPass: false });
      pythonGenerator.STATEMENT_PREFIX = prevPrefix;
      pythonGenerator.STATEMENT_SUFFIX = prevSuffix;
    }

    const { scopes: variableScopes, allLocalEntries } = analyzeWorkspaceScopes(
      workspace,
      varIdToIdent,
    );

    const cleanRouter = buildEntryDispatchRouters(workspace, this, false);
    const cleanPrependLines: string[] = [];
    if (usedSharedClean && sharedInfo.moduleName) {
      cleanPrependLines.push(`import ${sharedInfo.moduleName}`);
    }
    for (const imp of cleanRouter.autoImports) {
      if (!rawClean.includes(imp) && !cleanPrependLines.includes(imp)) {
        cleanPrependLines.push(imp);
      }
    }
    const mergedCleanBody = [
      cleanPrependLines.join('\n'),
      rawClean.trim(),
      cleanRouter.routerCode.trim(),
    ]
      .filter(Boolean)
      .join('\n\n');

    const header = eventDriven
      ? `# 由 PolyBlock 自动生成 (Target: Python 3 · Async Coroutine Event ABI)\n`
      : `# 由 PolyBlock 自动生成 (Target: Python 3 · Async Coroutine ABI)\n`;
    const combinedClean = mergedCleanBody
      ? `${header}${mergedCleanBody}\n`
      : `${header}# 请从左侧拖入积木开始编排`;
    const { code, sourceMap, lineToBlock } = extractSourceMap(combinedClean);

    // --- Pass 2: Instrumented single-track coroutine sandbox debug code ---
    let debugBody = '';
    let usedSharedDebug = false;
    try {
      resetCodegenPassContext({
        debugPass: true,
        pythonGlobalVarIdents: nonSharedVarIdents,
        pythonSharedModuleName: sharedInfo.moduleName,
        pythonSharedVarIdToAttr: sharedVarIdToAttr,
        pythonSharedVarIdents: sharedVarIdents,
        pythonUsedVarIdents: usedVarIdents,
        pythonAsyncFnNames: asyncFnNames,
      });
      pythonGenerator.STATEMENT_PREFIX = `await _poly_tick(%1, _poly_snap(locals(), globals()))\n`;
      pythonGenerator.STATEMENT_SUFFIX = null;
      debugBody = pythonGenerator.workspaceToCode(workspace);
      usedSharedDebug = codegenContext.usedSharedModule;
    } finally {
      resetCodegenPassContext({ debugPass: false });
      pythonGenerator.STATEMENT_PREFIX = prevPrefix;
      pythonGenerator.STATEMENT_SUFFIX = prevSuffix;
    }

    const activeSharedModName =
      usedSharedDebug && sharedInfo.moduleName ? sharedInfo.moduleName : '';

    const snapVarEntries: Array<[string, string]> = varEntries.filter(
      ([, ident]) => !sharedVarIdents.has(ident),
    );
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

    const debugRouter = buildEntryDispatchRouters(workspace, this, true);
    const debugPrependLines: string[] = [];
    if (usedSharedDebug && sharedInfo.moduleName) {
      debugPrependLines.push(`import ${sharedInfo.moduleName}`);
    }
    for (const imp of debugRouter.autoImports) {
      if (!debugBody.includes(imp) && !debugPrependLines.includes(imp)) {
        debugPrependLines.push(imp);
      }
    }
    const fullDebugBody = [
      debugPrependLines.join('\n'),
      debugBody.trim(),
      debugRouter.routerCode.trim(),
    ]
      .filter(Boolean)
      .join('\n\n');

    const companionDebugBody = fullDebugBody
      .split('\n')
      .filter((line) => !/^await _poly_tick\(/.test(line))
      .join('\n');

    const driver = buildPythonEventLoopDriver(keepAliveExternal);
    const debugCode = fullDebugBody
      ? `${debugPrelude}${fullDebugBody}\n${driver}\n_poly.final_snap(_poly_snap(locals(), globals()))\n`
      : '';
    const moduleDebugCode = companionDebugBody.trim()
      ? `${companionDebugPrelude}${companionDebugBody}\n`
      : '';

    return {
      language: this.id,
      code,
      debugCode,
      moduleDebugCode,
      sourceMap,
      lineToBlock,
      diagnostics: analyzeWorkspaceDiagnostics(workspace, 'python'),
      blockCount: workspace
        .getAllBlocks(false)
        .filter((b) => !b.isShadow()).length,
      variableNames: varEntries.map(([label]) => label),
      variableScopes,
      isEventDriven: eventDriven,
    };
    });
  }
}
