import type {
  ChannelPoolConfig,
  RuntimeHandle,
  ScriptLanguageId,
  VariableInitialValue,
} from '../../types/project';
import {
  collectHandleSharedVariableNames,
  collectUsedVariableNamesInJson,
  normalizeVariableInitialValue,
} from '../projects/handleVariables';
import { withCompileContext } from '../blocks/workspaceContextBridge';
import {
  buildHandleScriptsMeta,
  resolveHandleSharedInfo,
} from './eventMode';
import { backendRegistry } from './registry';

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
  /** Clean read-only source for the `🔒 shared.<ext>` tab and hardware ZIP export. */
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
 * Language-agnostic Style A1 read-only `shared.<ext>` module orchestrator.
 * Builds a shared module whenever `sharedVariables.length > 0 || sharedFunctions.length > 0`
 * (even for single-script handles) and delegates procedure compilation & document formatting
 * directly to the target `ScriptBackendAdapter` (zero language hardcoding!).
 */
export function buildHandleSharedModule(
  handle: RuntimeHandle,
  language: ScriptLanguageId,
  channelPoolConfigs?: Record<string, Partial<ChannelPoolConfig>>,
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

  const adapter = backendRegistry.get(language);
  const info = resolveHandleSharedInfo(metas, explicitVars, explicitFns);
  const moduleName = info.moduleName || 'shared';
  const fileName = `${moduleName}.${adapter.extension}`;

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

  const importSet = new Set<string>();
  const cleanFnBlocks: string[] = [];
  const debugFnBlocks: string[] = [];
  const fnEntries: HandleSharedModuleFnEntry[] = [];

  withCompileContext(
    {
      channelPoolConfigs,
      sharedVariables: explicitVars,
      sharedFunctions: explicitFns,
      handleScripts: metas,
      currentScriptId: effectiveHandle.entryScriptId,
    },
    () => {
      for (const proc of procSources) {
        const compiled = adapter.compileSharedProcedure({
          name: proc.name,
          params: proc.params,
          hasReturn: proc.hasReturn,
          usesSleep: proc.usesSleep,
          blockJson: proc.blockJson,
          scriptVariables: proc.scriptVariables,
          moduleName,
          sharedAttrByName,
          allAsyncSharedFnNames,
        });
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
    },
  );

  const { source, debugSource } = adapter.formatSharedModuleDocument({
    moduleName,
    importLines: Array.from(importSet),
    variables,
    cleanFnBlocks,
    debugFnBlocks,
  });

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
