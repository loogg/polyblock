import * as Blockly from 'blockly';
import type {
  ChannelPoolConfig,
  DiagnosticItem,
  ProjectModel,
  ProjectScript,
  RuntimeHandle,
  ScriptLanguageId,
} from '../../types/project';
import { buildHandleScriptsMeta } from '../backends/eventMode';
import { backendRegistry } from '../backends/registry';
import {
  buildHandleSharedModule,
  type HandleSharedModuleResult,
} from '../backends/sharedModule';
import type { GeneratedCodeResult } from '../backends/types';
import type { CompileContext } from '../blocks/workspaceContextBridge';
import {
  resolveProjectModules,
  type ModuleResolutionResult,
} from '../extensions/moduleResolver';
import { extensionRegistry } from '../extensions/registry';
import type { ExtensionModuleSource } from '../extensions/types';
import { collectHandleSharedVariableNames } from '../projects/handleVariables';
import { getAllHandleChannelPoolConfigs } from '../projects/store';

export interface HeadlessCompileResult {
  code: string;
  debugCode: string;
  moduleDebugCode: string;
  isEventDriven: boolean;
  diagnostics: DiagnosticItem[];
}

export interface CompiledScriptArtifact extends HeadlessCompileResult {
  scriptId: string;
  scriptName: string;
  isEntry: boolean;
}

export interface HandleBlockingError {
  scriptId: string;
  scriptName: string;
  message: string;
  blockId?: string;
}

export interface CompileHandleArtifactsOptions {
  project: ProjectModel;
  handle: RuntimeHandle;
  /** Optional prebuilt result for the currently mounted live Blockly canvas script to avoid re-compiling it. */
  liveScriptOverride?: {
    scriptId: string;
    workspace?: Record<string, unknown>;
    prebuilt?: GeneratedCodeResult;
  };
  /** When true (sandbox run), companion & shared preload modules use instrumented debug code; when false (target export), clean code. */
  useDebugCompanion?: boolean;
  /** When true, include entry script in `resolution` handleScripts (used for target bundle conflict checks); default false (sandbox preloads siblings only). */
  includeEntryInModuleResolution?: boolean;
}

export interface HandleCompiledArtifacts {
  effectiveHandle: RuntimeHandle;
  entryScript: ProjectScript;
  entryArtifact: CompiledScriptArtifact;
  allArtifacts: CompiledScriptArtifact[];
  sharedModule: HandleSharedModuleResult | null;
  preloadModules: ExtensionModuleSource[];
  blockingErrors: HandleBlockingError[];
  resolution: ModuleResolutionResult;
  channelPoolConfigs: Record<string, ChannelPoolConfig>;
  channelCounts: Record<string, number>;
  timerPoolKey: string | null;
}

export function compileScriptHeadless(
  workspaceJson: Record<string, unknown>,
  language: ScriptLanguageId,
  context?: CompileContext,
): HeadlessCompileResult {
  const ws = new Blockly.Workspace();
  try {
    Blockly.serialization.workspaces.load(workspaceJson, ws);
    const res = backendRegistry.get(language).generate(ws, context);
    return {
      code: res.code,
      debugCode: res.debugCode || res.code,
      moduleDebugCode: res.moduleDebugCode || res.code,
      isEventDriven: Boolean(res.isEventDriven),
      diagnostics: res.diagnostics,
    };
  } finally {
    ws.dispose();
  }
}

/**
 * Single Source of Truth headless compiler pipeline for a whole `RuntimeHandle`.
 * Used identically by single-handle execution, multi-handle concurrent simulation,
 * and single/project `.zip` target bundle export so runtime & export artifacts never drift.
 */
export function compileHandleArtifacts(
  opts: CompileHandleArtifactsOptions,
): HandleCompiledArtifacts {
  return extensionRegistry.withLocalPacks(opts.project.localExtensions, () =>
    compileHandleArtifactsInner(opts),
  );
}

function compileHandleArtifactsInner(
  opts: CompileHandleArtifactsOptions,
): HandleCompiledArtifacts {
  const {
    project,
    handle,
    liveScriptOverride,
    useDebugCompanion = true,
    includeEntryInModuleResolution = false,
  } = opts;
  const language = project.language;

  const effectiveHandle: RuntimeHandle =
    liveScriptOverride?.workspace
      ? {
          ...handle,
          scripts: handle.scripts.map((s) =>
            s.id === liveScriptOverride.scriptId
              ? { ...s, workspace: liveScriptOverride.workspace! }
              : s,
          ),
        }
      : handle;

  const channelPools = extensionRegistry
    .getChannelPools(project.enabledCapabilities, project.localExtensions)
    .map((entry) => entry.pool);
  const channelPoolConfigs = getAllHandleChannelPoolConfigs(
    effectiveHandle,
    channelPools,
  );
  const channelCounts: Record<string, number> = {};
  for (const [k, cfg] of Object.entries(channelPoolConfigs)) {
    channelCounts[k] = cfg.count;
  }
  const timerPoolKey = extensionRegistry.getRuntimeMonitorSummary(
    project.enabledCapabilities,
    project.localExtensions,
  ).timerPoolConfigKey;

  const handleMetas = buildHandleScriptsMeta(effectiveHandle);
  const sharedVars = collectHandleSharedVariableNames(effectiveHandle);
  const sharedModule = buildHandleSharedModule(
    effectiveHandle,
    language,
    channelPoolConfigs,
  );

  const entryScript =
    effectiveHandle.scripts.find((s) => s.id === effectiveHandle.entryScriptId) ??
    effectiveHandle.scripts[0];

  const allArtifacts: CompiledScriptArtifact[] = [];
  const blockingErrors: HandleBlockingError[] = [];

  for (const scr of effectiveHandle.scripts) {
    const isEntry = scr.id === entryScript.id;
    let compiled: HeadlessCompileResult;
    if (
      liveScriptOverride?.prebuilt &&
      liveScriptOverride.scriptId === scr.id
    ) {
      const pre = liveScriptOverride.prebuilt;
      compiled = {
        code: pre.code,
        debugCode: pre.debugCode || pre.code,
        moduleDebugCode: pre.moduleDebugCode || pre.code,
        isEventDriven: Boolean(pre.isEventDriven),
        diagnostics: pre.diagnostics,
      };
    } else {
      compiled = compileScriptHeadless(scr.workspace, language, {
        channelPoolConfigs,
        enabledCapabilities: project.enabledCapabilities,
        handleScripts: handleMetas,
        currentScriptId: scr.id,
        sharedVariables: sharedVars,
        scriptVarInitials: scr.variableInitialValues ?? {},
        sharedFunctions: effectiveHandle.sharedFunctions ?? [],
        moduleConflicts: [],
      });
    }

    for (const d of compiled.diagnostics) {
      if (d.severity === 'error') {
        blockingErrors.push({
          scriptId: scr.id,
          scriptName: scr.name,
          message: d.message,
          blockId: d.blockId,
        });
      }
    }

    allArtifacts.push({
      scriptId: scr.id,
      scriptName: scr.name,
      isEntry,
      ...compiled,
    });
  }

  const entryArtifact =
    allArtifacts.find((a) => a.isEntry) ?? allArtifacts[0];

  const preloadModules: ExtensionModuleSource[] = [];
  if (sharedModule) {
    preloadModules.push({
      moduleName: sharedModule.moduleName,
      sources: {
        [language]: useDebugCompanion
          ? sharedModule.debugSource
          : sharedModule.source,
      },
    });
  }
  for (const art of allArtifacts) {
    if (art.isEntry) continue;
    preloadModules.push({
      moduleName: art.scriptName,
      sources: {
        [language]: useDebugCompanion ? art.moduleDebugCode : art.code,
      },
    });
  }

  const resolutionHandleScripts: Array<{
    scriptId: string;
    scriptName: string;
    sources?: Partial<Record<ScriptLanguageId, string>>;
  }> = includeEntryInModuleResolution
    ? [
        ...(sharedModule
          ? [
              {
                scriptId: '__poly_shared__',
                scriptName: sharedModule.moduleName,
                sources: { [language]: sharedModule.source },
              },
            ]
          : []),
        ...allArtifacts.map((art) => ({
          scriptId: art.scriptId,
          scriptName: art.scriptName,
          sources: { [language]: `${art.code}\n` },
        })),
      ]
    : preloadModules.map((m, idx) => ({
        scriptId: `${effectiveHandle.id}-mod-${idx}`,
        scriptName: m.moduleName,
        sources: m.sources,
      }));

  const resolution = resolveProjectModules({
    enabledCapabilities: project.enabledCapabilities,
    localExtensions: project.localExtensions,
    handleScripts: resolutionHandleScripts,
  });

  return {
    effectiveHandle,
    entryScript,
    entryArtifact,
    allArtifacts,
    sharedModule,
    preloadModules,
    blockingErrors,
    resolution,
    channelPoolConfigs,
    channelCounts,
    timerPoolKey,
  };
}
