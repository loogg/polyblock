import type { ExtensionModuleSource } from '../core/extensions/types';
import type { WorkerDebugSession } from './debugSession';
import type { WorkerRuntimeScheduler } from './runtimeScheduler';

const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>;

export interface JsSandboxExecutionOptions {
  code: string;
  mockModules?: ExtensionModuleSource[];
  scheduler: WorkerRuntimeScheduler;
  session: WorkerDebugSession;
  postStdout: (line: string) => void;
  emitScopedState: (packId: string | undefined, kind: string, value: unknown) => void;
  getScopedState: (packId: string | undefined, key: string) => unknown;
  emitCustomEvent: (eventName: string, args: unknown[]) => void;
}

function formatConsoleArg(val: unknown): string {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') {
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

/**
 * Pure, self-contained JavaScript (ES2023) single-track coroutine sandbox engine shared by
 * both `js.worker.ts` (browser Web Worker) and Node.js Vitest runtime integration tests.
 *
 * Provides per-run isolated `globalThis`, lazy CommonJS `require()` with pack-scoped `_poly`
 * state proxying, sandboxed `console.log`, and full `WorkerRuntimeScheduler` / `WorkerDebugSession`
 * bindings matching Lua 5.4 and MicroPython WASM 1:1.
 */
export async function runJsInSandbox(
  opts: JsSandboxExecutionOptions,
): Promise<void> {
  const {
    code,
    mockModules = [],
    scheduler,
    session,
    postStdout,
    emitScopedState,
    getScopedState,
    emitCustomEvent,
  } = opts;

  const sandboxConsole = {
    log: (...args: unknown[]) => {
      postStdout(args.map(formatConsoleArg).join(' '));
    },
    info: (...args: unknown[]) => {
      postStdout(args.map(formatConsoleArg).join(' '));
    },
    warn: (...args: unknown[]) => {
      postStdout(`[WARN] ${args.map(formatConsoleArg).join(' ')}`);
    },
    error: (...args: unknown[]) => {
      postStdout(`[ERROR] ${args.map(formatConsoleArg).join(' ')}`);
    },
  };

  // Per-run isolated `globalThis` proxy so sibling handlers (`globalThis.on_timer_0 = ...`)
  // never leak across consecutive runs or separate handles while standard JS globals stay accessible.
  const runLocalGlobals: Record<PropertyKey, unknown> = Object.create(null);
  const realGlobal = globalThis as Record<PropertyKey, unknown>;
  const sandboxGlobal = new Proxy(runLocalGlobals, {
    get(target, prop) {
      if (prop === 'globalThis') return sandboxGlobal;
      if (prop === 'console') return sandboxConsole;
      if (prop in target) return target[prop];
      const val = realGlobal[prop];
      return typeof val === 'function' ? (val as (...a: unknown[]) => unknown) : val;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
    has(target, prop) {
      return prop in target || prop in realGlobal;
    },
    deleteProperty(target, prop) {
      delete target[prop];
      return true;
    },
  });

  const makePolyBridge = (packId?: string) => ({
    step: (blockId: string, varsJson: string) =>
      session.onStep(String(blockId), varsJson, false),
    step_start: (blockId: string, varsJson: string) =>
      session.onStep(String(blockId), varsJson, true),
    sleep: (ms: number) => {
      if (scheduler.isInCallback()) {
        throw new Error(
          '禁止在事件回调（on_run / on_timer / on_button / on_stop）中调用等待 (sleep)；实板同步回调不可阻塞，请移至「当程序启动」协程或改用定时器。',
        );
      }
      return session.onSleep(ms);
    },
    final_snap: (varsJson: string) => {
      session.setFinalVars(varsJson);
    },
    emit_device: (kind: string, value: unknown) =>
      emitScopedState(packId, kind, value),
    sim_set: (kind: string, value: unknown) =>
      emitScopedState(packId, kind, value),
    sim_set_scoped: (explicitPackId: string, kind: string, value: unknown) =>
      emitScopedState(String(explicitPackId), kind, value),
    get_input: (key: string) => getScopedState(packId, key),
    sim_get: (key: string) => getScopedState(packId, key),
    sim_get_scoped: (explicitPackId: string, key: string) =>
      getScopedState(String(explicitPackId), key),
    emit_event: (eventName: string, ...args: unknown[]) => {
      emitCustomEvent(String(eventName), args);
    },
    now_ms: () => performance.now(),
    rt_set_run_period: (ms: unknown) => scheduler.setRunPeriod(ms),
    rt_start_run: () => scheduler.startRun(),
    rt_stop_run: () => scheduler.stopRun(),
    rt_start_timer: (id: unknown, periodMs: unknown, repeat?: unknown) =>
      scheduler.startTimer(id, periodMs, repeat ?? 0),
    rt_stop_timer: (id: unknown) => scheduler.stopTimer(id),
    rt_get_timer_value: (id: unknown) => scheduler.getTimerValue(id),
    rt_is_timer_running: (id: unknown) => scheduler.isTimerRunning(id),
    rt_tick: () => scheduler.getTick(),
    rt_ms_to_tick: (ms: unknown) => scheduler.msToTick(ms),
    rt_is_expired: (startTick: unknown, timeoutTicks: unknown) =>
      scheduler.isTickExpired(startTick, timeoutTicks),
    init_scheduler: (
      hasStart: unknown,
      hasRun: unknown,
      hasTimer: unknown,
      hasBtn: unknown,
    ) =>
      scheduler.initCoroutineMode(
        Boolean(hasStart),
        Boolean(hasRun),
        Boolean(hasTimer),
        Boolean(hasBtn),
      ),
    sync_handlers: (hasRun: unknown, hasTimer: unknown, hasBtn: unknown) =>
      scheduler.syncHandlers(Boolean(hasRun), Boolean(hasTimer), Boolean(hasBtn)),
    co_sleep: (ms: unknown) => scheduler.onStartCoSleep(ms),
    co_yield_slice: () => scheduler.onStartCoYieldSlice(),
    co_done: () => scheduler.onStartCoDone(),
    wait_start_turn: () => scheduler.waitPythonStartTurn(),
    resume_start_slice: () => scheduler.resumePythonStartSlice(),
    cb_enter: (name: unknown) =>
      scheduler.beginCallback(String(name ?? 'callback')),
    cb_exit: () => scheduler.endCallback(),
    cb_expired: () => scheduler.isCallbackTimedOut(),
    is_in_callback: () => scheduler.isInCallback(),
    is_stop_requested: () => scheduler.isStopRequested(),
    get_time_slice_ms: () => scheduler.getTimeSliceMs(),
    logic_now_ms: () => scheduler.now(),
    next_event: () => scheduler.nextEvent(),
  });

  const rootPolyBridge = makePolyBridge(undefined);
  const polyRtModule: Record<string, unknown> = {};
  const moduleSources = new Map<string, ExtensionModuleSource>();
  const moduleCache = new Map<string, unknown>();

  // Preserve higher-tier overwrite order (global -> project -> handle)
  for (const mod of mockModules) {
    if (mod.moduleName && mod.sources?.js) {
      moduleSources.set(mod.moduleName, mod);
    }
  }

  const normalizeModuleKey = (rawName: string): string =>
    rawName
      .trim()
      .replace(/^\.\//, '')
      .replace(/\.js$/i, '')
      .replace(/\//g, '.');

  const getLoadedModule = (rawName: string): unknown => {
    const key = normalizeModuleKey(rawName);
    return moduleCache.get(key);
  };

  const makeRequire = (ownerPackId?: string) => {
    const requireFn = (rawName: string): unknown => {
      const name = String(rawName ?? '').trim();
      if (name === '_poly') {
        return ownerPackId ? makePolyBridge(ownerPackId) : rootPolyBridge;
      }
      if (name === '_poly_rt') {
        return polyRtModule;
      }

      const key = normalizeModuleKey(name);
      if (moduleCache.has(key)) {
        return moduleCache.get(key);
      }

      const spec = moduleSources.get(name) ?? moduleSources.get(key);
      if (!spec || !spec.sources?.js) {
        throw new Error(`未找到 JavaScript 模块 "${name}"（请确认已启用对应扩展包或已添加该同句柄脚本）`);
      }

      const modObj: { exports: Record<string, unknown> } = { exports: {} };
      moduleCache.set(key, modObj.exports);

      try {
        const modRequire = makeRequire(spec.packId);
        const modFn = new Function(
          'require',
          'module',
          'exports',
          'console',
          'globalThis',
          '_poly_get_loaded_mod',
          `"use strict";\n${spec.sources.js}`,
        );
        modFn(
          modRequire,
          modObj,
          modObj.exports,
          sandboxConsole,
          sandboxGlobal,
          getLoadedModule,
        );
        moduleCache.set(key, modObj.exports);
        return modObj.exports;
      } catch (err) {
        moduleCache.delete(key);
        throw err;
      }
    };
    return requireFn;
  };

  const registerRt = (rtApi: Record<string, unknown>) => {
    Object.assign(polyRtModule, rtApi);
  };

  const rootRequire = makeRequire(undefined);
  const mainFn = new AsyncFunction(
    'require',
    'console',
    'globalThis',
    '_poly_register_rt',
    '_poly_get_loaded_mod',
    `"use strict";\n${code}`,
  );

  await mainFn(
    rootRequire,
    sandboxConsole,
    sandboxGlobal,
    registerRt,
    getLoadedModule,
  );
}
