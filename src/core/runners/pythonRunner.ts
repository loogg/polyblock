import mpWasmAsset from '@micropython/micropython-webassembly-pyscript/micropython.wasm?url';
import PythonWorker from '../../workers/python.worker.ts?worker';
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
    | 'DONE'
    | 'ERROR';
  runId: string;
  line?: string;
  blockId?: string;
  vars?: Record<string, string>;
  reason?: 'breakpoint' | 'step';
  active?: boolean;
  message?: string;
  durationMs?: number;
}

export class MicroPythonWasmRunner implements ScriptRunner {
  readonly id = 'browser-python-micropython';
  readonly name = '浏览器 Python 3 沙箱 (MicroPython WASM)';
  readonly shortLabel = 'MicroPython WASM';
  readonly kind = 'browser-wasm' as const;
  readonly supportedLanguages = ['python' as const];
  readonly description =
    '基于 MicroPython WebAssembly 的轻量 Python 3 调试沙箱，支持异步延时、逐块高亮、断点暂停与单步执行。';
  readonly availability = 'builtin' as const;
  readonly supportsDebugging = true;

  private worker: Worker | null = null;
  private activeRunId: string | null = null;
  private activeResolve: ((res: RunResult) => void) | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private activeCallbacks: RunCallbacks | null = null;
  private activeTimeoutMs = 5000;
  private startedAt = 0;

  private resolveWasmUrl(): string {
    return new URL(mpWasmAsset, window.location.href).href;
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new PythonWorker();
    }
    return this.worker;
  }

  private pauseWatchdog(): void {
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
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
        `单步连续计算超过 ${this.activeTimeoutMs}ms（疑似死循环），已自动终止 Python Worker 沙箱。`,
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
    this.activeRunId = null;
    this.activeResolve = null;
    this.activeCallbacks = null;
  }

  run(request: RunRequest, callbacks: RunCallbacks): Promise<RunResult> {
    this.stop();

    const worker = this.ensureWorker();
    const runId = `py-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.activeRunId = runId;
    this.activeCallbacks = callbacks;
    this.activeTimeoutMs = request.timeoutMs;
    this.startedAt = performance.now();
    callbacks.onStatusChange?.('running');

    return new Promise<RunResult>((resolve) => {
      this.activeResolve = resolve;
      let loggedStderr = false;

      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        const msg = event.data;
        if (!msg || msg.runId !== this.activeRunId) return;

        if (msg.type === 'STDOUT' && msg.line !== undefined) {
          const parsed = parseStdoutLine(msg.line);
          if (parsed.isClear) {
            callbacks.onClear?.();
          } else {
            callbacks.onLog(parsed.level, parsed.message);
          }
          return;
        }

        if (msg.type === 'STDERR' && msg.line !== undefined) {
          loggedStderr = true;
          const errLine = extractErrorLine(msg.line, 'python');
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

        if (msg.type === 'DONE') {
          this.cleanupRun();
          callbacks.onStatusChange?.('ready');
          resolve({
            ok: true,
            durationMs: msg.durationMs ?? 1,
            finalVars: msg.vars,
          });
          return;
        }

        if (msg.type === 'ERROR') {
          const errMsg = msg.message || 'Python 脚本运行出错';
          const errLine = extractErrorLine(errMsg, 'python');
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
        const errMsg = err.message || 'Python Worker 发生异常';
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

  stop(): void {
    if (!this.activeRunId) return;
    const durationMs = Math.max(1, Math.round(performance.now() - this.startedAt));
    const callbacks = this.activeCallbacks;
    const done = this.activeResolve;
    this.terminateWorker();
    this.cleanupRun();
    callbacks?.onLog('warn', '已手动停止 Python 脚本执行并重置沙箱。');
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
    this.stop();
    this.terminateWorker();
  }
}
