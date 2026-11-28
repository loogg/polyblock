import {
  qualifySimKey as qualifyScopedSimKey,
  resolveScopedSimStateMutation,
} from '../core/extensions/simState';
import {
  WorkerDebugSession,
  type WorkerControlMessage,
} from './debugSession';
import { WorkerRuntimeScheduler } from './runtimeScheduler';

export type WorkerRunMessage = Extract<WorkerControlMessage, { type: 'RUN' }>;

export interface WorkerRunContext {
  msg: WorkerRunMessage;
  runId: string;
  startedAt: number;
  session: WorkerDebugSession;
  scheduler: WorkerRuntimeScheduler;
  post: (payload: Record<string, unknown>) => void;
  emitScopedState: (
    packId: string | undefined,
    rawKind: string,
    value: unknown,
  ) => void;
  getScopedState: (packId: string | undefined, rawKey: string) => unknown;
  emitCustomEvent: (eventName: string, args: unknown[]) => void;
}

/**
 * Shared Web Worker protocol host encapsulating control message routing,
 * per-run `WorkerDebugSession` + `WorkerRuntimeScheduler` lifecycle,
 * pack-scoped simulator state (`qualifySimKey` / `emitScopedState` / `getScopedState`),
 * and structured `DONE` / `ERROR` completion messaging across all WASM language workers.
 */
export class WorkerProtocolHost {
  private activeRunId = '';
  private activeSession: WorkerDebugSession | null = null;
  private activeScheduler: WorkerRuntimeScheduler | null = null;
  private currentMockInputs: Record<string, unknown> = {};
  private readonly post: (payload: Record<string, unknown>) => void;

  constructor(post: (payload: Record<string, unknown>) => void) {
    this.post = post;
  }

  getActiveRunId(): string {
    return this.activeRunId;
  }

  getActiveSession(): WorkerDebugSession | null {
    return this.activeSession;
  }

  getActiveScheduler(): WorkerRuntimeScheduler | null {
    return this.activeScheduler;
  }

  qualifySimKey(packId: string | undefined, rawKey: string): string {
    return qualifyScopedSimKey(packId ?? '', rawKey);
  }

  emitScopedState(
    packId: string | undefined,
    rawKind: string,
    value: unknown,
    runIdOverride?: string,
  ): void {
    const k = this.qualifySimKey(packId, String(rawKind));
    const { targetKey, nextVal } = resolveScopedSimStateMutation(
      this.currentMockInputs,
      k,
      value,
    );
    this.currentMockInputs[targetKey] = nextVal;
    this.post({
      type: 'DEVICE_EVENT',
      runId: runIdOverride ?? this.activeRunId,
      kind: k,
      value,
    });
  }

  getScopedState(packId: string | undefined, rawKey: string): unknown {
    const keyStr = String(rawKey);
    const full = this.qualifySimKey(packId, keyStr);
    if (Object.prototype.hasOwnProperty.call(this.currentMockInputs, full)) {
      return this.currentMockInputs[full];
    }
    return this.currentMockInputs[keyStr];
  }

  emitCustomEvent(
    eventName: string,
    args: unknown[],
    runIdOverride?: string,
    schedulerOverride?: WorkerRuntimeScheduler | null,
  ): void {
    const ename = String(eventName);
    (schedulerOverride ?? this.activeScheduler)?.enqueueEvent(ename, args);
    this.post({
      type: 'CUSTOM_EVENT',
      runId: runIdOverride ?? this.activeRunId,
      eventName: ename,
      args,
    });
  }

  async handleMessage(
    msg: WorkerControlMessage | null | undefined,
    executeRun: (ctx: WorkerRunContext) => Promise<void>,
    formatError?: (err: unknown) => string,
  ): Promise<void> {
    if (!msg) return;

    switch (msg.type) {
      case 'RESUME':
        if (this.activeSession?.runId === msg.runId) this.activeSession.resume();
        return;
      case 'STEP_NEXT':
        if (this.activeSession?.runId === msg.runId) this.activeSession.stepNext();
        return;
      case 'PAUSE':
        if (this.activeSession?.runId === msg.runId) this.activeSession.pause();
        return;
      case 'STOP_GRACEFUL':
        if (this.activeScheduler?.runId === msg.runId) {
          this.activeScheduler.requestGracefulStop();
        }
        if (this.activeSession?.runId === msg.runId) {
          this.activeSession.enterGracefulStop();
        }
        return;
      case 'SET_BREAKPOINTS':
        if (this.activeSession?.runId === msg.runId) {
          this.activeSession.setBreakpoints(msg.breakpoints);
        }
        return;
      case 'SET_SPEED':
        if (this.activeSession?.runId === msg.runId) {
          this.activeSession.setStepDelay(msg.stepDelayMs);
        }
        return;
      case 'SET_TIME_SLICE':
        if (this.activeScheduler?.runId === msg.runId) {
          this.activeScheduler.setTimeSliceMs(msg.timeSliceMs);
        }
        return;
      case 'UPDATE_MOCK_INPUTS':
        this.currentMockInputs = {
          ...this.currentMockInputs,
          ...msg.mockInputs,
        };
        return;
      case 'EMIT_EVENT':
        if (this.activeScheduler?.runId === msg.runId) {
          this.activeScheduler.enqueueEvent(msg.eventName, msg.args);
        }
        return;
      case 'RUN':
        break;
    }

    const {
      runId,
      breakpoints,
      stepDelayMs,
      startInStepMode,
      channelCounts,
      timerPoolKey,
      timeSliceMs,
      callbackTimeoutMs,
      mockInputs,
    } = msg;

    this.activeRunId = runId;
    this.currentMockInputs = { ...(mockInputs ?? {}) };
    const startedAt = performance.now();
    const resolvedTimerCount =
      (timerPoolKey ? channelCounts?.[timerPoolKey] : undefined) ?? 8;
    const scheduler = new WorkerRuntimeScheduler({
      runId,
      timerCount: resolvedTimerCount,
      timeSliceMs: timeSliceMs ?? 20,
      callbackTimeoutMs: callbackTimeoutMs ?? 5000,
      post: this.post,
    });
    const session = new WorkerDebugSession(
      {
        runId,
        breakpoints,
        stepDelayMs,
        startInStepMode,
        onClockPause: (paused, creditMs) => {
          if (paused) scheduler.pauseClock();
          else scheduler.resumeClock(creditMs ?? 0);
        },
        getTimeSliceMs: () => scheduler.getTimeSliceMs(),
      },
      this.post,
    );
    this.activeSession = session;
    this.activeScheduler = scheduler;

    try {
      await executeRun({
        msg,
        runId,
        startedAt,
        session,
        scheduler,
        post: this.post,
        emitScopedState: (packId, rawKind, value) =>
          this.emitScopedState(packId, rawKind, value, runId),
        getScopedState: (packId, rawKey) => this.getScopedState(packId, rawKey),
        emitCustomEvent: (eventName, args) =>
          this.emitCustomEvent(eventName, args, runId, scheduler),
      });

      this.post({
        type: 'DONE',
        runId,
        durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
        vars: session.getLastVars(),
      });
    } catch (err) {
      const message = formatError
        ? formatError(err)
        : err instanceof Error
          ? err.message
          : String(err);
      this.post({
        type: 'ERROR',
        runId,
        message,
        durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
      });
    } finally {
      if (this.activeSession === session) this.activeSession = null;
      if (this.activeScheduler === scheduler) this.activeScheduler = null;
    }
  }
}
