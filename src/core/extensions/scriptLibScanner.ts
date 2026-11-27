import type { ScriptLanguageId } from '../../types/project';
import type {
  ExtensionBlockDef,
  ExtensionModuleSource,
  PolyExtensionPack,
} from './types';

export interface ScannedLibFunction {
  id: string;
  moduleName: string;
  funcName: string;
  params: string[];
  inferredKind: 'statement' | 'value';
  /** Editable fields presented in the import preview modal */
  selected: boolean;
  kind: 'statement' | 'value';
  label: string;
}

export interface UploadedScriptLibFile {
  fileName: string;
  moduleName: string;
  language: ScriptLanguageId;
  source: string;
  /** Whether to scan this file's exported functions into blocks (entry lib) vs keep as helper dependency. */
  scanForBlocks: boolean;
  scannedFunctions: ScannedLibFunction[];
}

export function deriveModuleNameFromFileName(fileName: string): string {
  const base = fileName
    .trim()
    .replace(/\.(lua|py)$/i, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return base || 'custom_lib';
}

function splitParamList(rawParams: string): string[] {
  const cleaned = rawParams
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p !== '...' && p !== '*args' && p !== '**kwargs');
  const out: string[] = [];
  for (const part of cleaned) {
    // Strip Python default values & type annotations (e.g. `init: int = 0xFFFF` -> `init`)
    const name = part.split('=')[0].split(':')[0].trim().replace(/^\*+/, '');
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name !== 'self' && name !== 'cls') {
      out.push(name);
    }
  }
  return out;
}

function hasNonEmptyLuaReturn(body: string): boolean {
  // Strip single-line comments first
  const noComments = body.replace(/--[^\n]*/g, '');
  // Match `return <something>` where <something> is not end/else/elseif/until/empty
  return /\breturn\s+(?!\s*(?:$|\n|end\b|else\b|elseif\b|until\b|;))[^\s;]/m.test(
    noComments,
  );
}

function extractLuaBody(source: string, startOffset: number): string {
  // Strip comments and string literals lightly while tracking Lua block nesting depth
  // so the body stops strictly at the matching `end` and NEVER swallows trailing `return M`!
  const slice = source.slice(startOffset, startOffset + 8000);
  const lines = slice.split('\n');
  let depth = 1;
  const bodyLines: string[] = [];

  for (const rawLine of lines) {
    // Remove single-line comments and quoted strings before counting keywords
    const stripped = rawLine
      .replace(/--.*$/, '')
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');

    const tokens = stripped.match(/\b(?:function|if|for|while|repeat|do|end|until)\b/g) ?? [];
    let closedAtThisLine = false;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok === 'function' || tok === 'if' || tok === 'repeat') {
        depth += 1;
      } else if (tok === 'for' || tok === 'while') {
        // `for ... do` / `while ... do` pairs with one `end`; skip the matching `do`
        depth += 1;
      } else if (tok === 'do') {
        // Only standalone `do ... end` adds depth (not `for/while ... do`)
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
      // Include anything before the closing `end` on the same line (e.g. `return x end`)
      const beforeEnd = rawLine.replace(/\bend\b[\s\S]*$/, '');
      if (beforeEnd.trim()) bodyLines.push(beforeEnd);
      break;
    }
    bodyLines.push(rawLine);
  }

  return bodyLines.join('\n');
}

/**
 * Statically scans a Lua 5.4 library file for exported module functions:
 * - `function M.foo(a, b)` / `function mod.foo(a, b)`
 * - `M.foo = function(a, b)`
 * - `return { foo = local_fn, bar = function(x) ... end }`
 * Private `local function` definitions NOT exposed via module table or return table are skipped.
 */
export function scanLuaLibraryFunctions(
  moduleName: string,
  source: string,
): ScannedLibFunction[] {
  const normalized = source.replace(/\r\n/g, '\n');
  const results: ScannedLibFunction[] = [];
  const seen = new Set<string>();

  // Index local functions so `return { calc = calc }` can recover params + return inference
  const localFnMeta = new Map<
    string,
    { params: string[]; inferredKind: 'statement' | 'value' }
  >();
  const localFnRe =
    /^\s*local\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/gm;
  let lm: RegExpExecArray | null;
  while ((lm = localFnRe.exec(normalized)) !== null) {
    const fnName = lm[1];
    const params = splitParamList(lm[2]);
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
    results.push({
      id: `${moduleName}.${funcName}`,
      moduleName,
      funcName,
      params,
      inferredKind,
      selected: true,
      kind: inferredKind,
      label: `${moduleName}.${funcName}`,
    });
  };

  // Pattern 1: `function M.foo(a, b)` (dotted export on any table identifier)
  const dotFnRe =
    /^\s*function\s+[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = dotFnRe.exec(normalized)) !== null) {
    const body = extractLuaBody(normalized, m.index + m[0].length);
    pushCandidate(
      m[1],
      splitParamList(m[2]),
      hasNonEmptyLuaReturn(body) ? 'value' : 'statement',
    );
  }

  // Pattern 2: `M.foo = function(a, b)`
  const assignFnRe =
    /^\s*[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function\s*\(([^)]*)\)/gm;
  while ((m = assignFnRe.exec(normalized)) !== null) {
    const body = extractLuaBody(normalized, m.index + m[0].length);
    pushCandidate(
      m[1],
      splitParamList(m[2]),
      hasNonEmptyLuaReturn(body) ? 'value' : 'statement',
    );
  }

  // Pattern 3: `return { calc = calc, reset = function() ... end }`
  const returnTableRe = /return\s*\{([\s\S]*?)\}\s*$/;
  const rtMatch = returnTableRe.exec(normalized.trim());
  if (rtMatch?.[1]) {
    const tableContent = rtMatch[1];
    // Inline anonymous function entries
    const inlineEntryRe =
      /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function\s*\(([^)]*)\)([\s\S]*?)\bend\b/g;
    let im: RegExpExecArray | null;
    while ((im = inlineEntryRe.exec(tableContent)) !== null) {
      pushCandidate(
        im[1],
        splitParamList(im[2]),
        hasNonEmptyLuaReturn(im[3]) ? 'value' : 'statement',
      );
    }
    // Identifier reference entries (`calc = calc` or `calc = _calc_impl`)
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

/**
 * Statically scans a Python 3 / MicroPython library file for top-level public `def` functions.
 * Strictly skips `_private` / `__dunder__` functions and indented class methods.
 */
export function scanPythonLibraryFunctions(
  moduleName: string,
  source: string,
): ScannedLibFunction[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const results: ScannedLibFunction[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^def\s+([A-Za-z][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->[^:]+)?\s*:/.exec(
      line,
    );
    if (!m) continue;
    const funcName = m[1];
    if (funcName.startsWith('_') || seen.has(funcName)) continue;
    seen.add(funcName);

    const params = splitParamList(m[2]);
    // Collect indented body lines
    const bodyLines: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const bl = lines[j];
      if (bl.trim() === '' || /^\s+#/.test(bl)) continue;
      if (!/^\s+/.test(bl)) break;
      bodyLines.push(bl);
    }
    const bodyStr = bodyLines.join('\n').replace(/#[^\n]*/g, '');
    const hasValReturn = /\breturn\s+(?!\s*(?:$|\n|None\b))[^\s#]/m.test(bodyStr);
    const inferredKind: 'statement' | 'value' = hasValReturn
      ? 'value'
      : 'statement';

    results.push({
      id: `${moduleName}.${funcName}`,
      moduleName,
      funcName,
      params,
      inferredKind,
      selected: true,
      kind: inferredKind,
      label: `${moduleName}.${funcName}`,
    });
  }

  return results;
}

export function scanScriptLibraryFile(
  fileName: string,
  source: string,
  fallbackLang: ScriptLanguageId = 'lua',
): UploadedScriptLibFile {
  const lower = fileName.toLowerCase();
  const language: ScriptLanguageId = lower.endsWith('.py')
    ? 'python'
    : lower.endsWith('.lua')
      ? 'lua'
      : fallbackLang;
  const moduleName = deriveModuleNameFromFileName(fileName);
  const scannedFunctions =
    language === 'python'
      ? scanPythonLibraryFunctions(moduleName, source)
      : scanLuaLibraryFunctions(moduleName, source);

  return {
    fileName,
    moduleName,
    language,
    source,
    scanForBlocks: scannedFunctions.length > 0,
    scannedFunctions,
  };
}

export interface BuildPackFromLibsOptions {
  packId: string;
  packName: string;
  iconLabel: string;
  color: string;
  toolboxOrder: number;
  description?: string;
  files: UploadedScriptLibFile[];
  functions: ScannedLibFunction[];
}

/**
 * Generates a clean, valid single-track `.polyext.json` (`PolyExtensionPack`) from uploaded
 * `.lua` / `.py` script files and user-reviewed candidate functions.
 */
export function buildExtensionPackFromScriptLibs(
  opts: BuildPackFromLibsOptions,
): PolyExtensionPack {
  const safeId =
    opts.packId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'custom-lib';

  const scanEnabledModules = new Set(
    opts.files.filter((f) => f.scanForBlocks).map((f) => f.moduleName),
  );
  const selectedFns = opts.functions.filter(
    (f) => f.selected && scanEnabledModules.has(f.moduleName),
  );
  if (selectedFns.length === 0) {
    throw new Error('请至少勾选 1 个已启用扫描的函数以生成积木');
  }

  // Merge uploaded files by moduleName (supports pairing `crc16.lua` + `crc16.py` under one moduleName!)
  const libMap = new Map<string, ExtensionModuleSource>();
  for (const f of opts.files) {
    const existing = libMap.get(f.moduleName) ?? {
      moduleName: f.moduleName,
      sources: {},
      role: f.scanForBlocks ? 'entry' : 'helper',
    };
    existing.sources[f.language] = f.source;
    if (f.scanForBlocks) existing.role = 'entry';
    libMap.set(f.moduleName, existing);
  }
  const libs = Array.from(libMap.values());

  // Determine which modules & languages are actually provided by uploaded files
  const usedModuleNames = Array.from(new Set(selectedFns.map((f) => f.moduleName)));
  const luaModules = usedModuleNames.filter((mn) => Boolean(libMap.get(mn)?.sources.lua));
  const pyModules = usedModuleNames.filter((mn) => Boolean(libMap.get(mn)?.sources.python));
  const luaImports = luaModules.map(
    (mn) => `local ${mn.replace(/[^A-Za-z0-9_]/g, '_')} = require("${mn}")`,
  );
  const pyImports = pyModules.map((mn) => `import ${mn}`);

  const blocks: ExtensionBlockDef[] = selectedFns.map((fn) => {
    const safeModIdent = fn.moduleName.replace(/[^A-Za-z0-9_]/g, '_');
    const blockType = `ext_${safeId.replace(/-/g, '_')}_${fn.moduleName.replace(/[^A-Za-z0-9_]/g, '_')}_${fn.funcName}`;
    const args0: Array<Record<string, unknown>> = [];
    const shadows: Record<string, { type: 'math_number' | 'text'; value: number | string }> = {};
    const paramParts: string[] = [];
    const callPlaceholders: string[] = [];

    fn.params.forEach((p, idx) => {
      const argName = `ARG${idx + 1}`;
      args0.push({ type: 'input_value', name: argName });
      shadows[argName] = { type: 'text', value: '' };
      paramParts.push(`${p} %${idx + 1}`);
      callPlaceholders.push(`{{${argName}}}`);
    });

    const msgBase = fn.label.trim() || `${fn.moduleName}.${fn.funcName}`;
    const message0 =
      paramParts.length > 0 ? `${msgBase} ${paramParts.join(' ')}` : msgBase;
    const callExpr = `${safeModIdent}.${fn.funcName}(${callPlaceholders.join(', ')})`;
    const pyCallExpr = `${fn.moduleName}.${fn.funcName}(${callPlaceholders.join(', ')})`;
    const modEntry = libMap.get(fn.moduleName);
    const hasLua = Boolean(modEntry?.sources.lua);
    const hasPy = Boolean(modEntry?.sources.python);
    const code: ExtensionBlockDef['code'] = {
      ...(hasLua ? { lua: { template: callExpr } } : {}),
      ...(hasPy ? { python: { template: pyCallExpr } } : {}),
    };

    return {
      type: blockType,
      kind: fn.kind,
      ...(fn.kind === 'value' ? { outputType: null } : {}),
      message0,
      ...(args0.length > 0 ? { args0 } : {}),
      inputsInline: true,
      ...(Object.keys(shadows).length > 0 ? { shadows } : {}),
      tooltip: `调用库模块 ${fn.moduleName}.${fn.funcName}(${fn.params.join(', ')})`,
      keywords: `${opts.packName} ${fn.moduleName} ${fn.funcName} ${msgBase}`,
      code,
    };
  });

  const importsObj: PolyExtensionPack['imports'] =
    luaImports.length > 0 || pyImports.length > 0
      ? {
          ...(luaImports.length > 0 ? { lua: luaImports } : {}),
          ...(pyImports.length > 0 ? { python: pyImports } : {}),
        }
      : undefined;

  return {
    $schema: './schemas/polyext.schema.json',
    format: 'polyblock-extension',
    version: 1,
    id: safeId,
    name: opts.packName.trim() || safeId,
    packVersion: '1.0.0',
    iconLabel: (opts.iconLabel.trim() || safeId).slice(0, 4),
    color: opts.color.startsWith('#') ? opts.color : '#10b981',
    description:
      opts.description?.trim() ||
      `由原生脚本库自动生成的扩展包（含 ${libs.length} 个源码模块，沙箱与真机导出共用）。`,
    builtin: false,
    tags: ['脚本库'],
    ...(importsObj ? { imports: importsObj } : {}),
    sections: [
      {
        id: 'main',
        label: (opts.iconLabel.trim() || safeId).slice(0, 6),
        toolboxOrder: Math.max(0, Math.min(9999, Math.round(opts.toolboxOrder))),
        blocks,
      },
    ],
    libs,
  };
}

/**
 * Merges newly attached `.lua`/`.py` files into an existing pack's `libs[]` array by `moduleName`.
 * Existing modules with the same `moduleName` get their language source updated in place.
 */
export function mergeAttachedLibFiles(
  existingLibs: ExtensionModuleSource[] | undefined,
  files: Array<{
    moduleName: string;
    language: ScriptLanguageId;
    source: string;
    role?: 'entry' | 'helper';
  }>,
): ExtensionModuleSource[] {
  const map = new Map<string, ExtensionModuleSource>();
  for (const lib of existingLibs ?? []) {
    map.set(lib.moduleName, { ...lib, sources: { ...(lib.sources ?? {}) } });
  }
  for (const f of files) {
    const cleanName = f.moduleName.trim();
    if (!cleanName) continue;
    const prev = map.get(cleanName) ?? {
      moduleName: cleanName,
      sources: {},
      role: f.role ?? 'helper',
    };
    prev.sources[f.language] = f.source;
    if (f.role) prev.role = f.role;
    map.set(cleanName, prev);
  }
  return Array.from(map.values());
}
