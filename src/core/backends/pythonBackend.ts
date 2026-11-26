import * as Blockly from 'blockly';
import { Order, pythonGenerator } from 'blockly/python';
import {
  buildPythonGlobalLineForBlocks,
  codegenContext,
  formatPythonVarRef,
  resetCodegenPassContext,
} from './codegenContext';
import {
  buildEntryDispatchRouters,
  hasExternalKeepAliveHat,
  isEventDrivenWorkspace,
  resolveHandleSharedPythonVars,
} from './eventMode';
import {
  getActiveHandleScriptId,
  getActiveHandleScripts,
} from '../blocks/timerConfigBridge';
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
import type { GeneratedCodeResult, ScriptBackendAdapter } from './types';

let pythonGeneratorsRegistered = false;
let pySharedFnRequiredScripts = new Set<string>();

function getCurrentPyScriptName(): string {
  const curId = getActiveHandleScriptId();
  if (!curId) return '';
  return getActiveHandleScripts().find((s) => s.id === curId)?.name ?? '';
}

function collectManualPyRequireScripts(workspace: Blockly.Workspace): Set<string> {
  const out = new Set<string>();
  for (const blk of workspace.getAllBlocks(false)) {
    if (blk.isShadow() || !blk.isEnabled()) continue;
    if (blk.type === 'poly_require_script') {
      const name = String(blk.getFieldValue('SCRIPT') || '').trim();
      if (name) out.add(name);
    }
  }
  return out;
}

function registerPythonBlockGenerators(): void {
  if (pythonGeneratorsRegistered) return;

  // Wrap Blockly's pythonGenerator.init so:
  // 1) Cross-file shared variables are NOT re-declared as `<var> = None` and add `import shared`
  // 2) Unused handle-synced variables in this script do NOT pollute top-level with redundant `<var> = None`
  const origInit = pythonGenerator.init.bind(pythonGenerator);
  pythonGenerator.init = (workspace: Blockly.Workspace) => {
    origInit(workspace);
    const sharedMod = codegenContext.pythonSharedModuleName;
    const sharedIdents = codegenContext.pythonSharedVarIdents;
    const usedIdents = codegenContext.pythonUsedVarIdents;
    const defs = (
      pythonGenerator as unknown as { definitions_: Record<string, string> }
    ).definitions_;
    if (
      typeof defs.variables === 'string' &&
      (sharedIdents.size > 0 || usedIdents !== null)
    ) {
      const kept = defs.variables.split('\n').filter((line) => {
        const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*None$/);
        if (!m) return Boolean(line.trim());
        const ident = m[1];
        if (sharedIdents.has(ident)) return false;
        if (usedIdents !== null && !usedIdents.has(ident)) return false;
        return true;
      });
      if (kept.length > 0) {
        defs.variables = kept.join('\n');
      } else {
        delete defs.variables;
      }
    }
    if (sharedMod && sharedIdents.size > 0) {
      defs['import_poly_shared'] = `import ${sharedMod}`;
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

  const origTextAppend = pythonGenerator.forBlock['text_append'];
  if (origTextAppend) {
    pythonGenerator.forBlock['text_append'] = (block, generator) => {
      const varId = String(block.getFieldValue('VAR') || '');
      const ref = formatPythonVarRef(varId, generator, block);
      const ident = generator.getVariableName(varId);
      if (ref === ident) return origTextAppend(block, generator);
      const val = generator.valueToCode(block, 'TEXT', Order.NONE) || "''";
      return `${ref} = str(${ref}) + str(${val})\n`;
    };
  }

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

  pythonGenerator.forBlock['poly_on_start'] = (block, generator) => {
    const body = generator.statementToCode(block, 'BODY');
    const defKw = codegenContext.debugPass ? 'async def' : 'def';
    const globalLine = buildPythonGlobalLineForBlocks([block], generator);
    const safeBody = body.trim() ? body : '  pass\n';
    if (codegenContext.debugPass) {
      return `${defKw} on_start():\n${globalLine}${safeBody}\n`;
    }
    return (
      `${SENTINEL_START_PREFIX}'${block.id}'__\n` +
      `${defKw} on_start():\n` +
      `${globalLine}${safeBody}` +
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

  pythonGenerator.forBlock['poly_clear_log'] = () => {
    if (codegenContext.debugPass) {
      return `print("__POLYBLOCK_CLEAR__")\n`;
    }
    return `# 清空控制台（仅 PolyBlock 沙箱调试生效）\n`;
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

  pythonGenerator.forBlock['poly_wait_ms'] = (block, generator) => {
    const ms = generator.valueToCode(block, 'MS', Order.NONE) || '0';
    if (codegenContext.debugPass) {
      return `await _poly_sleep_ms(${ms})\n`;
    }
    // Unified coroutine ABI with Lua: `sleep_ms(ms)` is provided by the host runtime inside `on_start`
    return `sleep_ms(${ms})\n`;
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

  pythonGenerator.forBlock['poly_list_append'] = (block, generator) => {
    const listVar = formatPythonVarRef(
      String(block.getFieldValue('LIST') || ''),
      generator,
      block,
    );
    const item = generator.valueToCode(block, 'ITEM', Order.NONE) || 'None';
    return `${listVar}.append(${item})\n`;
  };

  // Override built-in math_change so it avoids `from numbers import Number`
  // which is absent in MicroPython WASM while remaining 100% valid in CPython.
  pythonGenerator.forBlock['math_change'] = (block, generator) => {
    const delta = generator.valueToCode(block, 'DELTA', Order.ADDITIVE) || '0';
    const varName = formatPythonVarRef(
      String(block.getFieldValue('VAR') || ''),
      generator,
      block,
    );
    return `${varName} = (${varName} if isinstance(${varName}, (int, float)) else 0) + ${delta}\n`;
  };

  // Wrap built-in procedure calls/defs so breakpoints & async delays work inside custom functions
  // during sandbox debug pass while keeping clean export 100% synchronous standard Python.
  const origDefNoReturn = pythonGenerator.forBlock['procedures_defnoreturn'];
  const origDefReturn = pythonGenerator.forBlock['procedures_defreturn'];
  const origCallNoReturn = pythonGenerator.forBlock['procedures_callnoreturn'];
  const origCallReturn = pythonGenerator.forBlock['procedures_callreturn'];

  if (origDefReturn) {
    const wrapDef = (orig: typeof origDefReturn) => (
      block: Blockly.Block,
      generator: typeof pythonGenerator,
    ) => {
      const out = orig(block, generator);
      const defs = (
        generator as unknown as { definitions_: Record<string, string> }
      ).definitions_;
      const sharedIdents = codegenContext.pythonSharedVarIdents;
      for (const key of Object.keys(defs)) {
        if (!key.startsWith('%')) continue;
        if (sharedIdents.size > 0) {
          defs[key] = defs[key].replace(
            /^([ \t]+)global ([^\n]+)\n/gm,
            (_m, indent: string, list: string) => {
              const kept = list
                .split(',')
                .map((s) => s.trim())
                .filter((name) => name && !sharedIdents.has(name));
              return kept.length > 0 ? `${indent}global ${kept.join(', ')}\n` : '';
            },
          );
        }
        if (
          codegenContext.debugPass &&
          (defs[key].startsWith('def ') || defs[key].includes('\ndef '))
        ) {
          defs[key] = defs[key].replace(/(^|\n)def /g, '$1async def ');
        }
      }
      return out;
    };
    pythonGenerator.forBlock['procedures_defreturn'] = wrapDef(origDefReturn);
    if (origDefNoReturn) {
      pythonGenerator.forBlock['procedures_defnoreturn'] = wrapDef(origDefNoReturn);
    }
  }

  if (origCallNoReturn) {
    pythonGenerator.forBlock['procedures_callnoreturn'] = (block, generator) => {
      const out = origCallNoReturn(block, generator);
      if (codegenContext.debugPass && typeof out === 'string' && out.trim()) {
        return `await ${out}`;
      }
      return out;
    };
  }

  if (origCallReturn) {
    pythonGenerator.forBlock['procedures_callreturn'] = (block, generator) => {
      const out = origCallReturn(block, generator);
      if (codegenContext.debugPass && Array.isArray(out)) {
        return [`(await ${out[0]})`, Order.ATOMIC];
      }
      return out;
    };
  }

  const emitPySharedFnCall = (
    block: Blockly.Block,
    generator: typeof pythonGenerator,
    asExpr: boolean,
  ): string => {
    const meta = (
      block as Blockly.Block & {
        sharedFnMeta_?: { scriptName: string; fnName: string; params: string[] };
      }
    ).sharedFnMeta_ ?? { scriptName: 'utils', fnName: 'my_func', params: [] };
    const curScriptName = getCurrentPyScriptName();
    const fnIdent = generator.getProcedureName(meta.fnName);
    const args = meta.params.map(
      (_p, idx) => generator.valueToCode(block, `ARG${idx}`, Order.NONE) || 'None',
    );
    const argsStr = args.join(', ');
    if (!meta.scriptName || meta.scriptName === curScriptName) {
      if (codegenContext.debugPass) {
        return asExpr
          ? `(await ${fnIdent}(${argsStr}))`
          : `await ${fnIdent}(${argsStr})`;
      }
      return `${fnIdent}(${argsStr})`;
    }
    pySharedFnRequiredScripts.add(meta.scriptName);
    const pyMod = sanitizeLocalIdent(meta.scriptName);
    if (codegenContext.debugPass) {
      const callArgs = argsStr
        ? `${JSON.stringify(pyMod)}, ${JSON.stringify(fnIdent)}, ${argsStr}`
        : `${JSON.stringify(pyMod)}, ${JSON.stringify(fnIdent)}`;
      return asExpr
        ? `(await _poly_call_mod(${callArgs}))`
        : `await _poly_call_mod(${callArgs})`;
    }
    return `${pyMod}.${fnIdent}(${argsStr})`;
  };

  pythonGenerator.forBlock['poly_call_shared_noreturn'] = (block, generator) => {
    return `${emitPySharedFnCall(block, generator, false)}\n`;
  };

  pythonGenerator.forBlock['poly_call_shared_return'] = (block, generator) => {
    return [
      emitPySharedFnCall(block, generator, true),
      codegenContext.debugPass ? Order.ATOMIC : Order.FUNCTION_CALL,
    ];
  };

  pythonGeneratorsRegistered = true;
}

function buildPythonEventLoopDriver(keepAliveExternal: boolean): string {
  return `
_POLY_EVENT_MODE = True
_has_start = 'on_start' in globals() and callable(on_start)
_has_run = 'on_run' in globals() and callable(on_run)
_has_timer = 'on_timer' in globals() and callable(on_timer)
_has_ext = ${keepAliveExternal ? 'True' : "'on_button' in globals() and callable(on_button)"}

async def _poly_start_runner():
  global _POLY_IN_START, _POLY_SLICE_START, _POLY_START_ERR
  try:
    _keep = await _poly.wait_start_turn()
    if not _keep:
      return
    _POLY_IN_START = True
    _POLY_SLICE_START = _poly.now_ms()
    await on_start()
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
    _has_ext or ('on_button' in globals() and callable(on_button))
  )

_start_task = asyncio.create_task(_poly_start_runner()) if _has_start else None
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
    elif isinstance(_ev, str) and _ev.startswith('button:'):
      _parts = _ev.split(':')
      if 'on_button' in globals() and callable(on_button) and len(_parts) == 3:
        await _poly_call_cb('on_button', on_button, _parts[1], _parts[2] == '1')
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
if _start_task is not None and not _start_task.done():
  _poly.co_done()
  try:
    _start_task.cancel()
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
    '标准 Python 3 脚本生成器，支持干净导出（含顶层零闭包事件回调 ABI）与沙箱异步事件调试。';

  generate(workspace: Blockly.Workspace): GeneratedCodeResult {
    registerPythonBlockGenerators();

    const prevPrefix = pythonGenerator.STATEMENT_PREFIX;
    const prevSuffix = pythonGenerator.STATEMENT_SUFFIX;
    const eventDriven = isEventDrivenWorkspace(workspace);
    const keepAliveExternal = hasExternalKeepAliveHat(workspace);

    // --- Pass 1: Clean display/export/board-download code + SourceMap ---
    pythonGenerator.STATEMENT_PREFIX = `${SENTINEL_START_PREFIX}%1__\n`;
    pythonGenerator.STATEMENT_SUFFIX = `${SENTINEL_END_PREFIX}%1__\n`;

    let rawClean = '';
    const varEntries: Array<[string, string]> = [];
    const varIdToIdent = new Map<string, string>();
    const sharedInfo = resolveHandleSharedPythonVars(
      getActiveHandleScripts(),
      workspace,
    );
    const sharedAttrByName = new Map(
      sharedInfo.entries.map((e) => [e.name, e.attr]),
    );
    const sharedVarIdToAttr = new Map<string, string>();
    const sharedVarIdents = new Set<string>();
    const sharedSnapEntries: Array<[string, string]> = [];
    const nonSharedVarIdents: string[] = [];
    const usedVarIdents = new Set<string>();

    const manualRequires = collectManualPyRequireScripts(workspace);
    try {
      resetCodegenPassContext({
        debugPass: false,
        eventDrivenMode: eventDriven,
      });
      pySharedFnRequiredScripts = new Set();
      pythonGenerator.init(workspace);
      const usedVarIds = new Set<string>();
      for (const blk of workspace.getAllBlocks(false)) {
        if (blk.isShadow() || !blk.isEnabled()) continue;
        for (const fName of ['VAR', 'LIST']) {
          if (!blk.getField(fName)) continue;
          const vId = blk.getFieldValue(fName);
          if (vId) usedVarIds.add(String(vId));
        }
        for (const inp of blk.inputList) {
          for (const field of inp.fieldRow) {
            if (field instanceof Blockly.FieldVariable) {
              const vId = field.getValue();
              if (vId) usedVarIds.add(String(vId));
            }
          }
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
      const activeSharedModName =
        sharedVarIdToAttr.size > 0 ? sharedInfo.moduleName : '';
      resetCodegenPassContext({
        debugPass: false,
        eventDrivenMode: eventDriven,
        pythonGlobalVarIdents: nonSharedVarIdents,
        pythonSharedModuleName: activeSharedModName,
        pythonSharedVarIdToAttr: sharedVarIdToAttr,
        pythonSharedVarIdents: sharedVarIdents,
        pythonUsedVarIdents: usedVarIdents,
      });
      rawClean = pythonGenerator.workspaceToCode(workspace);
    } finally {
      pythonGenerator.STATEMENT_PREFIX = prevPrefix;
      pythonGenerator.STATEMENT_SUFFIX = prevSuffix;
    }

    const { scopes: variableScopes, allLocalEntries } = analyzeWorkspaceScopes(
      workspace,
      varIdToIdent,
    );

    const cleanRouter = buildEntryDispatchRouters(workspace, 'python', false);
    const cleanAutoImports = [...cleanRouter.autoImports];
    for (const sName of pySharedFnRequiredScripts) {
      if (manualRequires.has(sName)) continue;
      const imp = `import ${sanitizeLocalIdent(sName)}`;
      if (!cleanAutoImports.includes(imp)) cleanAutoImports.push(imp);
    }
    const cleanPrepend = cleanAutoImports
      .filter((imp) => !rawClean.includes(imp))
      .join('\n');
    const mergedCleanBody = [
      cleanPrepend,
      rawClean.trim(),
      cleanRouter.routerCode.trim(),
    ]
      .filter(Boolean)
      .join('\n\n');

    const header = eventDriven
      ? `# 由 PolyBlock 自动生成 (Target: Python 3 · Event-Driven ABI)\n`
      : `# 由 PolyBlock 自动生成 (Target: Python 3)\n`;
    const combinedClean = mergedCleanBody
      ? `${header}${mergedCleanBody}\n`
      : `${header}# 请从左侧拖入积木开始编排`;
    const { code, sourceMap, lineToBlock } = extractSourceMap(combinedClean);

    // --- Pass 2: Instrumented async sandbox debug code ---
    let debugBody = '';
    const activeSharedModName =
      sharedVarIdToAttr.size > 0 ? sharedInfo.moduleName : '';
    try {
      resetCodegenPassContext({
        debugPass: true,
        eventDrivenMode: eventDriven,
        pythonGlobalVarIdents: nonSharedVarIdents,
        pythonSharedModuleName: activeSharedModName,
        pythonSharedVarIdToAttr: sharedVarIdToAttr,
        pythonSharedVarIdents: sharedVarIdents,
        pythonUsedVarIdents: usedVarIdents,
      });
      pySharedFnRequiredScripts = new Set();
      pythonGenerator.STATEMENT_PREFIX = `await _poly_tick(%1, _poly_snap(locals(), globals()))\n`;
      pythonGenerator.STATEMENT_SUFFIX = null;
      debugBody = pythonGenerator.workspaceToCode(workspace);
    } finally {
      resetCodegenPassContext({
        debugPass: false,
        eventDrivenMode: false,
        pythonGlobalVarIdents: [],
        pythonSharedModuleName: '',
        pythonSharedVarIdToAttr: new Map(),
        pythonSharedVarIdents: new Set(),
        pythonUsedVarIdents: null,
      });
      pythonGenerator.STATEMENT_PREFIX = prevPrefix;
      pythonGenerator.STATEMENT_SUFFIX = prevSuffix;
    }

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
      `_POLY_EVENT_MODE = False`,
      `_POLY_IN_START = False`,
      `_POLY_ACTIVE_CB = ''`,
      `_POLY_SLICE_START = 0.0`,
      `_POLY_START_ERR = None`,
      `class _PolyStopStart(Exception):`,
      `  pass`,
      `class _PolyStopCb(Exception):`,
      `  pass`,
      `async def _poly_sleep_ms(_ms):`,
      `  global _POLY_IN_START, _POLY_SLICE_START`,
      `  if _poly.is_in_callback():`,
      `    raise RuntimeError("禁止在事件回调（on_run / on_timer / on_button / on_stop）中调用等待 (sleep)；实板同步回调不可阻塞，请移至「当程序启动」协程或改用定时器。")`,
      `  if _POLY_EVENT_MODE and _POLY_IN_START:`,
      `    _POLY_IN_START = False`,
      `    _poly.co_sleep(_ms)`,
      `    _keep = await _poly.wait_start_turn()`,
      `    if not _keep:`,
      `      raise _PolyStopStart()`,
      `    _POLY_IN_START = True`,
      `    _POLY_SLICE_START = _poly.now_ms()`,
      `    return`,
      `  await _poly.sleep(_ms)`,
      `async def _poly_tick(_bid, _snap):`,
      `  global _POLY_IN_START, _POLY_SLICE_START`,
      `  if _POLY_EVENT_MODE and _POLY_IN_START and not _poly.is_in_callback():`,
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
      `  if _POLY_EVENT_MODE and _POLY_IN_START and not _poly.is_in_callback():`,
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
      `_poly_rt_mod._poly_sleep_ms = _poly_sleep_ms`,
      `_poly_rt_mod._poly_call_mod = _poly_call_mod`,
      `_poly_rt_mod._PolyStopStart = _PolyStopStart`,
      `_poly_rt_mod._PolyStopCb = _PolyStopCb`,
      `sys.modules['_poly_rt'] = _poly_rt_mod`,
      ...snapHelperLines,
      ``,
    ].join('\n');

    const companionDebugPrelude = [
      `import sys, json`,
      `from _poly_rt import _poly_tick, _poly_yield_check, _poly_sleep_ms, _poly_call_mod`,
      `_POLY_VAR_MAP = ${JSON.stringify(snapVarEntries)}`,
      `_POLY_SHARED_MOD = ${JSON.stringify(activeSharedModName)}`,
      `_POLY_SHARED_MAP = ${JSON.stringify(sharedSnapEntries)}`,
      ...snapHelperLines,
      ``,
    ].join('\n');

    const debugRouter = buildEntryDispatchRouters(workspace, 'python', true);
    const debugAutoImports = [...debugRouter.autoImports];
    for (const sName of pySharedFnRequiredScripts) {
      if (manualRequires.has(sName)) continue;
      const imp = `import ${sanitizeLocalIdent(sName)}`;
      if (!debugAutoImports.includes(imp)) debugAutoImports.push(imp);
    }
    const debugPrepend = debugAutoImports
      .filter((imp) => !debugBody.includes(imp))
      .join('\n');
    const fullDebugBody = [
      debugPrepend,
      debugBody.trim(),
      debugRouter.routerCode.trim(),
    ]
      .filter(Boolean)
      .join('\n\n');

    // Companion Python modules are loaded via synchronous `import <mod>`, where module-level
    // (column-0) `await` is a SyntaxError; strip column-0 `_poly_tick` lines while preserving
    // all indented `await` instrumentation inside `async def` callbacks and functions!
    const companionDebugBody = fullDebugBody
      .split('\n')
      .filter((line) => !/^await _poly_tick\(/.test(line))
      .join('\n');

    const driver = eventDriven
      ? buildPythonEventLoopDriver(keepAliveExternal)
      : `if 'on_start' in globals() and callable(on_start):\n  await on_start()\n`;
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
  }
}
