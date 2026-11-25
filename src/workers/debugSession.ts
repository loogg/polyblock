export interface DebugRunConfig {
  runId: string;
  breakpoints: string[];
  stepDelayMs: number;
  startInStepMode?: boolean;
  /** Optional hook invoked around debugger pauses (breakpoints & visual stepDelayMs) so scheduler logical clock stays accurate. */
  onClockPause?: (paused: boolean, creditLogicalMs?: number) => void;
  /** Cooperative time-slice (ms) used to cap logical credit during `on_start` visual step animation. */
  getTimeSliceMs?: () => number;
}

export interface WorkerMockModule {
  moduleName: string;
  luaSource?: string;
  pythonSource?: string;
  packId?: string;
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
      timeSliceMs?: number;
      callbackTimeoutMs?: number;
      mockModules?: WorkerMockModule[];
      mockInputs?: Record<string, unknown>;
    }
  | { type: 'RESUME'; runId: string }
  | { type: 'STEP_NEXT'; runId: string }
  | { type: 'PAUSE'; runId: string }
  | { type: 'STOP_GRACEFUL'; runId: string }
  | { type: 'SET_BREAKPOINTS'; runId: string; breakpoints: string[] }
  | { type: 'SET_SPEED'; runId: string; stepDelayMs: number }
  | { type: 'SET_TIME_SLICE'; runId: string; timeSliceMs: number }
  | {
      type: 'UPDATE_MOCK_INPUTS';
      runId: string;
      mockInputs: Record<string, unknown>;
    }
  | {
      type: 'EMIT_EVENT';
      runId: string;
      eventName: string;
      args: unknown[];
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
  private shuttingDown = false;
  private pendingResume: (() => void) | null = null;
  private pendingDelayCancel: (() => void) | null = null;
  private lastVars: Record<string, string> = {};
  private readonly post: (msg: Record<string, unknown>) => void;
  private readonly onClockPause?: (paused: boolean, creditLogicalMs?: number) => void;
  private readonly getTimeSliceMs?: () => number;

  constructor(
    config: DebugRunConfig,
    post: (msg: Record<string, unknown>) => void,
  ) {
    this.runId = config.runId;
    this.breakpoints = new Set(config.breakpoints);
    this.stepDelayMs = Math.max(0, config.stepDelayMs);
    this.pauseOnNextStep = Boolean(config.startInStepMode);
    this.onClockPause = config.onClockPause;
    this.getTimeSliceMs = config.getTimeSliceMs;
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
    const cancelDelay = this.pendingDelayCancel;
    this.pendingDelayCancel = null;
    if (cancelDelay) cancelDelay();
  }

  enterGracefulStop(): void {
    this.shuttingDown = true;
    this.stepDelayMs = 0;
    this.resume();
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

  async onStep(
    blockId: string,
    varsJson: unknown,
    inStartCoroutine = false,
  ): Promise<void> {
    const vars = parseVarsJson(varsJson);
    this.lastVars = vars;

    const hitBreakpoint = !this.shuttingDown && this.breakpoints.has(blockId);
    const shouldPause = !this.shuttingDown && (this.pauseOnNextStep || hitBreakpoint);

    if (shouldPause) {
      const reason = hitBreakpoint && !this.pauseOnNextStep ? 'breakpoint' : 'step';
      this.pauseOnNextStep = false;
      this.onClockPause?.(true);
      this.post({
        type: 'PAUSED',
        runId: this.runId,
        blockId,
        vars,
        reason,
      });

      try {
        await new Promise<void>((resolve) => {
          this.pendingResume = resolve;
        });
      } finally {
        // Zero logical time elapses while parked at a breakpoint/step pause
        this.onClockPause?.(false, 0);
      }
      return;
    }

    this.post({
      type: 'STEP',
      runId: this.runId,
      blockId,
      vars,
    });

    if (this.stepDelayMs > 0) {
      const delayMs = this.stepDelayMs;
      this.onClockPause?.(true);
      this.post({ type: 'WAITING', runId: this.runId, active: true });
      try {
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(handle);
            if (this.pendingDelayCancel === finish) this.pendingDelayCancel = null;
            resolve();
          };
          const handle = setTimeout(finish, delayMs);
          this.pendingDelayCancel = finish;
        });
      } finally {
        this.post({ type: 'WAITING', runId: this.runId, active: false });
        // Freeze logical clock completely during event callback visual stepping so timers never self-starve;
        // inside `on_start` coroutine, credit at most one time-slice quantum so tight loops still interleave smoothly.
        const credit = inStartCoroutine
          ? Math.min(delayMs, this.getTimeSliceMs?.() ?? 20)
          : 0;
        this.onClockPause?.(false, credit);
      }
    }
  }

  async onSleep(ms: unknown): Promise<void> {
    const numeric = Number(ms);
    const delay = Number.isFinite(numeric)
      ? Math.max(0, Math.min(600_000, numeric))
      : 0;
    this.post({ type: 'WAITING', runId: this.runId, active: true });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    } finally {
      this.post({ type: 'WAITING', runId: this.runId, active: false });
    }
  }
}
