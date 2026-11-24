import type { LogLevel, ScriptLanguageId } from '../../types/project';

export type RunnerKind = 'browser-wasm' | 'network-ws' | 'local-bridge' | 'web-serial';

export type RunnerStatus = 'ready' | 'running' | 'paused' | 'planned' | 'error';

export interface RunRequest {
  language: ScriptLanguageId;
  /** Clean script used for export and future hardware download runners. */
  code: string;
  /** Instrumented async debug script used by sandbox WASM runners. */
  debugCode?: string;
  timeoutMs: number;
  breakpoints?: string[];
  stepDelayMs?: number;
  startInStepMode?: boolean;
}

export interface RunCallbacks {
  onLog: (level: LogLevel, message: string, line?: number) => void;
  onClear?: () => void;
  onStatusChange?: (status: RunnerStatus) => void;
  onStep?: (blockId: string, vars: Record<string, string>) => void;
  onPaused?: (
    blockId: string,
    vars: Record<string, string>,
    reason: 'breakpoint' | 'step',
  ) => void;
  onResumed?: () => void;
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
 * Phase 1-2 provides Browser WASM Workers (Lua 5.4 & MicroPython) with async stepping & breakpoints.
 * Future hardware board runners simply consume `request.code` (clean script) and stream device logs.
 */
export interface ScriptRunner {
  readonly id: string;
  readonly name: string;
  readonly shortLabel: string;
  readonly kind: RunnerKind;
  readonly supportedLanguages: ScriptLanguageId[];
  readonly description: string;
  readonly availability: 'builtin' | 'planned';
  readonly supportsDebugging: boolean;
  run(request: RunRequest, callbacks: RunCallbacks): Promise<RunResult>;
  stop(): void;
  resume?(): void;
  stepNext?(): void;
  pause?(): void;
  updateBreakpoints?(breakpoints: string[]): void;
  updateStepDelay?(stepDelayMs: number): void;
  dispose(): void;
}
