import type {
  LogLevel,
  ProjectModel,
  RuntimeHandle,
  RuntimeTelemetry,
} from '../../types/project';
import { backendRegistry } from '../backends/registry';
import {
  compileHandleArtifacts,
  type HandleCompiledArtifacts,
} from '../compiler/handleBuilder';
import { runnerManager } from './manager';
import type { RunResult, RunnerStatus, ScriptRunner } from './types';

export interface MultiHandleRunOptions {
  project: ProjectModel;
  timeoutMs: number;
  timeSliceMs?: number;
  stepDelayMs: number;
  mockInputs: Record<string, unknown>;
  /** Optional precompiled artifacts keyed by handle ID to avoid compiling handles twice. */
  precompiledByHandleId?: Map<string, HandleCompiledArtifacts>;
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
  private runGeneration = 0;

  async runAllHandles(
    options: MultiHandleRunOptions,
    callbacks: MultiHandleRunCallbacks,
  ): Promise<Array<{ handle: RuntimeHandle; result: RunResult }>> {
    this.stopAll(true);
    const myGeneration = ++this.runGeneration;

    const {
      project,
      timeoutMs,
      timeSliceMs,
      stepDelayMs,
      mockInputs,
      precompiledByHandleId,
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

    callbacks.onStatusChange('running');

    const tasks = handlesToRun.map(async (handle) => {
      const built =
        precompiledByHandleId?.get(handle.id) ??
        compileHandleArtifacts({
          project,
          handle,
          useDebugCompanion: true,
        });

      if (built.blockingErrors.length > 0) {
        for (const err of built.blockingErrors) {
          callbacks.onHandleLog(
            handle,
            'error',
            `[${err.scriptName}] ${err.message}`,
          );
        }
        return {
          handle,
          result: {
            ok: false,
            durationMs: 0,
            errorMessage: built.blockingErrors.map((e) => e.message).join('\n'),
          },
        };
      }

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

      if (this.activeRunners.get(handle.id) === runner) {
        callbacks.onHandleTelemetry(handle.id, null);
        this.activeRunners.delete(handle.id);
      }
      runner.dispose();
      return { handle, result };
    });

    try {
      return await Promise.all(tasks);
    } finally {
      if (this.runGeneration === myGeneration) {
        callbacks.onStatusChange('ready');
      }
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
    }
  }

  dispose(): void {
    this.stopAll(true);
  }
}

export const multiHandleOrchestrator = new MultiHandleRunnerOrchestrator();
