import type {
  ChannelPoolConfig,
  LogLevel,
  ProjectModel,
  RuntimeHandle,
  RuntimeTelemetry,
  ScriptLanguageId,
} from '../../types/project';
import { backendRegistry } from '../backends/registry';
import { buildHandleScriptsMeta } from '../backends/eventMode';
import { buildHandleSharedModule } from '../backends/sharedModule';
import {
  compileHandleArtifacts,
  compileScriptHeadless,
} from '../compiler/handleBuilder';
import { collectHandleSharedVariableNames } from '../projects/handleVariables';
import type { ExtensionModuleSource } from '../extensions/types';
import { runnerManager } from './manager';
import type { RunResult, RunnerStatus, ScriptRunner } from './types';

export { compileScriptHeadless };

/**
 * Compiles sibling scripts within the SAME handle into isolated per-handle preload modules
 * so `require("helper")` / `import helper` works strictly within that handle without leaking across handles.
 * When `useDebugCompanion` is true (default for sandbox), companion scripts use `moduleDebugCode` so
 * breakpoints, live highlighting, and Python callback watchdog protection work across companion files!
 */
export function buildHandleScriptModules(
  handle: RuntimeHandle,
  excludeScriptId: string,
  language: ScriptLanguageId,
  channelPoolConfigs: Record<string, ChannelPoolConfig> = {},
  liveScriptOverride?: { scriptId: string; workspace: Record<string, unknown> },
  useDebugCompanion = true,
): ExtensionModuleSource[] {
  const modules: ExtensionModuleSource[] = [];
  const candidates = handle.scripts.filter((s) => s.id !== excludeScriptId);
  const poolCfgs = channelPoolConfigs;
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
  const sharedVars = collectHandleSharedVariableNames(effectiveHandle);

  // Unified Style A1 read-only `shared.lua` / `shared.py` (for BOTH Lua and Python!)
  const sharedMod = buildHandleSharedModule(
    effectiveHandle,
    language,
    poolCfgs,
  );
  if (sharedMod) {
    const sharedSrc = useDebugCompanion ? sharedMod.debugSource : sharedMod.source;
    modules.push({
      moduleName: sharedMod.moduleName,
      sources: { [language]: sharedSrc },
    });
  }

  for (const script of candidates) {
    try {
      const wsJson =
        liveScriptOverride && liveScriptOverride.scriptId === script.id
          ? liveScriptOverride.workspace
          : script.workspace;
      const compiled = compileScriptHeadless(wsJson, language, {
        channelPoolConfigs: poolCfgs,
        handleScripts: handleMetas,
        currentScriptId: script.id,
        sharedVariables: sharedVars,
        sharedVarInitials: effectiveHandle.variableInitialValues,
        scriptVarInitials: script.variableInitialValues,
        sharedFunctions: effectiveHandle.sharedFunctions ?? [],
      });
      const src = useDebugCompanion ? compiled.moduleDebugCode : compiled.code;
      modules.push({
        moduleName: script.name,
        sources: { [language]: src },
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
    const handlesToRun = (
      targetHandles.length > 0 ? targetHandles : project.handles.slice(0, 1)
    ).filter(Boolean);

    if (!runnerManager.findForLanguage(project.language)) {
      const langLabel =
        backendRegistry.tryGetDialect(project.language)?.displayName ??
        project.language;
      const errorMessage = `当前目标语言（${langLabel}）未注册浏览器沙箱 Runner（仅支持代码导出），无法启动多句柄模拟运行。`;
      for (const handle of handlesToRun) {
        callbacks.onHandleLog(handle, 'error', errorMessage);
      }
      callbacks.onStatusChange('ready');
      return handlesToRun.map((handle) => ({
        handle,
        result: {
          ok: false,
          durationMs: 0,
          errorMessage,
        },
      }));
    }

    this.running = true;
    callbacks.onStatusChange('running');

    const tasks = handlesToRun.map(async (handle) => {
      const built = compileHandleArtifacts({
        project,
        handle,
        useDebugCompanion: true,
      });

      if (built.resolution.conflicts.length > 0) {
        for (const conflict of built.resolution.conflicts) {
          callbacks.onHandleLog(handle, 'error', conflict.message);
        }
        return {
          handle,
          result: {
            ok: false,
            durationMs: 0,
            errorMessage: built.resolution.conflicts.map((c) => c.message).join('\n'),
          },
        };
      }

      const runner: ScriptRunner = runnerManager.createForLanguage(project.language);
      this.activeRunners.set(handle.id, runner);

      const result = await runner.run(
        {
          language: project.language,
          code: built.entryArtifact.code,
          debugCode: built.entryArtifact.debugCode,
          timeoutMs,
          timeSliceMs: timeSliceMs ?? 20,
          breakpoints: [],
          stepDelayMs,
          startInStepMode: false,
          channelCounts: built.channelCounts,
          timerPoolKey: built.timerPoolKey ?? undefined,
          mockModules: built.resolution.sandboxMountOrder,
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
