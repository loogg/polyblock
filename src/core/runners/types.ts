import type {
  LogLevel,
  RuntimeTelemetry,
  ScriptLanguageId,
} from '../../types/project';
import type { ExtensionModuleSource } from '../extensions/types';

export type RunnerKind =
  | 'browser-wasm'
  | 'browser-worker'
  | 'network-ws'
  | 'local-bridge'
  | 'web-serial';

export type RunnerStatus = 'ready' | 'running' | 'paused' | 'planned' | 'error';

export interface RunRequest {
  language: ScriptLanguageId;
  /** Clean script used for export and future hardware download runners. */
  code: string;
  /** Instrumented async debug script used by sandbox WASM runners. */
  debugCode?: string;
  timeoutMs: number;
  /** Cooperative time-slice (ms) for `on_start` coroutine preemption (default 20ms). */
  timeSliceMs?: number;
  breakpoints?: string[];
  stepDelayMs?: number;
  startInStepMode?: boolean;
  /** Per-channel-pool handle capacities keyed by configKey (e.g. `{ "rt.timers": 8 }`). */
  channelCounts?: Record<string, number>;
  /** Declaratively resolved configKey of the active timer channel pool (from `runtimeMonitor: "timers"`). */
  timerPoolKey?: string;
  /** Extension sandbox/bundle modules mounted into Lua package.preload / Python sys.modules. */
  mockModules?: ExtensionModuleSource[];
  /** Live interactive simulator inputs (e.g., virtual board temperature / buttons). */
  mockInputs?: Record<string, unknown>;
}

export interface RunCallbacks {
  onLog: (level: LogLevel, message: string, line?: number) => void;
  onStatusChange?: (status: RunnerStatus) => void;
  onStep?: (blockId: string, vars: Record<string, string>) => void;
  onPaused?: (
    blockId: string,
    vars: Record<string, string>,
    reason: 'breakpoint' | 'step',
  ) => void;
  onResumed?: () => void;
  onDeviceEvent?: (kind: string, value: unknown) => void;
  onCustomEvent?: (eventName: string, args: unknown[]) => void;
  onRuntimeTelemetry?: (telemetry: RuntimeTelemetry) => void;
}

export interface RunResult {
  ok: boolean;
  aborted?: boolean;
  timedOut?: boolean;
  durationMs: number;
  errorMessage?: string;
  errorLine?: number;
  finalVars?: Record<string, string>;
}

/**
 * Pluggable execution target contract.
 * Language plugins optionally provide browser sandboxes (WASM or native Web Worker) with async stepping & breakpoints.
 * External hardware/bridge runners simply consume `request.code` (clean script) and stream device logs.
 */
export interface ScriptRunner {
  readonly id: string;
  readonly name: string;
  readonly shortLabel: string;
  /** Optional short badge label rendered in DevicesPage runner cards (defaults to '沙箱'). */
  readonly engineBadge?: string;
  /** Optional human-readable transport subtitle shown in DevicesPage cards. */
  readonly transportLabel?: string;
  readonly kind: RunnerKind;
  readonly supportedLanguages: ScriptLanguageId[];
  readonly description: string;
  readonly availability: 'builtin' | 'planned';
  readonly supportsDebugging: boolean;
  run(request: RunRequest, callbacks: RunCallbacks): Promise<RunResult>;
  stop(force?: boolean): void;
  resume?(): void;
  stepNext?(): void;
  pause?(): void;
  updateBreakpoints?(breakpoints: string[]): void;
  updateStepDelay?(stepDelayMs: number): void;
  updateTimeSlice?(timeSliceMs: number): void;
  updateMockInputs?(mockInputs: Record<string, unknown>): void;
  emitEvent?(eventName: string, args: unknown[]): void;
  dispose(): void;
}
