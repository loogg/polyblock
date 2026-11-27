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
import { buildHandleScriptsMeta } from '../core/backends/eventMode';
import { backendRegistry } from '../core/backends/registry';
import type { GeneratedCodeResult } from '../core/backends/types';
import { setActiveModuleConflicts } from '../core/blocks/workspaceContextBridge';
import { resolveProjectModules } from '../core/extensions/moduleResolver';
import { extensionRegistry } from '../core/extensions/registry';
import {
  applySimDeviceEvent,
  buildDefaultSimState,
  buildPackResetPatch,
} from '../core/extensions/simState';
import type {
  PolyExtensionPack,
  SimStateMap,
} from '../core/extensions/types';
import { collectHandleSharedVariableNames } from '../core/projects/handleVariables';
import {
  getActiveHandle,
  getActiveProject,
  getActiveScript,
  getAllHandleChannelPoolConfigs,
  updateHandleById,
  updateProjectById,
} from '../core/projects/store';
import { runnerManager } from '../core/runners/manager';
import {
  buildHandleScriptModules,
  compileScriptHeadless,
  multiHandleOrchestrator,
} from '../core/runners/multiHandleManager';
import type { RunnerStatus } from '../core/runners/types';
import type {
  AppSettings,
  ChannelPoolConfig,
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
  fast: 0,
  normal: 180,
  slow: 450,
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

function findScriptNameOwningBlockId(
  handle: RuntimeHandle,
  blockId: string,
): string | null {
  for (const s of handle.scripts) {
    if (workspaceJsonContainsBlockId(s.workspace, blockId)) {
      return s.name;
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
      const def = extensionRegistry.getBlockDef(obj.type);
      if (def?.block.sandboxRunnable === false) {
        exportOnlyBlocks.add(def.block.message0.replace(/%\d/g, '▢'));
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
  activeChannelPoolConfigs: Record<string, ChannelPoolConfig>;
  activeChannelCounts: Record<string, number>;
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
  activeChannelPoolConfigs,
  activeChannelCounts,
  activeSimPacks,
  generated,
  setGenerated,
  workbenchRef,
  flushActiveCanvasIntoStore,
  regenerateFromWorkspace,
  notify,
}: UseExecutionControllerOptions) {
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [executingBlockId, setExecutingBlockId] = useState<string | null>(null);
  const [liveVariables, setLiveVariables] = useState<Record<string, string>>({});
  const [errorLine, setErrorLine] = useState<number | null>(null);

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
        'PolyBlock v3 三层多句柄工程工作台就绪：支持多隔离句柄并发模拟、事件回调/定时器、局部作用域变量树与双语言断点调试。',
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

  simStateRef.current = simState;
  activeSimPacksRef.current = activeSimPacks;
  runnerStatusRef.current = runnerStatus;
  multiHandleRunningRef.current = multiHandleRunning;

  useEffect(() => {
    return () => {
      runnerManager.disposeAll();
      multiHandleOrchestrator.dispose();
    };
  }, []);

  const appendLog = useCallback(
    (
      level: LogLevel,
      message: string,
      line?: number,
      blockId?: string,
      handleMeta?: { name: string; color: string },
    ) => {
      setLogs((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: formatNowTime(),
          level,
          message,
          line,
          blockId,
          handleName: handleMeta?.name,
          handleColor: handleMeta?.color,
        },
      ]);
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
      setStore((prev) => {
        const proj = getActiveProject(prev);
        const hdl = getActiveHandle(proj);
        const scr = getActiveScript(hdl);
        const exists = scr.breakpoints.includes(blockId);
        const nextBps = exists
          ? scr.breakpoints.filter((id) => id !== blockId)
          : [...scr.breakpoints, blockId];
        const nextScripts = hdl.scripts.map((s) =>
          s.id === scr.id ? { ...s, breakpoints: nextBps } : s,
        );
        runnerManager.updateActiveBreakpoints(
          collectHandleAllBreakpoints({ ...hdl, scripts: nextScripts }),
        );
        return updateProjectById(prev, proj.id, (p) =>
          updateHandleById(p, hdl.id, (h) => ({
            ...h,
            scripts: nextScripts,
          })),
        );
      });
    },
    [setStore],
  );

  const handleClearBreakpoints = useCallback(() => {
    setStore((prev) => {
      const proj = getActiveProject(prev);
      const hdl = getActiveHandle(proj);
      const nextScripts = hdl.scripts.map((s) =>
        s.id === activeScriptIdRef.current ? { ...s, breakpoints: [] } : s,
      );
      runnerManager.updateActiveBreakpoints(
        collectHandleAllBreakpoints({ ...hdl, scripts: nextScripts }),
      );
      return updateProjectById(prev, activeProjectIdRef.current, (p) =>
        updateHandleById(p, activeHandleIdRef.current, (h) => ({
          ...h,
          scripts: nextScripts,
        })),
      );
    });
    notify('已清除当前脚本的全部断点');
  }, [activeHandleIdRef, activeProjectIdRef, activeScriptIdRef, notify, setStore]);

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
      const runner = runnerManager.findForLanguage(language);
      if (!runner) {
        notify('当前语言仅支持代码生成与导出，暂无内置沙箱');
        return;
      }

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
      // while preloading all sibling scripts in the same handle (including unsaved live edits!).
      const entryScript =
        activeHandle.scripts.find((s) => s.id === activeHandle.entryScriptId) ??
        activeHandle.scripts[0];
      const runningEntryDirectly = activeScript.id === entryScript.id;
      const liveSnapshot = workbenchRef.current?.saveWorkspaceJson();
      const handleForRun: RuntimeHandle = liveSnapshot
        ? {
            ...activeHandle,
            scripts: activeHandle.scripts.map((s) =>
              s.id === activeScript.id ? { ...s, workspace: liveSnapshot } : s,
            ),
          }
        : activeHandle;

      // Pre-Run Static Error Gate: collect blocking `severity === 'error'` diagnostics across ALL scripts in the handle!
      const handleMetasForRun = buildHandleScriptsMeta(handleForRun);
      const sharedVarsForRun = collectHandleSharedVariableNames(handleForRun);
      const blockingErrors: Array<{
        scriptName: string;
        message: string;
        blockId?: string;
        isActiveScript: boolean;
      }> = [];
      for (const scr of handleForRun.scripts) {
        if (scr.id === activeScript.id) {
          for (const d of latest.diagnostics) {
            if (d.severity === 'error') {
              blockingErrors.push({
                scriptName: scr.name,
                message: d.message,
                blockId: d.blockId,
                isActiveScript: true,
              });
            }
          }
        } else {
          const sibCompiled = compileScriptHeadless(scr.workspace, language, {
            channelPoolConfigs: activeChannelPoolConfigs,
            enabledCapabilities: activeProject.enabledCapabilities,
            handleScripts: handleMetasForRun,
            currentScriptId: scr.id,
            sharedVariables: sharedVarsForRun,
            sharedVarInitials: handleForRun.variableInitialValues ?? {},
            scriptVarInitials: scr.variableInitialValues ?? {},
            sharedFunctions: handleForRun.sharedFunctions ?? [],
          });
          for (const d of sibCompiled.diagnostics) {
            if (d.severity === 'error') {
              blockingErrors.push({
                scriptName: scr.name,
                message: d.message,
                blockId: d.blockId,
                isActiveScript: false,
              });
            }
          }
        }
      }

      if (blockingErrors.length > 0) {
        setShowConsole(true);
        setLogs(
          blockingErrors.map((err, idx) => ({
            id: `static-err-${Date.now()}-${idx}`,
            timestamp: formatNowTime(),
            level: 'error' as const,
            message: `[${err.scriptName}.${adapter.extension}] ${err.message}`,
            blockId: err.isActiveScript ? err.blockId : undefined,
          })),
        );
        const firstActiveErr = blockingErrors.find(
          (e) => e.isActiveScript && e.blockId,
        );
        if (firstActiveErr?.blockId) {
          workbenchRef.current?.focusBlock(firstActiveErr.blockId);
        }
        notify(
          `检测到 ${blockingErrors.length} 处静态校验错误，已阻止运行（请查看日志与校验面板）`,
        );
        return;
      }

      let runCode = latest.code;
      let runDebugCode = latest.debugCode || latest.code;
      let runIsEventDriven = Boolean(latest.isEventDriven);
      if (!runningEntryDirectly) {
        const compiledEntry = compileScriptHeadless(
          entryScript.workspace,
          language,
          {
            channelPoolConfigs: activeChannelPoolConfigs,
            enabledCapabilities: activeProject.enabledCapabilities,
            handleScripts: handleMetasForRun,
            currentScriptId: entryScript.id,
            sharedVariables: sharedVarsForRun,
            sharedVarInitials: handleForRun.variableInitialValues ?? {},
            scriptVarInitials: entryScript.variableInitialValues ?? {},
            sharedFunctions: handleForRun.sharedFunctions ?? [],
          },
        );
        runCode = compiledEntry.code;
        runDebugCode = compiledEntry.debugCode;
        runIsEventDriven = compiledEntry.isEventDriven;
      }

      const scriptFileLabel = `${activeHandle.name}/${entryScript.name}.${adapter.extension}`;
      const siblingNames = handleForRun.scripts
        .filter((s) => s.id !== entryScript.id)
        .map((s) => `${s.name}.${adapter.extension}`);

      const exportOnlyBlocks = scanHandleExportOnlyBlocks(handleForRun);

      runnerManager.setActive(runner);

      const siblingMocks = buildHandleScriptModules(
        handleForRun,
        entryScript.id,
        language,
        activeChannelPoolConfigs,
      );

      const modResolution = resolveProjectModules({
        enabledCapabilities: activeProject.enabledCapabilities,
        localExtensions: activeProject.localExtensions,
        handleScripts: siblingMocks.map((m, idx) => ({
          scriptId: `${activeHandle.id}-sib-${idx}`,
          scriptName: m.moduleName,
          sources: m.sources,
        })),
      });

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
              }步进 ${speedDelay}ms${
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
          channelCounts: activeChannelCounts,
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
            const inActiveCanvas = Boolean(
              workbenchRef.current?.getWorkspace()?.getBlockById(blockId),
            );
            setExecutingBlockId(inActiveCanvas ? blockId : null);
            setLiveVariables(vars);
          },
          onPaused: (blockId, vars, reason) => {
            const inActiveCanvas = Boolean(
              workbenchRef.current?.getWorkspace()?.getBlockById(blockId),
            );
            setExecutingBlockId(inActiveCanvas ? blockId : null);
            setLiveVariables(vars);
            const range = inActiveCanvas ? latest.sourceMap[blockId] : undefined;
            if (reason === 'breakpoint') {
              const ownerScriptName = inActiveCanvas
                ? activeScript.name
                : findScriptNameOwningBlockId(handleForRun, blockId);
              const bpFileLabel = ownerScriptName
                ? `${activeHandle.name}/${ownerScriptName}.${adapter.extension}`
                : scriptFileLabel;
              appendLog(
                'warn',
                `[${bpFileLabel}] 命中断点并暂停${
                  range ? `（第 ${range.startLine} 行）` : ''
                }，可查看变量或点击「继续 / 单步」。`,
                range?.startLine,
                inActiveCanvas ? blockId : undefined,
              );
            }
          },
          onDeviceEvent: handleDeviceEvent,
          onRuntimeTelemetry: (tele) =>
            setHandleTelemetries({ [activeHandle.id]: tele }),
          onStatusChange: (status) => setRunnerStatus(status),
        },
      );

      setLastDurationMs(result.durationMs);
      setExecutingBlockId(null);
      setHandleTelemetries({});
      if (result.finalVars) setLiveVariables(result.finalVars);
      runnerManager.setActive(null);

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
      } else if (result.errorLine) {
        setErrorLine(result.errorLine);
        const mappedBlock = latest.lineToBlock[result.errorLine];
        if (mappedBlock) workbenchRef.current?.focusBlock(mappedBlock);
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
      activeChannelCounts,
      activeChannelPoolConfigs,
      language,
      activeHandle,
      activeScript.id,
      activeScript.name,
      activeProject.enabledCapabilities,
      activeProject.localExtensions,
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
    const currentProj = getActiveProject(storeRef.current);
    if (!runnerManager.hasRunnerForLanguage(currentProj.language)) {
      notify('当前语言仅支持代码生成与导出，暂无内置沙箱');
      return;
    }

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

    // Pre-Run Static Error Gate across all target autoStart handles
    const poolsForMulti = extensionRegistry
      .getChannelPools(proj.enabledCapabilities, proj.localExtensions)
      .map((entry) => entry.pool);
    const multiBlockingErrors: Array<{
      handleName: string;
      handleColor: string;
      scriptName: string;
      message: string;
    }> = [];
    for (const hdl of runList) {
      const hdlPools = getAllHandleChannelPoolConfigs(hdl, poolsForMulti);
      const hdlSharedVars = collectHandleSharedVariableNames(hdl);
      const hdlMetas = buildHandleScriptsMeta(hdl);
      for (const scr of hdl.scripts) {
        const res = compileScriptHeadless(scr.workspace, proj.language, {
          channelPoolConfigs: hdlPools,
          enabledCapabilities: proj.enabledCapabilities,
          handleScripts: hdlMetas,
          currentScriptId: scr.id,
          sharedVariables: hdlSharedVars,
          sharedVarInitials: hdl.variableInitialValues ?? {},
          scriptVarInitials: scr.variableInitialValues ?? {},
          sharedFunctions: hdl.sharedFunctions ?? [],
        });
        for (const d of res.diagnostics) {
          if (d.severity === 'error') {
            multiBlockingErrors.push({
              handleName: hdl.name,
              handleColor: hdl.color,
              scriptName: scr.name,
              message: d.message,
            });
          }
        }
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
    setMultiHandleRunning(true);

    const multiBootLogs: LogEntry[] = [
      {
        id: `mstart-${Date.now()}`,
        timestamp: formatNowTime(),
        level: 'system',
        message: `启动多句柄并发仿真：${runList.map((h) => h.name).join(' + ')}（共 ${runList.length} 个独立 WASM Worker，定时器与全局变量完全隔离）...`,
      },
    ];
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
    setMultiHandleRunning(false);
    setHandleTelemetries({});
    appendLog(
      'system',
      `多句柄并发仿真已全部退出（累计耗时 ${totalMs}ms）。`,
    );
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
