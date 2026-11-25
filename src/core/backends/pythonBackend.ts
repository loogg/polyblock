import * as Blockly from 'blockly';
import { Order, pythonGenerator } from 'blockly/python';
import {
  codegenContext,
  resetCodegenPassContext,
} from './codegenContext';
import {
  hasExternalKeepAliveHat,
  isEventDrivenWorkspace,
} from './eventMode';
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

function getPythonGlobalLine(): string {
  if (codegenContext.pythonGlobalVarIdents.length === 0) return '';
  return `  global ${codegenContext.pythonGlobalVarIdents.join(', ')}\n`;
}

function registerPythonBlockGenerators(): void {
  if (pythonGeneratorsRegistered) return;

  pythonGenerator.forBlock['poly_on_start'] = (block, generator) => {
    const body = generator.statementToCode(block, 'BODY');
    if (codegenContext.eventDrivenMode) {
      const defKw = codegenContext.debugPass ? 'async def' : 'def';
      const globalLine = getPythonGlobalLine();
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
    }

    const dedented = body.replace(/^  /gm, '');
    if (codegenContext.debugPass) {
      return `# 当程序启动\n${dedented}`;
    }
    return (
      `${SENTINEL_START_PREFIX}'${block.id}'__\n` +
      `# 当程序启动\n` +
      `${dedented}` +
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
    return `print("__POLYBLOCK_CLEAR__")\n`;
  };

  pythonGenerator.forBlock['poly_repeat_times'] = (block, generator) => {
    const times = generator.valueToCode(block, 'TIMES', Order.NONE) || '0';
    const branch = generator.statementToCode(block, 'DO') || generator.PASS;
    return `for _count in range(int(${times})):\n${branch}`;
  };

  pythonGenerator.forBlock['poly_for_range'] = (block, generator) => {
    const variableName = generator.getVariableName(block.getFieldValue('VAR'));
    const from = generator.valueToCode(block, 'FROM', Order.NONE) || '1';
    const to = generator.valueToCode(block, 'TO', Order.NONE) || '1';
    const by = generator.valueToCode(block, 'BY', Order.NONE) || '1';
    const branch = generator.statementToCode(block, 'DO') || generator.PASS;

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
      return `await _poly.sleep(${ms})\n`;
    }
    (generator as unknown as { definitions_: Record<string, string> }).definitions_['import_time'] =
      'import time';
    const msNum = Number(ms.trim());
    if (!Number.isNaN(msNum) && Number.isFinite(msNum)) {
      const secs = Number((msNum / 1000).toFixed(4));
      return `time.sleep(${secs})\n`;
    }
    return `time.sleep((${ms}) / 1000)\n`;
  };

  pythonGenerator.forBlock['poly_comment'] = (block) => {
    const text = (block.getFieldValue('TEXT') || '').replace(/\r?\n/g, ' ');
    return `# ${text}\n`;
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
    const listVar = generator.getVariableName(block.getFieldValue('LIST'));
    const item = generator.valueToCode(block, 'ITEM', Order.NONE) || 'None';
    return `${listVar}.append(${item})\n`;
  };

  // Override built-in math_change so it avoids `from numbers import Number`
  // which is absent in MicroPython WASM while remaining 100% valid in CPython.
  pythonGenerator.forBlock['math_change'] = (block, generator) => {
    const delta = generator.valueToCode(block, 'DELTA', Order.ADDITIVE) || '0';
    const varName = generator.getVariableName(block.getFieldValue('VAR'));
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
      if (codegenContext.debugPass) {
        const defs = (
          generator as unknown as { definitions_: Record<string, string> }
        ).definitions_;
        for (const key of Object.keys(defs)) {
          if (defs[key].startsWith('def ') || defs[key].includes('\ndef ')) {
            defs[key] = defs[key].replace(/(^|\n)def /g, '$1async def ');
          }
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

  pythonGeneratorsRegistered = true;
}

function buildPythonEventLoopDriver(keepAliveExternal: boolean): string {
  return `
if 'on_start' in globals() and callable(on_start):
  await on_start()
if _poly.should_loop('on_run' in globals(), 'on_timer' in globals(), ${keepAliveExternal ? 'True' : "'on_button' in globals()"}):
  while True:
    _ev = await _poly.next_event()
    if _ev == 'run':
      if 'on_run' in globals() and callable(on_run):
        await on_run()
    elif isinstance(_ev, str) and _ev.startswith('timer:'):
      if 'on_timer' in globals() and callable(on_timer):
        await on_timer(int(_ev[6:]))
    elif isinstance(_ev, str) and _ev.startswith('button:'):
      _parts = _ev.split(':')
      if 'on_button' in globals() and callable(on_button) and len(_parts) == 3:
        await on_button(_parts[1], _parts[2] == '1')
    elif isinstance(_ev, str) and _ev.startswith('event:'):
      _epayload = json.loads(_ev[6:])
      _ename = _epayload[0]
      _eargs = _epayload[1] if len(_epayload) > 1 else []
      _efn = globals().get(_ename)
      if callable(_efn):
        await _efn(*_eargs)
    else:
      break
if 'on_stop' in globals() and callable(on_stop):
  await on_stop()
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
    try {
      pythonGenerator.init(workspace);
      for (const v of workspace.getVariableMap().getAllVariables()) {
        const ident = pythonGenerator.getVariableName(v.getId());
        varEntries.push([v.getName(), ident]);
        varIdToIdent.set(v.getId(), ident);
      }
      resetCodegenPassContext({
        debugPass: false,
        eventDrivenMode: eventDriven,
        pythonGlobalVarIdents: varEntries.map(([, ident]) => ident),
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

    const header = eventDriven
      ? `# 由 PolyBlock 自动生成 (Target: Python 3 · Event-Driven ABI)\n`
      : `# 由 PolyBlock 自动生成 (Target: Python 3)\n`;
    const combinedClean = rawClean.trim()
      ? `${header}${rawClean}`
      : `${header}# 请从左侧拖入积木开始编排`;
    const { code, sourceMap, lineToBlock } = extractSourceMap(combinedClean);

    // --- Pass 2: Instrumented async sandbox debug code ---
    let debugBody = '';
    try {
      resetCodegenPassContext({
        debugPass: true,
        eventDrivenMode: eventDriven,
        pythonGlobalVarIdents: varEntries.map(([, ident]) => ident),
      });
      pythonGenerator.STATEMENT_PREFIX = `await _poly.step(%1, _poly_snap(locals(), globals()))\n`;
      pythonGenerator.STATEMENT_SUFFIX = null;
      debugBody = pythonGenerator.workspaceToCode(workspace);
    } finally {
      resetCodegenPassContext({
        debugPass: false,
        eventDrivenMode: false,
        pythonGlobalVarIdents: [],
      });
      pythonGenerator.STATEMENT_PREFIX = prevPrefix;
      pythonGenerator.STATEMENT_SUFFIX = prevSuffix;
    }

    const snapVarEntries: Array<[string, string]> = [...varEntries];
    const seenPyLabels = new Set(varEntries.map(([label]) => label));
    for (const loc of allLocalEntries) {
      if (!seenPyLabels.has(loc.label)) {
        seenPyLabels.add(loc.label);
        snapVarEntries.push([loc.label, loc.ident]);
      }
    }

    const debugPrelude = [
      `import _poly, json`,
      `_POLY_VAR_MAP = ${JSON.stringify(snapVarEntries)}`,
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
      ``,
    ].join('\n');

    const driver = eventDriven ? buildPythonEventLoopDriver(keepAliveExternal) : '';
    const debugCode = debugBody.trim()
      ? `${debugPrelude}${debugBody}\n${driver}\n_poly.final_snap(_poly_snap(locals(), globals()))\n`
      : '';

    return {
      language: this.id,
      code,
      debugCode,
      sourceMap,
      lineToBlock,
      diagnostics: analyzeWorkspaceDiagnostics(workspace),
      blockCount: workspace
        .getAllBlocks(false)
        .filter((b) => !b.isShadow()).length,
      variableNames: varEntries.map(([label]) => label),
      variableScopes,
      isEventDriven: eventDriven,
    };
  }
}
