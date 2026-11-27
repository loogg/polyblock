import * as Blockly from 'blockly';
import { javascriptGenerator, Order } from 'blockly/javascript';
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
  formatSharedVarRef,
  type CodegenPassContextOptions,
} from './codegenContext';
import { sanitizeLocalIdent } from './scopeAnalysis';
import {
  SENTINEL_END_PREFIX,
  SENTINEL_START_PREFIX,
} from './sourceMap';
import {
  formatInitialValueForDialect,
  splitLibParamList,
  type EntryDispatchBranchSpec,
  type ExtensionHatRegisterContext,
  type LanguageDialect,
  type ScannedLibFunctionMeta,
  type SharedModuleDocumentInput,
  type SharedProcCompileInput,
} from './types';

function hasNonEmptyJsReturn(body: string): boolean {
  const noComments = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  return /\breturn\s+(?!\s*(?:$|\n|;|}))[^\s;}]/m.test(noComments);
}

function extractJsBraceBody(source: string, openBraceIdx: number): string {
  let depth = 1;
  let i = openBraceIdx + 1;
  const maxEnd = Math.min(source.length, openBraceIdx + 8000);
  while (i < maxEnd && depth > 0) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < maxEnd && source[i] !== quote) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < maxEnd && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < maxEnd && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  return source.slice(openBraceIdx + 1, Math.max(openBraceIdx + 1, i - 1));
}

function scanJsLibraryFunctionMetas(source: string): ScannedLibFunctionMeta[] {
  const normalized = source.replace(/\r\n/g, '\n');
  const results: ScannedLibFunctionMeta[] = [];
  const seen = new Set<string>();

  const pushCandidate = (
    funcName: string,
    params: string[],
    inferredKind: 'statement' | 'value',
  ) => {
    if (!funcName || funcName.startsWith('_') || seen.has(funcName)) return;
    seen.add(funcName);
    results.push({ funcName, params, inferredKind });
  };

  // Track local `function foo(a, b) { ... }` definitions for `module.exports = { foo }` resolution
  const localFnMeta = new Map<
    string,
    { params: string[]; inferredKind: 'statement' | 'value' }
  >();
  const declFnRe =
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = declFnRe.exec(normalized)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const body = extractJsBraceBody(normalized, openIdx);
    const meta = {
      params: splitLibParamList(m[2]),
      inferredKind: hasNonEmptyJsReturn(body)
        ? ('value' as const)
        : ('statement' as const),
    };
    localFnMeta.set(m[1], meta);
    if (/^\s*export\b/.test(m[0])) {
      pushCandidate(m[1], meta.params, meta.inferredKind);
    }
  }

  // `exports.foo = [async] function(a, b) { ... }` or `module.exports.foo = ...`
  const cjsFnRe =
    /^\s*(?:module\.)?exports\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s+)?function(?:\s+[A-Za-z_][A-Za-z0-9_]*)?\s*\(([^)]*)\)\s*\{/gm;
  while ((m = cjsFnRe.exec(normalized)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const body = extractJsBraceBody(normalized, openIdx);
    pushCandidate(
      m[1],
      splitLibParamList(m[2]),
      hasNonEmptyJsReturn(body) ? 'value' : 'statement',
    );
  }

  // `exports.foo = (a, b) => { ... }` / `export const foo = (a, b) => ...`
  const arrowFnRe =
    /^\s*(?:(?:module\.)?exports\.|export\s+(?:const|let|var)\s+)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>\s*(\{)?/gm;
  while ((m = arrowFnRe.exec(normalized)) !== null) {
    if (m[3] === '{') {
      const openIdx = m.index + m[0].length - 1;
      const body = extractJsBraceBody(normalized, openIdx);
      pushCandidate(
        m[1],
        splitLibParamList(m[2]),
        hasNonEmptyJsReturn(body) ? 'value' : 'statement',
      );
    } else {
      pushCandidate(m[1], splitLibParamList(m[2]), 'value');
    }
  }

  // `exports.foo = localFn;`
  const cjsAliasRe =
    /^\s*(?:module\.)?exports\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/gm;
  while ((m = cjsAliasRe.exec(normalized)) !== null) {
    const meta = localFnMeta.get(m[2]);
    if (meta) {
      pushCandidate(m[1], meta.params, meta.inferredKind);
    }
  }

  // `module.exports = { foo, bar: localBar, baz(x) { ... } }`
  const modExportsObjRe = /module\.exports\s*=\s*\{([\s\S]*?)\}\s*;?\s*$/;
  const meMatch = modExportsObjRe.exec(normalized.trim());
  if (meMatch?.[1]) {
    const objContent = meMatch[1];
    const inlineMethodRe =
      /([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*(?:async\s+)?function\s*)?\(([^)]*)\)\s*\{/g;
    let im: RegExpExecArray | null;
    while ((im = inlineMethodRe.exec(objContent)) !== null) {
      const openIdx = im.index + im[0].length - 1;
      const body = extractJsBraceBody(objContent, openIdx);
      pushCandidate(
        im[1],
        splitLibParamList(im[2]),
        hasNonEmptyJsReturn(body) ? 'value' : 'statement',
      );
    }
    const refRe =
      /([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([A-Za-z_][A-Za-z0-9_]*))?\s*(?:,|$)/gm;
    let rm: RegExpExecArray | null;
    while ((rm = refRe.exec(objContent)) !== null) {
      const exportKey = rm[1];
      const targetIdent = rm[2] || rm[1];
      const meta = localFnMeta.get(targetIdent);
      if (meta) {
        pushCandidate(exportKey, meta.params, meta.inferredKind);
      }
    }
  }

  // Fallback: if no explicit CommonJS/ESM exports were found, accept top-level named functions
  if (results.length === 0) {
    for (const [fnName, meta] of localFnMeta.entries()) {
      pushCandidate(fnName, meta.params, meta.inferredKind);
    }
  }

  return results;
}

/** Single-source-of-truth dialect metadata owned by the JavaScript (ES2023) backend. */
export const JS_DIALECT = {
  id: 'js',
  displayName: 'JavaScript',
  shortLabel: 'JS',
  compactLabel: 'JS',
  extension: 'js',
  accentGradient: 'linear-gradient(135deg, #f59e0b, #ea580c)',
  boolTrue: 'true',
  boolFalse: 'false',
  nullLiteral: 'null',
  listLiteral: '[]',
  dictLiteral: '{}',
  notOp: '!',
  commentToken: '//',
  lineCommentPrefix: ' // ',
  keywords: [
    'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false',
    'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let',
    'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw',
    'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  ],
  builtinFuncs: [
    'console', 'Math', 'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON',
    'parseInt', 'parseFloat', 'isNaN', 'require', 'globalThis',
  ],
  explicitAsyncCoroutine: true,
  libBinding: {
    formatImport: (mod: string) =>
      `const ${mod.replace(/[^A-Za-z0-9_]/g, '_')} = require("${mod}");`,
    formatCall: (mod: string, fn: string, args: string[]) =>
      `${mod.replace(/[^A-Za-z0-9_]/g, '_')}.${fn}(${args.join(', ')})`,
    extractImportedModuleName: (line: string) => {
      const m =
        /require\s*\(\s*["']([^"']+)["']\s*\)/.exec(line) ??
        /from\s+["']([^"']+)["']/.exec(line);
      return m?.[1]?.trim() || null;
    },
    scanFunctions: scanJsLibraryFunctionMetas,
  },
  extractErrorLine: (message: string) => {
    const m =
      /<anonymous>:(\d+):/.exec(message) ??
      /\.js:(\d+):/.exec(message) ??
      /\bline\s+(\d+)/i.exec(message);
    return m ? Number(m[1]) : undefined;
  },
  exportToolchain: {
    label: 'QuickJS / Node.js / Espruino',
    notes: '标准 CommonJS 风格 ES2023 脚本，支持浏览器 Worker 沙箱实时仿真与真机直接运行。',
  },
} as const satisfies LanguageDialect<'js'>;

let jsGeneratorsRegistered = false;

function formatJsVarRef(
  varId: string,
  generator: { getVariableName(id: string): string },
  block?: Blockly.Block,
): string {
  return formatSharedVarRef(varId, generator, block, {
    bareAttrInSharedModule: false,
  });
}

/** Converts a 1-based Blockly list index expression into clean 0-based JS index (`1` -> `0`, `k` -> `Math.trunc(k) - 1`). */
function formatJsZeroBasedIndex(rawIdx: string): string {
  const trimmed = rawIdx.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isInteger(n) && n >= 1) return String(n - 1);
  }
  return `Math.trunc(${trimmed}) - 1`;
}

/**
 * Collects ALL `poly_local_set` variable identifiers used anywhere inside the given root blocks
 * (both top-level and nested branches/loops) and marks them in `codegenContext.hoistedLocalsByRoot`
 * so JS emits a single `let ident = null;` at function top (preventing duplicate `let` SyntaxErrors
 * and avoiding block-scope leaks across `if`/`else` branches).
 */
function buildJsHoistedLocalsLine(
  rootBlocks: Blockly.Block[],
  bodyInputName = 'BODY',
  indent = '  ',
): string {
  const ordered: string[] = [];
  const seen = new Set<string>();

  for (const root of rootBlocks) {
    const bodyRoot = root.getInputTargetBlock(bodyInputName);
    if (!bodyRoot) continue;
    let rootSet = codegenContext.hoistedLocalsByRoot.get(root.id);
    for (const blk of bodyRoot.getDescendants(false)) {
      if (blk.isShadow() || !blk.isEnabled()) continue;
      if (blk.type !== 'poly_local_set') continue;
      const ident = sanitizeLocalIdent(String(blk.getFieldValue('NAME') || 'tmp'));
      if (!rootSet) {
        rootSet = new Set<string>();
        codegenContext.hoistedLocalsByRoot.set(root.id, rootSet);
      }
      rootSet.add(ident);
      if (!seen.has(ident)) {
        seen.add(ident);
        ordered.push(ident);
      }
    }
  }

  if (ordered.length === 0) return '';
  return ordered.map((ident) => `${indent}let ${ident} = null;\n`).join('');
}

function buildJsSnapObjectLiteral(
  entries: Array<{ label: string; ident: string }>,
): string {
  if (entries.length === 0) return '{}';
  const props = entries.map(
    ({ label, ident }) =>
      `${JSON.stringify(label)}: typeof ${ident} !== "undefined" ? ${ident} : undefined`,
  );
  return `{ ${props.join(', ')} }`;
}

export function registerJsBlockGenerators(): void {
  if (jsGeneratorsRegistered) return;

  // Wrap Blockly's javascriptGenerator.init so:
  // 1) Cross-file shared variables are NOT re-declared at file top
  // 2) Unused handle-synced variables do NOT pollute top level
  // 3) Used single-file globals emit clean `let x = <initialValue>;`
  const origInit = javascriptGenerator.init.bind(javascriptGenerator);
  javascriptGenerator.init = (workspace: Blockly.Workspace) => {
    origInit(workspace);
    const sharedIdents = codegenContext.sharedVarIdents;
    const usedIdents = codegenContext.usedVarIdents;
    const scriptInitials = getActiveScriptVarInitials();
    const identToVarName = new Map<string, string>();
    for (const v of workspace.getVariableMap().getAllVariables()) {
      identToVarName.set(javascriptGenerator.getVariableName(v.getId()), v.getName());
    }

    const defs = (
      javascriptGenerator as unknown as { definitions_: Record<string, string> }
    ).definitions_;
    if (typeof defs.variables === 'string') {
      const m = defs.variables.match(/^\s*var\s+([^;]+);/);
      if (m) {
        const declared = m[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const kept: string[] = [];
        for (const ident of declared) {
          if (codegenContext.compilingSharedModule) continue;
          if (sharedIdents.has(ident)) continue;
          if (usedIdents !== null && !usedIdents.has(ident)) continue;
          const varName = identToVarName.get(ident) ?? ident;
          kept.push(
            `let ${ident} = ${formatInitialValueForDialect(scriptInitials[varName], JS_DIALECT)};`,
          );
        }
        if (kept.length > 0) {
          defs.variables = kept.join('\n');
        } else {
          delete defs.variables;
        }
      }
    }
  };

  javascriptGenerator.forBlock['variables_get'] = (block, generator) => {
    const ref = formatJsVarRef(
      String(block.getFieldValue('VAR') || ''),
      generator,
      block,
    );
    return [ref, Order.ATOMIC];
  };

  javascriptGenerator.forBlock['variables_set'] = (block, generator) => {
    const ref = formatJsVarRef(
      String(block.getFieldValue('VAR') || ''),
      generator,
      block,
    );
    const val = generator.valueToCode(block, 'VALUE', Order.ASSIGNMENT) || '0';
    return `${ref} = ${val};\n`;
  };

  // Clean idiomatic JS `+=` (ZERO `typeof x === 'number' ? x : 0` magic!)
  javascriptGenerator.forBlock['math_change'] = (block, generator) => {
    const delta = generator.valueToCode(block, 'DELTA', Order.ADDITION) || '0';
    const varName = formatJsVarRef(
      String(block.getFieldValue('VAR') || ''),
      generator,
      block,
    );
    return `${varName} += ${delta};\n`;
  };

  // Pure inline random integer expression (ZERO `provideFunction_` hidden helpers!)
  javascriptGenerator.forBlock['math_random_int'] = (block, generator) => {
    const from = generator.valueToCode(block, 'FROM', Order.NONE) || '0';
    const to = generator.valueToCode(block, 'TO', Order.NONE) || '0';
    const aNum = Number(from.trim());
    const bNum = Number(to.trim());
    if (
      /^-?\d+$/.test(from.trim()) &&
      /^-?\d+$/.test(to.trim()) &&
      Number.isInteger(aNum) &&
      Number.isInteger(bNum)
    ) {
      const lo = Math.min(aNum, bNum);
      const hi = Math.max(aNum, bNum);
      const span = hi - lo + 1;
      if (lo === 0) {
        return [`Math.floor(Math.random() * ${span})`, Order.FUNCTION_CALL];
      }
      return [
        `Math.floor(Math.random() * ${span}) + ${lo}`,
        Order.ADDITION,
      ];
    }
    return [
      `Math.floor(Math.random() * ((${to}) - (${from}) + 1)) + (${from})`,
      Order.ADDITION,
    ];
  };

  javascriptGenerator.forBlock['text_append'] = (block, generator) => {
    const ref = formatJsVarRef(
      String(block.getFieldValue('VAR') || ''),
      generator,
      block,
    );
    const val = generator.valueToCode(block, 'TEXT', Order.NONE) || '""';
    return `${ref} = String(${ref}) + String(${val});\n`;
  };

  const origControlsFor = javascriptGenerator.forBlock['controls_for'];
  if (origControlsFor) {
    javascriptGenerator.forBlock['controls_for'] = (block, generator) => {
      const out = origControlsFor(block, generator);
      if (typeof out !== 'string') return out;
      const varId = String(block.getFieldValue('VAR') || '');
      const ref = formatJsVarRef(varId, generator, block);
      const ident = generator.getVariableName(varId);
      if (ref === ident) return out;
      return out.replace(new RegExp(`\\b${ident}\\b`, 'g'), ref);
    };
  }

  javascriptGenerator.forBlock['controls_forEach'] = (block, generator) => {
    const ref = formatJsVarRef(
      String(block.getFieldValue('VAR') || ''),
      generator,
      block,
    );
    const list = generator.valueToCode(block, 'LIST', Order.ASSIGNMENT) || '[]';
    const rawBranch = generator.statementToCode(block, 'DO');
    const branch =
      rawBranch ||
      (codegenContext.debugPass ? '  await _poly_yield_check();\n' : '');
    return `for (const _item of ${list}) {\n  ${ref} = _item;\n${branch}}\n`;
  };

  // Unified Scheme 1 single-thread coroutine ABI: `on_start` ALWAYS exports as `async function on_start()`
  javascriptGenerator.forBlock['poly_on_start'] = (block, generator) => {
    const hoistedLocals = buildJsHoistedLocalsLine([block], 'BODY', '  ');
    const body = generator.statementToCode(block, 'BODY');
    if (codegenContext.debugPass) {
      return `async function on_start() {\n${hoistedLocals}${body}}\n`;
    }
    return (
      `${SENTINEL_START_PREFIX}'${block.id}'__\n` +
      `async function on_start() {\n` +
      `${hoistedLocals}${body}` +
      `}\n` +
      `${SENTINEL_END_PREFIX}'${block.id}'__\n`
    );
  };

  javascriptGenerator.forBlock['poly_print'] = (block, generator) => {
    const value = generator.valueToCode(block, 'VALUE', Order.NONE) || '""';
    return `console.log(${value});\n`;
  };

  javascriptGenerator.forBlock['poly_log'] = (block, generator) => {
    const level = block.getFieldValue('LEVEL') || 'INFO';
    const msg = generator.valueToCode(block, 'MESSAGE', Order.NONE) || '""';
    return `console.log("[${level}] " + String(${msg}));\n`;
  };

  javascriptGenerator.forBlock['poly_print_kv'] = (block, generator) => {
    const rawLabel = block.getFieldValue('LABEL') || 'value';
    const label = JSON.stringify(`${rawLabel} =`);
    const value = generator.valueToCode(block, 'VALUE', Order.NONE) || 'null';
    return `console.log(${label}, ${value});\n`;
  };

  javascriptGenerator.forBlock['poly_repeat_times'] = (block, generator) => {
    const times = generator.valueToCode(block, 'TIMES', Order.NONE) || '0';
    const rawBranch = generator.statementToCode(block, 'DO');
    const branch =
      rawBranch ||
      (codegenContext.debugPass ? '  await _poly_yield_check();\n' : '');
    const trimmed = times.trim();
    const limitExpr = /^\d+$/.test(trimmed) ? trimmed : `Math.trunc(${times})`;
    return `for (let _count = 0; _count < ${limitExpr}; _count++) {\n${branch}}\n`;
  };

  javascriptGenerator.forBlock['poly_for_range'] = (block, generator) => {
    const variableName = formatJsVarRef(
      String(block.getFieldValue('VAR') || ''),
      generator,
      block,
    );
    const from = generator.valueToCode(block, 'FROM', Order.ASSIGNMENT) || '1';
    const to = generator.valueToCode(block, 'TO', Order.ASSIGNMENT) || '1';
    const by = generator.valueToCode(block, 'BY', Order.ASSIGNMENT) || '1';
    const rawBranch = generator.statementToCode(block, 'DO');
    const branch =
      rawBranch ||
      (codegenContext.debugPass ? '  await _poly_yield_check();\n' : '');

    const byTrim = by.trim();
    const byNum = Number(byTrim);
    if (/^-?\d+(?:\.\d+)?$/.test(byTrim) && Number.isFinite(byNum)) {
      if (byNum === 1) {
        return `for (${variableName} = ${from}; ${variableName} <= ${to}; ${variableName}++) {\n${branch}}\n`;
      }
      if (byNum === -1) {
        return `for (${variableName} = ${from}; ${variableName} >= ${to}; ${variableName}--) {\n${branch}}\n`;
      }
      if (byNum >= 0) {
        return `for (${variableName} = ${from}; ${variableName} <= ${to}; ${variableName} += ${byTrim}) {\n${branch}}\n`;
      }
      return `for (${variableName} = ${from}; ${variableName} >= ${to}; ${variableName} += ${byTrim}) {\n${branch}}\n`;
    }

    return `for (let _step = ${by}, _end = ${to}, _ = (${variableName} = ${from}); _step >= 0 ? ${variableName} <= _end : ${variableName} >= _end; ${variableName} += _step) {\n${branch}}\n`;
  };

  // Unified Scheme 1 coroutine sleep ABI: IDENTICAL in clean hardware export and sandbox!
  javascriptGenerator.forBlock['poly_wait_ms'] = (block, generator) => {
    const ms = generator.valueToCode(block, 'MS', Order.NONE) || '0';
    return `await sleep_ms(${ms});\n`;
  };

  const origJsWhileUntil = javascriptGenerator.forBlock['controls_whileUntil'];
  if (origJsWhileUntil) {
    javascriptGenerator.forBlock['controls_whileUntil'] = (block, generator) => {
      const code = origJsWhileUntil(block, generator);
      if (
        codegenContext.debugPass &&
        typeof code === 'string' &&
        !block.getInputTargetBlock('DO')
      ) {
        return code.replace(/\{\s*\}\n?$/, '{\n  await _poly_yield_check();\n}\n');
      }
      return code;
    };
  }

  javascriptGenerator.forBlock['poly_comment'] = (block) => {
    const text = (block.getFieldValue('TEXT') || '').replace(/\r?\n/g, ' ');
    return `// ${text}\n`;
  };

  javascriptGenerator.forBlock['poly_require_script'] = (block) => {
    const raw = String(block.getFieldValue('SCRIPT') || '').trim();
    if (!raw) return `// 未选择目标脚本\n`;
    const ident = sanitizeLocalIdent(raw);
    return `require(${JSON.stringify(ident)});\n`;
  };

  javascriptGenerator.forBlock['poly_local_set'] = (block, generator) => {
    const rawName = String(block.getFieldValue('NAME') || 'tmp');
    const ident = sanitizeLocalIdent(rawName);
    const val = generator.valueToCode(block, 'VALUE', Order.ASSIGNMENT) || 'null';
    const rootId = block.getRootBlock().id;
    const isHoisted = codegenContext.hoistedLocalsByRoot.get(rootId)?.has(ident);
    return isHoisted ? `${ident} = ${val};\n` : `let ${ident} = ${val};\n`;
  };

  javascriptGenerator.forBlock['poly_local_get'] = (block) => {
    const rawName = String(block.getFieldValue('NAME') || 'tmp');
    return [sanitizeLocalIdent(rawName), Order.ATOMIC];
  };

  javascriptGenerator.forBlock['poly_to_string'] = (block, generator) => {
    const value = generator.valueToCode(block, 'VALUE', Order.NONE) || '""';
    return [`String(${value})`, Order.FUNCTION_CALL];
  };

  javascriptGenerator.forBlock['poly_str_replace'] = (block, generator) => {
    const src = generator.valueToCode(block, 'SRC', Order.NONE) || '""';
    const oldStr = generator.valueToCode(block, 'OLD', Order.NONE) || '""';
    const newStr = generator.valueToCode(block, 'NEW', Order.NONE) || '""';
    return [
      `String(${src}).split(String(${oldStr})).join(String(${newStr}))`,
      Order.FUNCTION_CALL,
    ];
  };

  // Pure value-slot list primitives (zero hidden helper functions!)
  javascriptGenerator.forBlock['poly_list_append'] = (block, generator) => {
    const listCode = generator.valueToCode(block, 'LIST', Order.MEMBER) || '[]';
    const item = generator.valueToCode(block, 'ITEM', Order.NONE) || 'null';
    return `${listCode}.push(${item});\n`;
  };

  javascriptGenerator.forBlock['poly_list_get'] = (block, generator) => {
    const listCode = generator.valueToCode(block, 'LIST', Order.MEMBER) || '[]';
    const idx = generator.valueToCode(block, 'INDEX', Order.NONE) || '1';
    return [`${listCode}[${formatJsZeroBasedIndex(idx)}]`, Order.MEMBER];
  };

  javascriptGenerator.forBlock['poly_list_set'] = (block, generator) => {
    const listCode = generator.valueToCode(block, 'LIST', Order.MEMBER) || '[]';
    const idx = generator.valueToCode(block, 'INDEX', Order.NONE) || '1';
    const val = generator.valueToCode(block, 'VALUE', Order.ASSIGNMENT) || 'null';
    return `${listCode}[${formatJsZeroBasedIndex(idx)}] = ${val};\n`;
  };

  javascriptGenerator.forBlock['poly_list_remove'] = (block, generator) => {
    const listCode = generator.valueToCode(block, 'LIST', Order.MEMBER) || '[]';
    const idx = generator.valueToCode(block, 'INDEX', Order.NONE) || '1';
    return `${listCode}.splice(${formatJsZeroBasedIndex(idx)}, 1);\n`;
  };

  // Pure value-slot dict primitives (zero hidden helpers, native JS objects, supports nested chaining)
  javascriptGenerator.forBlock['poly_dict_new'] = () => ['{}', Order.ATOMIC];

  javascriptGenerator.forBlock['poly_dict_set'] = (block, generator) => {
    const rawDict = generator.valueToCode(block, 'DICT', Order.MEMBER) || '({})';
    const dictCode = rawDict.trim() === '{}' ? '({})' : rawDict;
    const key = generator.valueToCode(block, 'KEY', Order.NONE) || '""';
    const val = generator.valueToCode(block, 'VAL', Order.ASSIGNMENT) || 'null';
    return `${dictCode}[${key}] = ${val};\n`;
  };

  javascriptGenerator.forBlock['poly_dict_get'] = (block, generator) => {
    const rawDict = generator.valueToCode(block, 'DICT', Order.MEMBER) || '({})';
    const dictCode = rawDict.trim() === '{}' ? '({})' : rawDict;
    const key = generator.valueToCode(block, 'KEY', Order.NONE) || '""';
    return [`(${dictCode}[${key}] ?? null)`, Order.ATOMIC];
  };

  javascriptGenerator.forBlock['poly_dict_has'] = (block, generator) => {
    const rawDict = generator.valueToCode(block, 'DICT', Order.IN) || '({})';
    const dictCode = rawDict.trim() === '{}' ? '({})' : rawDict;
    const key = generator.valueToCode(block, 'KEY', Order.IN) || '""';
    return [`(${key} in ${dictCode})`, Order.ATOMIC];
  };

  javascriptGenerator.forBlock['poly_dict_delete'] = (block, generator) => {
    const rawDict = generator.valueToCode(block, 'DICT', Order.MEMBER) || '({})';
    const dictCode = rawDict.trim() === '{}' ? '({})' : rawDict;
    const key = generator.valueToCode(block, 'KEY', Order.NONE) || '""';
    return `delete ${dictCode}[${key}];\n`;
  };

  // Wrap built-in procedure defs/calls:
  // 1) Shared functions live ONLY in `shared.js` (suppressed in normal script files)
  // 2) Hoist all `poly_local_set` vars as `let ident = null;` at function top
  // 3) Emit `async function` + `await` for procedures containing `sleep_ms` (and all procs in debugPass)
  const origDefNoReturn = javascriptGenerator.forBlock['procedures_defnoreturn'];
  const origDefReturn = javascriptGenerator.forBlock['procedures_defreturn'];

  if (origDefReturn) {
    const wrapDef =
      (orig: typeof origDefReturn) =>
      (block: Blockly.Block, generator: typeof javascriptGenerator) => {
        const rawName = String(block.getFieldValue('NAME') || '').trim();
        const sharedFnSet = new Set(getActiveHandleSharedFunctions() ?? []);
        const isSharedFn = sharedFnSet.has(rawName);
        if (isSharedFn && !codegenContext.compilingSharedModule) {
          return null;
        }

        const hoistedLocals = buildJsHoistedLocalsLine([block], 'STACK', '  ');
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
              /(^|\n)((?:async\s+)?function\s+[^\n]+\{\n)/,
              `$1$2${hoistedLocals}`,
            );
          }

          const shouldBeAsync =
            codegenContext.debugPass ||
            codegenContext.asyncFnNames.has(rawName);
          if (shouldBeAsync) {
            nextCode = nextCode.replace(/(^|\n)function /, '$1async function ');
          }

          defs[defKey] = nextCode;
        }
        return out;
      };
    javascriptGenerator.forBlock['procedures_defreturn'] = wrapDef(origDefReturn);
    if (origDefNoReturn) {
      javascriptGenerator.forBlock['procedures_defnoreturn'] =
        wrapDef(origDefNoReturn);
    }
  }

  const formatJsProcCall = (
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

    const expr = `${fnIdent}(${argsStr})`;
    if (codegenContext.debugPass || isAsyncClean) {
      return asExpr ? `(await ${expr})` : `await ${expr}`;
    }
    return expr;
  };

  javascriptGenerator.forBlock['procedures_callnoreturn'] = (block, generator) => {
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
      args.push(generator.valueToCode(block, `ARG${i}`, Order.NONE) || 'null');
    }
    return `${formatJsProcCall(rawName, fnIdent, args.join(', '), isShared, false)};\n`;
  };

  javascriptGenerator.forBlock['procedures_callreturn'] = (block, generator) => {
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
      args.push(generator.valueToCode(block, `ARG${i}`, Order.NONE) || 'null');
    }
    const out = formatJsProcCall(rawName, fnIdent, args.join(', '), isShared, true);
    const needsAtomic =
      codegenContext.debugPass || codegenContext.asyncFnNames.has(rawName);
    return [out, needsAtomic ? Order.ATOMIC : Order.FUNCTION_CALL];
  };

  const emitJsSharedFnCall = (
    block: Blockly.Block,
    generator: typeof javascriptGenerator,
    asExpr: boolean,
  ): string => {
    const meta = (
      block as Blockly.Block & {
        sharedFnMeta_?: { scriptName: string; fnName: string; params: string[] };
      }
    ).sharedFnMeta_ ?? { scriptName: 'shared', fnName: 'my_func', params: [] };
    const fnIdent = generator.getProcedureName(meta.fnName);
    const args = meta.params.map(
      (_p, idx) => generator.valueToCode(block, `ARG${idx}`, Order.NONE) || 'null',
    );
    return formatJsProcCall(meta.fnName, fnIdent, args.join(', '), true, asExpr);
  };

  javascriptGenerator.forBlock['poly_call_shared_noreturn'] = (block, generator) => {
    return `${emitJsSharedFnCall(block, generator, false)};\n`;
  };

  javascriptGenerator.forBlock['poly_call_shared_return'] = (block, generator) => {
    const meta = (
      block as Blockly.Block & { sharedFnMeta_?: { fnName: string } }
    ).sharedFnMeta_;
    const needsAtomic =
      codegenContext.debugPass ||
      Boolean(meta?.fnName && codegenContext.asyncFnNames.has(meta.fnName));
    return [
      emitJsSharedFnCall(block, generator, true),
      needsAtomic ? Order.ATOMIC : Order.FUNCTION_CALL,
    ];
  };

  jsGeneratorsRegistered = true;
}

/** Unified single-track JavaScript async coroutine & event-loop scheduler driver. */
function buildJsEventLoopDriver(
  keepAliveExternal: boolean,
  finalSnapExpr: string,
): string {
  return `
const _has_start = typeof on_start === "function";
const _has_run = typeof on_run === "function";
const _has_timer = typeof on_timer === "function";
const _has_ext = ${keepAliveExternal ? 'true' : 'false'};

async function _poly_start_runner() {
  try {
    const _keep = await _poly.wait_start_turn();
    if (!_keep) return;
    _POLY_IN_START = true;
    _POLY_SLICE_START = _poly.now_ms();
    await on_start();
  } catch (_e) {
    if (!(_e instanceof _PolyStopStart)) {
      _POLY_START_ERR = _e;
    }
  } finally {
    _POLY_IN_START = false;
    _poly.co_done();
  }
}

async function _poly_call_cb(_cname, _fn, ..._args) {
  if (typeof _fn !== "function") return;
  _POLY_ACTIVE_CB = _cname;
  _poly.cb_enter(_cname);
  try {
    await _fn(..._args);
  } catch (_e) {
    if (!(_e instanceof _PolyStopCb)) {
      throw _e;
    }
  } finally {
    _POLY_ACTIVE_CB = "";
    _poly.cb_exit();
  }
}

function _poly_refresh_handlers() {
  _poly.sync_handlers(
    typeof on_run === "function",
    typeof on_timer === "function",
    _has_ext
  );
}

const _start_task = _has_start ? _poly_start_runner() : null;
try {
  if (_poly.init_scheduler(_has_start, _has_run, _has_timer, _has_ext)) {
    while (true) {
      const _ev = await _poly.next_event();
      if (_ev === "start_resume") {
        await _poly.resume_start_slice();
        if (_POLY_START_ERR !== null) {
          throw _POLY_START_ERR;
        }
        _poly_refresh_handlers();
      } else if (_ev === "run") {
        if (typeof on_run === "function") {
          await _poly_call_cb("on_run", on_run);
        }
        _poly_refresh_handlers();
      } else if (typeof _ev === "string" && _ev.startsWith("timer:")) {
        if (typeof on_timer === "function") {
          await _poly_call_cb("on_timer", on_timer, Number(_ev.slice(6)));
        }
        _poly_refresh_handlers();
      } else if (typeof _ev === "string" && _ev.startsWith("event:")) {
        const _epayload = JSON.parse(_ev.slice(6));
        const _ename = _epayload[0];
        const _eargs = Array.isArray(_epayload[1]) ? _epayload[1] : [];
        const _efn = _poly_lookup_handler(_ename);
        if (typeof _efn === "function") {
          await _poly_call_cb(_ename, _efn, ..._eargs);
        }
        _poly_refresh_handlers();
      } else {
        break;
      }
    }
  }
} finally {
  if (_start_task !== null) {
    _poly.co_done();
    try {
      await _start_task;
    } catch (_ignore) {
      // ignore teardown errors
    }
  }
}
if (typeof on_stop === "function") {
  await _poly_call_cb("on_stop", on_stop);
}
_poly.final_snap(_poly_snap(${finalSnapExpr}));
`;
}

interface JsDebugMeta {
  snapExpr: string;
  sharedSnapEntries: Array<[string, string]>;
  activeSharedModName: string;
}

export class JsBackendAdapter extends BaseScriptBackend<JsDebugMeta> {
  readonly id = JS_DIALECT.id;
  readonly name = 'JavaScript';
  readonly version = 'ES2023';
  readonly extension = JS_DIALECT.extension;
  readonly fileName = `main.${JS_DIALECT.extension}`;
  readonly accentColor = '#f59e0b';
  readonly description =
    '标准 ES2023 / CommonJS 脚本生成器，支持 Style A1 只读 shared 模块、async/await 单轨协程 ABI 与浏览器 Worker 零额外体积沙箱。';
  readonly dialect = JS_DIALECT;

  protected readonly bareAttrInSharedModule = false;
  protected readonly orderNone = Order.NONE;
  protected readonly orderAtomic = Order.ATOMIC;
  protected readonly topLevelDebugTickRe = /^await _poly_tick\(/;

  protected ensureGeneratorsRegistered(): void {
    registerJsBlockGenerators();
  }

  protected getGenerator(): BlocklyGeneratorLike {
    return javascriptGenerator;
  }

  protected formatFileHeader(eventDriven: boolean): string {
    return eventDriven
      ? `// 由 PolyBlock 自动生成 (Target: JavaScript ES2023 · Async Coroutine Event ABI)\n`
      : `// 由 PolyBlock 自动生成 (Target: JavaScript ES2023 · Async Coroutine ABI)\n`;
  }

  protected formatSharedModuleImport(moduleName: string): string {
    return `const ${moduleName} = require(${JSON.stringify(moduleName)});`;
  }

  protected buildPassContextOptions(
    debugPass: boolean,
    analysis: WorkspacePassAnalysis,
  ): CodegenPassContextOptions {
    const sharedVarIdToAttr = new Map<string, string>();
    const sharedVarIdents = new Set<string>();
    const usedVarIdents = new Set<string>();

    for (const v of analysis.variables) {
      if (!v.used) continue;
      usedVarIdents.add(v.ident);
      if (v.sharedAttr && analysis.sharedModuleName) {
        sharedVarIdToAttr.set(v.id, v.sharedAttr);
        sharedVarIdents.add(v.ident);
      }
    }

    return {
      debugPass,
      sharedModuleName: analysis.sharedModuleName,
      sharedVarIdToAttr,
      sharedVarIdents,
      usedVarIdents,
      asyncFnNames: analysis.asyncFnNames,
    };
  }

  protected prepareDebugPass(
    analysis: WorkspacePassAnalysis,
    allLocalEntries: Array<{ label: string; ident: string }>,
    usedSharedClean: boolean,
  ): DebugPassPreparation<JsDebugMeta> {
    const sharedVarIdents = new Set<string>();
    const sharedSnapEntries: Array<[string, string]> = [];
    for (const v of analysis.variables) {
      if (v.used && v.sharedAttr && analysis.sharedModuleName) {
        sharedVarIdents.add(v.ident);
        sharedSnapEntries.push([v.label, v.sharedAttr]);
      }
    }

    const snapVarEntries: Array<{ label: string; ident: string }> =
      analysis.variables
        .filter((v) => !sharedVarIdents.has(v.ident))
        .map((v) => ({ label: v.label, ident: v.ident }));
    const seenLabels = new Set([
      ...snapVarEntries.map((e) => e.label),
      ...sharedSnapEntries.map(([label]) => label),
    ]);
    for (const loc of allLocalEntries) {
      if (!seenLabels.has(loc.label)) {
        seenLabels.add(loc.label);
        snapVarEntries.push({ label: loc.label, ident: loc.ident });
      }
    }

    const snapExpr = buildJsSnapObjectLiteral(snapVarEntries);
    const activeSharedModName =
      usedSharedClean && analysis.sharedModuleName
        ? analysis.sharedModuleName
        : '';

    return {
      statementPrefix: `await _poly_tick(%1, _poly_snap(${snapExpr}));\n`,
      meta: {
        snapExpr,
        sharedSnapEntries,
        activeSharedModName,
      },
    };
  }

  protected assembleDebugOutputs(
    input: DebugAssemblyInput<JsDebugMeta>,
  ): { debugCode: string; moduleDebugCode: string } {
    const {
      fullDebugBody,
      companionDebugBody,
      keepAliveExternal,
      usedSharedDebug,
      sharedModuleName,
      debugMeta,
    } = input;

    const activeSharedModName =
      usedSharedDebug && sharedModuleName
        ? sharedModuleName
        : debugMeta.activeSharedModName;

    const snapHelperLines = [
      `const _POLY_SHARED_MOD = ${JSON.stringify(activeSharedModName)};`,
      `const _POLY_SHARED_MAP = ${JSON.stringify(debugMeta.sharedSnapEntries)};`,
      `function _poly_repr(_v) {`,
      `  if (_v === null) return "null";`,
      `  if (typeof _v === "string") return JSON.stringify(_v);`,
      `  if (typeof _v === "object") {`,
      `    try { return JSON.stringify(_v); } catch (_e) { return String(_v); }`,
      `  }`,
      `  return String(_v);`,
      `}`,
      `function _poly_snap(_locals) {`,
      `  const _out = {};`,
      `  if (_locals && typeof _locals === "object") {`,
      `    for (const [_label, _v] of Object.entries(_locals)) {`,
      `      if (_v !== undefined) _out[_label] = _poly_repr(_v);`,
      `    }`,
      `  }`,
      `  if (_POLY_SHARED_MOD && _POLY_SHARED_MAP.length > 0) {`,
      `    const _sm = _poly_get_loaded_mod(_POLY_SHARED_MOD);`,
      `    if (_sm && typeof _sm === "object") {`,
      `      for (const [_label, _attr] of _POLY_SHARED_MAP) {`,
      `        if (Object.prototype.hasOwnProperty.call(_sm, _attr) && _sm[_attr] !== undefined) {`,
      `          _out[_label] = _poly_repr(_sm[_attr]);`,
      `        }`,
      `      }`,
      `    }`,
      `  }`,
      `  return JSON.stringify(_out);`,
      `}`,
    ];

    const debugPrelude = [
      `const _poly = require("_poly");`,
      `let _POLY_IN_START = false;`,
      `let _POLY_ACTIVE_CB = "";`,
      `let _POLY_SLICE_START = 0;`,
      `let _POLY_START_ERR = null;`,
      `class _PolyStopStart extends Error {}`,
      `class _PolyStopCb extends Error {}`,
      `async function sleep_ms(_ms) {`,
      `  if (_poly.is_in_callback() || !_POLY_IN_START) {`,
      `    throw new Error("禁止在事件回调（on_run / on_timer / on_button / on_stop）或顶层脚本中调用等待 (sleep_ms)；请移至「当程序启动 (on_start)」协程内。");`,
      `  }`,
      `  _POLY_IN_START = false;`,
      `  _poly.co_sleep(_ms);`,
      `  const _keep = await _poly.wait_start_turn();`,
      `  if (!_keep) throw new _PolyStopStart();`,
      `  _POLY_IN_START = true;`,
      `  _POLY_SLICE_START = _poly.now_ms();`,
      `}`,
      `async function _poly_tick(_bid, _snap) {`,
      `  if (_POLY_IN_START && !_poly.is_in_callback()) {`,
      `    await _poly.step_start(_bid, _snap);`,
      `    if (_poly.is_stop_requested()) throw new _PolyStopStart();`,
      `    if ((_poly.now_ms() - _POLY_SLICE_START) >= _poly.get_time_slice_ms()) {`,
      `      _POLY_IN_START = false;`,
      `      _poly.co_yield_slice();`,
      `      const _keep = await _poly.wait_start_turn();`,
      `      if (!_keep) throw new _PolyStopStart();`,
      `      _POLY_IN_START = true;`,
      `      _POLY_SLICE_START = _poly.now_ms();`,
      `    }`,
      `    return;`,
      `  }`,
      `  await _poly.step(_bid, _snap);`,
      `  if (_poly.is_in_callback()) {`,
      `    if (_poly.is_stop_requested() && _POLY_ACTIVE_CB !== "on_stop") {`,
      `      throw new _PolyStopCb();`,
      `    }`,
      `    if (_poly.cb_expired()) {`,
      `      throw new Error("事件回调执行超时（疑似死循环），已按单次回调超时保护中断。");`,
      `    }`,
      `  }`,
      `}`,
      `async function _poly_yield_check() {`,
      `  if (_POLY_IN_START && !_poly.is_in_callback()) {`,
      `    if (_poly.is_stop_requested()) throw new _PolyStopStart();`,
      `    if ((_poly.now_ms() - _POLY_SLICE_START) >= _poly.get_time_slice_ms()) {`,
      `      _POLY_IN_START = false;`,
      `      _poly.co_yield_slice();`,
      `      const _keep = await _poly.wait_start_turn();`,
      `      if (!_keep) throw new _PolyStopStart();`,
      `      _POLY_IN_START = true;`,
      `      _POLY_SLICE_START = _poly.now_ms();`,
      `    }`,
      `  } else if (_poly.is_in_callback()) {`,
      `    if (_poly.is_stop_requested() && _POLY_ACTIVE_CB !== "on_stop") {`,
      `      throw new _PolyStopCb();`,
      `    }`,
      `    if (_poly.cb_expired()) {`,
      `      throw new Error("事件回调执行超时（疑似死循环），已按单次回调超时保护中断。");`,
      `    }`,
      `  }`,
      `}`,
      `async function _poly_call_mod(_mname, _fname, ..._args) {`,
      `  const _m = require(_mname);`,
      `  const _fn = _m && _m[_fname];`,
      `  if (typeof _fn !== "function") {`,
      `    throw new Error(\`模块 "\${_mname}" 中未找到函数 "\${_fname}"\`);`,
      `  }`,
      `  return await _fn(..._args);`,
      `}`,
      `async function _poly_call_global(_fname, ..._args) {`,
      `  const _fn = globalThis[_fname];`,
      `  if (typeof _fn === "function") {`,
      `    return await _fn(..._args);`,
      `  }`,
      `}`,
      `_poly_register_rt({`,
      `  _poly_tick,`,
      `  _poly_yield_check,`,
      `  sleep_ms,`,
      `  _poly_call_mod,`,
      `  _poly_call_global,`,
      `});`,
      ...snapHelperLines,
      ``,
    ].join('\n');

    const companionDebugPrelude = [
      `const { _poly_tick, _poly_yield_check, sleep_ms, _poly_call_mod, _poly_call_global } = require("_poly_rt");`,
      ...snapHelperLines,
      ``,
    ].join('\n');

    // Collect top-level `on_*` handler declarations in main debug script so custom declarative
    // `emitEvent` callbacks (e.g. `on_button`, `on_drive_estop`) resolve cleanly via `_poly_lookup_handler`.
    const declaredHandlers = Array.from(
      new Set(
        Array.from(
          fullDebugBody.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+(on_[A-Za-z0-9_]*)\s*\(/g),
        ).map((m) => m[1]),
      ),
    );
    const handlerLookupLines = [
      `function _poly_lookup_handler(_name) {`,
      `  switch (_name) {`,
      ...declaredHandlers.map(
        (h) => `    case ${JSON.stringify(h)}: return ${h};`,
      ),
      `    default: return typeof globalThis[_name] === "function" ? globalThis[_name] : null;`,
      `  }`,
      `}`,
    ].join('\n');

    const driver = buildJsEventLoopDriver(keepAliveExternal, debugMeta.snapExpr);
    const debugCode = fullDebugBody
      ? `${debugPrelude}${fullDebugBody}\n${handlerLookupLines}\n${driver}`
      : '';
    const moduleDebugCode = companionDebugBody.trim()
      ? `${companionDebugPrelude}${companionDebugBody}\n`
      : '';
    return { debugCode, moduleDebugCode };
  }

  protected getSharedProcDebugStatementPrefix(
    input: SharedProcCompileInput,
    snapEntries: Array<{ label: string; attr: string }>,
  ): string {
    const props = snapEntries.map(
      ({ label, attr }) =>
        `${JSON.stringify(label)}: ${input.moduleName}.${attr}`,
    );
    return `await _poly_tick(%1, _poly_snap({ ${props.join(', ')} }));\n`;
  }

  formatDispatchRouter(
    eventName: string,
    branches: EntryDispatchBranchSpec[],
    debugPass: boolean,
  ): { autoImports: string[]; code: string } {
    if (branches.length === 0) return { autoImports: [], code: '' };
    const paramsStr = (branches[0].params ?? []).join(', ');
    const defKw = debugPass ? 'async function' : 'function';
    const lines: string[] = [];
    branches.forEach((br, idx) => {
      const kw = idx === 0 ? 'if' : '} else if';
      const cond = br.condition.js ?? this.dialect.boolTrue;
      const comment = br.comment.js ?? '';
      const callArgs = br.passParams ? paramsStr : '';
      const srcTag = br.isLocal
        ? ''
        : comment
          ? ` (${br.scriptName}.js)`
          : ` // ${br.scriptName}.js`;
      if (br.isLocal) {
        const callExpr = debugPass
          ? `await ${br.fnName}(${callArgs});`
          : `${br.fnName}(${callArgs});`;
        lines.push(`  ${kw} (${cond}) {${comment}${srcTag}\n    ${callExpr}`);
      } else if (debugPass) {
        const callArgsWithName = callArgs
          ? `${JSON.stringify(br.fnName)}, ${callArgs}`
          : `${JSON.stringify(br.fnName)}`;
        lines.push(
          `  ${kw} (${cond}) {${comment}${srcTag}\n` +
            `    await _poly_call_global(${callArgsWithName});`,
        );
      } else {
        lines.push(
          `  ${kw} (${cond}) {${comment}${srcTag}\n` +
            `    if (typeof globalThis.${br.fnName} === "function") {\n` +
            `      globalThis.${br.fnName}(${callArgs});\n` +
            `    }`,
        );
      }
    });
    return {
      autoImports: [],
      code: `${defKw} ${eventName}(${paramsStr}) {\n${lines.join('\n')}\n  }\n}\n`,
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
        'js',
        {
          resolveValueInput: (blk, argName) =>
            javascriptGenerator.valueToCode(blk, argName, Order.NONE) || '""',
          resolveVarField: (blk, argName) =>
            formatJsVarRef(
              String(blk.getFieldValue(argName) || ''),
              javascriptGenerator,
              blk,
            ),
        },
        pack,
        section,
      );

    javascriptGenerator.forBlock[b.type] = (block, generator) => {
      hoistImports(generator, hatSpec.imports?.js);
      const defKw = codegenContext.debugPass ? 'async function' : 'function';

      if (hatSpec.mode === 'singleton') {
        const hoistedLocals = buildJsHoistedLocalsLine([block], 'BODY', '  ');
        const body = generator.statementToCode(block, 'BODY');
        if (codegenContext.debugPass) {
          return `${defKw} ${hatSpec.eventName}(${paramsStr}) {\n${hoistedLocals}${body}}\n`;
        }
        return (
          `${SENTINEL_START_PREFIX}'${block.id}'__\n` +
          `${defKw} ${hatSpec.eventName}(${paramsStr}) {\n` +
          `${hoistedLocals}${body}` +
          `}\n` +
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
          const hoistedLocals = buildJsHoistedLocalsLine([hatBlk], 'BODY', '  ');
          const rawBody = generator.statementToCode(hatBlk, 'BODY');
          const headerComment = comment.trim() ? `${comment.trim()}\n` : '';
          const exportLine = `globalThis.${fnName} = ${fnName};\n`;
          if (codegenContext.debugPass) {
            return `${defKw} ${fnName}(${branchParamsStr}) {\n${hoistedLocals}${rawBody}}\n${exportLine}`;
          }
          return (
            `${SENTINEL_START_PREFIX}'${hatBlk.id}'__\n` +
            `${headerComment}` +
            `${defKw} ${fnName}(${branchParamsStr}) {\n` +
            `${hoistedLocals}${rawBody}` +
            `}\n` +
            `${exportLine}` +
            `${SENTINEL_END_PREFIX}'${hatBlk.id}'__\n`
          );
        });

        return `${fnDefs.join('\n')}`;
      }

      const dispatchHoistedLocals = buildJsHoistedLocalsLine(
        matchingHats,
        'BODY',
        '  ',
      );
      const branches: string[] = [];
      matchingHats.forEach((hatBlk, idx) => {
        const kw = idx === 0 ? 'if' : '} else if';
        const cond = hatSpec.condition?.js
          ? renderHatTpl(hatSpec.condition.js, hatBlk)
          : this.dialect.boolTrue;
        const comment = hatSpec.branchComment?.js
          ? renderHatTpl(hatSpec.branchComment.js, hatBlk)
          : '';
        const rawBody = generator.statementToCode(hatBlk, 'BODY');
        const indentedBody = rawBody.trim() ? indentLines(rawBody, '  ') : '';
        if (codegenContext.debugPass) {
          branches.push(`  ${kw} (${cond}) {${comment}\n${indentedBody}`);
        } else {
          branches.push(
            `${SENTINEL_START_PREFIX}'${hatBlk.id}'__\n` +
              `  ${kw} (${cond}) {${comment}\n` +
              `${indentedBody}` +
              `${SENTINEL_END_PREFIX}'${hatBlk.id}'__\n`,
          );
        }
      });

      return `${defKw} ${hatSpec.eventName}(${paramsStr}) {\n${dispatchHoistedLocals}${branches.join('')}  }\n}\n`;
    };
  }

  formatSharedModuleDocument(input: SharedModuleDocumentInput): {
    source: string;
    debugSource: string;
  } {
    const mod = input.moduleName;
    const varLines = input.variables.map(
      (v) =>
        `${mod}.${v.attr} = ${formatInitialValueForDialect(v.initialValue, JS_DIALECT)};`,
    );

    const buildFnExportLines = (blocks: string[]): string[] => {
      const out: string[] = [];
      for (const fnBlock of blocks) {
        const m = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(
          fnBlock,
        );
        if (m?.[1]) {
          out.push(`${mod}.${m[1]} = ${m[1]};`);
        }
      }
      return out;
    };

    const cleanParts: string[] = [
      `// 由 PolyBlock 自动生成的同句柄跨文件共享模块（只读）`,
    ];
    if (input.importLines.length > 0) cleanParts.push(input.importLines.join('\n'));
    cleanParts.push(`const ${mod} = {};`);
    if (varLines.length > 0) cleanParts.push(varLines.join('\n'));
    if (input.cleanFnBlocks.length > 0) {
      cleanParts.push(input.cleanFnBlocks.join('\n\n'));
      const exportLines = buildFnExportLines(input.cleanFnBlocks);
      if (exportLines.length > 0) cleanParts.push(exportLines.join('\n'));
    }
    cleanParts.push(`module.exports = ${mod};`);
    const source = `${cleanParts.join('\n\n')}\n`;

    const debugParts: string[] = [
      ...(input.debugFnBlocks.length > 0
        ? [
            `const { _poly_tick, _poly_yield_check, sleep_ms, _poly_call_mod, _poly_call_global } = require("_poly_rt");`,
          ]
        : []),
      ...input.importLines,
      `function _poly_repr(_v) {`,
      `  if (_v === null) return "null";`,
      `  if (typeof _v === "string") return JSON.stringify(_v);`,
      `  if (typeof _v === "object") {`,
      `    try { return JSON.stringify(_v); } catch (_e) { return String(_v); }`,
      `  }`,
      `  return String(_v);`,
      `}`,
      `function _poly_snap(_locals) {`,
      `  const _out = {};`,
      `  if (_locals && typeof _locals === "object") {`,
      `    for (const [_label, _v] of Object.entries(_locals)) {`,
      `      if (_v !== undefined) _out[_label] = _poly_repr(_v);`,
      `    }`,
      `  }`,
      `  return JSON.stringify(_out);`,
      `}`,
      `const ${mod} = {};`,
    ];
    if (varLines.length > 0) debugParts.push('', ...varLines);
    if (input.debugFnBlocks.length > 0) {
      debugParts.push('', ...input.debugFnBlocks);
      const dbgExports = buildFnExportLines(input.debugFnBlocks);
      if (dbgExports.length > 0) debugParts.push('', ...dbgExports);
    }
    debugParts.push('', `module.exports = ${mod};`);
    const debugSource = `${debugParts.join('\n')}\n`;

    return { source, debugSource };
  }
}
