import type * as Blockly from 'blockly';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { BlocklyWorkbenchHandle } from '../components/BlocklyWorkbench';
import { backendRegistry } from '../core/backends/registry';
import type { GeneratedCodeResult } from '../core/backends/types';
import { setActiveModuleConflicts } from '../core/blocks/workspaceContextBridge';
import { compileHandleArtifacts } from '../core/compiler/handleBuilder';
import { resolveProjectModules } from '../core/extensions/moduleResolver';
import {
  extensionRegistry,
  formatExtensionBlockLabel,
} from '../core/extensions/registry';
import {
  applySimDeviceEvent,
  buildDefaultSimState,
  buildPackResetPatch,
} from '../core/extensions/simState';
import type {
  PolyExtensionPack,
  SimStateMap,
} from '../core/extensions/types';
import {
  getActiveHandle,
  getActiveProject,
  getActiveScript,
  updateHandleById,
  updateProjectById,
} from '../core/projects/store';
import { runnerManager } from '../core/runners/manager';
import { multiHandleOrchestrator } from '../core/runners/multiHandleManager';
import type { RunnerStatus } from '../core/runners/types';
import type {
  AppSettings,
  ExecutionSpeedId,
  LogEntry,
  LogLevel,
  PageId,
  ProjectModel,
  ProjectScript,
  RuntimeHandle,
  RuntimeTelemetry,
  ScriptLanguageId,
  WorkspaceStoreState,
} from '../types/project';
import { collectHandleAllBreakpoints } from './useProjectStore';

const SPEED_DELAY_MS: Record<ExecutionSpeedId, number> = {
  realtime: 0,
  animate: 60,
  slow: 250,
};

const SPEED_LABEL_ZH: Record<ExecutionSpeedId, string> = {
  realtime: '实时 0ms',
  animate: '动画 60ms',
  slow: '慢放 250ms',
};

export function formatNowTime(): string {
  return new Date().toTimeString().slice(0, 8);
}

function workspaceJsonContainsBlockId(node: unknown, targetId: string): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) {
    return node.some((item) => workspaceJsonContainsBlockId(item, targetId));
  }
  const obj = node as Record<string, unknown>;
  if (obj.id === targetId) return true;
  if (obj.blocks && workspaceJsonContainsBlockId(obj.blocks, targetId)) return true;
  if (obj.inputs && typeof obj.inputs === 'object') {
    for (const v of Object.values(obj.inputs as Record<string, unknown>)) {
      if (workspaceJsonContainsBlockId(v, targetId)) return true;
    }
  }
  if (obj.next && workspaceJsonContainsBlockId(obj.next, targetId)) return true;
  if (obj.block && workspaceJsonContainsBlockId(obj.block, targetId)) return true;
  return false;
}

function findScriptOwningBlockId(
  handle: RuntimeHandle,
  blockId: string,
): ProjectScript | null {
  for (const s of handle.scripts) {
    if (workspaceJsonContainsBlockId(s.workspace, blockId)) {
      return s;
    }
  }
  return null;
}

function scanHandleExportOnlyBlocks(handle: RuntimeHandle): Set<string> {
  const exportOnlyBlocks = new Set<string>();
  const scanNode = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) scanNode(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.enabled === false) return;
    if (typeof obj.type === 'string') {
      const def = extensionRegistry.findOwnerForBlockType(obj.type);
      if (def?.block.sandboxRunnable === false) {
        exportOnlyBlocks.add(formatExtensionBlockLabel(def.block, def.section));
      }
    }
    if (obj.inputs && typeof obj.inputs === 'object') {
      for (const v of Object.values(obj.inputs as Record<string, unknown>)) {
        scanNode(v);
      }
    }
    if (obj.next) scanNode(obj.next);
    if (obj.block) scanNode(obj.block);
  };
  for (const s of handle.scripts) {
    scanNode(s.workspace);
  }
  return exportOnlyBlocks;
}

export interface UseExecutionControllerOptions {
  activePage: PageId;
  navigateTo: (page: PageId) => void;
  settings: AppSettings;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  setShowConsole: (show: boolean) => void;
  storeRef: RefObject<WorkspaceStoreState>;
  setStore: Dispatch<SetStateAction<WorkspaceStoreState>>;
  activeProject: ProjectModel;
  activeHandle: RuntimeHandle;
  activeScript: ProjectScript;
  language: ScriptLanguageId;
  activeProjectIdRef: RefObject<string>;
  activeHandleIdRef: RefObject<string>;
  activeScriptIdRef: RefObject<string>;
  activeSimPacks: PolyExtensionPack[];
  generated: GeneratedCodeResult;
  setGenerated: Dispatch<SetStateAction<GeneratedCodeResult>>;
  workbenchRef: RefObject<BlocklyWorkbenchHandle | null>;
  flushActiveCanvasIntoStore: (
    baseStore: WorkspaceStoreState,
  ) => WorkspaceStoreState;
  regenerateFromWorkspace: (
    ws: Blockly.WorkspaceSvg,
    lang: ScriptLanguageId,
  ) => GeneratedCodeResult;
  onFocusScriptForPause: (handleId: string, scriptId: string) => void;
  notify: (msg: string) => void;
}

export function useExecutionController({
  activePage,
  navigateTo,
  settings,
  setSettings,
  setShowConsole,
  storeRef,
  setStore,
  activeProject,
  activeHandle,
  activeScript,
  language,
  activeProjectIdRef,
  activeHandleIdRef,
  activeScriptIdRef,
  activeSimPacks,
  generated,
  setGenerated,
  workbenchRef,
  flushActiveCanvasIntoStore,
  regenerateFromWorkspace,
  onFocusScriptForPause,
  notify,
}: UseExecutionControllerOptions) {
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [executingBlockId, setExecutingBlockId] = useState<string | null>(null);
  const [liveVariables, setLiveVariables] = useState<Record<string, string>>({});
  const [errorLine, setErrorLine] = useState<number | null>(null);
  const [runningHandleIds, setRunningHandleIds] = useState<string[]>([]);

  /** Per-project isolated simulator state so switching projects never bleeds simulated hardware state. */
  const [simStatesByProject, setSimStatesByProject] = useState<
    Record<string, SimStateMap>
  >({});

  const [runnerStatus, setRunnerStatus] = useState<RunnerStatus>('ready');
  const [multiHandleRunning, setMultiHandleRunning] = useState<boolean>(false);
  const [handleTelemetries, setHandleTelemetries] = useState<
    Record<string, RuntimeTelemetry>
  >({});
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>(() => [
    {
      id: 'boot-log',
      timestamp: formatNowTime(),
      level: 'system',
      message:
        'PolyBlock 多语言积木工作台就绪：支持多隔离句柄并发模拟、事件回调/定时器、局部作用域变量树与多语言断点调试。',
    },
  ]);

  const simState = useMemo<SimStateMap>(() => {
    const defaults = buildDefaultSimState(activeSimPacks);
    const saved = simStatesByProject[activeProject.id];
    return saved ? { ...defaults, ...saved } : defaults;
  }, [activeSimPacks, simStatesByProject, activeProject.id]);

  const simStateRef = useRef<SimStateMap>(simState);
  const activeSimPacksRef = useRef<PolyExtensionPack[]>(activeSimPacks);
  const runnerStatusRef = useRef<RunnerStatus>(runnerStatus);
  const multiHandleRunningRef = useRef<boolean>(multiHandleRunning);
  const launchingRef = useRef<boolean>(false);
  const runningHandleIdRef = useRef<string | null>(null);
  const lastExecutingRef = useRef<{ handleId: string; blockId: string } | null>(
    null,
  );
  const onFocusScriptForPauseRef = useRef(onFocusScriptForPause);

  simStateRef.current = simState;
  activeSimPacksRef.current = activeSimPacks;
  runnerStatusRef.current = runnerStatus;
  multiHandleRunningRef.current = multiHandleRunning;
  onFocusScriptForPauseRef.current = onFocusScriptForPause;

  useEffect(() => {
    return () => {
      runnerManager.disposeAll();
      multiHandleOrchestrator.dispose();
    };
  }, []);

  const MAX_LOG_ENTRIES = 1000;
  const appendLog = useCallback(
    (
      level: LogLevel,
      message: string,
      line?: number,
      blockId?: string,
      handleMeta?: { name: string; color: string },
    ) => {
      const nextEntry: LogEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: formatNowTime(),
        level,
        message,
        line,
        blockId,
        handleName: handleMeta?.name,
        handleColor: handleMeta?.color,
      };
      setLogs((prev) =>
        prev.length >= MAX_LOG_ENTRIES
          ? [...prev.slice(prev.length - MAX_LOG_ENTRIES + 1), nextEntry]
          : [...prev, nextEntry],
      );
    },
    [],
  );

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  const reportErrorLogs = useCallback((messages: string[], idPrefix: string) => {
    const ts = Date.now();
    setLogs(
      messages.map((message, idx) => ({
        id: `${idPrefix}-${ts}-${idx}`,
        timestamp: formatNowTime(),
        level: 'error' as const,
        message,
      })),
    );
  }, []);

  const isExecutionActive = useCallback(
    () =>
      runnerStatusRef.current === 'running' ||
      runnerStatusRef.current === 'paused',
    [],
  );

  const stopIfRunning = useCallback(() => {
    if (
      runnerStatusRef.current === 'running' ||
      runnerStatusRef.current === 'paused'
    ) {
      runnerManager.stopActive(true);
      multiHandleOrchestrator.stopAll(true);
      runningHandleIdRef.current = null;
      lastExecutingRef.current = null;
      setRunningHandleIds([]);
      setMultiHandleRunning(false);
      setExecutingBlockId(null);
      setHandleTelemetries({});
    }
  }, []);

  const clearErrorLine = useCallback(() => {
    setErrorLine(null);
  }, []);

  const resetExecutionForSwitch = useCallback(() => {
    setSelectedBlockId(null);
    setExecutingBlockId(null);
    setLiveVariables({});
    setHandleTelemetries({});
    setErrorLine(null);
  }, []);

  const syncViewSwitchDuringRun = useCallback(
    (viewedHandleId: string, ws: Blockly.WorkspaceSvg | null) => {
      setSelectedBlockId(null);
      const last = lastExecutingRef.current;
      if (
        last &&
        last.handleId === viewedHandleId &&
        ws &&
        ws.getBlockById(last.blockId)
      ) {
        setExecutingBlockId(last.blockId);
      } else {
        setExecutingBlockId(null);
      }
    },
    [],
  );

  const deleteProjectSimState = useCallback((projectId: string) => {
    setSimStatesByProject((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, projectId)) return prev;
      const copy = { ...prev };
      delete copy[projectId];
      return copy;
    });
  }, []);

  const resetAllSimStates = useCallback(() => {
    setSimStatesByProject({});
  }, []);

  const syncActiveBreakpoints = useCallback((bps: string[]) => {
    runnerManager.updateActiveBreakpoints(bps);
  }, []);

  /* ========================================================================
     Simulator State & Device/Widget Event Operations
     ======================================================================== */
  const handleUpdateSimValues = useCallback(
    (patch: Record<string, unknown>) => {
      const pid = activeProjectIdRef.current;
      setSimStatesByProject((prev) => {
        const base = prev[pid] ?? buildDefaultSimState(activeSimPacksRef.current);
        const next = { ...base, ...patch };
        simStateRef.current = next;
        return { ...prev, [pid]: next };
      });
      runnerManager.updateActiveMockInputs(patch);
      multiHandleOrchestrator.updateMockInputs(patch);
    },
    [activeProjectIdRef],
  );

  const handleResetSimPack = useCallback(
    (pack: PolyExtensionPack) => {
      const patch = buildPackResetPatch(pack);
      handleUpdateSimValues(patch);
      notify(`已复位「${pack.name}」模拟状态`);
    },
    [handleUpdateSimValues, notify],
  );

  const handleEmitSimEvent = useCallback(
    (eventName: string, args: unknown[] = [], excludeHandleId?: string) => {
      runnerManager.emitActiveEvent(eventName, args);
      multiHandleOrchestrator.emitEvent(eventName, args, excludeHandleId);
    },
    [],
  );

  const handleDeviceEvent = useCallback(
    (kind: string, value: unknown) => {
      const pid = activeProjectIdRef.current;
      const { next, broadcastPatch } = applySimDeviceEvent(
        simStateRef.current,
        kind,
        value,
        activeSimPacksRef.current,
      );
      simStateRef.current = next;
      setSimStatesByProject((prev) => ({ ...prev, [pid]: next }));
      // Broadcast state updates across all concurrent handle Workers so every handle
      // shares the same simulated physical hardware / C-layer device state.
      runnerManager.updateActiveMockInputs(broadcastPatch);
      multiHandleOrchestrator.updateMockInputs(broadcastPatch);
    },
    [activeProjectIdRef],
  );

  /* ========================================================================
     Breakpoints & Execution Speed Controls
     ======================================================================== */
  const handleToggleBreakpoint = useCallback(
    (blockId: string) => {
      const isMulti = multiHandleRunningRef.current;
      const isSingleActive =
        !isMulti &&
        (runnerStatusRef.current === 'running' ||
          runnerStatusRef.current === 'paused');

      const curProj = getActiveProject(storeRef.current);
      const curHdl = getActiveHandle(curProj);
      const curScr = getActiveScript(curHdl);
      const exists = curScr.breakpoints.includes(blockId);
      const nextBps = exists
        ? curScr.breakpoints.filter((id) => id !== blockId)
        : [...curScr.breakpoints, blockId];
      const nextScripts = curHdl.scripts.map((s) =>
        s.id === curScr.id ? { ...s, breakpoints: nextBps } : s,
      );
      setStore((prev) =>
        updateProjectById(prev, curProj.id, (p) =>
          updateHandleById(p, curHdl.id, (h) => ({
            ...h,
            scripts: h.scripts.map((s) =>
              s.id === curScr.id
                ? {
                    ...s,
                    breakpoints: s.breakpoints.includes(blockId)
                      ? s.breakpoints.filter((id) => id !== blockId)
                      : [...s.breakpoints, blockId],
                  }
                : s,
            ),
          })),
        ),
      );
      if (isSingleActive && runningHandleIdRef.current === curHdl.id) {
        runnerManager.updateActiveBreakpoints(
          collectHandleAllBreakpoints({ ...curHdl, scripts: nextScripts }),
        );
      }

      if (isMulti) {
        notify(
          '断点已保存；多句柄「并发」模式不触发断点暂停，单句柄「运行 / 单步」时生效',
        );
      }
    },
    [notify, setStore, storeRef],
  );

  const handleClearBreakpoints = useCallback(() => {
    const isMulti = multiHandleRunningRef.current;
    const isSingleActive =
      !isMulti &&
      (runnerStatusRef.current === 'running' ||
        runnerStatusRef.current === 'paused');

    const curProj = getActiveProject(storeRef.current);
    const curHdl = getActiveHandle(curProj);
    const targetScriptId = activeScriptIdRef.current;
    const nextScripts = curHdl.scripts.map((s) =>
      s.id === targetScriptId ? { ...s, breakpoints: [] } : s,
    );
    setStore((prev) =>
      updateProjectById(prev, curProj.id, (p) =>
        updateHandleById(p, curHdl.id, (h) => ({
          ...h,
          scripts: h.scripts.map((s) =>
            s.id === targetScriptId ? { ...s, breakpoints: [] } : s,
          ),
        })),
      ),
    );
    if (isSingleActive && runningHandleIdRef.current === curHdl.id) {
      runnerManager.updateActiveBreakpoints(
        collectHandleAllBreakpoints({ ...curHdl, scripts: nextScripts }),
      );
    }
    notify('已清除当前脚本的全部断点');
  }, [activeScriptIdRef, notify, setStore, storeRef]);

  const handleSelectSpeed = useCallback(
    (speed: ExecutionSpeedId) => {
      setSettings((prev) => ({ ...prev, executionSpeed: speed }));
      const delay = SPEED_DELAY_MS[speed];
      runnerManager.updateActiveStepDelay(delay);
      multiHandleOrchestrator.updateStepDelay(delay);
    },
    [setSettings],
  );

  const updateTimeSlice = useCallback((timeSliceMs: number) => {
    runnerManager.updateActiveTimeSlice(timeSliceMs);
    multiHandleOrchestrator.updateTimeSlice(timeSliceMs);
  }, []);

  /* ========================================================================
     Single-Handle & Multi-Handle Execution Launchers
     ======================================================================== */
  const launchSingleHandleExecution = useCallback(
    async (startInStepMode: boolean) => {
      if (
        launchingRef.current ||
        runnerStatusRef.current === 'running' ||
        runnerStatusRef.current === 'paused'
      ) {
        return;
      }
      const runner = runnerManager.findForLanguage(language);
      if (!runner) {
        notify('当前目标语言仅支持代码生成与导出，暂无浏览器沙箱运行器');
        return;
      }
      launchingRef.current = true;
      try {

      if (activePage !== 'blocks') navigateTo('blocks');
      if (settings.autoOpenConsoleOnRun) setShowConsole(true);

      const ws = workbenchRef.current?.getWorkspace();
      const adapter = backendRegistry.get(language);
      const latest = ws ? adapter.generate(ws) : generated;
      setGenerated(latest);
      setErrorLine(null);
      setExecutingBlockId(null);
      setLiveVariables({});
      setHandleTelemetries({});
      setMultiHandleRunning(false);

      // Whole-handle execution: 1 Handle = 1 program -> ALWAYS launch from entry script
      // via unified HandleCompilerService (shared with multi-handle & ZIP export!).
      const liveSnapshot = workbenchRef.current?.saveWorkspaceJson();
      const built = compileHandleArtifacts({
        project: activeProject,
        handle: activeHandle,
        liveScriptOverride: {
          scriptId: activeScript.id,
          workspace: liveSnapshot ?? undefined,
          prebuilt: latest,
        },
        useDebugCompanion: true,
      });
      const {
        effectiveHandle: handleForRun,
        entryScript,
        entryArtifact,
        blockingErrors,
        resolution: modResolution,
        channelCounts: builtChannelCounts,
        timerPoolKey,
      } = built;
      const runningEntryDirectly = activeScript.id === entryScript.id;

      if (blockingErrors.length > 0) {
        setShowConsole(true);
        setLogs(
          blockingErrors.map((err, idx) => ({
            id: `static-err-${Date.now()}-${idx}`,
            timestamp: formatNowTime(),
            level: 'error' as const,
            message: `[${err.scriptName}.${adapter.extension}] ${err.message}`,
            blockId: err.scriptId === activeScript.id ? err.blockId : undefined,
          })),
        );
        const firstActiveErr = blockingErrors.find(
          (e) => e.scriptId === activeScript.id && e.blockId,
        );
        if (firstActiveErr?.blockId) {
          workbenchRef.current?.focusBlock(firstActiveErr.blockId);
        }
        notify(
          `检测到 ${blockingErrors.length} 处静态校验错误，已阻止运行（请查看日志与校验面板）`,
        );
        return;
      }

      const runCode = entryArtifact.code;
      const runDebugCode = entryArtifact.debugCode;
      const runIsEventDriven = entryArtifact.isEventDriven;

      const scriptFileLabel = `${activeHandle.name}/${entryScript.name}.${adapter.extension}`;
      const siblingNames = handleForRun.scripts
        .filter((s) => s.id !== entryScript.id)
        .map((s) => `${s.name}.${adapter.extension}`);

      const exportOnlyBlocks = scanHandleExportOnlyBlocks(handleForRun);

      runnerManager.setActive(runner);

      if (modResolution.conflicts.length > 0) {
        setActiveModuleConflicts(modResolution.conflicts);
        if (ws) regenerateFromWorkspace(ws, language);
        setLogs(
          modResolution.conflicts.map((c, idx) => ({
            id: `mod-conflict-${Date.now()}-${idx}`,
            timestamp: formatNowTime(),
            level: 'error' as const,
            message: c.message,
          })),
        );
        runnerManager.setActive(null);
        notify(`存在 ${modResolution.conflicts.length} 处同层级模块名冲突，已阻止运行（请查看日志与诊断）`);
        return;
      }

      const allHandleBreakpoints = collectHandleAllBreakpoints(handleForRun);
      const speedDelay = SPEED_DELAY_MS[settings.executionSpeed];
      const speedLabel = SPEED_LABEL_ZH[settings.executionSpeed];
      runningHandleIdRef.current = handleForRun.id;
      lastExecutingRef.current = null;
      setRunningHandleIds([handleForRun.id]);

      const bootLogs: LogEntry[] = [
        {
          id: `start-${Date.now()}`,
          timestamp: formatNowTime(),
          level: 'system',
          message: startInStepMode
            ? `启动整句柄单步调试 [${scriptFileLabel}] · ${runner.shortLabel}`
            : `运行整句柄 [${scriptFileLabel}] · ${runner.shortLabel}（${
                runIsEventDriven ? '事件循环 · ' : ''
              }${
                siblingNames.length > 0
                  ? `同句柄模块: ${siblingNames.join(', ')} · `
                  : ''
              }${speedLabel}${
                allHandleBreakpoints.length > 0
                  ? ` · ${allHandleBreakpoints.length} 断点`
                  : ''
              }）...`,
        },
      ];
      for (const ov of modResolution.overrides) {
        bootLogs.push({
          id: `override-${Date.now()}-${ov.moduleName}`,
          timestamp: formatNowTime(),
          level: 'info',
          message: ov.message,
        });
      }
      if (exportOnlyBlocks.size > 0) {
        bootLogs.push({
          id: `warn-export-only-${Date.now()}`,
          timestamp: formatNowTime(),
          level: 'warn',
          message: `检测到仅真机可用积木（${Array.from(exportOnlyBlocks).join('、')}），浏览器沙箱不含其固件实现，运行到此积木时可能报错；导出给真机则完全正常。`,
        });
      }
      setLogs(bootLogs);

      const result = await runner.run(
        {
          language,
          code: runCode,
          debugCode: runDebugCode,
          timeoutMs: settings.timeoutMs,
          timeSliceMs: settings.timeSliceMs,
          breakpoints: allHandleBreakpoints,
          stepDelayMs: speedDelay,
          startInStepMode,
          channelCounts: builtChannelCounts,
          timerPoolKey: timerPoolKey ?? undefined,
          mockModules: modResolution.sandboxMountOrder,
          mockInputs: simStateRef.current,
        },
        {
          onLog: (level, message, line) => {
            const mappedBlock =
              runningEntryDirectly && line ? latest.lineToBlock[line] : undefined;
            appendLog(level, message, line, mappedBlock);
          },
          onStep: (blockId, vars) => {
            lastExecutingRef.current = { handleId: handleForRun.id, blockId };
            const isViewingRunHandle =
              activeHandleIdRef.current === handleForRun.id;
            const inActiveCanvas =
              isViewingRunHandle &&
              Boolean(workbenchRef.current?.getWorkspace()?.getBlockById(blockId));
            setExecutingBlockId(inActiveCanvas ? blockId : null);
            setLiveVariables(vars);
          },
          onPaused: (blockId, vars, reason) => {
            lastExecutingRef.current = { handleId: handleForRun.id, blockId };
            const isViewingRunHandle =
              activeHandleIdRef.current === handleForRun.id;
            const inActiveCanvas =
              isViewingRunHandle &&
              Boolean(workbenchRef.current?.getWorkspace()?.getBlockById(blockId));
            const ownerScript = findScriptOwningBlockId(handleForRun, blockId);
            setLiveVariables(vars);

            if (ownerScript) {
              // Always exit SharedVarsView / auto-jump to the paused script so breakpoint pause is visible
              onFocusScriptForPauseRef.current(handleForRun.id, ownerScript.id);
              requestAnimationFrame(() => {
                workbenchRef.current?.focusBlock(blockId);
              });
              setExecutingBlockId(blockId);
            } else {
              setExecutingBlockId(inActiveCanvas ? blockId : null);
              if (inActiveCanvas) {
                workbenchRef.current?.focusBlock(blockId);
              }
            }

            const range = inActiveCanvas ? latest.sourceMap[blockId] : undefined;
            if (reason === 'breakpoint') {
              const bpFileLabel = ownerScript
                ? `${handleForRun.name}/${ownerScript.name}.${adapter.extension}`
                : scriptFileLabel;
              appendLog(
                'warn',
                `[${bpFileLabel}] 命中断点并暂停${
                  range ? `（第 ${range.startLine} 行）` : ''
                }，可查看变量或点击「继续 / 单步」。`,
                range?.startLine,
                blockId,
              );
            }
          },
          onDeviceEvent: handleDeviceEvent,
          onRuntimeTelemetry: (tele) =>
            setHandleTelemetries({ [handleForRun.id]: tele }),
          onStatusChange: (status) => setRunnerStatus(status),
        },
      );

      setLastDurationMs(result.durationMs);
      if (result.finalVars) setLiveVariables(result.finalVars);

      if (result.ok) {
        appendLog(
          'system',
          `[${scriptFileLabel}] 执行完成，总耗时 ${result.durationMs}ms（导出文件干净无插桩）。`,
        );
      } else if (result.aborted) {
        appendLog(
          'system',
          `[${scriptFileLabel}] 已退出事件循环并停止运行（累计耗时 ${result.durationMs}ms）。`,
        );
      } else if (
        result.errorLine &&
        runningEntryDirectly &&
        activeScriptIdRef.current === entryScript.id
      ) {
        setErrorLine(result.errorLine);
        const mappedBlock = latest.lineToBlock[result.errorLine];
        if (mappedBlock) workbenchRef.current?.focusBlock(mappedBlock);
      }
      } finally {
        runningHandleIdRef.current = null;
        lastExecutingRef.current = null;
        setRunningHandleIds([]);
        setExecutingBlockId(null);
        setHandleTelemetries({});
        runnerManager.setActive(null);
        launchingRef.current = false;
      }
    },
    [
      activePage,
      navigateTo,
      setShowConsole,
      settings.autoOpenConsoleOnRun,
      settings.executionSpeed,
      settings.timeoutMs,
      settings.timeSliceMs,
      language,
      activeProject,
      activeHandle,
      activeScript.id,
      activeScript.name,
      activeScriptIdRef,
      generated,
      setGenerated,
      workbenchRef,
      appendLog,
      handleDeviceEvent,
      notify,
      regenerateFromWorkspace,
    ],
  );

  const launchMultiHandleSimulation = useCallback(async () => {
    if (
      launchingRef.current ||
      runnerStatusRef.current === 'running' ||
      runnerStatusRef.current === 'paused'
    ) {
      return;
    }
    const currentProj = getActiveProject(storeRef.current);
    if (!runnerManager.hasRunnerForLanguage(currentProj.language)) {
      notify('当前目标语言仅支持代码生成与导出，暂无浏览器沙箱运行器');
      return;
    }
    launchingRef.current = true;
    try {

    if (activePage !== 'blocks') navigateTo('blocks');
    if (settings.autoOpenConsoleOnRun) setShowConsole(true);

    const flushed = flushActiveCanvasIntoStore(storeRef.current);
    setStore(flushed);
    const proj = getActiveProject(flushed);
    const targets = proj.handles.filter((h) => h.autoStart);
    const runList = targets.length > 0 ? targets : [proj.handles[0]];

    const projectModRes = resolveProjectModules({
      enabledCapabilities: proj.enabledCapabilities,
      localExtensions: proj.localExtensions,
    });
    if (projectModRes.conflicts.length > 0) {
      setActiveModuleConflicts(projectModRes.conflicts);
      setLogs(
        projectModRes.conflicts.map((c, idx) => ({
          id: `mconflict-${Date.now()}-${idx}`,
          timestamp: formatNowTime(),
          level: 'error' as const,
          message: c.message,
        })),
      );
      notify(`存在 ${projectModRes.conflicts.length} 处同层级模块名冲突，已阻止并发仿真`);
      return;
    }

    // Pre-Run Static Error Gate across all target autoStart handles (compile ONCE & reuse!)
    const precompiledByHandleId = new Map<
      string,
      ReturnType<typeof compileHandleArtifacts>
    >();
    const multiBlockingErrors: Array<{
      handleName: string;
      handleColor: string;
      scriptName: string;
      message: string;
    }> = [];
    for (const hdl of runList) {
      const built = compileHandleArtifacts({
        project: proj,
        handle: hdl,
        useDebugCompanion: true,
      });
      precompiledByHandleId.set(hdl.id, built);
      for (const err of built.blockingErrors) {
        multiBlockingErrors.push({
          handleName: hdl.name,
          handleColor: hdl.color,
          scriptName: err.scriptName,
          message: err.message,
        });
      }
    }

    if (multiBlockingErrors.length > 0) {
      const ext = backendRegistry.get(proj.language).extension;
      setShowConsole(true);
      setLogs(
        multiBlockingErrors.map((e, idx) => ({
          id: `mstatic-err-${Date.now()}-${idx}`,
          timestamp: formatNowTime(),
          level: 'error' as const,
          message: `[${e.scriptName}.${ext}] ${e.message}`,
          handleName: e.handleName,
          handleColor: e.handleColor,
        })),
      );
      notify(
        `检测到 ${multiBlockingErrors.length} 处静态校验错误，已阻止并发仿真（请查看日志）`,
      );
      return;
    }

    setErrorLine(null);
    setExecutingBlockId(null);
    setLiveVariables({});
    setHandleTelemetries({});
    runningHandleIdRef.current = null;
    lastExecutingRef.current = null;
    setRunningHandleIds(runList.map((h) => h.id));
    setMultiHandleRunning(true);

    const totalBreakpoints = runList.reduce(
      (acc, h) => acc + collectHandleAllBreakpoints(h).length,
      0,
    );
    const speedLabel = SPEED_LABEL_ZH[settings.executionSpeed];

    const multiBootLogs: LogEntry[] = [
      {
        id: `mstart-${Date.now()}`,
        timestamp: formatNowTime(),
        level: 'system',
        message: `启动多句柄并发仿真：${runList.map((h) => h.name).join(' + ')}（共 ${runList.length} 个独立沙箱 Worker · ${speedLabel} · 定时器与全局变量完全隔离）...`,
      },
      {
        id: `mbp-hint-${Date.now()}`,
        timestamp: formatNowTime(),
        level: totalBreakpoints > 0 ? 'warn' : 'info',
        message:
          totalBreakpoints > 0
            ? `检测到当前自启动句柄中存在 ${totalBreakpoints} 个断点：多句柄「并发」模式专注多 VM 实时联动，不触发断点暂停；如需断点/单步调试请使用单句柄「运行」或「单步」。`
            : '提示：多句柄「并发」模式专注多 VM 实时联动，不触发断点暂停（如需断点/单步调试请对单句柄使用「运行」或「单步」）。',
      },
    ];
    if (totalBreakpoints > 0) {
      notify(
        `并发模式不触发断点暂停（已跳过 ${totalBreakpoints} 个断点）；如需断点调试请用单句柄「运行 / 单步」`,
      );
    }
    for (const ov of projectModRes.overrides) {
      multiBootLogs.push({
        id: `mov-${Date.now()}-${ov.moduleName}`,
        timestamp: formatNowTime(),
        level: 'info',
        message: ov.message,
      });
    }
    setLogs(multiBootLogs);

    const t0 = performance.now();
    await multiHandleOrchestrator.runAllHandles(
      {
        project: proj,
        timeoutMs: settings.timeoutMs,
        timeSliceMs: settings.timeSliceMs,
        stepDelayMs: SPEED_DELAY_MS[settings.executionSpeed],
        mockInputs: simStateRef.current,
        precompiledByHandleId,
      },
      {
        onHandleLog: (hdl, level, message, line) => {
          appendLog(level, message, line, undefined, {
            name: hdl.name,
            color: hdl.color,
          });
        },
        onDeviceEvent: handleDeviceEvent,
        onCustomEvent: (sourceHandleId, eventName, args) => {
          multiHandleOrchestrator.emitEvent(eventName, args, sourceHandleId);
        },
        onHandleTelemetry: (handleId, tele) => {
          setHandleTelemetries((prev) => {
            if (!tele) {
              const next = { ...prev };
              delete next[handleId];
              return next;
            }
            return { ...prev, [handleId]: tele };
          });
        },
        onStatusChange: (status) => setRunnerStatus(status),
      },
    );

    const totalMs = Math.max(1, Math.round(performance.now() - t0));
    setLastDurationMs(totalMs);
    appendLog(
      'system',
      `多句柄并发仿真已全部退出（累计耗时 ${totalMs}ms）。`,
    );
    } finally {
      runningHandleIdRef.current = null;
      lastExecutingRef.current = null;
      setRunningHandleIds([]);
      setMultiHandleRunning(false);
      setHandleTelemetries({});
      launchingRef.current = false;
    }
  }, [
    activePage,
    navigateTo,
    setShowConsole,
    settings.autoOpenConsoleOnRun,
    settings.timeoutMs,
    settings.timeSliceMs,
    settings.executionSpeed,
    flushActiveCanvasIntoStore,
    storeRef,
    setStore,
    appendLog,
    handleDeviceEvent,
    notify,
  ]);

  const handleStop = useCallback(() => {
    if (multiHandleRunningRef.current) {
      multiHandleOrchestrator.stopAll(false);
    } else {
      runnerManager.stopActive(false);
    }
    setExecutingBlockId(null);
  }, []);

  const handleResume = useCallback(() => {
    runnerManager.resumeActive();
  }, []);

  const handleStepNext = useCallback(() => {
    runnerManager.stepNextActive();
  }, []);

  const handlePause = useCallback(() => {
    runnerManager.pauseActive();
  }, []);

  return {
    selectedBlockId,
    setSelectedBlockId,
    executingBlockId,
    liveVariables,
    errorLine,
    simState,
    runnerStatus,
    multiHandleRunning,
    runningHandleIds,
    handleTelemetries,
    lastDurationMs,
    logs,
    appendLog,
    clearLogs,
    reportErrorLogs,
    isExecutionActive,
    stopIfRunning,
    clearErrorLine,
    resetExecutionForSwitch,
    syncViewSwitchDuringRun,
    deleteProjectSimState,
    resetAllSimStates,
    syncActiveBreakpoints,
    handleUpdateSimValues,
    handleResetSimPack,
    handleEmitSimEvent,
    handleDeviceEvent,
    handleToggleBreakpoint,
    handleClearBreakpoints,
    handleSelectSpeed,
    updateTimeSlice,
    launchSingleHandleExecution,
    launchMultiHandleSimulation,
    handleStop,
    handleResume,
    handleStepNext,
    handlePause,
  };
}
