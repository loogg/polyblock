import * as Blockly from 'blockly';
import { luaGenerator, Order } from 'blockly/lua';
import type { VariableInitialValue } from '../../../types/project';
import { getActiveHandleSharedFunctions } from '../../../core/blocks/workspaceContextBridge';
import {
  hoistImports,
  indentLines,
  renderExtensionTemplate,
} from '../../../core/extensions/templateRenderer';
import {
  BaseScriptBackend,
  type BlocklyGeneratorLike,
  type DebugAssemblyInput,
  type DebugPassPreparation,
  type WorkspacePassAnalysis,
} from '../../../core/backends/baseBackend';
import {
  codegenContext,
  collectNestedPolyLocalIdents,
  formatSharedVarRef,
  isShadowedByEnclosingForLoop,
  isShadowedByProcedureParam,
  LOOP_SCOPED_FOR_TYPES,
  type CodegenPassContextOptions,
} from '../../../core/backends/codegenContext';
import {
  getBlockVariableFieldIds,
  resolveSharedFnIdent,
  sanitizeLocalIdent,
} from '../../../core/backends/scopeAnalysis';
import {
  SENTINEL_END_PREFIX,
  SENTINEL_START_PREFIX,
} from '../../../core/backends/sourceMap';
import {
  formatInitialValueForDialect,
  splitLibParamList,
  type EntryDispatchBranchSpec,
  type ExtensionHatRegisterContext,
  type LanguageDialect,
  type ScannedLibFunctionMeta,
  type SharedModuleDocumentInput,
  type SharedProcCompileInput,
} from '../../../core/backends/types';

function hasNonEmptyLuaReturn(body: string): boolean {
  const noComments = body.replace(/--[^\n]*/g, '');
  return /\breturn\s+(?!\s*(?:$|\n|end\b|else\b|elseif\b|until\b|;))[^\s;]/m.test(
    noComments,
  );
}

function extractLuaBody(source: string, startOffset: number): string {
  const slice = source.slice(startOffset, startOffset + 8000);
  const lines = slice.split('\n');
  let depth = 1;
  const bodyLines: string[] = [];

  for (const rawLine of lines) {
    const stripped = rawLine
      .replace(/--.*$/, '')
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');

    const tokens =
      stripped.match(/\b(?:function|if|for|while|repeat|do|end|until)\b/g) ?? [];
    let closedAtThisLine = false;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok === 'function' || tok === 'if' || tok === 'repeat') {
        depth += 1;
      } else if (tok === 'for' || tok === 'while') {
        depth += 1;
      } else if (tok === 'do') {
        const prev = i > 0 ? tokens[i - 1] : '';
        if (prev !== 'for' && prev !== 'while') {
          depth += 1;
        }
      } else if (tok === 'end' || tok === 'until') {
        depth -= 1;
        if (depth <= 0) {
          closedAtThisLine = true;
          break;
        }
      }
    }

    if (closedAtThisLine) {
      const beforeEnd = rawLine.replace(/\bend\b[\s\S]*$/, '');
      if (beforeEnd.trim()) bodyLines.push(beforeEnd);
      break;
    }
    bodyLines.push(rawLine);
  }

  return bodyLines.join('\n');
}

function scanLuaLibraryFunctionMetas(source: string): ScannedLibFunctionMeta[] {
  const normalized = source.replace(/\r\n/g, '\n');
  const results: ScannedLibFunctionMeta[] = [];
  const seen = new Set<string>();

  const localFnMeta = new Map<
    string,
    { params: string[]; inferredKind: 'statement' | 'value' }
  >();
  const localFnRe =
    /^\s*local\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/gm;
  let lm: RegExpExecArray | null;
  while ((lm = localFnRe.exec(normalized)) !== null) {
    const fnName = lm[1];
    const params = splitLibParamList(lm[2]);
    const body = extractLuaBody(normalized, lm.index + lm[0].length);
    localFnMeta.set(fnName, {
      params,
      inferredKind: hasNonEmptyLuaReturn(body) ? 'value' : 'statement',
    });
  }

  const pushCandidate = (
    funcName: string,
    params: string[],
    inferredKind: 'statement' | 'value',
  ) => {
    if (funcName.startsWith('_') || seen.has(funcName)) return;
    seen.add(funcName);
    results.push({ funcName, params, inferredKind });
  };

  const dotFnRe =
    /^\s*function\s+[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = dotFnRe.exec(normalized)) !== null) {
    const body = extractLuaBody(normalized, m.index + m[0].length);
    pushCandidate(
      m[1],
      splitLibParamList(m[2]),
      hasNonEmptyLuaReturn(body) ? 'value' : 'statement',
    );
  }

  const assignFnRe =
    /^\s*[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function\s*\(([^)]*)\)/gm;
  while ((m = assignFnRe.exec(normalized)) !== null) {
    const body = extractLuaBody(normalized, m.index + m[0].length);
    pushCandidate(
      m[1],
      splitLibParamList(m[2]),
      hasNonEmptyLuaReturn(body) ? 'value' : 'statement',
    );
  }

  const returnTableRe = /return\s*\{([\s\S]*?)\}\s*$/;
  const rtMatch = returnTableRe.exec(normalized.trim());
  if (rtMatch?.[1]) {
    const tableContent = rtMatch[1];
    const inlineEntryRe =
      /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function\s*\(([^)]*)\)([\s\S]*?)\bend\b/g;
    let im: RegExpExecArray | null;
    while ((im = inlineEntryRe.exec(tableContent)) !== null) {
      pushCandidate(
        im[1],
        splitLibParamList(im[2]),
        hasNonEmptyLuaReturn(im[3]) ? 'value' : 'statement',
      );
    }
    const refEntryRe =
      /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,|$)/gm;
    let rm: RegExpExecArray | null;
    while ((rm = refEntryRe.exec(tableContent)) !== null) {
      const exportKey = rm[1];
      const targetIdent = rm[2];
      const meta = localFnMeta.get(targetIdent);
      if (meta) {
        pushCandidate(exportKey, meta.params, meta.inferredKind);
      }
    }
  }

  return results;
}

/** Single-source-of-truth dialect metadata owned by the Lua 5.4 backend. */
export const LUA_DIALECT = {
  id: 'lua',
  displayName: 'Lua 5.4',
  shortLabel: 'Lua',
  compactLabel: 'Lua',
  extension: 'lua',
  accentGradient: 'linear-gradient(135deg, #2563eb, #4f46e5)',
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
  builtinFuncs: [
    'print', 'tostring', 'tonumber', 'pairs', 'ipairs', 'table', 'math',
    'string', 'require', 'type',
  ],
  explicitAsyncCoroutine: false,
  libBinding: {
    formatImport: (mod: string) =>
      `local ${mod.replace(/[^A-Za-z0-9_]/g, '_')} = require("${mod}")`,
    formatCall: (mod: string, fn: string, args: string[]) =>
      `${mod.replace(/[^A-Za-z0-9_]/g, '_')}.${fn}(${args.join(', ')})`,
    extractImportedModuleName: (line: string) => {
      const m = /require\s*\(\s*["']([^"']+)["']\s*\)/.exec(line);
      return m?.[1]?.trim() || null;
    },
    scanFunctions: scanLuaLibraryFunctionMetas,
  },
  extractErrorLine: (message: string) => {
    // e.g. [string "..."]:7: attempt to perform arithmetic...
    const m = /\[string[^\]]*\]:(\d+):/.exec(message) ?? /:(\d+):/.exec(message);
    return m ? Number(m[1]) : undefined;
  },
} as const satisfies LanguageDialect<'lua'>;

let luaGeneratorsRegistered = false;
let luaDeclaredLocalsByRoot = new Map<string, Set<string>>();

function getLuaScopeRootId(block: Blockly.Block): string {
  return block.getRootBlock().id;
}

function formatLuaVarRef(
  varId: string,
  generator: { getVariableName(id: string): string },
  block?: Blockly.Block,
): string {
  return formatSharedVarRef(varId, generator, block, {
    bareAttrInSharedModule: false,
    loopScopedForVars: true,
  });
}

/** Computes Lua function-top `local a, b\n` hoisting ONLY for nested `poly_local_set` variables. */
function buildLuaHoistedLocalsLine(
  rootBlocks: Blockly.Block[],
  bodyInputName = 'BODY',
  indent = '  ',
): string {
  const hoisted = collectNestedPolyLocalIdents(rootBlocks, bodyInputName, true);
  if (hoisted.length === 0) return '';
  return `${indent}local ${hoisted.join(', ')}\n`;
}

export function registerLuaBlockGenerators(): void {
  if (luaGeneratorsRegistered) return;

  luaGenerator.forBlock['variables_get'] = (block, generator) => {
    const ref = formatLuaVarRef(
      String(block.getFieldValue('VAR') || ''),
      generator,
      block,
    );
    return [ref, Order.ATOMIC];
  };

  luaGenerator.forBlock['variables_set'] = (block, generator) => {
    const ref = formatLuaVarRef(
      String(block.getFieldValue('VAR') || ''),
      generator,
      block,
    );
    const val = generator.valueToCode(block, 'VALUE', Order.NONE) || '0';
    return `${ref} = ${val}\n`;
  };

  luaGenerator.forBlock['math_change'] = (block, generator) => {
    const ref = formatLuaVarRef(
      String(block.getFieldValue('VAR') || ''),
      generator,
      block,
    );
    const delta = generator.valueToCode(block, 'DELTA', Order.ADDITIVE) || '0';
    return `${ref} = ${ref} + ${delta}\n`;
  };

  luaGenerator.forBlock['text_append'] = (block, generator) => {
    const ref = formatLuaVarRef(
      String(block.getFieldValue('VAR') || ''),
      generator,
      block,
    );
    const val = generator.valueToCode(block, 'TEXT', Order.NONE) || '""';
    return `${ref} = tostring(${ref}) .. tostring(${val})\n`;
  };

  luaGenerator.forBlock['poly_on_start'] = (block, generator) => {
    const hoistedLocals = buildLuaHoistedLocalsLine([block], 'BODY', '  ');
    const body = generator.statementToCode(block, 'BODY');
    if (codegenContext.debugPass) {
      return `function on_start()\n${hoistedLocals}${body}end\n`;
    }
    return (
      `${SENTINEL_START_PREFIX}'${block.id}'__\n` +
      `function on_start()\n` +
      `${hoistedLocals}${body}` +
      `end\n` +
      `${SENTINEL_END_PREFIX}'${block.id}'__\n`
    );
  };

  luaGenerator.forBlock['poly_print'] = (block, generator) => {
    const value = generator.valueToCode(block, 'VALUE', Order.NONE) || '""';
    return `print(${value})\n`;
  };

  luaGenerator.forBlock['poly_log'] = (block, generator) => {
    const level = block.getFieldValue('LEVEL') || 'INFO';
    const msg = generator.valueToCode(block, 'MESSAGE', Order.NONE) || '""';
    return `print("[${level}] " .. tostring(${msg}))\n`;
  };

  luaGenerator.forBlock['poly_print_kv'] = (block, generator) => {
    const rawLabel = block.getFieldValue('LABEL') || 'value';
    const label = JSON.stringify(rawLabel);
    const value = generator.valueToCode(block, 'VALUE', Order.NONE) || 'nil';
    return `print(${label} .. " = " .. tostring(${value}))\n`;
  };

  const loopNeedsLuaContinueLabel = (loopBlock: Blockly.Block): boolean => {
    for (const desc of loopBlock.getDescendants(false)) {
      if (desc.isShadow() || !desc.isEnabled() || desc === loopBlock) continue;
      if (
        desc.type === 'controls_flow_statements' &&
        desc.getFieldValue('FLOW') === 'CONTINUE'
      ) {
        const flowBlk = desc as Blockly.Block & {
          getSurroundLoop?: () => Blockly.Block | null;
        };
        if (flowBlk.getSurroundLoop?.() === loopBlock) {
          return true;
        }
      }
    }
    return false;
  };

  luaGenerator.forBlock['poly_repeat_times'] = (block, generator) => {
    const times = generator.valueToCode(block, 'TIMES', Order.NONE) || '0';
    let branch = generator.statementToCode(block, 'DO');
    if (codegenContext.debugPass && !branch.trim()) {
      branch = '  __poly_yield_check()\n';
    }
    if (loopNeedsLuaContinueLabel(block)) {
      branch += '  ::continue::\n';
    }
    return `for _count = 1, ${times} do\n${branch}end\n`;
  };

  luaGenerator.forBlock['poly_for_range'] = (block, generator) => {
    const variableName = generator.getVariableName(block.getFieldValue('VAR'));
    const from = generator.valueToCode(block, 'FROM', Order.NONE) || '1';
    const to = generator.valueToCode(block, 'TO', Order.NONE) || '1';
    const by = generator.valueToCode(block, 'BY', Order.NONE) || '1';
    let branch = generator.statementToCode(block, 'DO');
    if (codegenContext.debugPass && !branch.trim()) {
      branch = '  __poly_yield_check()\n';
    }
    if (loopNeedsLuaContinueLabel(block)) {
      branch += '  ::continue::\n';
    }
    const stepPart = by.trim() === '1' ? '' : `, ${by}`;
    return `for ${variableName} = ${from}, ${to}${stepPart} do\n${branch}end\n`;
  };

  luaGenerator.forBlock['poly_wait_ms'] = (block, generator) => {
    const ms = generator.valueToCode(block, 'MS', Order.NONE) || '0';
    return `sleep_ms(${ms})\n`;
  };

  // Ensure empty `while true do end` loops in debugPass still preempt cleanly inside `on_start` coroutine
  const origWhileUntil = luaGenerator.forBlock['controls_whileUntil'];
  if (origWhileUntil) {
    luaGenerator.forBlock['controls_whileUntil'] = (block, generator) => {
      const code = origWhileUntil(block, generator);
      if (
        codegenContext.debugPass &&
        typeof code === 'string' &&
        !block.getInputTargetBlock('DO')
      ) {
        return code.replace(/do\nend/, 'do\n  __poly_yield_check()\nend');
      }
      return code;
    };
  }

  luaGenerator.forBlock['poly_comment'] = (block) => {
    const text = (block.getFieldValue('TEXT') || '').replace(/\r?\n/g, ' ');
    return `-- ${text}\n`;
  };

  luaGenerator.forBlock['poly_require_script'] = (block) => {
    const scriptName = String(block.getFieldValue('SCRIPT') || '').trim();
    if (!scriptName) return `-- 未选择目标脚本\n`;
    return `require(${JSON.stringify(scriptName)})\n`;
  };

  luaGenerator.forBlock['poly_local_set'] = (block, generator) => {
    const rawName = String(block.getFieldValue('NAME') || 'tmp');
    const ident = sanitizeLocalIdent(rawName);
    const val = generator.valueToCode(block, 'VALUE', Order.NONE) || 'nil';
    const rootId = getLuaScopeRootId(block);
    if (codegenContext.hoistedLocalsByRoot.get(rootId)?.has(ident)) {
      return `${ident} = ${val}\n`;
    }
    let declared = luaDeclaredLocalsByRoot.get(rootId);
    if (!declared) {
      declared = new Set<string>();
      luaDeclaredLocalsByRoot.set(rootId, declared);
    }
    if (!declared.has(ident)) {
      declared.add(ident);
      return `local ${ident} = ${val}\n`;
    }
    return `${ident} = ${val}\n`;
  };

  luaGenerator.forBlock['poly_local_get'] = (block) => {
    const rawName = String(block.getFieldValue('NAME') || 'tmp');
    return [sanitizeLocalIdent(rawName), Order.ATOMIC];
  };

  luaGenerator.forBlock['poly_to_string'] = (block, generator) => {
    const value = generator.valueToCode(block, 'VALUE', Order.NONE) || '""';
    return [`tostring(${value})`, Order.HIGH];
  };

  luaGenerator.forBlock['controls_flow_statements'] = (block) => {
    return block.getFieldValue('FLOW') === 'CONTINUE'
      ? 'goto continue\n'
      : 'break\n';
  };

  // Safe Lua text_join override: wraps non-string operands with tostring(...) so joining booleans/nil never throws
  luaGenerator.forBlock['text_join'] = (block, generator) => {
    const itemCount =
      (block as Blockly.Block & { itemCount_?: number }).itemCount_ ?? 0;
    if (itemCount === 0) return ['""', Order.ATOMIC];
    const parts: string[] = [];
    for (let i = 0; i < itemCount; i++) {
      const code = generator.valueToCode(block, `ADD${i}`, Order.NONE) || '""';
      const trimmed = code.trim();
      const isStringLit =
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"));
      const isNumLit = /^-?\d+(?:\.\d+)?$/.test(trimmed);
      parts.push(isStringLit || isNumLit ? code : `tostring(${code})`);
    }
    if (parts.length === 1) return [parts[0], Order.HIGH];
    if (parts.length === 2) return [`${parts[0]} .. ${parts[1]}`, Order.CONCATENATION];
    return [`table.concat({${parts.join(', ')}})`, Order.HIGH];
  };

  luaGenerator.forBlock['poly_str_replace'] = (block, generator) => {
    const src = generator.valueToCode(block, 'SRC', Order.NONE) || '""';
    const oldStr = generator.valueToCode(block, 'OLD', Order.NONE) || '""';
    const newStr = generator.valueToCode(block, 'NEW', Order.NONE) || '""';
    return [
      `(string.gsub(tostring(${src}), (string.gsub(tostring(${oldStr}), "([%(%)%.%%%+%-%*%?%[%]%^%$])", "%%%1")), (string.gsub(tostring(${newStr}), "%%", "%%%%"))))`,
      Order.ATOMIC,
    ];
  };

  // Pure value-slot list primitives (zero hidden helper functions!)
  luaGenerator.forBlock['poly_list_append'] = (block, generator) => {
    const listCode = generator.valueToCode(block, 'LIST', Order.NONE) || '{}';
    const item = generator.valueToCode(block, 'ITEM', Order.NONE) || 'nil';
    return `table.insert(${listCode}, ${item})\n`;
  };

  luaGenerator.forBlock['poly_list_get'] = (block, generator) => {
    const listCode = generator.valueToCode(block, 'LIST', Order.HIGH) || '({})';
    const idx = generator.valueToCode(block, 'INDEX', Order.NONE) || '1';
    return [`${listCode}[${idx}]`, Order.ATOMIC];
  };

  luaGenerator.forBlock['poly_list_set'] = (block, generator) => {
    const listCode = generator.valueToCode(block, 'LIST', Order.HIGH) || '({})';
    const idx = generator.valueToCode(block, 'INDEX', Order.NONE) || '1';
    const val = generator.valueToCode(block, 'VALUE', Order.NONE) || 'nil';
    return `${listCode}[${idx}] = ${val}\n`;
  };

  luaGenerator.forBlock['poly_list_remove'] = (block, generator) => {
    const listCode = generator.valueToCode(block, 'LIST', Order.NONE) || '{}';
    const idx = generator.valueToCode(block, 'INDEX', Order.NONE) || '1';
    return `table.remove(${listCode}, ${idx})\n`;
  };

  // Pure value-slot dict primitives (zero hidden helpers, native Lua tables, supports nested chaining)
  // Note: `{}` is an exp (not prefixexp) in Lua, so `Order.HIGH` keeps `a = {}` bare while auto-parenthesizing `({})['k']`;
  // `poly_dict_get` returns `Order.ATOMIC` so chained `a['b']['val'] = 99` never emits leading `(` (avoiding Lua call-ambiguity).
  luaGenerator.forBlock['poly_dict_new'] = () => ['{}', Order.HIGH];

  luaGenerator.forBlock['poly_dict_set'] = (block, generator) => {
    const dictCode = generator.valueToCode(block, 'DICT', Order.HIGH) || '({})';
    const key = generator.valueToCode(block, 'KEY', Order.NONE) || '""';
    const val = generator.valueToCode(block, 'VAL', Order.NONE) || 'nil';
    return `${dictCode}[${key}] = ${val}\n`;
  };

  luaGenerator.forBlock['poly_dict_get'] = (block, generator) => {
    const dictCode = generator.valueToCode(block, 'DICT', Order.HIGH) || '({})';
    const key = generator.valueToCode(block, 'KEY', Order.NONE) || '""';
    return [`${dictCode}[${key}]`, Order.ATOMIC];
  };

  luaGenerator.forBlock['poly_dict_has'] = (block, generator) => {
    const dictCode = generator.valueToCode(block, 'DICT', Order.HIGH) || '({})';
    const key = generator.valueToCode(block, 'KEY', Order.NONE) || '""';
    return [`${dictCode}[${key}] ~= nil`, Order.RELATIONAL];
  };

  luaGenerator.forBlock['poly_dict_delete'] = (block, generator) => {
    const dictCode = generator.valueToCode(block, 'DICT', Order.HIGH) || '({})';
    const key = generator.valueToCode(block, 'KEY', Order.NONE) || '""';
    return `${dictCode}[${key}] = nil\n`;
  };

  // Style A1 2-tier custom functions in Lua + function-top hoisting of nested `poly_local_set`:
  // - Cross-file shared (`handle.sharedFunctions`): emitted ONLY inside read-only `shared.lua` as `function shared.foo(...)`
  // - File-private (default): `local function foo(...)` (never pollutes `_G`)
  const origLuaDefReturn = luaGenerator.forBlock['procedures_defreturn'];
  const origLuaDefNoReturn = luaGenerator.forBlock['procedures_defnoreturn'];
  const origLuaCallReturn = luaGenerator.forBlock['procedures_callreturn'];
  const origLuaCallNoReturn = luaGenerator.forBlock['procedures_callnoreturn'];

  if (origLuaDefReturn) {
    const wrapLuaDef =
      (orig: typeof origLuaDefReturn) =>
      (block: Blockly.Block, generator: typeof luaGenerator) => {
        const rawName = String(block.getFieldValue('NAME') || '').trim();
        const sharedFnSet = new Set(getActiveHandleSharedFunctions() ?? []);
        const isSharedFn = sharedFnSet.has(rawName);
        if (isSharedFn && !codegenContext.compilingSharedModule) {
          // Cross-file shared function is emitted centrally inside `shared.lua`
          return null;
        }
        const hoistedLocals = buildLuaHoistedLocalsLine([block], 'STACK', '  ');
        const out = orig(block, generator);
        const procIdent = generator.getProcedureName(rawName);
        const defKey = `%${procIdent}`;
        const defs = (
          generator as unknown as { definitions_: Record<string, string> }
        ).definitions_;
        const existing = defs[defKey];
        if (typeof existing === 'string') {
          let nextCode = existing;
          if (hoistedLocals) {
            nextCode = nextCode.replace(
              /(^|\n)((?:local\s+)?function\s+[^\n]+\n)/,
              `$1$2${hoistedLocals}`,
            );
          }
          if (isSharedFn && codegenContext.compilingSharedModule) {
            const modName = codegenContext.sharedModuleName || 'shared';
            const sharedFnIdent = resolveSharedFnIdent(rawName);
            nextCode = nextCode.replace(
              /(^|\n)function\s+[A-Za-z0-9_]+\s*\(/,
              `$1function ${modName}.${sharedFnIdent}(`,
            );
          } else {
            nextCode = nextCode.replace(/(^|\n)function /, '$1local function ');
          }
          defs[defKey] = nextCode;
        }
        return out;
      };
    luaGenerator.forBlock['procedures_defreturn'] = wrapLuaDef(origLuaDefReturn);
    if (origLuaDefNoReturn) {
      luaGenerator.forBlock['procedures_defnoreturn'] = wrapLuaDef(origLuaDefNoReturn);
    }
  }

  if (origLuaCallNoReturn) {
    luaGenerator.forBlock['procedures_callnoreturn'] = (block, generator) => {
      const out = origLuaCallNoReturn(block, generator);
      const call = block as Blockly.Block & { getProcedureCall?: () => string };
      const rawName = call.getProcedureCall?.()?.trim() ?? '';
      const sharedFnSet = new Set(getActiveHandleSharedFunctions() ?? []);
      if (rawName && sharedFnSet.has(rawName) && typeof out === 'string') {
        const modName = codegenContext.sharedModuleName || 'shared';
        const sharedFnIdent = resolveSharedFnIdent(rawName);
        if (!codegenContext.compilingSharedModule) {
          codegenContext.usedSharedModule = true;
        }
        const trimmed = out.trimStart();
        const parenIdx = trimmed.indexOf('(');
        const argsSuffix = parenIdx >= 0 ? trimmed.slice(parenIdx) : '()\n';
        return `${modName}.${sharedFnIdent}${argsSuffix}`;
      }
      return out;
    };
  }

  if (origLuaCallReturn) {
    luaGenerator.forBlock['procedures_callreturn'] = (block, generator) => {
      const out = origLuaCallReturn(block, generator);
      const call = block as Blockly.Block & { getProcedureCall?: () => string };
      const rawName = call.getProcedureCall?.()?.trim() ?? '';
      const sharedFnSet = new Set(getActiveHandleSharedFunctions() ?? []);
      if (rawName && sharedFnSet.has(rawName) && Array.isArray(out)) {
        const modName = codegenContext.sharedModuleName || 'shared';
        const sharedFnIdent = resolveSharedFnIdent(rawName);
        if (!codegenContext.compilingSharedModule) {
          codegenContext.usedSharedModule = true;
        }
        const parenIdx = out[0].indexOf('(');
        const argsSuffix = parenIdx >= 0 ? out[0].slice(parenIdx) : '()';
        return [`${modName}.${sharedFnIdent}${argsSuffix}`, out[1]];
      }
      return out;
    };
  }

  const emitLuaSharedFnCall = (
    block: Blockly.Block,
    generator: typeof luaGenerator,
  ): string => {
    const meta = (
      block as Blockly.Block & {
        sharedFnMeta_?: { scriptName: string; fnName: string; params: string[] };
      }
    ).sharedFnMeta_ ?? { scriptName: 'shared', fnName: 'my_func', params: [] };
    const modName = codegenContext.sharedModuleName || 'shared';
    if (!codegenContext.compilingSharedModule) {
      codegenContext.usedSharedModule = true;
    }
    const fnIdent = resolveSharedFnIdent(meta.fnName);
    const args = meta.params.map(
      (_p, idx) => generator.valueToCode(block, `ARG${idx}`, Order.NONE) || 'nil',
    );
    return `${modName}.${fnIdent}(${args.join(', ')})`;
  };

  luaGenerator.forBlock['poly_call_shared_noreturn'] = (block, generator) => {
    return `${emitLuaSharedFnCall(block, generator)}\n`;
  };

  luaGenerator.forBlock['poly_call_shared_return'] = (block, generator) => {
    return [emitLuaSharedFnCall(block, generator), Order.HIGH];
  };

  luaGeneratorsRegistered = true;
}

function collectLuaFileLocalVars(
  workspace: Blockly.Workspace,
  varIdToIdent: Map<string, string>,
  sharedVarNames: Set<string>,
  sharedFnNames: Set<string>,
): Array<{ name: string; ident: string }> {
  const varMap = workspace.getVariableMap();

  const isInsideSharedFunction = (blk: Blockly.Block): boolean => {
    const root = blk.getRootBlock();
    if (
      root.type === 'procedures_defnoreturn' ||
      root.type === 'procedures_defreturn'
    ) {
      const fnName = String(root.getFieldValue('NAME') || '').trim();
      return sharedFnNames.has(fnName);
    }
    return false;
  };

  const neededIds = new Set<string>();
  for (const blk of workspace.getAllBlocks(false)) {
    if (blk.isShadow() || !blk.isEnabled()) continue;
    if (isInsideSharedFunction(blk)) continue;
    if (LOOP_SCOPED_FOR_TYPES.has(blk.type)) continue;
    for (const vId of getBlockVariableFieldIds(blk)) {
      const model = varMap.getVariableById(vId);
      if (!model) continue;
      const vName = model.getName();
      if (sharedVarNames.has(vName)) continue;
      if (isShadowedByProcedureParam(vId, blk)) continue;
      if (isShadowedByEnclosingForLoop(vId, blk)) continue;
      neededIds.add(vId);
    }
  }

  const out: Array<{ name: string; ident: string }> = [];
  const seen = new Set<string>();
  for (const v of varMap.getAllVariables()) {
    if (!neededIds.has(v.getId())) continue;
    const ident = varIdToIdent.get(v.getId());
    if (ident && !seen.has(ident)) {
      seen.add(ident);
      out.push({ name: v.getName(), ident });
    }
  }
  return out;
}

/**
 * When a Lua script defines 2+ file-private `local function`s, hoists `local f1, f2`
 * forward declarations so forward calls & mutual recursion work identically to Python/JS.
 */
function hoistLuaPrivateFunctionDecls(body: string): string {
  const privateNames: string[] = [];
  const seen = new Set<string>();
  const re = /^local function ([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      privateNames.push(m[1]);
    }
  }
  if (privateNames.length < 2) return body;
  const rewritten = body.replace(
    /^local function ([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm,
    'function $1(',
  );
  return injectLuaFileLocalDecls(rewritten, [`local ${privateNames.join(', ')}`]);
}

/** Inserts file-local `local x = <init>` declarations cleanly right after top `require(...)` imports. */
function injectLuaFileLocalDecls(body: string, decls: string[]): string {
  if (decls.length === 0) return body;
  const declBlock = decls.join('\n');
  if (!body.trim()) return declBlock;

  const lines = body.split('\n');
  let insertAfter = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (/^(?:local\s+[A-Za-z0-9_]+\s*=\s*)?require\s*\(/.test(trimmed)) {
      insertAfter = i;
      continue;
    }
    break;
  }
  if (insertAfter < 0) {
    return `${declBlock}\n\n${body}`;
  }
  const head = lines.slice(0, insertAfter + 1).join('\n');
  const tail = lines.slice(insertAfter + 1).join('\n').replace(/^\n+/, '');
  return tail ? `${head}\n\n${declBlock}\n\n${tail}` : `${head}\n\n${declBlock}`;
}

function buildLuaSnapshotExpr(
  entries: Array<{ label: string; ident: string }>,
): string {
  if (entries.length === 0) return '{}';
  const pairs = entries.map(
    ({ label, ident }) => `[${JSON.stringify(label)}] = ${ident}`,
  );
  return `{ ${pairs.join(', ')} }`;
}

/** Unified single-track Lua coroutine & event-loop scheduler driver (matches C host 1-handle-1-thread model). */
function buildLuaEventLoopDriver(keepAliveExternal: boolean): string {
  return `
local _has_start = (type(on_start) == "function")
local _has_run = (type(on_run) == "function")
local _has_timer = (type(on_timer) == "function")
local _has_ext = ${keepAliveExternal ? 'true' : 'false'}

if _has_start then
  __poly_start_co = coroutine.create(on_start)
end

local function __poly_call_cb(cbName, fn, ...)
  if type(fn) ~= "function" then return end
  __poly_cb_enter(cbName)
  debug.sethook(function()
    if __poly_is_stop_requested() and cbName ~= "on_stop" then
      error("__POLY_STOP_CB__", 0)
    end
    if __poly_cb_expired() then
      error("事件回调 " .. cbName .. " 执行超时（疑似死循环），已按单次回调超时保护中断。", 2)
    end
  end, "", 4000)
  local _ok, _err = pcall(fn, ...)
  debug.sethook()
  __poly_cb_exit()
  if not _ok and _err ~= "__POLY_STOP_CB__" then
    error(_err, 0)
  end
end

local function __poly_run_start_slice()
  if __poly_start_co == nil or coroutine.status(__poly_start_co) == "dead" then
    __poly_start_co = nil
    __poly_co_done()
    return
  end
  local _slice_ms = __poly_get_time_slice_ms()
  local _slice_wall_start = __poly_now_ms()
  local _empty_checks = 0
  while true do
    local _ok, _tag, _a, _b = coroutine.resume(__poly_start_co)
    if not _ok then
      __poly_start_co = nil
      __poly_co_done()
      error(_tag, 0)
    end
    if coroutine.status(__poly_start_co) == "dead" then
      __poly_start_co = nil
      __poly_co_done()
      return
    end
    if _tag == "__POLY_SLEEP__" then
      __poly_co_sleep(_a or 0)
      return
    elseif _tag == "__POLY_STEP__" then
      __poly_step_start(_a, _b):await()
      if __poly_is_stop_requested() then
        __poly_start_co = nil
        __poly_co_done()
        return
      end
      if (__poly_now_ms() - _slice_wall_start) >= _slice_ms then
        __poly_co_yield_slice()
        return
      end
    elseif _tag == "__POLY_SLICE_CHECK__" then
      _empty_checks = _empty_checks + 1
      if _empty_checks >= 1000 or (__poly_now_ms() - _slice_wall_start) >= _slice_ms then
        __poly_co_yield_slice()
        return
      end
    else
      __poly_co_yield_slice()
      return
    end
  end
end

local function __poly_refresh_handlers()
  __poly_sync_handlers(
    type(on_run) == "function",
    type(on_timer) == "function",
    _has_ext
  )
end

if __poly_init_scheduler(_has_start, _has_run, _has_timer, _has_ext) then
  while true do
    local _ev = __poly_next_event():await()
    if _ev == "start_resume" then
      __poly_run_start_slice()
      __poly_refresh_handlers()
    elseif _ev == "run" then
      __poly_call_cb("on_run", on_run)
      __poly_refresh_handlers()
    elseif type(_ev) == "string" and _ev:sub(1, 6) == "timer:" then
      local _tid = tonumber(_ev:sub(7))
      if _tid ~= nil then __poly_call_cb("on_timer", on_timer, _tid) end
      __poly_refresh_handlers()
    elseif type(_ev) == "string" and _ev:sub(1, 6) == "event:" then
      local _ename = __poly_last_event_name()
      local _fn = _G[_ename]
      if type(_fn) == "function" then
        local _argc = __poly_last_event_argc()
        local _args = {}
        for _ai = 1, _argc do _args[_ai] = __poly_last_event_arg(_ai) end
        __poly_call_cb(_ename, _fn, table.unpack(_args, 1, _argc))
      end
      __poly_refresh_handlers()
    else
      break
    end
  end
end
__poly_call_cb("on_stop", on_stop)
`;
}

interface LuaDebugMeta {
  snapExpr: string;
}

export class LuaBackendAdapter extends BaseScriptBackend<LuaDebugMeta> {
  readonly id = LUA_DIALECT.id;
  readonly name = 'Lua';
  readonly version = '5.4';
  readonly extension = LUA_DIALECT.extension;
  readonly fileName = `main.${LUA_DIALECT.extension}`;
  readonly accentColor = '#3b82f6';
  readonly description =
    '标准 Lua 5.4 脚本生成器，支持 Style A1 只读 shared 模块、单线程协程事件 ABI 与伴生脚本断点调试。';
  readonly dialect = LUA_DIALECT;
  protected readonly loopScopedForVars = true;

  protected readonly bareAttrInSharedModule = false;
  protected readonly orderNone = Order.NONE;
  protected readonly orderAtomic = Order.ATOMIC;
  protected readonly topLevelDebugTickRe = /^__poly_tick\(/;

  protected ensureGeneratorsRegistered(): void {
    registerLuaBlockGenerators();
  }

  protected getGenerator(): BlocklyGeneratorLike {
    return luaGenerator;
  }

  protected override beforePass(): void {
    luaDeclaredLocalsByRoot = new Map();
  }

  protected formatFileHeader(eventDriven: boolean): string {
    return eventDriven
      ? `-- 由 PolyBlock 自动生成 (Target: Lua 5.4 · Event-Driven ABI)\n`
      : `-- 由 PolyBlock 自动生成 (Target: Lua 5.4)\n`;
  }

  protected formatSharedModuleImport(moduleName: string): string {
    return `local ${moduleName} = require(${JSON.stringify(moduleName)})`;
  }

  protected override formatMissingTemplateValueExpr(): string {
    return `nil --[[ 未提供 code.${this.id}.template ]]`;
  }

  protected override collectResultVariableNames(
    analysis: WorkspacePassAnalysis,
  ): string[] {
    const sharedLabels = analysis.variables
      .filter((v) => Boolean(v.sharedAttr))
      .map((v) => v.label);
    const localLabels = analysis.variables
      .filter((v) => !v.sharedAttr)
      .map((v) => v.label);
    return [...sharedLabels, ...localLabels];
  }

  protected buildPassContextOptions(
    debugPass: boolean,
    analysis: WorkspacePassAnalysis,
  ): CodegenPassContextOptions {
    const sharedVarIdToAttr = new Map<string, string>();
    const sharedVarIdents = new Set<string>();
    for (const v of analysis.variables) {
      if (v.sharedAttr) {
        sharedVarIdToAttr.set(v.id, v.sharedAttr);
        sharedVarIdents.add(v.ident);
      }
    }
    return {
      debugPass,
      sharedModuleName: analysis.sharedModuleName,
      sharedVarIdToAttr,
      sharedVarIdents,
    };
  }

  protected override postProcessBody(
    body: string,
    _debugPass: boolean,
    workspace: Blockly.Workspace,
    analysis: WorkspacePassAnalysis,
    scriptInitials: Record<string, VariableInitialValue>,
  ): string {
    const fileLocalDecls = collectLuaFileLocalVars(
      workspace,
      analysis.varIdToIdent,
      analysis.sharedNames,
      analysis.sharedFnSet,
    ).map(
      ({ name, ident }) =>
        `local ${ident} = ${formatInitialValueForDialect(scriptInitials[name], LUA_DIALECT)}`,
    );
    return injectLuaFileLocalDecls(hoistLuaPrivateFunctionDecls(body), fileLocalDecls);
  }

  protected prepareDebugPass(
    analysis: WorkspacePassAnalysis,
    allLocalEntries: Array<{ label: string; ident: string }>,
    usedSharedClean: boolean,
  ): DebugPassPreparation<LuaDebugMeta> {
    const varEntries = analysis.variables
      .filter((v) => !v.sharedAttr)
      .map((v) => ({ label: v.label, ident: v.ident }));
    const sharedSnapEntries = analysis.variables
      .filter((v) => Boolean(v.sharedAttr) && Boolean(analysis.sharedModuleName))
      .map((v) => ({
        label: v.label,
        ident: `${analysis.sharedModuleName}.${v.sharedAttr}`,
      }));

    const snapEntries: Array<{ label: string; ident: string }> = [
      ...varEntries,
      ...(usedSharedClean ? sharedSnapEntries : []),
    ];
    const seenSnapLabels = new Set(snapEntries.map((e) => e.label));
    for (const loc of allLocalEntries) {
      if (!seenSnapLabels.has(loc.label)) {
        seenSnapLabels.add(loc.label);
        snapEntries.push(loc);
      }
    }
    const snapExpr = buildLuaSnapshotExpr(snapEntries);
    return {
      statementPrefix: `__poly_tick(%1, __poly_snap(${snapExpr}))\n`,
      meta: { snapExpr },
    };
  }

  protected assembleDebugOutputs(
    input: DebugAssemblyInput<LuaDebugMeta>,
  ): { debugCode: string; moduleDebugCode: string } {
    const driver = buildLuaEventLoopDriver(input.keepAliveExternal);
    const debugCode = input.fullDebugBody
      ? `${input.fullDebugBody}\n${driver}\n__poly_final_snap(__poly_snap(${input.debugMeta.snapExpr}))\n`
      : '';
    const moduleDebugCode = input.companionDebugBody.trim()
      ? `${input.companionDebugBody}\n`
      : '';
    return { debugCode, moduleDebugCode };
  }

  protected getSharedProcDebugStatementPrefix(
    input: SharedProcCompileInput,
    snapEntries: Array<{ label: string; attr: string }>,
  ): string {
    const snapExpr = buildLuaSnapshotExpr(
      snapEntries.map((e) => ({
        label: e.label,
        ident: `${input.moduleName}.${e.attr}`,
      })),
    );
    return `__poly_tick(%1, __poly_snap(${snapExpr}))\n`;
  }

  formatDispatchRouter(
    eventName: string,
    branches: EntryDispatchBranchSpec[],
    _debugPass: boolean,
  ): { autoImports: string[]; code: string } {
    if (branches.length === 0) return { autoImports: [], code: '' };
    const paramsStr = (branches[0].params ?? []).join(', ');
    const lines: string[] = [];
    branches.forEach((br, idx) => {
      const kw = idx === 0 ? 'if' : 'elseif';
      const cond = br.condition.lua ?? this.dialect.boolTrue;
      const comment = br.comment.lua ?? '';
      const callArgs = br.passParams ? paramsStr : '';
      const srcTag = br.isLocal
        ? ''
        : comment
          ? ` (${br.scriptName}.lua)`
          : ` -- ${br.scriptName}.lua`;
      const callLine = br.isLocal
        ? `    ${br.fnName}(${callArgs})`
        : `    if ${br.fnName} then ${br.fnName}(${callArgs}) end`;
      lines.push(`  ${kw} ${cond} then${comment}${srcTag}\n${callLine}`);
    });
    return {
      autoImports: [],
      code: `function ${eventName}(${paramsStr})\n${lines.join('\n')}\n  end\nend\n`,
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
        'lua',
        {
          resolveValueInput: (blk, argName) =>
            luaGenerator.valueToCode(blk, argName, Order.NONE) || '""',
          resolveVarField: (blk, argName) =>
            formatLuaVarRef(
              String(blk.getFieldValue(argName) || ''),
              luaGenerator,
              blk,
            ),
        },
        pack,
        section,
      );

    luaGenerator.forBlock[b.type] = (block, generator) => {
      hoistImports(generator, hatSpec.imports?.lua);

      if (hatSpec.mode === 'singleton') {
        const hoistedLocals = buildLuaHoistedLocalsLine([block], 'BODY', '  ');
        const body = generator.statementToCode(block, 'BODY');
        if (codegenContext.debugPass) {
          return `function ${hatSpec.eventName}(${paramsStr})\n${hoistedLocals}${body}end\n`;
        }
        return (
          `${SENTINEL_START_PREFIX}'${block.id}'__\n` +
          `function ${hatSpec.eventName}(${paramsStr})\n` +
          `${hoistedLocals}${body}` +
          `end\n` +
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
          const hoistedLocals = buildLuaHoistedLocalsLine([hatBlk], 'BODY', '  ');
          const rawBody = generator.statementToCode(hatBlk, 'BODY');
          const headerComment = comment.trim() ? `${comment.trim()}\n` : '';
          if (codegenContext.debugPass) {
            return `function ${fnName}(${branchParamsStr})\n${hoistedLocals}${rawBody}end\n`;
          }
          return (
            `${SENTINEL_START_PREFIX}'${hatBlk.id}'__\n` +
            `${headerComment}` +
            `function ${fnName}(${branchParamsStr})\n` +
            `${hoistedLocals}${rawBody}` +
            `end\n` +
            `${SENTINEL_END_PREFIX}'${hatBlk.id}'__\n`
          );
        });

        return `${fnDefs.join('\n')}`;
      }

      const hoistedInlineLocals = buildLuaHoistedLocalsLine(matchingHats, 'BODY', '  ');
      const branches: string[] = [];
      matchingHats.forEach((hatBlk, idx) => {
        const kw = idx === 0 ? 'if' : 'elseif';
        const cond = hatSpec.condition?.lua
          ? renderHatTpl(hatSpec.condition.lua, hatBlk)
          : this.dialect.boolTrue;
        const comment = hatSpec.branchComment?.lua
          ? renderHatTpl(hatSpec.branchComment.lua, hatBlk)
          : '';
        const rawBody = generator.statementToCode(hatBlk, 'BODY');
        const indentedBody = indentLines(rawBody, '  ');
        if (codegenContext.debugPass) {
          branches.push(`  ${kw} ${cond} then${comment}\n${indentedBody}`);
        } else {
          branches.push(
            `${SENTINEL_START_PREFIX}'${hatBlk.id}'__\n` +
              `  ${kw} ${cond} then${comment}\n` +
              `${indentedBody}` +
              `${SENTINEL_END_PREFIX}'${hatBlk.id}'__\n`,
          );
        }
      });

      return `function ${hatSpec.eventName}(${paramsStr})\n${hoistedInlineLocals}${branches.join('')}  end\nend\n`;
    };
  }

  formatSharedModuleDocument(input: SharedModuleDocumentInput): {
    source: string;
    debugSource: string;
  } {
    const varLines = input.variables.map(
      (v) =>
        `${input.moduleName}.${v.attr} = ${formatInitialValueForDialect(v.initialValue, LUA_DIALECT)}`,
    );
    const buildLuaDoc = (fnBodies: string[]) => {
      const parts: string[] = [
        `-- 由 PolyBlock 自动生成的同句柄跨文件共享模块（只读）`,
      ];
      if (input.importLines.length > 0) parts.push(input.importLines.join('\n'));
      parts.push(`local ${input.moduleName} = {}`);
      if (varLines.length > 0) parts.push(varLines.join('\n'));
      if (fnBodies.length > 0) parts.push(fnBodies.join('\n\n'));
      parts.push(`return ${input.moduleName}`);
      return `${parts.join('\n\n')}\n`;
    };
    return {
      source: buildLuaDoc(input.cleanFnBlocks),
      debugSource: buildLuaDoc(input.debugFnBlocks),
    };
  }
}
