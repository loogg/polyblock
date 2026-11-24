import type { LogLevel, ScriptLanguageId } from '../../types/project';

export type RunnerKind = 'browser-wasm' | 'network-ws' | 'local-bridge' | 'web-serial';

export type RunnerStatus = 'ready' | 'running' | 'planned' | 'error';

export interface RunRequest {
  language: ScriptLanguageId;
  code: string;
  timeoutMs: number;
}

export interface RunCallbacks {
  onLog: (level: LogLevel, message: string, line?: number) => void;
  onClear?: () => void;
  onStatusChange?: (status: RunnerStatus) => void;
}

export interface RunResult {
  ok: boolean;
  aborted?: boolean;
  timedOut?: boolean;
  durationMs: number;
  errorMessage?: string;
  errorLine?: number;
}

/**
 * Pluggable execution target contract.
 * Phase 1 provides Browser WASM Workers (Lua 5.4 & MicroPython).
 * Future phases can plug in WebSocket / Local Bridge / WebSerial runners
 * without changing any workspace or console UI code.
 */
export interface ScriptRunner {
  readonly id: string;
  readonly name: string;
  readonly shortLabel: string;
  readonly kind: RunnerKind;
  readonly supportedLanguages: ScriptLanguageId[];
  readonly description: string;
  readonly availability: 'builtin' | 'planned';
  run(request: RunRequest, callbacks: RunCallbacks): Promise<RunResult>;
  stop(): void;
  dispose(): void;
}
