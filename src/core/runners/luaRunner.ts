import luaWasmAsset from 'wasmoon/dist/glue.wasm?url';
import LuaWorker from '../../workers/lua.worker.ts?worker';
import { extractErrorLine, parseStdoutLine } from './logParser';
import type { RunCallbacks, RunRequest, RunResult, ScriptRunner } from './types';

interface WorkerReply {
  type: 'STDOUT' | 'DONE' | 'ERROR';
  runId: string;
  line?: string;
  message?: string;
  durationMs?: number;
}

export class WasmoonLuaRunner implements ScriptRunner {
  readonly id = 'browser-lua-wasmoon';
  readonly name = '浏览器 Lua 5.4 沙箱 (Wasmoon WASM)';
  readonly shortLabel = 'Lua 5.4 WASM';
  readonly kind = 'browser-wasm' as const;
  readonly supportedLanguages = ['lua' as const];
  readonly description =
    '基于 WebAssembly 的纯前端 Lua 5.4 Web Worker 运行器，支持实时 print 输出与超时/手动强杀。';
  readonly availability = 'builtin' as const;

  private worker: Worker | null = null;
  private activeRunId: string | null = null;
  private activeResolve: ((res: RunResult) => void) | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private activeCallbacks: RunCallbacks | null = null;
  private startedAt = 0;

  private resolveWasmUrl(): string {
    return new URL(luaWasmAsset, window.location.href).href;
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new LuaWorker();
    }
    return this.worker;
  }

  private cleanupRun(): void {
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.activeRunId = null;
    this.activeResolve = null;
    this.activeCallbacks = null;
  }

  run(request: RunRequest, callbacks: RunCallbacks): Promise<RunResult> {
    this.stop();

    const worker = this.ensureWorker();
    const runId = `lua-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.activeRunId = runId;
    this.activeCallbacks = callbacks;
    this.startedAt = performance.now();
    callbacks.onStatusChange?.('running');

    return new Promise<RunResult>((resolve) => {
      this.activeResolve = resolve;

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

        if (msg.type === 'DONE') {
          this.cleanupRun();
          callbacks.onStatusChange?.('ready');
          resolve({ ok: true, durationMs: msg.durationMs ?? 1 });
          return;
        }

        if (msg.type === 'ERROR') {
          const errMsg = msg.message || 'Lua 脚本运行出错';
          const errLine = extractErrorLine(errMsg, 'lua');
          callbacks.onLog('error', errMsg, errLine);
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
        const errMsg = err.message || 'Lua Worker 发生异常';
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

      this.timeoutHandle = setTimeout(() => {
        if (this.activeRunId !== runId) return;
        const durationMs = Math.round(performance.now() - this.startedAt);
        callbacks.onLog(
          'warn',
          `执行超过 ${request.timeoutMs}ms（疑似死循环），已自动终止 Lua Worker 沙箱。`,
        );
        this.terminateWorker();
        const done = this.activeResolve;
        this.cleanupRun();
        callbacks.onStatusChange?.('ready');
        done?.({
          ok: false,
          timedOut: true,
          durationMs,
          errorMessage: 'Execution timed out',
        });
      }, request.timeoutMs);

      worker.postMessage({
        type: 'RUN',
        runId,
        code: request.code,
        wasmUrl: this.resolveWasmUrl(),
      });
    });
  }

  stop(): void {
    if (!this.activeRunId) return;
    const durationMs = Math.max(1, Math.round(performance.now() - this.startedAt));
    const callbacks = this.activeCallbacks;
    const done = this.activeResolve;
    this.terminateWorker();
    this.cleanupRun();
    callbacks?.onLog('warn', '已手动停止 Lua 脚本执行并重置沙箱。');
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
