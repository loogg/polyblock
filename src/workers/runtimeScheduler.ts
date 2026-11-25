import type {
  RuntimeTelemetry,
  RuntimeTimerTelemetry,
  StartCoroutineState,
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

interface QueuedCustomEvent {
  eventName: string;
  args: unknown[];
}

export interface RuntimeSchedulerConfig {
  runId: string;
  timerCount: number;
  /** Cooperative time-slice budget (ms) for `on_start` coroutine preemption (default 20ms). */
  timeSliceMs?: number;
  /** Single synchronous event callback timeout protection (ms, default 5000ms). */
  callbackTimeoutMs?: number;
  /** Simulated RTOS tick frequency in Hz (default 1000Hz -> 1 tick = 1ms). */
  tickHz?: number;
  post: (msg: Record<string, unknown>) => void;
}

/**
 * Isolated per-run cooperative runtime scheduler mirroring embedded Scheme A C-host semantics:
 * - `on_start` runs inside an isolated coroutine (`CO_READY` / `CO_SLEEPING` / `CO_RUNNING` / `CO_DEAD`)
 *   supporting infinite loops, non-blocking `sleep_ms(ms)` yield, and cooperative time-slice preemption.
 * - `on_run`, `on_timer(id)`, `on_button(key, pressed)`, and custom events run as short synchronous
 *   callbacks on the main state with strict single-callback timeout guard and no `sleep_ms` blocking.
 * - Pause-aware logical clock freezes during visual stepping (`stepDelayMs`) and breakpoint pauses
 *   so timers & `on_run` never drift or starve at normal/slow visual stepping speeds.
 * - Fair round-robin dispatch prevents any single due timer from starving `on_run` or sibling timers.
 */
export class WorkerRuntimeScheduler {
  readonly runId: string;
  readonly timerCount: number;
  private readonly post: (msg: Record<string, unknown>) => void;

  // --- Pause-aware logical clock & RTOS tick base ---
  private pausedOffsetMs = 0;
  private pauseDepth = 0;
  private pauseStartedAt: number | null = null;
  private readonly tickHz: number;
  private readonly bootLogicalMs: number;

  // --- Independent on_run periodic schedule (completely independent of T0..TN) ---
  private runPeriodMs = 100;
  private runActive = false;
  private runExplicitlyControlled = false;
  private nextRunAt = 0;
  private runCount = 0;

  private hasOnRun = false;
  private hasOnTimer = false;
  private hasOnButton = false;
  private eventLoopActive = false;

  // --- `on_start` coroutine scheduling state (mirrors C ScriptCtx co_state / wake_at) ---
  private coState: StartCoroutineState = 'idle';
  private coWakeAt = 0;
  private coHasRunOnce = false;
  private timeSliceMs = 20;

  // --- Main-state synchronous callback guard (mirrors C main-L timeout hook) ---
  private callbackTimeoutMs = 5000;
  private activeCallbackName: string | null = null;
  private callbackStartedAt = 0;

  // --- Timers & external event queues ---
  private timers = new Map<number, TimerSlot>();
  private buttonQueue: QueuedButtonEvent[] = [];
  private customEventQueue: QueuedCustomEvent[] = [];
  private lastCustomEvent: QueuedCustomEvent | null = null;
  private lastPeriodicKey: string | null = null;
  private stopRequested = false;

  // --- Async wake & Python coroutine slice handshake ---
  private wakeFn: (() => void) | null = null;
  private waitingPosted = false;
  private lastTelemetryAt = 0;

  private pyTurnReady = false;
  private pyTurnWaiter: (() => void) | null = null;
  private pySliceDoneWaiter: (() => void) | null = null;
  private pySliceActive = false;

  constructor(config: RuntimeSchedulerConfig) {
    this.runId = config.runId;
    this.timerCount = Math.max(1, Math.min(32, Math.trunc(config.timerCount || 8)));
    this.timeSliceMs = this.clampTimeSlice(config.timeSliceMs ?? 20);
    this.callbackTimeoutMs = Math.max(
      500,
      Math.min(120_000, Math.round(config.callbackTimeoutMs ?? 5000)),
    );
    const hz = Number(config.tickHz);
    this.tickHz = Number.isFinite(hz) ? Math.max(10, Math.min(100_000, Math.round(hz))) : 1000;
    this.bootLogicalMs = performance.now();
    this.post = config.post;
  }

  /** Returns current 32-bit unsigned system tick count (default 1000Hz -> 1ms/tick, logical-clock aligned). */
  getTick(): number {
    const elapsedMs = Math.max(0, this.now() - this.bootLogicalMs);
    return Math.floor((elapsedMs * this.tickHz) / 1000) >>> 0;
  }

  /** Converts milliseconds to unsigned system ticks (mirrors FreeRTOS pdMS_TO_TICKS). */
  msToTick(rawMs: unknown): number {
    const ms = Number(rawMs);
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return Math.ceil((ms * this.tickHz) / 1000) >>> 0;
  }

  /**
   * 32-bit unsigned wrap-around safe timeout check (Scheme A):
   * Mirrors C: `(uint32_t)(now_tick - start_tick) >= (uint32_t)timeout_ticks`.
   */
  isTickExpired(
    rawStartTick: unknown,
    rawTimeoutTicks: unknown,
    overrideNowTick?: number,
  ): boolean {
    const nowTick = (overrideNowTick !== undefined ? overrideNowTick : this.getTick()) >>> 0;
    const startTick = Math.trunc(Number(rawStartTick) || 0) >>> 0;
    const timeoutTicks = Math.max(0, Math.trunc(Number(rawTimeoutTicks) || 0)) >>> 0;
    const elapsed = (nowTick - startTick) >>> 0;
    return elapsed >= timeoutTicks;
  }

  private clampTimeSlice(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isFinite(n)) return 20;
    return Math.max(5, Math.min(500, Math.round(n)));
  }

  setTimeSliceMs(raw: unknown): void {
    this.timeSliceMs = this.clampTimeSlice(raw);
    this.emitTelemetry(true);
  }

  getTimeSliceMs(): number {
    return this.timeSliceMs;
  }

  getCallbackTimeoutMs(): number {
    return this.callbackTimeoutMs;
  }

  /**
   * Freezes logical clock during breakpoint pauses and visual stepping animations.
   * Nested pause calls are reference-counted.
   */
  pauseClock(): void {
    if (this.pauseDepth === 0) {
      this.pauseStartedAt = performance.now();
    }
    this.pauseDepth += 1;
  }

  /**
   * Resumes logical clock after a debugger pause.
   * `creditLogicalMs` lets `on_start` visual steps advance logical time by at most one slice quantum
   * while callback steps and breakpoints credit `0` so timers never drift or self-starve.
   */
  resumeClock(creditLogicalMs = 0): void {
    if (this.pauseDepth <= 0) return;
    this.pauseDepth -= 1;
    if (this.pauseDepth === 0 && this.pauseStartedAt !== null) {
      const wallDelta = Math.max(0, performance.now() - this.pauseStartedAt);
      const credit = Math.max(0, Math.min(wallDelta, creditLogicalMs));
      this.pausedOffsetMs += wallDelta - credit;
      this.pauseStartedAt = null;
    }
  }

  now(): number {
    const base = this.pauseStartedAt ?? performance.now();
    return base - this.pausedOffsetMs;
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

  // --- Synchronous callback guard (Option A strict alignment) ---
  beginCallback(name: string): void {
    this.activeCallbackName = name || 'callback';
    this.callbackStartedAt = this.now();
  }

  endCallback(): void {
    this.activeCallbackName = null;
  }

  isInCallback(): boolean {
    return this.activeCallbackName !== null;
  }

  getActiveCallbackName(): string {
    return this.activeCallbackName ?? '';
  }

  isCallbackTimedOut(): boolean {
    if (this.activeCallbackName === null) return false;
    if (this.stopRequested && this.activeCallbackName !== 'on_stop') {
      return true;
    }
    return this.now() - this.callbackStartedAt >= this.callbackTimeoutMs;
  }

  isStopRequested(): boolean {
    return this.stopRequested;
  }

  // --- `on_start` coroutine state transitions ---
  initCoroutineMode(
    hasStart: boolean,
    hasOnRun: boolean,
    hasOnTimer: boolean,
    hasOnButton: boolean,
  ): boolean {
    this.hasOnRun = Boolean(hasOnRun);
    this.hasOnTimer = Boolean(hasOnTimer);
    this.hasOnButton = Boolean(hasOnButton);

    this.coState = hasStart ? 'ready' : 'dead';
    this.coWakeAt = 0;
    this.coHasRunOnce = false;

    if (this.hasOnRun && !this.runExplicitlyControlled) {
      this.runActive = true;
      this.nextRunAt = this.now() + this.runPeriodMs;
    }

    const active =
      !this.stopRequested &&
      (this.coState === 'ready' ||
        (this.hasOnRun && this.runActive) ||
        this.hasAnyRunningTimer() ||
        this.hasOnButton);

    this.eventLoopActive = active;
    this.emitTelemetry(true);
    return active;
  }

  onStartCoSleep(rawMs: unknown): void {
    const n = Number(rawMs);
    const delay = Number.isFinite(n) ? Math.max(0, Math.min(600_000, n)) : 0;
    this.coState = 'sleeping';
    this.coWakeAt = this.now() + delay;
    this.resolvePySliceDone();
    this.wake();
    this.emitTelemetry(false);
  }

  onStartCoYieldSlice(): void {
    this.coState = 'ready';
    this.resolvePySliceDone();
    this.wake();
    this.emitTelemetry(false);
  }

  onStartCoDone(): void {
    this.coState = 'dead';
    this.resolvePySliceDone();
    this.wake();
    this.emitTelemetry(true);
  }

  getStartCoState(): StartCoroutineState {
    return this.coState;
  }

  // --- Python asyncio single-slice mutual-exclusion handshake ---
  private resolvePySliceDone(): void {
    this.pySliceActive = false;
    const fn = this.pySliceDoneWaiter;
    this.pySliceDoneWaiter = null;
    if (fn) fn();
  }

  waitPythonStartTurn(): Promise<boolean> {
    if (this.stopRequested || this.coState === 'dead') {
      return Promise.resolve(false);
    }
    if (this.pyTurnReady) {
      this.pyTurnReady = false;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      this.pyTurnWaiter = () => resolve(!this.stopRequested && this.coState !== 'dead');
    });
  }

  resumePythonStartSlice(): Promise<void> {
    if (this.stopRequested || this.coState === 'dead') {
      return Promise.resolve();
    }
    this.pySliceActive = true;
    return new Promise<void>((resolve) => {
      this.pySliceDoneWaiter = resolve;
      if (this.pyTurnWaiter) {
        const fn = this.pyTurnWaiter;
        this.pyTurnWaiter = null;
        fn();
      } else {
        this.pyTurnReady = true;
      }
    });
  }

  /**
   * Dynamically refreshes discovered `_G` callbacks (mirrors C backend per-tick / lazy lookup).
   * Enables `require("timers")` / `require("buttons")` inside `on_start()` to activate callbacks dynamically.
   */
  syncHandlers(
    hasOnRun: boolean,
    hasOnTimer: boolean,
    hasOnButton: boolean,
  ): void {
    const prevHasRun = this.hasOnRun;
    this.hasOnRun = Boolean(hasOnRun);
    this.hasOnTimer = Boolean(hasOnTimer);
    this.hasOnButton = Boolean(hasOnButton);

    if (!prevHasRun && this.hasOnRun && !this.runExplicitlyControlled) {
      this.runActive = true;
      this.nextRunAt = this.now() + this.runPeriodMs;
      this.wake();
      this.emitTelemetry(true);
    } else if (this.hasOnButton && !this.eventLoopActive && !this.stopRequested) {
      this.eventLoopActive = true;
      this.wake();
      this.emitTelemetry(true);
    }
  }

  setRunPeriod(rawMs: unknown): void {
    const n = Number(rawMs);
    const period = Number.isFinite(n) ? Math.max(10, Math.min(600_000, Math.round(n))) : 100;
    this.runPeriodMs = period;
    // Immediately re-arm next trigger from current logical time (effective immediately)
    if (this.runActive) {
      this.nextRunAt = this.now() + period;
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

  /** Enqueues a generic declarative event (e.g. `on_button`, `on_robot_estop`, `on_can_rx`). */
  enqueueEvent(eventName: string, args: unknown[] = []): void {
    if (!eventName) return;
    this.customEventQueue.push({
      eventName: String(eventName),
      args: Array.isArray(args) ? args : [],
    });
    this.wake();
  }

  getLastEventName(): string {
    return this.lastCustomEvent?.eventName ?? '';
  }

  getLastEventArgCount(): number {
    return this.lastCustomEvent?.args.length ?? 0;
  }

  getLastEventArg(oneBasedIndex: number): unknown {
    const idx = Math.trunc(Number(oneBasedIndex)) - 1;
    if (!this.lastCustomEvent || idx < 0 || idx >= this.lastCustomEvent.args.length) {
      return undefined;
    }
    return this.lastCustomEvent.args[idx];
  }

  requestGracefulStop(): void {
    this.stopRequested = true;
    if (this.pyTurnWaiter) {
      const fn = this.pyTurnWaiter;
      this.pyTurnWaiter = null;
      fn();
    }
    if (this.pySliceActive) {
      this.resolvePySliceDone();
    }
    this.wake();
  }

  /** Legacy compatibility helper (equivalent to initCoroutineMode without an active `on_start` coroutine). */
  shouldEnterEventLoop(
    hasOnRun: boolean,
    hasOnTimer: boolean,
    hasOnButton: boolean,
  ): boolean {
    return this.initCoroutineMode(false, hasOnRun, hasOnTimer, hasOnButton);
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
      startCoState: this.coState,
      timeSliceMs: this.timeSliceMs,
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

  private async macrotaskYield(ms = 4): Promise<void> {
    this.setWaiting(true);
    try {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timerHandle);
          if (this.wakeFn === finish) this.wakeFn = null;
          resolve();
        };
        const timerHandle = setTimeout(finish, ms);
        this.wakeFn = finish;
      });
    } finally {
      this.setWaiting(false);
    }
  }

  /**
   * Waits cooperatively for the next scheduled event or `on_start` coroutine slice.
   * Returns compact primitive tokens:
   *   "start_resume" | "run" | "timer:<id>" | "button:<A|B>:<1|0>" | "event:<json>" | "stop" | "done"
   */
  async nextEvent(): Promise<string> {
    while (true) {
      if (this.stopRequested) {
        this.eventLoopActive = false;
        this.setWaiting(false);
        this.emitTelemetry(true);
        return 'stop';
      }

      // 0. Always launch `on_start` first on initial startup before any periodic events
      if (this.coState === 'ready' && !this.coHasRunOnce) {
        this.coHasRunOnce = true;
        this.coState = 'running';
        this.setWaiting(false);
        this.emitTelemetry(false);
        return 'start_resume';
      }

      // 1. Immediate external events (custom declarative events & virtual buttons)
      if (this.customEventQueue.length > 0) {
        const ev = this.customEventQueue.shift()!;
        this.lastCustomEvent = ev;
        this.setWaiting(false);
        return `event:${JSON.stringify([ev.eventName, ev.args])}`;
      }

      if (this.buttonQueue.length > 0) {
        const ev = this.buttonQueue.shift()!;
        if (this.hasOnButton) {
          this.setWaiting(false);
          return `button:${ev.key}:${ev.pressed ? '1' : '0'}`;
        }
      }

      const now = this.now();

      // 2. Fair round-robin selection across ALL due timers AND independent `on_run`
      const dueCandidates: Array<{
        key: string;
        dueAt: number;
        slot?: TimerSlot;
      }> = [];

      for (const slot of this.timers.values()) {
        if (slot.running && slot.nextFireAt <= now) {
          dueCandidates.push({
            key: `timer:${slot.id}`,
            dueAt: slot.nextFireAt,
            slot,
          });
        }
      }
      if (this.hasOnRun && this.runActive && this.nextRunAt <= now) {
        dueCandidates.push({ key: 'run', dueAt: this.nextRunAt });
      }

      if (dueCandidates.length > 0) {
        dueCandidates.sort((a, b) => {
          // If multiple sources are due simultaneously, rotate away from whichever just ran
          // so no timer or on_run can ever starve another.
          const aJustRan = a.key === this.lastPeriodicKey ? 1 : 0;
          const bJustRan = b.key === this.lastPeriodicKey ? 1 : 0;
          if (aJustRan !== bJustRan) return aJustRan - bJustRan;
          return a.dueAt - b.dueAt;
        });

        const winner = dueCandidates[0];
        this.lastPeriodicKey = winner.key;

        if (winner.slot) {
          const slot = winner.slot;
          slot.firedCount += 1;
          const finished = slot.repeat > 0 && slot.firedCount >= slot.repeat;
          const firedId = slot.id;
          if (finished) {
            slot.running = false;
            this.timers.delete(firedId);
          } else {
            slot.startedAt = now;
            slot.nextFireAt = now + slot.periodMs;
          }
          this.emitTelemetry(true);
          if (this.hasOnTimer) {
            this.setWaiting(false);
            return `timer:${firedId}`;
          }
          continue;
        }

        // Independent `on_run` tick
        this.nextRunAt = now + this.runPeriodMs;
        this.runCount += 1;
        this.emitTelemetry(false);
        this.setWaiting(false);
        return 'run';
      }

      // 3. Check `on_start` coroutine wake (CO_READY slice or CO_SLEEPING wake_at reached)
      if (this.coState === 'ready') {
        // Yield 1 short macrotask tick (like RTOS vTaskDelay(1)/taskYIELD()) so Web Worker
        // onmessage always stays responsive to STOP, button clicks, and sensor sliders.
        await this.macrotaskYield(4);
        if (this.stopRequested) continue;
        // Re-check if an urgent external event arrived during the breather
        if (
          this.customEventQueue.length > 0 ||
          (this.buttonQueue.length > 0 && this.hasOnButton)
        ) {
          continue;
        }
        this.coState = 'running';
        this.setWaiting(false);
        this.emitTelemetry(false);
        return 'start_resume';
      }

      if (this.coState === 'sleeping' && this.coWakeAt <= now) {
        this.coState = 'running';
        this.setWaiting(false);
        this.emitTelemetry(false);
        return 'start_resume';
      }

      // 4. Check if any active event source or sleeping `on_start` coroutine remains
      const hasSources =
        this.coState === 'sleeping' ||
        (this.hasOnRun && this.runActive) ||
        this.hasAnyRunningTimer() ||
        this.hasOnButton;
      if (!hasSources) {
        this.eventLoopActive = false;
        this.setWaiting(false);
        this.emitTelemetry(true);
        return 'done';
      }

      // 5. Compute earliest upcoming deadline across `on_run`, timers, and `on_start` wake_at
      let earliest = Number.POSITIVE_INFINITY;
      if (this.hasOnRun && this.runActive) {
        earliest = Math.min(earliest, this.nextRunAt);
      }
      for (const slot of this.timers.values()) {
        if (slot.running) {
          earliest = Math.min(earliest, slot.nextFireAt);
        }
      }
      if (this.coState === 'sleeping') {
        earliest = Math.min(earliest, this.coWakeAt);
      }

      const delta = Number.isFinite(earliest) ? Math.max(4, earliest - now) : 80;
      const sleepMs = Math.min(delta, 80);

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
