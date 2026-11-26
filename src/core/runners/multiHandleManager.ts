import * as Blockly from 'blockly';
import type {
  DiagnosticItem,
  LogLevel,
  ProjectModel,
  ProjectScript,
  RuntimeHandle,
  RuntimeTelemetry,
  ScriptLanguageId,
} from '../../types/project';
import { backendRegistry } from '../backends/registry';
import {
  buildHandlePythonSharedModule,
  buildHandleScriptsMeta,
} from '../backends/eventMode';
import {
  setActiveChannelPoolConfigs,
  setActiveHandleScripts,
} from '../blocks/timerConfigBridge';
import { CAP_RT_TIMERS } from '../capabilities/registry';
import { resolveProjectModules } from '../extensions/moduleResolver';
import { extensionRegistry } from '../extensions/registry';
import type { ExtensionModuleSource } from '../extensions/types';
import {
  getAllHandleChannelPoolConfigs,
  getHandleTimerConfig,
} from '../projects/store';
import { WasmoonLuaRunner } from './luaRunner';
import { MicroPythonWasmRunner } from './pythonRunner';
import type { RunResult, RunnerStatus, ScriptRunner } from './types';

export function compileScriptHeadless(
  workspaceJson: Record<string, unknown>,
  language: ScriptLanguageId,
  channelPoolConfigs: Record<string, ReturnType<typeof getHandleTimerConfig>>,
): {
  code: string;
  debugCode: string;
  isEventDriven: boolean;
  diagnostics: DiagnosticItem[];
} {
  setActiveChannelPoolConfigs(channelPoolConfigs);
  const ws = new Blockly.Workspace();
  try {
    Blockly.serialization.workspaces.load(workspaceJson, ws);
    const res = backendRegistry.get(language).generate(ws);
    return {
      code: res.code,
      debugCode: res.debugCode || res.code,
      isEventDriven: Boolean(res.isEventDriven),
      diagnostics: res.diagnostics,
    };
  } finally {
    ws.dispose();
  }
}

/**
 * Compiles sibling scripts within the SAME handle (plus optional project sharedModules)
 * into isolated per-handle preload modules so `require("helper")` / `import helper`
 * works strictly within that handle without leaking across handles.
 */
export function buildHandleScriptModules(
  handle: RuntimeHandle,
  excludeScriptId: string,
  language: ScriptLanguageId,
  sharedModules: ProjectScript[] = [],
  defaultTimerCount = 8,
  channelPoolConfigs?: Record<string, ReturnType<typeof getHandleTimerConfig>>,
  liveScriptOverride?: { scriptId: string; workspace: Record<string, unknown> },
): ExtensionModuleSource[] {
  const modules: ExtensionModuleSource[] = [];
  const candidates = [
    ...sharedModules,
    ...handle.scripts.filter((s) => s.id !== excludeScriptId),
  ];
  const poolCfgs = channelPoolConfigs ?? {
    [CAP_RT_TIMERS]: getHandleTimerConfig(handle, defaultTimerCount),
  };
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
  const handleMetas = buildHandleScriptsMeta(effectiveHandle);

  if (language === 'python') {
    const sharedMod = buildHandlePythonSharedModule(effectiveHandle);
    if (sharedMod) {
      modules.push({
        moduleName: sharedMod.moduleName,
        pythonSource: sharedMod.pythonSource,
      });
    }
  }

  for (const script of candidates) {
    try {
      const wsJson =
        liveScriptOverride && liveScriptOverride.scriptId === script.id
          ? liveScriptOverride.workspace
          : script.workspace;
      setActiveHandleScripts(handleMetas, script.id);
      const compiled = compileScriptHeadless(wsJson, language, poolCfgs);
      modules.push({
        moduleName: script.name,
        luaSource: language === 'lua' ? compiled.code : undefined,
        pythonSource: language === 'python' ? compiled.code : undefined,
      });
    } catch {
      // skip uncompilable auxiliary module gracefully
    }
  }

  return modules;
}

export interface MultiHandleRunOptions {
  project: ProjectModel;
  timeoutMs: number;
  timeSliceMs?: number;
  stepDelayMs: number;
  /** Optional legacy override; when omitted, modules are resolved per handle via `resolveProjectModules`. */
  extensionMocks?: ExtensionModuleSource[];
  mockInputs: Record<string, unknown>;
}

export interface MultiHandleRunCallbacks {
  onHandleLog: (
    handle: RuntimeHandle,
    level: LogLevel,
    message: string,
    line?: number,
  ) => void;
  onDeviceEvent: (kind: string, value: unknown) => void;
  onCustomEvent?: (
    sourceHandleId: string,
    eventName: string,
    args: unknown[],
  ) => void;
  onHandleTelemetry: (handleId: string, telemetry: RuntimeTelemetry | null) => void;
  onStatusChange: (status: RunnerStatus) => void;
}

/**
 * Orchestrates concurrent sandbox simulation of ALL autoStart handles in a project.
 * Each handle gets its own dedicated ScriptRunner -> independent Web Worker ->
 * independent WASM VM (lua_State* / MicroPython) & independent WorkerRuntimeScheduler.
 */
export class MultiHandleRunnerOrchestrator {
  private activeRunners = new Map<string, ScriptRunner>();
  private running = false;

  isRunning(): boolean {
    return this.running;
  }

  async runAllHandles(
    options: MultiHandleRunOptions,
    callbacks: MultiHandleRunCallbacks,
  ): Promise<Array<{ handle: RuntimeHandle; result: RunResult }>> {
    this.stopAll(true);

    const {
      project,
      timeoutMs,
      timeSliceMs,
      stepDelayMs,
      mockInputs,
    } = options;
    const targetHandles = project.handles.filter((h) => h.autoStart);
    const handlesToRun =
      targetHandles.length > 0 ? targetHandles : [project.handles[0]];

    this.running = true;
    callbacks.onStatusChange('running');

    const channelPools = extensionRegistry
      .getChannelPools(project.enabledCapabilities, project.localExtensions)
      .map((entry) => entry.pool);

    const tasks = handlesToRun.map(async (handle) => {
      const entryScript =
        handle.scripts.find((s) => s.id === handle.entryScriptId) ??
        handle.scripts[0];
      const timerCfg = getHandleTimerConfig(handle, project.defaultTimerCount);
      const poolCfgs = getAllHandleChannelPoolConfigs(
        handle,
        channelPools,
        project.defaultTimerCount,
      );
      setActiveChannelPoolConfigs(poolCfgs);
      const scriptMetas = buildHandleScriptsMeta(handle);
      setActiveHandleScripts(scriptMetas, entryScript.id);
      const compiled = compileScriptHeadless(
        entryScript.workspace,
        project.language,
        poolCfgs,
      );
      const handleAuxMocks = buildHandleScriptModules(
        handle,
        entryScript.id,
        project.language,
        project.sharedModules,
        project.defaultTimerCount,
        poolCfgs,
      );
      setActiveHandleScripts(scriptMetas, entryScript.id);

      const resolution = resolveProjectModules({
        enabledCapabilities: project.enabledCapabilities,
        localExtensions: project.localExtensions,
        handleScripts: handleAuxMocks.map((m, idx) => ({
          scriptId: `${handle.id}-aux-${idx}`,
          scriptName: m.moduleName,
          luaSource: m.luaSource,
          pythonSource: m.pythonSource,
        })),
      });

      if (resolution.conflicts.length > 0) {
        for (const conflict of resolution.conflicts) {
          callbacks.onHandleLog(handle, 'error', conflict.message);
        }
        return {
          handle,
          result: {
            ok: false,
            durationMs: 0,
            errorMessage: resolution.conflicts.map((c) => c.message).join('\n'),
          },
        };
      }

      const runner: ScriptRunner =
        project.language === 'lua'
          ? new WasmoonLuaRunner()
          : new MicroPythonWasmRunner();
      this.activeRunners.set(handle.id, runner);

      const result = await runner.run(
        {
          language: project.language,
          code: compiled.code,
          debugCode: compiled.debugCode,
          timeoutMs,
          timeSliceMs: timeSliceMs ?? 20,
          breakpoints: [],
          stepDelayMs,
          startInStepMode: false,
          timerCount: timerCfg.count,
          mockModules: resolution.sandboxMountOrder,
          mockInputs,
        },
        {
          onLog: (level, message, line) =>
            callbacks.onHandleLog(handle, level, message, line),
          onDeviceEvent: callbacks.onDeviceEvent,
          onCustomEvent: (eventName, args) =>
            callbacks.onCustomEvent?.(handle.id, eventName, args),
          onRuntimeTelemetry: (telemetry) =>
            callbacks.onHandleTelemetry(handle.id, telemetry),
        },
      );

      callbacks.onHandleTelemetry(handle.id, null);
      runner.dispose();
      this.activeRunners.delete(handle.id);
      return { handle, result };
    });

    try {
      return await Promise.all(tasks);
    } finally {
      this.running = false;
      callbacks.onStatusChange('ready');
    }
  }

  updateMockInputs(mockInputs: Record<string, unknown>): void {
    for (const runner of this.activeRunners.values()) {
      runner.updateMockInputs?.(mockInputs);
    }
  }

  emitEvent(
    eventName: string,
    args: unknown[] = [],
    excludeHandleId?: string,
  ): void {
    for (const [hdlId, runner] of this.activeRunners.entries()) {
      if (excludeHandleId && hdlId === excludeHandleId) continue;
      runner.emitEvent?.(eventName, args);
    }
  }

  updateStepDelay(stepDelayMs: number): void {
    for (const runner of this.activeRunners.values()) {
      runner.updateStepDelay?.(stepDelayMs);
    }
  }

  updateTimeSlice(timeSliceMs: number): void {
    for (const runner of this.activeRunners.values()) {
      runner.updateTimeSlice?.(timeSliceMs);
    }
  }

  stopAll(force = false): void {
    for (const runner of this.activeRunners.values()) {
      runner.stop(force);
    }
    if (force) {
      for (const runner of this.activeRunners.values()) {
        runner.dispose();
      }
      this.activeRunners.clear();
      this.running = false;
    }
  }

  dispose(): void {
    this.stopAll(true);
  }
}

export const multiHandleOrchestrator = new MultiHandleRunnerOrchestrator();
