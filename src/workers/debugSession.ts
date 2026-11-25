export interface DebugRunConfig {
  runId: string;
  breakpoints: string[];
  stepDelayMs: number;
  startInStepMode?: boolean;
}

export interface WorkerMockModule {
  moduleName: string;
  luaSource?: string;
  pythonSource?: string;
}

export type WorkerControlMessage =
  | {
      type: 'RUN';
      runId: string;
      code: string;
      wasmUrl: string;
      breakpoints: string[];
      stepDelayMs: number;
      startInStepMode?: boolean;
      timerCount?: number;
      mockModules?: WorkerMockModule[];
      mockInputs?: Record<string, unknown>;
    }
  | { type: 'RESUME'; runId: string }
  | { type: 'STEP_NEXT'; runId: string }
  | { type: 'PAUSE'; runId: string }
  | { type: 'STOP_GRACEFUL'; runId: string }
  | { type: 'SET_BREAKPOINTS'; runId: string; breakpoints: string[] }
  | { type: 'SET_SPEED'; runId: string; stepDelayMs: number }
  | {
      type: 'UPDATE_MOCK_INPUTS';
      runId: string;
      mockInputs: Record<string, unknown>;
    };

export function parseVarsJson(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Shared async debugger session running inside a Web Worker.
 * Uses native JS Promises (no SharedArrayBuffer required) so GitHub Pages
 * supports real breakpoints, single-step execution, and non-blocking delays.
 */
export class WorkerDebugSession {
  readonly runId: string;
  private breakpoints: Set<string>;
  private stepDelayMs: number;
  private pauseOnNextStep: boolean;
  private pendingResume: (() => void) | null = null;
  private lastVars: Record<string, string> = {};
  private readonly post: (msg: Record<string, unknown>) => void;

  constructor(
    config: DebugRunConfig,
    post: (msg: Record<string, unknown>) => void,
  ) {
    this.runId = config.runId;
    this.breakpoints = new Set(config.breakpoints);
    this.stepDelayMs = Math.max(0, config.stepDelayMs);
    this.pauseOnNextStep = Boolean(config.startInStepMode);
    this.post = post;
  }

  getLastVars(): Record<string, string> {
    return this.lastVars;
  }

  setFinalVars(rawJson: unknown): void {
    this.lastVars = parseVarsJson(rawJson);
  }

  setBreakpoints(ids: string[]): void {
    this.breakpoints = new Set(ids);
  }

  setStepDelay(ms: number): void {
    this.stepDelayMs = Math.max(0, ms);
  }

  pause(): void {
    this.pauseOnNextStep = true;
  }

  resume(): void {
    this.pauseOnNextStep = false;
    const fn = this.pendingResume;
    this.pendingResume = null;
    if (fn) {
      this.post({ type: 'RESUMED', runId: this.runId });
      fn();
    }
  }

  stepNext(): void {
    this.pauseOnNextStep = true;
    const fn = this.pendingResume;
    this.pendingResume = null;
    if (fn) {
      this.post({ type: 'RESUMED', runId: this.runId });
      fn();
    }
  }

  async onStep(blockId: string, varsJson: unknown): Promise<void> {
    const vars = parseVarsJson(varsJson);
    this.lastVars = vars;

    const hitBreakpoint = this.breakpoints.has(blockId);
    const shouldPause = this.pauseOnNextStep || hitBreakpoint;

    if (shouldPause) {
      const reason = hitBreakpoint && !this.pauseOnNextStep ? 'breakpoint' : 'step';
      this.pauseOnNextStep = false;
      this.post({
        type: 'PAUSED',
        runId: this.runId,
        blockId,
        vars,
        reason,
      });

      await new Promise<void>((resolve) => {
        this.pendingResume = resolve;
      });
      return;
    }

    this.post({
      type: 'STEP',
      runId: this.runId,
      blockId,
      vars,
    });

    if (this.stepDelayMs > 0) {
      this.post({ type: 'WAITING', runId: this.runId, active: true });
      await new Promise<void>((resolve) => setTimeout(resolve, this.stepDelayMs));
      this.post({ type: 'WAITING', runId: this.runId, active: false });
    }
  }

  async onSleep(ms: unknown): Promise<void> {
    const numeric = Number(ms);
    const delay = Number.isFinite(numeric)
      ? Math.max(0, Math.min(600_000, numeric))
      : 0;
    this.post({ type: 'WAITING', runId: this.runId, active: true });
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    this.post({ type: 'WAITING', runId: this.runId, active: false });
  }
}
