import type {
  RuntimeTelemetry,
  RuntimeTimerTelemetry,
} from '../types/project';

interface TimerSlot {
  id: number;
  periodMs: number;
  repeat: number; // 0 = infinite, 1 = one-shot, N > 1 = N triggers
  firedCount: number;
  startedAt: number;
  nextFireAt: number;
  running: boolean;
}

interface QueuedButtonEvent {
  key: 'A' | 'B';
  pressed: boolean;
}

export interface RuntimeSchedulerConfig {
  runId: string;
  timerCount: number;
  post: (msg: Record<string, unknown>) => void;
}

/**
 * Isolated per-run cooperative runtime scheduler for embedded-style
 * on_start / on_run / on_timer(id) / on_button(key, pressed) / on_stop execution.
 * Mirrors isolated C-host ScriptCtx semantics: zero shared global timer state across runs.
 */
export class WorkerRuntimeScheduler {
  readonly runId: string;
  readonly timerCount: number;
  private readonly post: (msg: Record<string, unknown>) => void;

  private runPeriodMs = 100;
  private runActive = false;
  private runExplicitlyControlled = false;
  private nextRunAt = 0;
  private runCount = 0;

  private hasOnRun = false;
  private hasOnTimer = false;
  private hasOnButton = false;
  private eventLoopActive = false;

  private timers = new Map<number, TimerSlot>();
  private buttonQueue: QueuedButtonEvent[] = [];
  private stopRequested = false;

  private wakeFn: (() => void) | null = null;
  private waitingPosted = false;
  private lastTelemetryAt = 0;

  constructor(config: RuntimeSchedulerConfig) {
    this.runId = config.runId;
    this.timerCount = Math.max(1, Math.min(32, Math.trunc(config.timerCount || 8)));
    this.post = config.post;
  }

  private now(): number {
    return performance.now();
  }

  private assertTimerId(rawId: unknown): number {
    const id = Math.trunc(Number(rawId));
    if (!Number.isFinite(id) || id < 0 || id >= this.timerCount) {
      throw new Error(
        `定时器通道 ID ${String(rawId)} 超出当前项目配置范围 (0~${this.timerCount - 1})`,
      );
    }
    return id;
  }

  private wake(): void {
    const fn = this.wakeFn;
    this.wakeFn = null;
    if (fn) fn();
  }

  setRunPeriod(rawMs: unknown): void {
    const n = Number(rawMs);
    const period = Number.isFinite(n) ? Math.max(10, Math.min(600_000, Math.round(n))) : 100;
    this.runPeriodMs = period;
    if (this.runActive) {
      this.nextRunAt = Math.min(this.nextRunAt, this.now() + period);
    }
    this.wake();
    this.emitTelemetry(true);
  }

  startRun(): void {
    this.runExplicitlyControlled = true;
    this.runActive = true;
    this.nextRunAt = this.now() + this.runPeriodMs;
    this.wake();
    this.emitTelemetry(true);
  }

  stopRun(): void {
    this.runExplicitlyControlled = true;
    this.runActive = false;
    this.wake();
    this.emitTelemetry(true);
  }

  startTimer(rawId: unknown, rawPeriodMs: unknown, rawRepeat: unknown = 0): void {
    const id = this.assertTimerId(rawId);
    const pNum = Number(rawPeriodMs);
    const periodMs = Number.isFinite(pNum)
      ? Math.max(10, Math.min(600_000, Math.round(pNum)))
      : 500;
    const rNum = Number(rawRepeat);
    const repeat = Number.isFinite(rNum) ? Math.max(0, Math.trunc(rNum)) : 0;
    const now = this.now();

    // Standard embedded re-arm semantics: calling start_timer on a running ID resets its countdown
    this.timers.set(id, {
      id,
      periodMs,
      repeat,
      firedCount: 0,
      startedAt: now,
      nextFireAt: now + periodMs,
      running: true,
    });
    this.wake();
    this.emitTelemetry(true);
  }

  stopTimer(rawId: unknown): void {
    const id = this.assertTimerId(rawId);
    const existing = this.timers.get(id);
    if (existing) {
      existing.running = false;
      this.timers.delete(id);
      this.wake();
      this.emitTelemetry(true);
    }
  }

  /** Returns elapsed milliseconds in the current timer cycle (0 -> periodMs), or 0 if stopped. */
  getTimerValue(rawId: unknown): number {
    const id = this.assertTimerId(rawId);
    const slot = this.timers.get(id);
    if (!slot || !slot.running) return 0;
    const elapsed = Math.round(this.now() - slot.startedAt);
    return Math.max(0, Math.min(slot.periodMs, elapsed));
  }

  isTimerRunning(rawId: unknown): boolean {
    const id = this.assertTimerId(rawId);
    return Boolean(this.timers.get(id)?.running);
  }

  hasAnyRunningTimer(): boolean {
    for (const slot of this.timers.values()) {
      if (slot.running) return true;
    }
    return false;
  }

  onMockInputsDelta(
    prevInputs: Record<string, unknown>,
    nextInputs: Record<string, unknown>,
  ): void {
    const prevA = Boolean(prevInputs.btnA);
    const nextA = Boolean(nextInputs.btnA);
    if (prevA !== nextA) {
      this.buttonQueue.push({ key: 'A', pressed: nextA });
      this.wake();
    }

    const prevB = Boolean(prevInputs.btnB);
    const nextB = Boolean(nextInputs.btnB);
    if (prevB !== nextB) {
      this.buttonQueue.push({ key: 'B', pressed: nextB });
      this.wake();
    }
  }

  requestGracefulStop(): void {
    this.stopRequested = true;
    this.wake();
  }

  shouldEnterEventLoop(
    hasOnRun: boolean,
    hasOnTimer: boolean,
    hasOnButton: boolean,
  ): boolean {
    this.hasOnRun = Boolean(hasOnRun);
    this.hasOnTimer = Boolean(hasOnTimer);
    this.hasOnButton = Boolean(hasOnButton);

    if (this.hasOnRun && !this.runExplicitlyControlled) {
      this.runActive = true;
      this.nextRunAt = this.now() + this.runPeriodMs;
    }

    const active =
      !this.stopRequested &&
      ((this.hasOnRun && this.runActive) ||
        this.hasAnyRunningTimer() ||
        this.hasOnButton);

    this.eventLoopActive = active;
    this.emitTelemetry(true);
    return active;
  }

  getTelemetrySnapshot(): RuntimeTelemetry {
    const now = this.now();
    const timers: RuntimeTimerTelemetry[] = Array.from(this.timers.values())
      .sort((a, b) => a.id - b.id)
      .map((slot) => ({
        id: slot.id,
        periodMs: slot.periodMs,
        repeat: slot.repeat,
        firedCount: slot.firedCount,
        elapsedMs: slot.running
          ? Math.max(0, Math.min(slot.periodMs, Math.round(now - slot.startedAt)))
          : 0,
        running: slot.running,
      }));

    return {
      eventLoopActive: this.eventLoopActive,
      hasOnRun: this.hasOnRun,
      runActive: this.runActive,
      runPeriodMs: this.runPeriodMs,
      runCount: this.runCount,
      hasOnButton: this.hasOnButton,
      timers,
    };
  }

  emitTelemetry(force = false): void {
    const now = this.now();
    if (!force && now - this.lastTelemetryAt < 90) return;
    this.lastTelemetryAt = now;
    this.post({
      type: 'RUNTIME_TELEMETRY',
      runId: this.runId,
      telemetry: this.getTelemetrySnapshot(),
    });
  }

  private setWaiting(active: boolean): void {
    if (this.waitingPosted === active) return;
    this.waitingPosted = active;
    this.post({ type: 'WAITING', runId: this.runId, active });
  }

  /**
   * Waits cooperatively for the next scheduled event.
   * Returns a compact primitive string ("run", "timer:<id>", "button:<A|B>:<1|0>", "stop", "done")
   * so both Wasmoon Lua and MicroPython WASM consume it cleanly with zero JS-proxy ambiguity.
   */
  async nextEvent(): Promise<string> {
    while (true) {
      if (this.stopRequested) {
        this.eventLoopActive = false;
        this.setWaiting(false);
        this.emitTelemetry(true);
        return 'stop';
      }

      if (this.buttonQueue.length > 0) {
        const ev = this.buttonQueue.shift()!;
        if (this.hasOnButton) {
          this.setWaiting(false);
          return `button:${ev.key}:${ev.pressed ? '1' : '0'}`;
        }
      }

      const now = this.now();

      // 1. Check earliest due timer
      let dueTimer: TimerSlot | null = null;
      for (const slot of this.timers.values()) {
        if (!slot.running) continue;
        if (slot.nextFireAt <= now) {
          if (!dueTimer || slot.nextFireAt < dueTimer.nextFireAt) {
            dueTimer = slot;
          }
        }
      }

      if (dueTimer) {
        dueTimer.firedCount += 1;
        const finished = dueTimer.repeat > 0 && dueTimer.firedCount >= dueTimer.repeat;
        const firedId = dueTimer.id;
        if (finished) {
          dueTimer.running = false;
          this.timers.delete(firedId);
        } else {
          dueTimer.startedAt = now;
          dueTimer.nextFireAt = now + dueTimer.periodMs;
        }
        this.emitTelemetry(true);
        if (this.hasOnTimer) {
          this.setWaiting(false);
          return `timer:${firedId}`;
        }
        continue;
      }

      // 2. Check on_run periodic callback
      if (this.hasOnRun && this.runActive && this.nextRunAt <= now) {
        this.nextRunAt = now + this.runPeriodMs;
        this.runCount += 1;
        this.emitTelemetry(false);
        this.setWaiting(false);
        return 'run';
      }

      // 3. Check if any active event source remains
      const hasSources =
        (this.hasOnRun && this.runActive) ||
        this.hasAnyRunningTimer() ||
        this.hasOnButton;
      if (!hasSources) {
        this.eventLoopActive = false;
        this.setWaiting(false);
        this.emitTelemetry(true);
        return 'done';
      }

      // 4. Compute earliest upcoming deadline & sleep cleanly while pausing watchdog
      let earliest = Number.POSITIVE_INFINITY;
      if (this.hasOnRun && this.runActive) {
        earliest = Math.min(earliest, this.nextRunAt);
      }
      for (const slot of this.timers.values()) {
        if (slot.running) {
          earliest = Math.min(earliest, slot.nextFireAt);
        }
      }

      const delta = Number.isFinite(earliest) ? Math.max(8, earliest - now) : 120;
      const sleepMs = Math.min(delta, 120);

      this.setWaiting(true);
      this.emitTelemetry(false);

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timerHandle);
          if (this.wakeFn === finish) this.wakeFn = null;
          resolve();
        };
        const timerHandle = setTimeout(finish, sleepMs);
        this.wakeFn = finish;
      });
    }
  }
}
