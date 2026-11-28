import type { RuntimeTelemetry, ScriptLanguageId } from '../../types/project';
import { backendRegistry } from '../backends/registry';
import { extractErrorLine, parseStdoutLine } from './logParser';
import type { RunCallbacks, RunRequest, RunResult, ScriptRunner } from './types';

interface WorkerReply {
  type:
    | 'STDOUT'
    | 'STDERR'
    | 'STEP'
    | 'PAUSED'
    | 'RESUMED'
    | 'WAITING'
    | 'DEVICE_EVENT'
    | 'CUSTOM_EVENT'
    | 'RUNTIME_TELEMETRY'
    | 'DONE'
    | 'ERROR';
  runId: string;
  line?: string;
  blockId?: string;
  vars?: Record<string, string>;
  reason?: 'breakpoint' | 'step';
  active?: boolean;
  kind?: string;
  value?: unknown;
  eventName?: string;
  args?: unknown[];
  telemetry?: RuntimeTelemetry;
  message?: string;
  durationMs?: number;
}

export interface WorkerWasmRunnerConfig {
  id: string;
  name: string;
  shortLabel: string;
  engineBadge?: string;
  kind?: 'browser-wasm' | 'browser-worker';
  transportLabel?: string;
  language: ScriptLanguageId;
  description: string;
  wasmAssetUrl?: string;
  createWorker: () => Worker;
}

/**
 * Unified WebWorker sandbox runner shared across all browser-sandbox languages (WASM or native JS Worker).
 * Eliminates duplicated worker lifecycle, watchdog, graceful stop, and message routing code
 * whenever new sandboxed languages are added.
 */
export class WorkerWasmRunner implements ScriptRunner {
  readonly id: string;
  readonly name: string;
  readonly shortLabel: string;
  readonly engineBadge: string;
  readonly transportLabel: string;
  readonly kind: 'browser-wasm' | 'browser-worker';
  readonly supportedLanguages: ScriptLanguageId[];
  readonly description: string;
  readonly availability = 'builtin' as const;
  readonly supportsDebugging = true;

  private readonly language: ScriptLanguageId;
  private readonly wasmAssetUrl: string;
  private readonly createWorkerFn: () => Worker;

  private worker: Worker | null = null;
  private activeRunId: string | null = null;
  private activeResolve: ((res: RunResult) => void) | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private gracefulStopHandle: ReturnType<typeof setTimeout> | null = null;
  private activeCallbacks: RunCallbacks | null = null;
  private activeTimeoutMs = 5000;
  private startedAt = 0;
  private inEventLoop = false;

  constructor(config: WorkerWasmRunnerConfig) {
    this.id = config.id;
    this.name = config.name;
    this.shortLabel = config.shortLabel;
    this.engineBadge = config.engineBadge ?? 'WASM';
    this.kind = config.kind ?? (config.wasmAssetUrl ? 'browser-wasm' : 'browser-worker');
    this.transportLabel =
      config.transportLabel ??
      (this.kind === 'browser-wasm'
        ? '浏览器 WASM Worker · 离线可运行'
        : '原生 Web Worker · 零 WASM 体积');
    this.language = config.language;
    this.supportedLanguages = [config.language];
    this.description = config.description;
    this.wasmAssetUrl = config.wasmAssetUrl ?? '';
    this.createWorkerFn = config.createWorker;
  }

  private get langLabel(): string {
    return backendRegistry.tryGetDialect(this.language)?.shortLabel ?? this.language;
  }

  private resolveWasmUrl(): string {
    if (!this.wasmAssetUrl) return '';
    return new URL(this.wasmAssetUrl, window.location.href).href;
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = this.createWorkerFn();
    }
    return this.worker;
  }

  private pauseWatchdog(): void {
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  private clearGracefulStop(): void {
    if (this.gracefulStopHandle !== null) {
      clearTimeout(this.gracefulStopHandle);
      this.gracefulStopHandle = null;
    }
  }

  private armWatchdog(runId: string): void {
    this.pauseWatchdog();
    this.timeoutHandle = setTimeout(() => {
      if (this.activeRunId !== runId) return;
      const durationMs = Math.round(performance.now() - this.startedAt);
      const callbacks = this.activeCallbacks;
      const done = this.activeResolve;
      callbacks?.onLog(
        'warn',
        `单次同步回调/计算连续耗时超过 ${this.activeTimeoutMs}ms（疑似死循环），已自动终止 ${this.langLabel} Worker 沙箱。`,
      );
      this.terminateWorker();
      this.cleanupRun();
      callbacks?.onStatusChange?.('ready');
      done?.({
        ok: false,
        timedOut: true,
        durationMs,
        errorMessage: 'Execution timed out',
      });
    }, this.activeTimeoutMs);
  }

  private cleanupRun(): void {
    this.pauseWatchdog();
    this.clearGracefulStop();
    this.activeRunId = null;
    this.activeResolve = null;
    this.activeCallbacks = null;
    this.inEventLoop = false;
  }

  run(request: RunRequest, callbacks: RunCallbacks): Promise<RunResult> {
    this.stop(true);

    const worker = this.ensureWorker();
    const runId = `${this.language}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.activeRunId = runId;
    this.activeCallbacks = callbacks;
    this.activeTimeoutMs = request.timeoutMs;
    this.startedAt = performance.now();
    this.inEventLoop = false;
    callbacks.onStatusChange?.('running');

    return new Promise<RunResult>((resolve) => {
      this.activeResolve = resolve;
      let loggedStderr = false;

      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        const msg = event.data;
        if (!msg || msg.runId !== this.activeRunId) return;

        if (msg.type === 'STDOUT' && msg.line !== undefined) {
          const parsed = parseStdoutLine(msg.line);
          callbacks.onLog(parsed.level, parsed.message);
          return;
        }

        if (msg.type === 'STDERR' && msg.line !== undefined) {
          loggedStderr = true;
          const errLine = extractErrorLine(msg.line, this.language);
          callbacks.onLog('error', msg.line, errLine);
          return;
        }

        if (msg.type === 'STEP' && msg.blockId) {
          this.armWatchdog(runId);
          callbacks.onStep?.(msg.blockId, msg.vars ?? {});
          return;
        }

        if (msg.type === 'PAUSED' && msg.blockId) {
          this.pauseWatchdog();
          callbacks.onStatusChange?.('paused');
          callbacks.onPaused?.(msg.blockId, msg.vars ?? {}, msg.reason ?? 'step');
          return;
        }

        if (msg.type === 'RESUMED') {
          callbacks.onStatusChange?.('running');
          callbacks.onResumed?.();
          this.armWatchdog(runId);
          return;
        }

        if (msg.type === 'WAITING') {
          if (msg.active) {
            this.pauseWatchdog();
          } else {
            this.armWatchdog(runId);
          }
          return;
        }

        if (msg.type === 'DEVICE_EVENT' && msg.kind) {
          callbacks.onDeviceEvent?.(msg.kind, msg.value);
          return;
        }

        if (msg.type === 'CUSTOM_EVENT' && msg.eventName) {
          callbacks.onCustomEvent?.(msg.eventName, msg.args ?? []);
          return;
        }

        if (msg.type === 'RUNTIME_TELEMETRY' && msg.telemetry) {
          this.inEventLoop = msg.telemetry.eventLoopActive;
          callbacks.onRuntimeTelemetry?.(msg.telemetry);
          return;
        }

        if (msg.type === 'DONE') {
          const wasGracefulStop = this.gracefulStopHandle !== null;
          this.cleanupRun();
          callbacks.onStatusChange?.('ready');
          resolve({
            ok: !wasGracefulStop,
            aborted: wasGracefulStop || undefined,
            durationMs: msg.durationMs ?? 1,
            finalVars: msg.vars,
          });
          return;
        }

        if (msg.type === 'ERROR') {
          const errMsg = msg.message || `${this.langLabel} 脚本运行出错`;
          const errLine = extractErrorLine(errMsg, this.language);
          if (!loggedStderr) {
            callbacks.onLog('error', errMsg, errLine);
          }
          this.cleanupRun();
          callbacks.onStatusChange?.('error');
          resolve({
            ok: false,
            durationMs: msg.durationMs ?? 1,
            errorMessage: errMsg,
            errorLine: errLine,
          });
        }
      };

      worker.onerror = (err) => {
        const errMsg = err.message || `${this.langLabel} Worker 发生异常`;
        callbacks.onLog('error', errMsg);
        this.terminateWorker();
        this.cleanupRun();
        callbacks.onStatusChange?.('error');
        resolve({
          ok: false,
          durationMs: Math.max(1, Math.round(performance.now() - this.startedAt)),
          errorMessage: errMsg,
        });
      };

      this.armWatchdog(runId);

      worker.postMessage({
        type: 'RUN',
        runId,
        code: request.debugCode ?? request.code,
        wasmUrl: this.resolveWasmUrl(),
        breakpoints: request.breakpoints ?? [],
        stepDelayMs: request.stepDelayMs ?? 0,
        startInStepMode: request.startInStepMode ?? false,
        channelCounts: request.channelCounts ?? {},
        timerPoolKey: request.timerPoolKey,
        timeSliceMs: request.timeSliceMs ?? 20,
        callbackTimeoutMs: request.timeoutMs,
        mockModules: request.mockModules ?? [],
        mockInputs: request.mockInputs ?? {},
      });
    });
  }

  resume(): void {
    if (!this.worker || !this.activeRunId) return;
    this.worker.postMessage({ type: 'RESUME', runId: this.activeRunId });
  }

  stepNext(): void {
    if (!this.worker || !this.activeRunId) return;
    this.worker.postMessage({ type: 'STEP_NEXT', runId: this.activeRunId });
  }

  pause(): void {
    if (!this.worker || !this.activeRunId) return;
    this.worker.postMessage({ type: 'PAUSE', runId: this.activeRunId });
  }

  updateBreakpoints(breakpoints: string[]): void {
    if (!this.worker || !this.activeRunId) return;
    this.worker.postMessage({
      type: 'SET_BREAKPOINTS',
      runId: this.activeRunId,
      breakpoints,
    });
  }

  updateStepDelay(stepDelayMs: number): void {
    if (!this.worker || !this.activeRunId) return;
    this.worker.postMessage({
      type: 'SET_SPEED',
      runId: this.activeRunId,
      stepDelayMs,
    });
  }

  updateTimeSlice(timeSliceMs: number): void {
    if (!this.worker || !this.activeRunId) return;
    this.worker.postMessage({
      type: 'SET_TIME_SLICE',
      runId: this.activeRunId,
      timeSliceMs,
    });
  }

  updateMockInputs(mockInputs: Record<string, unknown>): void {
    if (!this.worker || !this.activeRunId) return;
    this.worker.postMessage({
      type: 'UPDATE_MOCK_INPUTS',
      runId: this.activeRunId,
      mockInputs,
    });
  }

  emitEvent(eventName: string, args: unknown[] = []): void {
    if (!this.worker || !this.activeRunId) return;
    this.worker.postMessage({
      type: 'EMIT_EVENT',
      runId: this.activeRunId,
      eventName,
      args,
    });
  }

  stop(force = false): void {
    if (!this.activeRunId) return;
    const runId = this.activeRunId;

    if (!force && this.inEventLoop && this.worker && this.gracefulStopHandle === null) {
      this.worker.postMessage({ type: 'STOP_GRACEFUL', runId });
      this.gracefulStopHandle = setTimeout(() => {
        if (this.activeRunId === runId) {
          this.stop(true);
        }
      }, 650);
      return;
    }

    const durationMs = Math.max(1, Math.round(performance.now() - this.startedAt));
    const callbacks = this.activeCallbacks;
    const done = this.activeResolve;
    this.terminateWorker();
    this.cleanupRun();
    callbacks?.onLog('warn', `已手动停止 ${this.langLabel} 脚本执行并重置沙箱。`);
    callbacks?.onStatusChange?.('ready');
    done?.({ ok: false, aborted: true, durationMs });
  }

  private terminateWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  dispose(): void {
    this.stop(true);
    this.terminateWorker();
  }
}
