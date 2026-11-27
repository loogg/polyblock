import * as Blockly from 'blockly';
import { luaGenerator } from 'blockly/lua';
import { pythonGenerator } from 'blockly/python';
import type {
  ProjectTimerConfig,
  RuntimeHandle,
  ScriptLanguageId,
  VariableInitialValue,
} from '../../types/project';
import {
  collectHandleSharedVariableNames,
  collectUsedVariableNamesInJson,
  formatInitialValueLua,
  formatInitialValuePython,
  normalizeVariableInitialValue,
} from '../projects/handleVariables';
import {
  getActiveHandleScriptId,
  getActiveHandleScripts,
  getActiveHandleSharedFunctions,
  getActiveHandleSharedVariables,
  setActiveChannelPoolConfigs,
  setActiveHandleScripts,
  setActiveHandleSharedFunctions,
  setActiveHandleSharedVariables,
} from '../blocks/timerConfigBridge';
import {
  computeAsyncFunctionNames,
  resetCodegenPassContext,
} from './codegenContext';
import {
  buildHandleScriptsMeta,
  resolveHandleSharedInfo,
} from './eventMode';
import { sanitizeLocalIdent } from './scopeAnalysis';
import { registerLuaBlockGenerators } from './luaBackend';
import { registerPythonBlockGenerators } from './pythonBackend';

export interface HandleSharedModuleVarEntry {
  name: string;
  attr: string;
  initialValue: VariableInitialValue;
  usedInScripts: string[];
}

export interface HandleSharedModuleFnEntry {
  name: string;
  ident: string;
  params: string[];
  hasReturn: boolean;
  usesSleep: boolean;
  scriptId: string;
  scriptName: string;
  blockId?: string;
}

export interface HandleSharedModuleResult {
  moduleName: string;
  fileName: string;
  language: ScriptLanguageId;
  variables: HandleSharedModuleVarEntry[];
  functions: HandleSharedModuleFnEntry[];
  /** Clean read-only source for the `🔒 shared.lua` / `🔒 shared.py` tab and hardware ZIP export. */
  source: string;
  /** Instrumented sandbox module source supporting breakpoints inside shared functions. */
  debugSource: string;
}

interface SharedProcSourceBlock {
  name: string;
  params: string[];
  hasReturn: boolean;
  usesSleep: boolean;
  scriptId: string;
  scriptName: string;
  blockId?: string;
  blockJson: Record<string, unknown>;
  scriptVariables: unknown[];
}

function collectSharedProcBlocks(
  handle: RuntimeHandle,
  sharedFnNames: string[],
  usesSleepMap: Map<string, boolean>,
): SharedProcSourceBlock[] {
  const sharedSet = new Set(sharedFnNames.map((n) => n.trim()).filter(Boolean));
  if (sharedSet.size === 0) return [];
  const seen = new Set<string>();
  const out: SharedProcSourceBlock[] = [];

  for (const scr of handle.scripts) {
    const blocksContainer = scr.workspace?.blocks as
      | { blocks?: Array<Record<string, unknown>> }
      | undefined;
    const topList = Array.isArray(blocksContainer?.blocks)
      ? blocksContainer.blocks
      : [];
    const scriptVariables = Array.isArray(scr.workspace?.variables)
      ? (scr.workspace.variables as unknown[])
      : [];
    for (const top of topList) {
      if (!top || top.enabled === false) continue;
      const t = String(top.type ?? '');
      if (t !== 'procedures_defnoreturn' && t !== 'procedures_defreturn') continue;
      const fields =
        top.fields && typeof top.fields === 'object'
          ? (top.fields as Record<string, unknown>)
          : {};
      const fnName = String(fields.NAME ?? '').trim();
      if (!fnName || !sharedSet.has(fnName) || seen.has(fnName)) continue;
      seen.add(fnName);
      const extra = top.extraState as
        | { params?: Array<{ name?: string }> }
        | undefined;
      const params = Array.isArray(extra?.params)
        ? extra.params
            .map((p) => (typeof p?.name === 'string' ? p.name.trim() : ''))
            .filter(Boolean)
        : [];
      out.push({
        name: fnName,
        params,
        hasReturn: t === 'procedures_defreturn',
        usesSleep: Boolean(usesSleepMap.get(fnName)),
        scriptId: scr.id,
        scriptName: scr.name,
        blockId: typeof top.id === 'string' ? top.id : undefined,
        blockJson: top,
        scriptVariables,
      });
    }
  }
  return out;
}

/**
 * Compiles ONE shared `procedures_def*` block into either `shared.lua` or `shared.py`
 * (both clean export and instrumented sandbox debug variants) while extracting any required
 * extension `imports` (`local board = require("board")` / `import board`).
 */
function compileSingleSharedProc(
  proc: SharedProcSourceBlock,
  language: ScriptLanguageId,
  moduleName: string,
  sharedAttrByName: Map<string, string>,
  allAsyncSharedFnNames: Set<string>,
): {
  ident: string;
  imports: string[];
  cleanFnCode: string;
  debugFnCode: string;
} {
  registerLuaBlockGenerators();
  registerPythonBlockGenerators();

  const ws = new Blockly.Workspace();
  const isolatedJson: Record<string, unknown> = {
    blocks: {
      languageVersion: 0,
      blocks: [proc.blockJson],
    },
    variables: proc.scriptVariables,
  };

  try {
    Blockly.serialization.workspaces.load(isolatedJson, ws);
    const topBlock = ws.getTopBlocks(false)[0];
    if (!topBlock) {
      return {
        ident: sanitizeLocalIdent(proc.name),
        imports: [],
        cleanFnCode: '',
        debugFnCode: '',
      };
    }

    if (language === 'lua') {
      const prevPrefix = luaGenerator.STATEMENT_PREFIX;
      const prevSuffix = luaGenerator.STATEMENT_SUFFIX;
      const sharedVarIdToAttr = new Map<string, string>();
      const sharedVarIdents = new Set<string>();
      const snapEntries: Array<{ label: string; ident: string }> = [];

      let cleanFnCode = '';
      let debugFnCode = '';
      let imports: string[] = [];
      let procIdent = sanitizeLocalIdent(proc.name);

      try {
        luaGenerator.init(ws);
        for (const v of ws.getVariableMap().getAllVariables()) {
          const ident = luaGenerator.getVariableName(v.getId());
          const attr = sharedAttrByName.get(v.getName());
          if (attr) {
            sharedVarIdToAttr.set(v.getId(), attr);
            sharedVarIdents.add(ident);
            snapEntries.push({ label: v.getName(), ident: `${moduleName}.${attr}` });
          }
        }
        procIdent = luaGenerator.getProcedureName(proc.name);
        luaGenerator.finish('');

        // Pass 1: Clean export (read `definitions_` BEFORE `finish('')` clears it!)
        resetCodegenPassContext({
          debugPass: false,
          compilingSharedModule: true,
          luaSharedModuleName: moduleName,
          luaSharedVarIdToAttr: sharedVarIdToAttr,
          luaSharedVarIdents: sharedVarIdents,
        });
        luaGenerator.STATEMENT_PREFIX = null;
        luaGenerator.STATEMENT_SUFFIX = null;
        luaGenerator.init(ws);
        luaGenerator.blockToCode(topBlock);
        const defs = (
          luaGenerator as unknown as { definitions_: Record<string, string> }
        ).definitions_;
        imports = Object.entries(defs)
          .filter(([k]) => !k.startsWith('%') && k !== 'variables')
          .map(([, v]) =>
            v
              .trim()
              .replace(/(^|\n)function\s+([A-Za-z0-9_]+)\s*\(/g, '$1local function $2('),
          )
          .filter(Boolean);
        cleanFnCode = (defs[`%${procIdent}`] ?? '').trim();
        luaGenerator.finish('');

        // Pass 2: Sandbox debug
        const snapExpr =
          snapEntries.length === 0
            ? '{}'
            : `{ ${snapEntries
                .map((e) => `[${JSON.stringify(e.label)}] = ${e.ident}`)
                .join(', ')} }`;
        resetCodegenPassContext({
          debugPass: true,
          compilingSharedModule: true,
          luaSharedModuleName: moduleName,
          luaSharedVarIdToAttr: sharedVarIdToAttr,
          luaSharedVarIdents: sharedVarIdents,
        });
        luaGenerator.STATEMENT_PREFIX = `__poly_tick(%1, __poly_snap(${snapExpr}))\n`;
        luaGenerator.STATEMENT_SUFFIX = null;
        luaGenerator.init(ws);
        luaGenerator.blockToCode(topBlock);
        const debugDefs = (
          luaGenerator as unknown as { definitions_: Record<string, string> }
        ).definitions_;
        debugFnCode = (debugDefs[`%${procIdent}`] ?? cleanFnCode).trim();
        luaGenerator.finish('');
      } finally {
        resetCodegenPassContext({ debugPass: false, compilingSharedModule: false });
        luaGenerator.STATEMENT_PREFIX = prevPrefix;
        luaGenerator.STATEMENT_SUFFIX = prevSuffix;
      }

      return { ident: procIdent, imports, cleanFnCode, debugFnCode };
    }

    // Python 3
    const prevPrefix = pythonGenerator.STATEMENT_PREFIX;
    const prevSuffix = pythonGenerator.STATEMENT_SUFFIX;
    const sharedVarIdToAttr = new Map<string, string>();
    const sharedVarIdents = new Set<string>();
    let cleanFnCode = '';
    let debugFnCode = '';
    let imports: string[] = [];
    let procIdent = sanitizeLocalIdent(proc.name);

    try {
      resetCodegenPassContext({ debugPass: false, compilingSharedModule: true });
      pythonGenerator.init(ws);
      for (const v of ws.getVariableMap().getAllVariables()) {
        const ident = pythonGenerator.getVariableName(v.getId());
        const attr = sharedAttrByName.get(v.getName());
        if (attr) {
          sharedVarIdToAttr.set(v.getId(), attr);
          sharedVarIdents.add(ident);
        }
      }
      procIdent = pythonGenerator.getProcedureName(proc.name);
      pythonGenerator.finish('');
      const asyncNames = computeAsyncFunctionNames(ws, allAsyncSharedFnNames);

      // Pass 1: Clean export (read `definitions_` BEFORE `finish('')` clears it!)
      resetCodegenPassContext({
        debugPass: false,
        compilingSharedModule: true,
        pythonSharedModuleName: moduleName,
        pythonSharedVarIdToAttr: sharedVarIdToAttr,
        pythonSharedVarIdents: sharedVarIdents,
        pythonAsyncFnNames: asyncNames,
      });
      pythonGenerator.STATEMENT_PREFIX = null;
      pythonGenerator.STATEMENT_SUFFIX = null;
      pythonGenerator.init(ws);
      pythonGenerator.blockToCode(topBlock);
      const defs = (
        pythonGenerator as unknown as { definitions_: Record<string, string> }
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
      cleanFnCode = (defs[`%${procIdent}`] ?? '').trim();
      pythonGenerator.finish('');

      // Pass 2: Sandbox debug
      resetCodegenPassContext({
        debugPass: true,
        compilingSharedModule: true,
        pythonSharedModuleName: moduleName,
        pythonSharedVarIdToAttr: sharedVarIdToAttr,
        pythonSharedVarIdents: sharedVarIdents,
        pythonAsyncFnNames: asyncNames,
      });
      pythonGenerator.STATEMENT_PREFIX = `await _poly_tick(%1, _poly_snap(locals(), globals()))\n`;
      pythonGenerator.STATEMENT_SUFFIX = null;
      pythonGenerator.init(ws);
      pythonGenerator.blockToCode(topBlock);
      const debugDefs = (
        pythonGenerator as unknown as { definitions_: Record<string, string> }
      ).definitions_;
      debugFnCode = (debugDefs[`%${procIdent}`] ?? cleanFnCode).trim();
      pythonGenerator.finish('');
    } finally {
      resetCodegenPassContext({ debugPass: false, compilingSharedModule: false });
      pythonGenerator.STATEMENT_PREFIX = prevPrefix;
      pythonGenerator.STATEMENT_SUFFIX = prevSuffix;
    }

    return { ident: procIdent, imports, cleanFnCode, debugFnCode };
  } finally {
    ws.dispose();
  }
}

/**
 * Builds the unified Style A1 read-only `shared.lua` / `shared.py` module for a RuntimeHandle
 * whenever `sharedVariables.length > 0 || sharedFunctions.length > 0` (even for single-script handles!).
 * Returns `null` when the handle has neither cross-file variables nor cross-file functions.
 */
export function buildHandleSharedModule(
  handle: RuntimeHandle,
  language: ScriptLanguageId,
  channelPoolConfigs?: Record<string, Partial<ProjectTimerConfig>>,
  liveScriptOverride?: { scriptId: string; workspace: Record<string, unknown> },
): HandleSharedModuleResult | null {
  const effectiveHandle: RuntimeHandle = liveScriptOverride
    ? {
        ...handle,
        scripts: handle.scripts.map((s) =>
          s.id === liveScriptOverride.scriptId
            ? { ...s, workspace: liveScriptOverride.workspace }
            : s,
        ),
      }
    : handle;

  const metas = buildHandleScriptsMeta(effectiveHandle);
  const explicitVars = collectHandleSharedVariableNames(effectiveHandle);
  const explicitFns = (effectiveHandle.sharedFunctions ?? [])
    .map((n) => n.trim())
    .filter(Boolean);

  // Build transitive `usesSleep` map across ALL declared shared functions in the handle
  const usesSleepMap = new Map<string, boolean>();
  for (const m of metas) {
    for (const fn of m.declaredFunctions ?? []) {
      if (fn.usesSleep) usesSleepMap.set(fn.name, true);
    }
  }
  const procSources = collectSharedProcBlocks(
    effectiveHandle,
    explicitFns,
    usesSleepMap,
  );

  if (explicitVars.length === 0 && procSources.length === 0) {
    return null;
  }

  const info = resolveHandleSharedInfo(metas, explicitVars, explicitFns);
  const moduleName = info.moduleName || 'shared';
  const ext = language === 'lua' ? 'lua' : 'py';
  const fileName = `${moduleName}.${ext}`;

  const usedByScript = effectiveHandle.scripts.map((s) => ({
    name: s.name,
    used: new Set(collectUsedVariableNamesInJson(s.workspace)),
  }));
  const handleInitials = effectiveHandle.variableInitialValues ?? {};

  const variables: HandleSharedModuleVarEntry[] = info.entries.map((entry) => ({
    name: entry.name,
    attr: entry.attr,
    initialValue: normalizeVariableInitialValue(handleInitials[entry.name]),
    usedInScripts: usedByScript
      .filter((s) => s.used.has(entry.name))
      .map((s) => s.name),
  }));

  const sharedAttrByName = new Map(variables.map((v) => [v.name, v.attr]));
  const allAsyncSharedFnNames = new Set(
    procSources.filter((p) => p.usesSleep).map((p) => p.name),
  );

  // Save & restore global bridge state around compiling shared functions
  const prevScripts = getActiveHandleScripts();
  const prevScriptId = getActiveHandleScriptId();
  const prevSharedVars = getActiveHandleSharedVariables();
  const prevSharedFns = getActiveHandleSharedFunctions();

  const importSet = new Set<string>();
  const cleanFnBlocks: string[] = [];
  const debugFnBlocks: string[] = [];
  const fnEntries: HandleSharedModuleFnEntry[] = [];

  try {
    if (channelPoolConfigs) {
      setActiveChannelPoolConfigs(channelPoolConfigs);
    }
    setActiveHandleSharedVariables(explicitVars);
    setActiveHandleSharedFunctions(explicitFns);
    setActiveHandleScripts(metas, effectiveHandle.entryScriptId);

    for (const proc of procSources) {
      const compiled = compileSingleSharedProc(
        proc,
        language,
        moduleName,
        sharedAttrByName,
        allAsyncSharedFnNames,
      );
      for (const imp of compiled.imports) importSet.add(imp);
      if (compiled.cleanFnCode) cleanFnBlocks.push(compiled.cleanFnCode);
      if (compiled.debugFnCode) debugFnBlocks.push(compiled.debugFnCode);
      fnEntries.push({
        name: proc.name,
        ident: compiled.ident,
        params: proc.params,
        hasReturn: proc.hasReturn,
        usesSleep: proc.usesSleep,
        scriptId: proc.scriptId,
        scriptName: proc.scriptName,
        blockId: proc.blockId,
      });
    }
  } finally {
    setActiveHandleScripts(prevScripts, prevScriptId);
    setActiveHandleSharedVariables(prevSharedVars);
    setActiveHandleSharedFunctions(prevSharedFns);
  }

  const importLines = Array.from(importSet);

  if (language === 'lua') {
    const varLines = variables.map(
      (v) => `${moduleName}.${v.attr} = ${formatInitialValueLua(v.initialValue)}`,
    );
    const buildLuaDoc = (fnBodies: string[]) => {
      const parts: string[] = [
        `-- 由 PolyBlock 自动生成的同句柄跨文件共享模块（只读）`,
      ];
      if (importLines.length > 0) parts.push(importLines.join('\n'));
      parts.push(`local ${moduleName} = {}`);
      if (varLines.length > 0) parts.push(varLines.join('\n'));
      if (fnBodies.length > 0) parts.push(fnBodies.join('\n\n'));
      parts.push(`return ${moduleName}`);
      return `${parts.join('\n\n')}\n`;
    };
    return {
      moduleName,
      fileName,
      language,
      variables,
      functions: fnEntries,
      source: buildLuaDoc(cleanFnBlocks),
      debugSource: buildLuaDoc(debugFnBlocks),
    };
  }

  // Python 3 (`shared.py`)
  const varLines = variables.map(
    (v) => `${v.attr} = ${formatInitialValuePython(v.initialValue)}`,
  );
  const cleanParts: string[] = [
    `# 由 PolyBlock 自动生成的同句柄跨文件共享模块（只读）`,
  ];
  if (importLines.length > 0) cleanParts.push(importLines.join('\n'));
  if (varLines.length > 0) cleanParts.push(varLines.join('\n'));
  if (cleanFnBlocks.length > 0) cleanParts.push(cleanFnBlocks.join('\n\n'));
  const source = `${cleanParts.join('\n\n')}\n`;

  const snapEntries = variables.map((v) => [v.name, v.attr]);
  const debugParts: string[] = [
    `import sys, json`,
    ...(debugFnBlocks.length > 0
      ? [`from _poly_rt import _poly_tick, _poly_yield_check, sleep_ms, _poly_call_mod`]
      : []),
    ...importLines,
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
  if (debugFnBlocks.length > 0) debugParts.push('', ...debugFnBlocks);
  const debugSource = `${debugParts.join('\n')}\n`;

  return {
    moduleName,
    fileName,
    language,
    variables,
    functions: fnEntries,
    source,
    debugSource,
  };
}
