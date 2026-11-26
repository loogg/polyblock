import * as Blockly from 'blockly';
import type {
  LogLevel,
  ProjectModel,
  ProjectScript,
  RuntimeHandle,
  RuntimeTelemetry,
  ScriptLanguageId,
} from '../../types/project';
import { backendRegistry } from '../backends/registry';
import { inspectWorkspaceScriptMeta } from '../backends/eventMode';
import {
  setActiveChannelPoolConfigs,
  setActiveHandleScripts,
} from '../blocks/timerConfigBridge';
import { CAP_RT_TIMERS } from '../capabilities/registry';
import { extensionRegistry } from '../extensions/registry';
import type { ExtensionSandboxMock } from '../extensions/types';
import {
  getAllHandleChannelPoolConfigs,
  getHandleTimerConfig,
} from '../projects/store';
import { WasmoonLuaRunner } from './luaRunner';
import { MicroPythonWasmRunner } from './pythonRunner';
import type { RunResult, RunnerStatus, ScriptRunner } from './types';

function compileScriptHeadless(
  workspaceJson: Record<string, unknown>,
  language: ScriptLanguageId,
  channelPoolConfigs: Record<string, ReturnType<typeof getHandleTimerConfig>>,
): { code: string; debugCode: string; isEventDriven: boolean } {
  setActiveChannelPoolConfigs(channelPoolConfigs);
  const ws = new Blockly.Workspace();
  try {
    Blockly.serialization.workspaces.load(workspaceJson, ws);
    const res = backendRegistry.get(language).generate(ws);
    return {
      code: res.code,
      debugCode: res.debugCode || res.code,
      isEventDriven: Boolean(res.isEventDriven),
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
): ExtensionSandboxMock[] {
  const modules: ExtensionSandboxMock[] = [];
  const candidates = [
    ...sharedModules,
    ...handle.scripts.filter((s) => s.id !== excludeScriptId),
  ];
  const poolCfgs = channelPoolConfigs ?? {
    [CAP_RT_TIMERS]: getHandleTimerConfig(handle, defaultTimerCount),
  };

  for (const script of candidates) {
    try {
      const compiled = compileScriptHeadless(
        script.workspace,
        language,
        poolCfgs,
      );
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
  extensionMocks: ExtensionSandboxMock[];
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
      extensionMocks,
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
      setActiveHandleScripts(
        handle.scripts.map((s) => {
          const meta = inspectWorkspaceScriptMeta(s.workspace);
          return {
            id: s.id,
            name: s.name,
            isEntry: s.id === handle.entryScriptId,
            declaredEvents: meta.declaredEvents,
            requiredScripts: meta.requiredScripts,
          };
        }),
        entryScript.id,
      );
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
          mockModules: [...extensionMocks, ...handleAuxMocks],
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
