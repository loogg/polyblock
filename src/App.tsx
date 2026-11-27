import * as Blockly from 'blockly';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityRail } from './components/ActivityRail';
import {
  BlocklyDialogModal,
  type BlocklyDialogRequest,
} from './components/BlocklyDialogModal';
import {
  BlocklyWorkbench,
  type BlocklyWorkbenchHandle,
  type HandleFunctionMutation,
} from './components/BlocklyWorkbench';
import { CodeInspector } from './components/CodeInspector';
import { LogConsole } from './components/LogConsole';
import { DevicesPage } from './components/pages/DevicesPage';
import { ExtensionsPage } from './components/pages/ExtensionsPage';
import { ProjectsPage } from './components/pages/ProjectsPage';
import { SettingsPage } from './components/pages/SettingsPage';
import { ProjectExplorer } from './components/ProjectExplorer';
import {
  ProjectSettingsModal,
  type ProjectSettingsTab,
} from './components/ProjectSettingsModal';
import { ScriptLibImportModal } from './components/ScriptLibImportModal';
import { ScriptTabBar } from './components/ScriptTabBar';
import { SharedVarsView } from './components/SharedVarsView';
import { StatusBar } from './components/StatusBar';
import { TimerAliasModal } from './components/TimerAliasModal';
import { TopBar } from './components/TopBar';
import { buildHandleScriptsMeta } from './core/backends/eventMode';
import { buildHandleSharedModule } from './core/backends/sharedModule';
import { backendRegistry } from './core/backends/registry';
import type { GeneratedCodeResult } from './core/backends/types';
import {
  normalizeTimerConfig,
  setActiveChannelPoolConfig,
  setActiveChannelPoolConfigs,
  setActiveHandleScripts,
  setActiveHandleSharedFunctions,
  setActiveHandleSharedVariables,
  setActiveHandleSharedVarInitials,
  setActiveModuleConflicts,
  setActiveProjectCapabilities,
  setActiveScriptVarInitials,
  type ChannelAliasPromptRequest,
} from './core/blocks/timerConfigBridge';
import {
  CAP_RT_TIMERS,
  hasCapability,
  targetProfileRegistry,
} from './core/capabilities/registry';
import {
  buildProjectTargetBundle,
  buildSingleHandleTargetBundle,
  ModuleConflictExportError,
} from './core/export/bundleExporter';
import { resolveProjectModules } from './core/extensions/moduleResolver';
import {
  extensionRegistry,
  getAllPackBlocks,
  togglePackOrSectionCapability,
} from './core/extensions/registry';
import {
  mergeAttachedLibFiles,
  type UploadedScriptLibFile,
} from './core/extensions/scriptLibScanner';
import {
  applySimDeviceEvent,
  buildDefaultSimState,
  buildPackResetPatch,
} from './core/extensions/simState';
import type {
  PolyExtensionPack,
  SimStateMap,
} from './core/extensions/types';
import {
  applyHandleVariableMutation,
  collectAllVariableNamesInHandle,
  collectHandleSharedVariableNames,
  collectScriptVariableNames,
  syncHandleVariablesIntoWorkspaceJson,
  type HandleVariableMutation,
  type VariableScopeKind,
} from './core/projects/handleVariables';
import {
  addHandleToProject,
  addScriptToHandle,
  applyTargetProfileToProject,
  buildExportableProjectJson,
  countProjectScripts,
  createDefaultWorkspaceStore,
  deleteHandleFromProject,
  deleteProjectFromStore,
  deleteScriptFromHandle,
  duplicateHandleInProject,
  duplicateProjectInStore,
  duplicateScriptInHandle,
  getActiveHandle,
  getActiveProject,
  getActiveScript,
  getAllHandleChannelPoolConfigs,
  getHandleChannelPoolConfig,
  getHandleTimerConfig,
  instantiateProjectFromTemplate,
  loadWorkspaceStore,
  makeUniqueProjectName,
  renameHandleInProject,
  renameScriptInHandle,
  saveWorkspaceStore,
  setHandleChannelPoolConfig,
  setHandleTimerConfig,
  STORAGE_STORE_V6_KEY,
  updateHandleById,
  updateProjectById,
} from './core/projects/store';
import { runnerManager } from './core/runners/manager';
import {
  buildHandleScriptModules,
  compileScriptHeadless,
  multiHandleOrchestrator,
} from './core/runners/multiHandleManager';
import type { RunnerStatus } from './core/runners/types';
import type {
  AppSettings,
  ExecutionSpeedId,
  LogEntry,
  LogLevel,
  PageId,
  ProjectModel,
  ProjectTimerConfig,
  RuntimeHandle,
  RuntimeTelemetry,
  ScriptLanguageId,
  TargetProfile,
  WorkspaceStoreState,
} from './types/project';

const STORAGE_SETTINGS_KEY = 'polyblock.settings.v1';

const SPEED_DELAY_MS: Record<ExecutionSpeedId, number> = {
  fast: 0,
  normal: 180,
  slow: 450,
};

const VALID_PAGES: PageId[] = [
  'blocks',
  'projects',
  'devices',
  'extensions',
  'settings',
];

function readPageFromHash(): PageId {
  const raw = window.location.hash.replace(/^#\/?/, '').trim() as PageId;
  return VALID_PAGES.includes(raw) ? raw : 'blocks';
}

function formatNowTime(): string {
  return new Date().toTimeString().slice(0, 8);
}

function loadSavedSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      const speed =
        parsed.executionSpeed === 'fast' ||
        parsed.executionSpeed === 'normal' ||
        parsed.executionSpeed === 'slow'
          ? parsed.executionSpeed
          : 'normal';
      return {
        theme: parsed.theme === 'dark' ? 'dark' : 'light',
        timeoutMs:
          typeof parsed.timeoutMs === 'number' && parsed.timeoutMs >= 1000
            ? parsed.timeoutMs
            : 5000,
        timeSliceMs:
          typeof parsed.timeSliceMs === 'number' &&
          parsed.timeSliceMs >= 5 &&
          parsed.timeSliceMs <= 500
            ? parsed.timeSliceMs
            : 20,
        autoOpenConsoleOnRun: parsed.autoOpenConsoleOnRun ?? true,
        executionSpeed: speed,
      };
    }
  } catch {
    // ignore storage errors
  }
  return {
    theme: 'light',
    timeoutMs: 5000,
    timeSliceMs: 20,
    autoOpenConsoleOnRun: true,
    executionSpeed: 'normal',
  };
}

function collectHandleAllBreakpoints(handle: RuntimeHandle): string[] {
  const seen = new Set<string>();
  for (const s of handle.scripts) {
    for (const bp of s.breakpoints) {
      if (bp) seen.add(bp);
    }
  }
  return Array.from(seen);
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

function triggerFileDownload(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function triggerBinaryDownload(filename: string, bytes: Uint8Array, mime: string) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function App() {
  extensionRegistry.ensureInitialized();
  targetProfileRegistry.ensureInitialized();

  const initialStoreRef = useRef<WorkspaceStoreState>(loadWorkspaceStore());
  const workbenchRef = useRef<BlocklyWorkbenchHandle | null>(null);

  const [store, setStore] = useState<WorkspaceStoreState>(initialStoreRef.current);
  const [settings, setSettings] = useState<AppSettings>(loadSavedSettings);
  const [activePage, setActivePage] = useState<PageId>(readPageFromHash);
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [extRevision, setExtRevision] = useState<number>(0);
  const [profileRevision, setProfileRevision] = useState<number>(0);

  const [showCode, setShowCode] = useState<boolean>(true);
  const [showConsole, setShowConsole] = useState<boolean>(true);
  const [showExplorer, setShowExplorer] = useState<boolean>(false);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [executingBlockId, setExecutingBlockId] = useState<string | null>(null);
  const [liveVariables, setLiveVariables] = useState<Record<string, string>>({});
  const [errorLine, setErrorLine] = useState<number | null>(null);

  const [settingsModal, setSettingsModal] = useState<{
    projectId: string;
    initialTab: ProjectSettingsTab;
    initialHandleId?: string;
  } | null>(null);
  const [scriptLibModal, setScriptLibModal] = useState<{
    targetScope: 'project' | 'global';
    projectId?: string;
  } | null>(null);
  const [aliasModalReq, setAliasModalReq] =
    useState<ChannelAliasPromptRequest | null>(null);
  const [blocklyDialogReq, setBlocklyDialogReq] =
    useState<BlocklyDialogRequest | null>(null);
  const [viewingSharedModule, setViewingSharedModule] = useState<boolean>(false);

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
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: 'boot-log',
      timestamp: formatNowTime(),
      level: 'system',
      message:
        'PolyBlock v3 三层多句柄工程工作台就绪：支持多隔离句柄并发模拟、事件回调/定时器、局部作用域变量树与双语言断点调试。',
    },
  ]);

  const activeProject = getActiveProject(store);
  const activeHandle = getActiveHandle(activeProject);
  const activeScript = getActiveScript(activeHandle);
  const activeChannelPools = useMemo(
    () =>
      extensionRegistry
        .getChannelPools(
          activeProject.enabledCapabilities,
          activeProject.localExtensions,
        )
        .map((entry) => entry.pool),
    [activeProject.enabledCapabilities, activeProject.localExtensions, extRevision],
  );
  const activeChannelPoolConfigs = useMemo(
    () =>
      getAllHandleChannelPoolConfigs(
        activeHandle,
        activeChannelPools,
        activeProject.defaultTimerCount,
      ),
    [activeHandle, activeChannelPools, activeProject.defaultTimerCount],
  );
  const activeTimerConfig =
    activeChannelPoolConfigs[CAP_RT_TIMERS] ??
    getHandleTimerConfig(activeHandle, activeProject.defaultTimerCount);
  const hasTimersCapability = hasCapability(
    activeProject.enabledCapabilities,
    CAP_RT_TIMERS,
  );
  const activeModuleResolution = useMemo(
    () =>
      resolveProjectModules({
        enabledCapabilities: activeProject.enabledCapabilities,
        localExtensions: activeProject.localExtensions,
        handleScripts: activeHandle.scripts.map((s) => ({
          scriptId: s.id,
          scriptName: s.name,
        })),
      }),
    [
      activeProject.enabledCapabilities,
      activeProject.localExtensions,
      activeHandle.scripts,
      extRevision,
    ],
  );
  setActiveChannelPoolConfigs(activeChannelPoolConfigs);
  setActiveProjectCapabilities(activeProject.enabledCapabilities);
  setActiveHandleSharedVariables(collectHandleSharedVariableNames(activeHandle));
  setActiveHandleSharedVarInitials(activeHandle.variableInitialValues ?? {});
  setActiveScriptVarInitials(activeScript.variableInitialValues ?? {});
  setActiveHandleSharedFunctions(activeHandle.sharedFunctions ?? []);
  setActiveHandleScripts(buildHandleScriptsMeta(activeHandle), activeScript.id);
  setActiveModuleConflicts(activeModuleResolution.conflicts);
  extensionRegistry.setActiveProjectLocalPacks(activeProject.localExtensions ?? []);

  const language = activeProject.language;
  const breakpoints = activeScript.breakpoints;
  const activeBackend = backendRegistry.get(language);

  const activeSharedModule = useMemo(
    () =>
      buildHandleSharedModule(
        activeHandle,
        language,
        activeChannelPoolConfigs,
      ),
    [activeHandle, language, activeChannelPoolConfigs],
  );

  useEffect(() => {
    if (!activeSharedModule && viewingSharedModule) {
      setViewingSharedModule(false);
    }
  }, [activeSharedModule, viewingSharedModule]);

  const allExtensionPacks = useMemo(
    () => extensionRegistry.listAll(),
    [extRevision],
  );

  const allTargetProfiles = useMemo(
    () => targetProfileRegistry.listAll(),
    [profileRevision],
  );

  const extraCategories = useMemo(
    () =>
      extensionRegistry.toCategorySpecs(
        activeProject.enabledCapabilities,
        activeProject.localExtensions,
      ),
    [activeProject.enabledCapabilities, activeProject.localExtensions, extRevision],
  );

  const activeSimPacks = useMemo(
    () =>
      extensionRegistry.getActiveSimPacks(
        activeProject.enabledCapabilities,
        activeProject.localExtensions,
      ),
    [activeProject.enabledCapabilities, activeProject.localExtensions, extRevision],
  );

  const simState = useMemo<SimStateMap>(() => {
    const defaults = buildDefaultSimState(activeSimPacks);
    const saved = simStatesByProject[activeProject.id];
    return saved ? { ...defaults, ...saved } : defaults;
  }, [activeSimPacks, simStatesByProject, activeProject.id]);

  const [generated, setGenerated] = useState<GeneratedCodeResult>({
    language,
    code: '',
    debugCode: '',
    sourceMap: {},
    lineToBlock: {},
    diagnostics: [],
    blockCount: 0,
    variableNames: [],
    variableScopes: [],
  });

  const [toastMsg, setToastMsg] = useState<string>('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const storeRef = useRef<WorkspaceStoreState>(store);
  storeRef.current = store;

  const activeProjectIdRef = useRef<string>(activeProject.id);
  const activeHandleIdRef = useRef<string>(activeHandle.id);
  const activeScriptIdRef = useRef<string>(activeScript.id);
  const languageRef = useRef<ScriptLanguageId>(language);
  const breakpointsRef = useRef<string[]>(breakpoints);
  const simStateRef = useRef<SimStateMap>(simState);
  const activeSimPacksRef = useRef<PolyExtensionPack[]>(activeSimPacks);

  activeProjectIdRef.current = activeProject.id;
  activeHandleIdRef.current = activeHandle.id;
  activeScriptIdRef.current = activeScript.id;
  languageRef.current = language;
  breakpointsRef.current = breakpoints;
  simStateRef.current = simState;
  activeSimPacksRef.current = activeSimPacks;

  const notify = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(''), 2400);
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

  useEffect(() => {
    saveWorkspaceStore(store);
  }, [store]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
    try {
      localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // ignore storage errors
    }
  }, [settings]);

  // Replace Blockly v12's unstyled default dialog/prompt/confirm/alert with PolyBlock's modal UI
  useEffect(() => {
    Blockly.dialog.setPrompt((message, defaultValue, callback) => {
      setBlocklyDialogReq({
        kind: 'prompt',
        message,
        defaultValue: defaultValue ?? '',
        callback,
      });
    });
    Blockly.dialog.setConfirm((message, callback) => {
      setBlocklyDialogReq({
        kind: 'confirm',
        message,
        callback,
      });
    });
    Blockly.dialog.setAlert((message, callback) => {
      setBlocklyDialogReq({
        kind: 'alert',
        message,
        callback,
      });
    });
  }, []);

  useEffect(() => {
    const onHashChange = () => setActivePage(readPageFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigateTo = useCallback((page: PageId) => {
    setActivePage(page);
    const targetHash = `#/${page}`;
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    }
  }, []);

  useEffect(() => {
    return () => {
      runnerManager.disposeAll();
      multiHandleOrchestrator.dispose();
    };
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => workbenchRef.current?.resize());
    return () => cancelAnimationFrame(id);
  }, [showCode, showConsole, showExplorer, activePage]);

  const regenerateFromWorkspace = useCallback(
    (ws: Blockly.WorkspaceSvg, lang: ScriptLanguageId) => {
      const adapter = backendRegistry.get(lang);
      const result = adapter.generate(ws);
      setGenerated(result);
      setErrorLine(null);
      return result;
    },
    [],
  );

  const flushActiveCanvasIntoStore = useCallback(
    (baseStore: WorkspaceStoreState): WorkspaceStoreState => {
      const ws = workbenchRef.current?.getWorkspace();
      if (!ws) return baseStore;
      const snapshot = workbenchRef.current?.saveWorkspaceJson();
      if (!snapshot) return baseStore;
      const projId = activeProjectIdRef.current;
      const hdlId = activeHandleIdRef.current;
      const scrId = activeScriptIdRef.current;
      const now = new Date().toISOString();

      return updateProjectById(baseStore, projId, (proj) =>
        updateHandleById(proj, hdlId, (hdl) => ({
          ...hdl,
          scripts: hdl.scripts.map((s) =>
            s.id === scrId
              ? {
                  ...s,
                  workspace: snapshot,
                  breakpoints: s.breakpoints.filter((bid) =>
                    Boolean(ws.getBlockById(bid)),
                  ),
                  updatedAt: now,
                }
              : s,
          ),
          updatedAt: now,
        })),
      );
    },
    [],
  );

  const mountScriptIntoCanvas = useCallback(
    (nextStore: WorkspaceStoreState) => {
      const nextProj = getActiveProject(nextStore);
      const nextHandle = getActiveHandle(nextProj);
      const nextScript = getActiveScript(nextHandle);
      extensionRegistry.setActiveProjectLocalPacks(nextProj.localExtensions ?? []);
      const nextPools = extensionRegistry
        .getChannelPools(nextProj.enabledCapabilities, nextProj.localExtensions)
        .map((entry) => entry.pool);
      setActiveChannelPoolConfigs(
        getAllHandleChannelPoolConfigs(
          nextHandle,
          nextPools,
          nextProj.defaultTimerCount,
        ),
      );
      setActiveProjectCapabilities(nextProj.enabledCapabilities);
      const sharedVarNames = collectHandleSharedVariableNames(nextHandle);
      setActiveHandleSharedVariables(sharedVarNames);
      setActiveHandleSharedVarInitials(nextHandle.variableInitialValues ?? {});
      setActiveScriptVarInitials(nextScript.variableInitialValues ?? {});
      setActiveHandleSharedFunctions(nextHandle.sharedFunctions ?? []);
      setActiveHandleScripts(buildHandleScriptsMeta(nextHandle), nextScript.id);
      const nextModRes = resolveProjectModules({
        enabledCapabilities: nextProj.enabledCapabilities,
        localExtensions: nextProj.localExtensions,
        handleScripts: nextHandle.scripts.map((s) => ({
          scriptId: s.id,
          scriptName: s.name,
        })),
      });
      setActiveModuleConflicts(nextModRes.conflicts);

      activeProjectIdRef.current = nextProj.id;
      activeHandleIdRef.current = nextHandle.id;
      activeScriptIdRef.current = nextScript.id;
      languageRef.current = nextProj.language;
      breakpointsRef.current = nextScript.breakpoints;

      setSelectedBlockId(null);
      setExecutingBlockId(null);
      setLiveVariables({});
      setHandleTelemetries({});
      setErrorLine(null);
      setViewingSharedModule(false);

      const syncedWorkspace = syncHandleVariablesIntoWorkspaceJson(
        nextScript.workspace,
        sharedVarNames,
      );
      workbenchRef.current?.loadWorkspaceJson(syncedWorkspace);
      const ws = workbenchRef.current?.getWorkspace();
      if (ws) {
        regenerateFromWorkspace(ws, nextProj.language);
      }
    },
    [regenerateFromWorkspace],
  );

  const stopIfRunning = useCallback(() => {
    if (runnerStatus === 'running' || runnerStatus === 'paused') {
      runnerManager.stopActive(true);
      multiHandleOrchestrator.stopAll(true);
      setMultiHandleRunning(false);
      setExecutingBlockId(null);
      setHandleTelemetries({});
    }
  }, [runnerStatus]);

  const handleHandleVariableEvent = useCallback(
    (mutation: HandleVariableMutation) => {
      const projId = activeProjectIdRef.current;
      const hdlId = activeHandleIdRef.current;
      const scrId = activeScriptIdRef.current;
      const now = new Date().toISOString();

      // Compute updated sharedVariables & sibling notice synchronously from current storeRef
      // (React 18 may batch setStore updaters asynchronously, so never read side-effects out of them!)
      const curProj = storeRef.current.projects.find((p) => p.id === projId);
      const curHdl = curProj?.handles.find((h) => h.id === hdlId);
      const previewRes = curHdl
        ? applyHandleVariableMutation(curHdl, scrId, mutation)
        : null;
      const nextSharedNames = previewRes
        ? collectHandleSharedVariableNames(previewRes.handle)
        : null;
      const keptNotice = previewRes?.keptInSiblings ?? [];

      if (nextSharedNames !== null && previewRes) {
        setActiveHandleSharedVariables(nextSharedNames);
        setActiveHandleSharedVarInitials(
          previewRes.handle.variableInitialValues ?? {},
        );
        const nextActiveScr = previewRes.handle.scripts.find((s) => s.id === scrId);
        if (nextActiveScr) {
          setActiveScriptVarInitials(nextActiveScr.variableInitialValues ?? {});
        }
      }

      setStore((prev) =>
        updateProjectById(prev, projId, (proj) =>
          updateHandleById(proj, hdlId, (hdl) => {
            const { handle: updatedHdl } = applyHandleVariableMutation(
              hdl,
              scrId,
              mutation,
            );
            return { ...updatedHdl, updatedAt: now };
          }),
        ),
      );

      const ws = workbenchRef.current?.getWorkspace();
      if (ws) regenerateFromWorkspace(ws, languageRef.current);
      workbenchRef.current?.refreshToolbox();

      if (mutation.kind === 'delete' && keptNotice.length > 0) {
        notify(
          `跨文件变量「${mutation.name}」仍在 ${keptNotice.join('、')} 中被积木引用，已保留这些脚本中的定义`,
        );
      }
    },
    [notify, regenerateFromWorkspace],
  );

  const handleRequestCreateVariable = useCallback(
    (initialScope: VariableScopeKind) => {
      setBlocklyDialogReq({
        kind: 'create-variable',
        initialScope,
        onConfirm: (name, scope, initialValue) => {
          handleHandleVariableEvent({
            kind: 'create',
            name,
            scope,
            initialValue,
          });
          workbenchRef.current?.createVariable(name, scope);
          const ws = workbenchRef.current?.getWorkspace();
          if (ws) regenerateFromWorkspace(ws, languageRef.current);
        },
      });
    },
    [handleHandleVariableEvent, regenerateFromWorkspace],
  );

  const handleToggleSharedFunction = useCallback(
    (fnName: string) => {
      const trimmed = fnName.trim();
      if (!trimmed) return;
      const projId = activeProjectIdRef.current;
      const hdlId = activeHandleIdRef.current;
      const now = new Date().toISOString();
      const curProj = storeRef.current.projects.find((p) => p.id === projId);
      const curHdl = curProj?.handles.find((h) => h.id === hdlId);
      const prevFns = curHdl?.sharedFunctions ?? [];
      const wasShared = prevFns.includes(trimmed);
      const nextFns = wasShared
        ? prevFns.filter((n) => n !== trimmed)
        : [...prevFns, trimmed];

      setActiveHandleSharedFunctions(nextFns);
      setStore((prev) =>
        updateProjectById(prev, projId, (proj) =>
          updateHandleById(proj, hdlId, (hdl) => ({
            ...hdl,
            sharedFunctions: nextFns,
            updatedAt: now,
          })),
        ),
      );
      const ws = workbenchRef.current?.getWorkspace();
      if (ws) regenerateFromWorkspace(ws, languageRef.current);
      workbenchRef.current?.refreshToolbox();
      notify(
        wasShared
          ? `已将函数「${trimmed}」转为本文件私有函数（仅本脚本可用）`
          : `已将函数「${trimmed}」设为跨文件公共函数（自动归入只读 shared 模块）`,
      );
    },
    [notify, regenerateFromWorkspace],
  );

  const handleRequestCreateFunction = useCallback(
    (initialScope: VariableScopeKind) => {
      setBlocklyDialogReq({
        kind: 'create-function',
        initialScope,
        onConfirm: (name, scope, hasReturn) => {
          const trimmed = name.trim();
          if (!trimmed) return;
          if (scope === 'shared') {
            const projId = activeProjectIdRef.current;
            const hdlId = activeHandleIdRef.current;
            const now = new Date().toISOString();
            const curProj = storeRef.current.projects.find((p) => p.id === projId);
            const curHdl = curProj?.handles.find((h) => h.id === hdlId);
            const prevFns = curHdl?.sharedFunctions ?? [];
            const nextFns = prevFns.includes(trimmed)
              ? prevFns
              : [...prevFns, trimmed];

            setActiveHandleSharedFunctions(nextFns);
            setStore((prev) =>
              updateProjectById(prev, projId, (proj) =>
                updateHandleById(proj, hdlId, (hdl) => ({
                  ...hdl,
                  sharedFunctions: nextFns,
                  updatedAt: now,
                })),
              ),
            );
          }
          setViewingSharedModule(false);
          workbenchRef.current?.createProcedure(trimmed, hasReturn);
          const ws = workbenchRef.current?.getWorkspace();
          if (ws) regenerateFromWorkspace(ws, languageRef.current);
          notify(
            scope === 'shared'
              ? `已创建跨文件公共函数「${trimmed}」，将自动归入 shared 模块供同句柄所有脚本调用`
              : `已创建本文件私有函数「${trimmed}」（仅当前脚本内可见）`,
          );
        },
      });
    },
    [notify, regenerateFromWorkspace],
  );

  const handleHandleFunctionEvent = useCallback(
    (mutation: HandleFunctionMutation) => {
      const projId = activeProjectIdRef.current;
      const hdlId = activeHandleIdRef.current;
      const now = new Date().toISOString();
      const curProj = storeRef.current.projects.find((p) => p.id === projId);
      const curHdl = curProj?.handles.find((h) => h.id === hdlId);
      if (!curHdl) return;
      const prevFns = curHdl.sharedFunctions ?? [];
      if (prevFns.length === 0) return;

      let nextFns = prevFns;
      if (mutation.kind === 'rename') {
        if (!prevFns.includes(mutation.oldName)) return;
        nextFns = Array.from(
          new Set(
            prevFns.map((n) => (n === mutation.oldName ? mutation.newName : n)),
          ),
        );
      } else if (mutation.kind === 'delete') {
        if (!prevFns.includes(mutation.name)) return;
        const scrId = activeScriptIdRef.current;
        const stillInOtherScript = curHdl.scripts.some(
          (s) =>
            s.id !== scrId &&
            (buildHandleScriptsMeta({ ...curHdl, scripts: [s] })[0]
              ?.declaredFunctions ?? []
            ).some((f) => f.name === mutation.name),
        );
        if (stillInOtherScript) return;
        nextFns = prevFns.filter((n) => n !== mutation.name);
      }

      setActiveHandleSharedFunctions(nextFns);
      setStore((prev) =>
        updateProjectById(prev, projId, (proj) =>
          updateHandleById(proj, hdlId, (hdl) => ({
            ...hdl,
            sharedFunctions: nextFns,
            updatedAt: now,
          })),
        ),
      );
      const ws = workbenchRef.current?.getWorkspace();
      if (ws) regenerateFromWorkspace(ws, languageRef.current);
      workbenchRef.current?.refreshToolbox();
    },
    [regenerateFromWorkspace],
  );

  const handleWorkspaceChange = useCallback(
    (ws: Blockly.WorkspaceSvg) => {
      regenerateFromWorkspace(ws, languageRef.current);
      setIsDirty(true);

      const snapshot = workbenchRef.current?.saveWorkspaceJson();
      if (!snapshot) return;
      const projId = activeProjectIdRef.current;
      const hdlId = activeHandleIdRef.current;
      const scrId = activeScriptIdRef.current;
      const now = new Date().toISOString();

      setStore((prev) =>
        updateProjectById(prev, projId, (proj) =>
          updateHandleById(proj, hdlId, (hdl) => {
            let prunedAny = false;
            const nextScripts = hdl.scripts.map((s) => {
              if (s.id !== scrId) return s;
              const pruned = s.breakpoints.filter((bid) =>
                Boolean(ws.getBlockById(bid)),
              );
              if (pruned.length !== s.breakpoints.length) {
                prunedAny = true;
              }
              return {
                ...s,
                workspace: snapshot,
                breakpoints: pruned,
                updatedAt: now,
              };
            });
            const nextHdl = { ...hdl, scripts: nextScripts, updatedAt: now };
            if (prunedAny) {
              runnerManager.updateActiveBreakpoints(
                collectHandleAllBreakpoints(nextHdl),
              );
            }
            return nextHdl;
          }),
        ),
      );
    },
    [regenerateFromWorkspace],
  );

  /* ========================================================================
     Target Profile, Capabilities, Extension Packs & Virtual Board Operations
     ======================================================================== */
  const handleToggleCapabilityForProject = useCallback(
    (projectId: string, capId: string) => {
      const curProj = storeRef.current.projects.find((p) => p.id === projectId);
      if (!curProj) return;
      const { nextCapabilities, action, displayName } =
        togglePackOrSectionCapability(
          capId,
          curProj.enabledCapabilities,
          curProj.localExtensions,
        );

      setStore((prev) =>
        updateProjectById(prev, projectId, (p) => ({
          ...p,
          enabledCapabilities: nextCapabilities,
          updatedAt: new Date().toISOString(),
        })),
      );

      if (projectId === activeProjectIdRef.current) {
        setActiveProjectCapabilities(nextCapabilities);
        const curHandle = getActiveHandle(curProj);
        const modRes = resolveProjectModules({
          enabledCapabilities: nextCapabilities,
          localExtensions: curProj.localExtensions,
          handleScripts: curHandle.scripts.map((s) => ({
            scriptId: s.id,
            scriptName: s.name,
          })),
        });
        setActiveModuleConflicts(modRes.conflicts);
        const ws = workbenchRef.current?.getWorkspace();
        if (ws) regenerateFromWorkspace(ws, languageRef.current);
      }

      notify(
        action === 'disabled'
          ? `已从「${curProj.name}」停用「${displayName}」`
          : `已为「${curProj.name}」启用「${displayName}」`,
      );
    },
    [notify, regenerateFromWorkspace],
  );

  const handleImportProjectLocalExtension = useCallback(
    (projectId: string, raw: unknown) => {
      try {
        const pack = extensionRegistry.validateProjectLocalPack(raw);
        const curProj = storeRef.current.projects.find((p) => p.id === projectId);
        if (!curProj) return;

        const existingLocal = curProj.localExtensions ?? [];
        const replaced = existingLocal.some((p) => p.id === pack.id);
        const nextLocal = replaced
          ? existingLocal.map((p) => (p.id === pack.id ? pack : p))
          : [...existingLocal, pack];
        const nextCaps = curProj.enabledCapabilities.includes(pack.id)
          ? curProj.enabledCapabilities
          : [...curProj.enabledCapabilities, pack.id];

        setStore((prev) =>
          updateProjectById(prev, projectId, (p) => ({
            ...p,
            localExtensions: nextLocal,
            enabledCapabilities: nextCaps,
            updatedAt: new Date().toISOString(),
          })),
        );

        if (projectId === activeProjectIdRef.current) {
          extensionRegistry.setActiveProjectLocalPacks(nextLocal);
          setActiveProjectCapabilities(nextCaps);
          const curHandle = getActiveHandle(curProj);
          const modRes = resolveProjectModules({
            enabledCapabilities: nextCaps,
            localExtensions: nextLocal,
            handleScripts: curHandle.scripts.map((s) => ({
              scriptId: s.id,
              scriptName: s.name,
            })),
          });
          setActiveModuleConflicts(modRes.conflicts);
          const ws = workbenchRef.current?.getWorkspace();
          if (ws) regenerateFromWorkspace(ws, languageRef.current);
        }

        notify(
          `已将「${pack.name}」内嵌到项目「${curProj.name}」（仅本项目可见，不写入全局扩展库）`,
        );
      } catch (err) {
        notify(
          `项目内嵌外设包校验失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [notify, regenerateFromWorkspace],
  );

  const handleRemoveProjectLocalExtension = useCallback(
    (projectId: string, packId: string) => {
      const curProj = storeRef.current.projects.find((p) => p.id === projectId);
      if (!curProj) return;
      const nextLocal = (curProj.localExtensions ?? []).filter((p) => p.id !== packId);
      const hasGlobalFallback = Boolean(extensionRegistry.get(packId));
      const nextCaps = hasGlobalFallback
        ? curProj.enabledCapabilities
        : curProj.enabledCapabilities.filter(
            (id) => id !== packId && !id.startsWith(`${packId}.`),
          );

      setStore((prev) =>
        updateProjectById(prev, projectId, (p) => ({
          ...p,
          localExtensions: nextLocal,
          enabledCapabilities: nextCaps,
          updatedAt: new Date().toISOString(),
        })),
      );

      if (projectId === activeProjectIdRef.current) {
        extensionRegistry.setActiveProjectLocalPacks(nextLocal);
        setActiveProjectCapabilities(nextCaps);
        const ws = workbenchRef.current?.getWorkspace();
        if (ws) regenerateFromWorkspace(ws, languageRef.current);
      }

      notify(
        hasGlobalFallback
          ? '已移除项目内嵌覆盖包，自动恢复使用全局扩展库版本'
          : '已从当前项目移除内嵌外设包',
      );
    },
    [notify, regenerateFromWorkspace],
  );

  const handlePromoteLocalExtensionToGlobal = useCallback(
    (pack: PolyExtensionPack) => {
      try {
        extensionRegistry.importCustomPack(pack);
        setExtRevision((r) => r + 1);
        notify(`已将「${pack.name}」复制保存到全局扩展库，其他项目现可直接启用`);
      } catch (err) {
        notify(
          `保存到全局库失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [notify],
  );

  const handleAttachLibsToProjectPack = useCallback(
    (projectId: string, packId: string, files: UploadedScriptLibFile[]) => {
      const curProj = storeRef.current.projects.find((p) => p.id === projectId);
      if (!curProj) return;
      const target = (curProj.localExtensions ?? []).find((p) => p.id === packId);
      if (!target) return;
      try {
        const mergedLibs = mergeAttachedLibFiles(
          target.libs,
          files.map((f) => ({
            moduleName: f.moduleName,
            language: f.language,
            source: f.source,
            role: f.scanForBlocks ? 'entry' : 'helper',
          })),
        );
        const validated = extensionRegistry.validateProjectLocalPack({
          ...target,
          libs: mergedLibs,
        });
        const nextLocal = (curProj.localExtensions ?? []).map((p) =>
          p.id === packId ? validated : p,
        );
        setStore((prev) =>
          updateProjectById(prev, projectId, (p) => ({
            ...p,
            localExtensions: nextLocal,
            updatedAt: new Date().toISOString(),
          })),
        );
        if (projectId === activeProjectIdRef.current) {
          extensionRegistry.setActiveProjectLocalPacks(nextLocal);
          const curHandle = getActiveHandle(curProj);
          const modRes = resolveProjectModules({
            enabledCapabilities: curProj.enabledCapabilities,
            localExtensions: nextLocal,
            handleScripts: curHandle.scripts.map((s) => ({
              scriptId: s.id,
              scriptName: s.name,
            })),
          });
          setActiveModuleConflicts(modRes.conflicts);
          const ws = workbenchRef.current?.getWorkspace();
          if (ws) regenerateFromWorkspace(ws, languageRef.current);
        }
        notify(
          `已为项目内嵌包「${validated.name}」附加 ${files.length} 个源码模块（当前共 ${mergedLibs.length} 个 libs[]）`,
        );
      } catch (err) {
        notify(
          `附加库源码失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [notify, regenerateFromWorkspace],
  );

  const handleAttachLibsToGlobalPack = useCallback(
    (packId: string, files: UploadedScriptLibFile[]) => {
      const target = extensionRegistry.get(packId);
      if (!target || target.builtin) return;
      try {
        const mergedLibs = mergeAttachedLibFiles(
          target.libs,
          files.map((f) => ({
            moduleName: f.moduleName,
            language: f.language,
            source: f.source,
            role: f.scanForBlocks ? 'entry' : 'helper',
          })),
        );
        const updated = extensionRegistry.importCustomPack({
          ...target,
          libs: mergedLibs,
        });
        setExtRevision((r) => r + 1);
        const curProj = getActiveProject(storeRef.current);
        const curHandle = getActiveHandle(curProj);
        const modRes = resolveProjectModules({
          enabledCapabilities: curProj.enabledCapabilities,
          localExtensions: curProj.localExtensions,
          handleScripts: curHandle.scripts.map((s) => ({
            scriptId: s.id,
            scriptName: s.name,
          })),
        });
        setActiveModuleConflicts(modRes.conflicts);
        const ws = workbenchRef.current?.getWorkspace();
        if (ws) regenerateFromWorkspace(ws, languageRef.current);
        notify(
          `已为全局扩展包「${updated.name}」附加 ${files.length} 个源码模块（当前共 ${mergedLibs.length} 个 libs[]）`,
        );
      } catch (err) {
        notify(
          `附加库源码失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [notify, regenerateFromWorkspace],
  );

  const handleApplyTargetProfile = useCallback(
    (projectId: string, profileId: string) => {
      const profile = targetProfileRegistry.get(profileId);
      const curProj = storeRef.current.projects.find((p) => p.id === projectId);
      if (!curProj) return;

      setStore((prev) =>
        updateProjectById(prev, projectId, (p) =>
          applyTargetProfileToProject(p, profile),
        ),
      );

      if (projectId === activeProjectIdRef.current) {
        setActiveProjectCapabilities(profile.capabilities);
        const ws = workbenchRef.current?.getWorkspace();
        if (ws) regenerateFromWorkspace(ws, languageRef.current);
      }

      notify(`已为「${curProj.name}」应用板型规格「${profile.name}」`);
    },
    [notify, regenerateFromWorkspace],
  );

  const handleImportBoardProfileJson = useCallback(
    (raw: unknown): TargetProfile | null => {
      try {
        const imported = targetProfileRegistry.importCustomProfile(raw);
        setProfileRevision((r) => r + 1);
        notify(`已导入自定义板型规格「${imported.name}」`);
        return imported;
      } catch (err) {
        notify(
          `板型规格校验失败：${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    },
    [notify],
  );

  const handleRemoveCustomProfile = useCallback(
    (profileId: string) => {
      const ok = targetProfileRegistry.removeCustomProfile(profileId);
      if (!ok) return;
      setProfileRevision((r) => r + 1);
      setStore((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.targetProfileId === profileId
            ? { ...p, targetProfileId: 'generic-script' }
            : p,
        ),
      }));
      notify('已删除自定义板型规格');
    },
    [notify],
  );

  const handleImportExtensionJson = useCallback(
    (raw: unknown) => {
      try {
        const imported = extensionRegistry.importCustomPack(raw);
        setExtRevision((r) => r + 1);
        setStore((prev) =>
          updateProjectById(prev, activeProjectIdRef.current, (p) => ({
            ...p,
            enabledCapabilities: p.enabledCapabilities.includes(imported.id)
              ? p.enabledCapabilities
              : [...p.enabledCapabilities, imported.id],
            updatedAt: new Date().toISOString(),
          })),
        );
        notify(
          `已导入并启用自定义扩展包「${imported.name}」（${getAllPackBlocks(imported).length} 个积木）`,
        );
      } catch (err) {
        notify(
          `扩展包校验失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [notify],
  );

  const handleRemoveCustomPack = useCallback(
    (packId: string) => {
      const ok = extensionRegistry.removeCustomPack(packId);
      if (!ok) return;
      setExtRevision((r) => r + 1);
      setStore((prev) => ({
        ...prev,
        projects: prev.projects.map((p) => ({
          ...p,
          enabledCapabilities: p.enabledCapabilities.filter((id) => id !== packId),
        })),
      }));
      notify('已删除自定义扩展包');
    },
    [notify],
  );

  const handleUpdateSimValues = useCallback((patch: Record<string, unknown>) => {
    const pid = activeProjectIdRef.current;
    setSimStatesByProject((prev) => {
      const base = prev[pid] ?? buildDefaultSimState(activeSimPacksRef.current);
      const next = { ...base, ...patch };
      simStateRef.current = next;
      return { ...prev, [pid]: next };
    });
    runnerManager.updateActiveMockInputs(patch);
    multiHandleOrchestrator.updateMockInputs(patch);
  }, []);

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

  const handleDeviceEvent = useCallback((kind: string, value: unknown) => {
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
  }, []);

  /* ========================================================================
     Three-Tier Handle & Script Operations
     ======================================================================== */
  const handleSelectHandleAndScript = useCallback(
    (handleId: string, scriptId?: string) => {
      const curProj = getActiveProject(storeRef.current);
      const targetHandle = curProj.handles.find((h) => h.id === handleId);
      if (!targetHandle) return;
      const targetScriptId = scriptId ?? targetHandle.activeScriptId;
      if (
        handleId === activeHandleIdRef.current &&
        targetScriptId === activeScriptIdRef.current
      ) {
        return;
      }
      stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const nextStore = updateProjectById(flushed, curProj.id, (p) => ({
        ...p,
        activeHandleId: handleId,
        handles: p.handles.map((h) =>
          h.id === handleId ? { ...h, activeScriptId: targetScriptId } : h,
        ),
      }));
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
    },
    [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas],
  );

  const handleAddHandle = useCallback(
    (projectId?: string) => {
      const targetProjId = projectId ?? activeProjectIdRef.current;
      const isTargetActive = targetProjId === activeProjectIdRef.current;
      if (isTargetActive) stopIfRunning();
      const base = isTargetActive
        ? flushActiveCanvasIntoStore(storeRef.current)
        : storeRef.current;
      const nextStore = updateProjectById(base, targetProjId, (p) =>
        addHandleToProject(p),
      );
      setStore(nextStore);
      if (isTargetActive) {
        mountScriptIntoCanvas(nextStore);
      }
      const createdH = getActiveHandle(
        nextStore.projects.find((p) => p.id === targetProjId)!,
      );
      notify(`已新建独立隔离句柄：${createdH.name}`);
    },
    [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  const handleRenameHandle = useCallback(
    (projectId: string, handleId: string, nextName: string) => {
      setStore((prev) =>
        updateProjectById(prev, projectId, (p) =>
          renameHandleInProject(p, handleId, nextName),
        ),
      );
    },
    [],
  );

  const handleDuplicateHandle = useCallback(
    (projectId: string, handleId: string) => {
      const isTargetActive = projectId === activeProjectIdRef.current;
      if (isTargetActive) stopIfRunning();
      const base = isTargetActive
        ? flushActiveCanvasIntoStore(storeRef.current)
        : storeRef.current;
      const nextStore = updateProjectById(base, projectId, (p) =>
        duplicateHandleInProject(p, handleId),
      );
      setStore(nextStore);
      if (isTargetActive) mountScriptIntoCanvas(nextStore);
      notify('已复制隔离句柄');
    },
    [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  const handleDeleteHandle = useCallback(
    (projectId: string, handleId: string) => {
      const targetProj = storeRef.current.projects.find((p) => p.id === projectId);
      if (!targetProj || targetProj.handles.length <= 1) {
        notify('项目内至少需要保留 1 个运行句柄');
        return;
      }
      const isTargetActive = projectId === activeProjectIdRef.current;
      const wasActiveHandle =
        isTargetActive && handleId === activeHandleIdRef.current;
      if (wasActiveHandle) stopIfRunning();
      const base = isTargetActive
        ? flushActiveCanvasIntoStore(storeRef.current)
        : storeRef.current;
      const nextStore = updateProjectById(base, projectId, (p) =>
        deleteHandleFromProject(p, handleId),
      );
      setStore(nextStore);
      if (wasActiveHandle) mountScriptIntoCanvas(nextStore);
      notify('已删除运行句柄');
    },
    [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  const handleUpdateHandleConfig = useCallback(
    (
      projectId: string,
      handleId: string,
      patch: {
        autoStart?: boolean;
        description?: string;
        timerConfig?: ProjectTimerConfig;
        channelPoolUpdate?: {
          configKey: string;
          config: ProjectTimerConfig;
          min?: number;
          max?: number;
        };
      },
    ) => {
      const normalizedTimer = patch.timerConfig
        ? normalizeTimerConfig(patch.timerConfig)
        : undefined;
      const poolUpd = patch.channelPoolUpdate
        ? {
            configKey: patch.channelPoolUpdate.configKey,
            min: patch.channelPoolUpdate.min,
            max: patch.channelPoolUpdate.max,
            config: normalizeTimerConfig(
              patch.channelPoolUpdate.config,
              patch.channelPoolUpdate.config.count,
              patch.channelPoolUpdate.min,
              patch.channelPoolUpdate.max,
            ),
          }
        : undefined;

      setStore((prev) =>
        updateProjectById(prev, projectId, (p) =>
          updateHandleById(p, handleId, (h) => {
            let base = normalizedTimer ? setHandleTimerConfig(h, normalizedTimer) : h;
            if (poolUpd) {
              base = setHandleChannelPoolConfig(
                base,
                poolUpd.configKey,
                poolUpd.config,
                poolUpd.min,
                poolUpd.max,
              );
            }
            return {
              ...base,
              ...(patch.autoStart !== undefined ? { autoStart: patch.autoStart } : {}),
              ...(patch.description !== undefined
                ? { description: patch.description }
                : {}),
              updatedAt: new Date().toISOString(),
            };
          }),
        ),
      );
      if (
        (normalizedTimer || poolUpd) &&
        projectId === activeProjectIdRef.current &&
        handleId === activeHandleIdRef.current
      ) {
        if (normalizedTimer) {
          setActiveChannelPoolConfig(CAP_RT_TIMERS, normalizedTimer);
        }
        if (poolUpd) {
          setActiveChannelPoolConfig(
            poolUpd.configKey,
            poolUpd.config,
            poolUpd.config.count,
            poolUpd.min,
            poolUpd.max,
          );
        }
        const ws = workbenchRef.current?.getWorkspace();
        if (ws) regenerateFromWorkspace(ws, languageRef.current);
      }
    },
    [regenerateFromWorkspace],
  );

  const handleSaveInlineChannelAlias = useCallback(
    (req: ChannelAliasPromptRequest, alias: string) => {
      const proj = getActiveProject(storeRef.current);
      const hdl = getActiveHandle(proj);
      const poolSpec = extensionRegistry
        .getChannelPools(proj.enabledCapabilities, proj.localExtensions)
        .find((entry) => entry.pool.configKey === req.configKey)?.pool;
      const fallback =
        req.configKey === CAP_RT_TIMERS
          ? proj.defaultTimerCount
          : (poolSpec?.defaultCount ?? 8);
      const curCfg = getHandleChannelPoolConfig(
        hdl,
        req.configKey,
        fallback,
        poolSpec?.min,
        poolSpec?.max,
      );
      const nextAliases = { ...curCfg.aliases };
      if (alias.trim()) {
        nextAliases[String(req.channelId)] = alias.trim().slice(0, 16);
      } else {
        delete nextAliases[String(req.channelId)];
      }
      handleUpdateHandleConfig(proj.id, hdl.id, {
        channelPoolUpdate: {
          configKey: req.configKey,
          config: { ...curCfg, aliases: nextAliases },
          min: poolSpec?.min,
          max: poolSpec?.max,
        },
      });
      notify(
        alias.trim()
          ? `已将 [${hdl.name}] 的 ${req.prefix}${req.channelId} 标注为「${alias.trim()}」`
          : `已清除 [${hdl.name}] 的 ${req.prefix}${req.channelId} 别名`,
      );
    },
    [handleUpdateHandleConfig, notify],
  );

  const handleAddScriptInHandle = useCallback(
    (handleId?: string) => {
      const targetHdlId = handleId ?? activeHandleIdRef.current;
      stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const nextStore = updateProjectById(
        flushed,
        activeProjectIdRef.current,
        (p) => {
          const updatedProj = updateHandleById(p, targetHdlId, (h) =>
            addScriptToHandle(h),
          );
          return { ...updatedProj, activeHandleId: targetHdlId };
        },
      );
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
      const added = getActiveScript(getActiveHandle(getActiveProject(nextStore)));
      notify(
        `已新建脚本 ${added.name}.${backendRegistry.get(languageRef.current).extension}`,
      );
    },
    [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  const handleRenameScript = useCallback((scriptId: string, nextName: string) => {
    setStore((prev) =>
      updateProjectById(prev, activeProjectIdRef.current, (p) =>
        updateHandleById(p, activeHandleIdRef.current, (h) =>
          renameScriptInHandle(h, scriptId, nextName),
        ),
      ),
    );
  }, []);

  const handleDuplicateScript = useCallback(
    (scriptId: string) => {
      stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const nextStore = updateProjectById(
        flushed,
        activeProjectIdRef.current,
        (p) =>
          updateHandleById(p, activeHandleIdRef.current, (h) =>
            duplicateScriptInHandle(h, scriptId),
          ),
      );
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
      const copied = getActiveScript(getActiveHandle(getActiveProject(nextStore)));
      notify(`已复制脚本为 ${copied.name}`);
    },
    [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  const handleSetEntryScript = useCallback(
    (scriptId: string) => {
      setStore((prev) =>
        updateProjectById(prev, activeProjectIdRef.current, (p) =>
          updateHandleById(p, activeHandleIdRef.current, (h) => ({
            ...h,
            entryScriptId: scriptId,
            updatedAt: new Date().toISOString(),
          })),
        ),
      );
      notify('已设为当前句柄入口脚本 (★)');
    },
    [notify],
  );

  const handleDeleteScript = useCallback(
    (scriptId: string) => {
      const currentHdl = getActiveHandle(getActiveProject(storeRef.current));
      if (currentHdl.scripts.length <= 1) {
        notify('句柄内至少需要保留 1 个脚本');
        return;
      }
      stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const wasActive = scriptId === activeScriptIdRef.current;
      const nextStore = updateProjectById(
        flushed,
        activeProjectIdRef.current,
        (p) =>
          updateHandleById(p, activeHandleIdRef.current, (h) =>
            deleteScriptFromHandle(h, scriptId),
          ),
      );
      setStore(nextStore);
      if (wasActive) mountScriptIntoCanvas(nextStore);
      notify('已删除脚本');
    },
    [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  /* ========================================================================
     Multi-Project Operations
     ======================================================================== */
  const handleSelectProject = useCallback(
    (projectId: string) => {
      if (projectId === activeProjectIdRef.current) return;
      stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const nextStore: WorkspaceStoreState = {
        ...flushed,
        activeProjectId: projectId,
      };
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
      const nextProj = getActiveProject(nextStore);
      if (nextProj.handles.length > 1) setShowExplorer(true);
      notify(`已切换至项目：${nextProj.name}`);
    },
    [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  const handleCreateFromTemplate = useCallback(
    (templateId: string) => {
      stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const created = instantiateProjectFromTemplate(
        templateId,
        flushed.projects.map((p) => p.name),
      );
      const nextStore: WorkspaceStoreState = {
        version: 3,
        activeProjectId: created.id,
        projects: [created, ...flushed.projects],
      };
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
      setShowExplorer(created.handles.length > 1);
      setIsDirty(false);
      navigateTo('blocks');
      notify(`已创建项目：${created.name}`);
    },
    [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas, navigateTo, notify],
  );

  const handleCreateBlankProject = useCallback(() => {
    handleCreateFromTemplate('blank_project');
  }, [handleCreateFromTemplate]);

  const handleUpdateProjectMeta = useCallback(
    (
      projectId: string,
      patch: {
        name?: string;
        description?: string;
        language?: ScriptLanguageId;
        defaultTimerCount?: number;
      },
    ) => {
      setStore((prev) => {
        const target = prev.projects.find((p) => p.id === projectId);
        if (!target) return prev;
        const nextName = patch.name
          ? makeUniqueProjectName(
              patch.name,
              prev.projects.map((p) => p.name),
              target.name,
            )
          : target.name;
        return updateProjectById(prev, projectId, (p) => ({
          ...p,
          name: nextName,
          ...(patch.description !== undefined
            ? { description: patch.description }
            : {}),
          ...(patch.language ? { language: patch.language } : {}),
          ...(patch.defaultTimerCount
            ? { defaultTimerCount: patch.defaultTimerCount }
            : {}),
          updatedAt: new Date().toISOString(),
        }));
      });
      if (patch.language && projectId === activeProjectIdRef.current) {
        languageRef.current = patch.language;
        const ws = workbenchRef.current?.getWorkspace();
        if (ws) regenerateFromWorkspace(ws, patch.language);
      }
      notify('已更新项目配置');
    },
    [regenerateFromWorkspace, notify],
  );

  const handleRenameProject = useCallback(
    (projectId: string, nextName: string) => {
      handleUpdateProjectMeta(projectId, { name: nextName });
    },
    [handleUpdateProjectMeta],
  );

  const handleDuplicateProject = useCallback(
    (projectId: string) => {
      stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const nextStore = duplicateProjectInStore(flushed, projectId);
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
      notify(`已复制项目：${getActiveProject(nextStore).name}`);
    },
    [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  const handleDeleteProject = useCallback(
    (projectId: string) => {
      if (storeRef.current.projects.length <= 1) {
        notify('至少需要保留 1 个项目');
        return;
      }
      stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const wasActive = projectId === activeProjectIdRef.current;
      const nextStore = deleteProjectFromStore(flushed, projectId);
      setStore(nextStore);
      setSimStatesByProject((prev) => {
        if (!Object.prototype.hasOwnProperty.call(prev, projectId)) return prev;
        const copy = { ...prev };
        delete copy[projectId];
        return copy;
      });
      if (wasActive) mountScriptIntoCanvas(nextStore);
      notify('已删除项目');
    },
    [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  const handleSaveProjectFile = useCallback(
    (projectId?: string) => {
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      setStore(flushed);
      const target =
        flushed.projects.find(
          (p) => p.id === (projectId ?? activeProjectIdRef.current),
        ) ?? getActiveProject(flushed);
      const safeName = target.name.replace(/[\\/:*?"<>|]+/g, '_');
      const fileName = `${safeName || 'project'}.polyblock.json`;
      const exportPayload = buildExportableProjectJson(
        target,
        extensionRegistry.listAll(),
      );
      triggerFileDownload(
        fileName,
        JSON.stringify(exportPayload, null, 2),
        'application/json;charset=utf-8',
      );
      setIsDirty(false);
      const bundledCount = exportPayload.bundledExtensions?.length ?? 0;
      const localCount = exportPayload.localExtensions?.length ?? 0;
      const packHint =
        bundledCount > 0 || localCount > 0
          ? ` · 含 ${localCount + bundledCount} 个随工程打包外设（开箱即用）`
          : '';
      notify(
        `已保存整项目工程 ${fileName}（${target.handles.length} 句柄 · ${countProjectScripts(target)} 脚本${packHint}）`,
      );
    },
    [flushActiveCanvasIntoStore, notify],
  );

  const handleImportProject = useCallback(
    (imported: ProjectModel, absorbedPackNames: string[] = []) => {
      stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const nextStore: WorkspaceStoreState = {
        version: 3,
        activeProjectId: imported.id,
        projects: [imported, ...flushed.projects],
      };
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
      setShowExplorer(imported.handles.length > 1);
      setIsDirty(false);
      navigateTo('blocks');
      notify(
        absorbedPackNames.length > 0
          ? `已导入项目「${imported.name}」，并将随工程附带的外设快照（${absorbedPackNames.join('、')}）直接加载为项目内嵌包（优先覆盖全局、不污染全局库）`
          : `已导入项目：${imported.name}（${imported.handles.length} 句柄 · ${countProjectScripts(imported)} 脚本）`,
      );
    },
    [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas, navigateTo, notify],
  );

  const handleResetWorkspace = useCallback(() => {
    stopIfRunning();
    localStorage.removeItem(STORAGE_STORE_V6_KEY);
    const freshStore = createDefaultWorkspaceStore();
    setStore(freshStore);
    mountScriptIntoCanvas(freshStore);
    setSimStatesByProject({});
    setIsDirty(false);
    navigateTo('blocks');
    notify('已恢复 4 个渐进式内置演示项目（L1 入门 ~ L4 旗舰）');
  }, [stopIfRunning, mountScriptIntoCanvas, navigateTo, notify]);

  /* ========================================================================
     Language, Breakpoints & Single/Multi-Handle Execution
     ======================================================================== */
  const handleSelectLanguage = useCallback(
    (nextLang: ScriptLanguageId) => {
      if (runnerStatus === 'running' || runnerStatus === 'paused') return;
      handleUpdateProjectMeta(activeProjectIdRef.current, { language: nextLang });
    },
    [runnerStatus, handleUpdateProjectMeta],
  );

  const handleToggleBreakpoint = useCallback((blockId: string) => {
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
  }, []);

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
  }, [notify]);

  const handleSelectSpeed = useCallback((speed: ExecutionSpeedId) => {
    setSettings((prev) => ({ ...prev, executionSpeed: speed }));
    const delay = SPEED_DELAY_MS[speed];
    runnerManager.updateActiveStepDelay(delay);
    multiHandleOrchestrator.updateStepDelay(delay);
  }, []);

  const launchSingleHandleExecution = useCallback(
    async (startInStepMode: boolean) => {
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

      // Whole-handle execution: 1 Handle = 1 program -> ALWAYS launch from entry script (`main.lua`)
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
      setActiveHandleSharedVarInitials(handleForRun.variableInitialValues ?? {});
      setActiveHandleSharedFunctions(handleForRun.sharedFunctions ?? []);
      const handleMetasForRun = buildHandleScriptsMeta(handleForRun);
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
          setActiveScriptVarInitials(scr.variableInitialValues ?? {});
          setActiveHandleScripts(handleMetasForRun, scr.id);
          const sibCompiled = compileScriptHeadless(
            scr.workspace,
            language,
            activeChannelPoolConfigs,
          );
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
      setActiveScriptVarInitials(activeScript.variableInitialValues ?? {});
      setActiveHandleScripts(handleMetasForRun, activeScript.id);

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
        setActiveScriptVarInitials(entryScript.variableInitialValues ?? {});
        setActiveHandleScripts(handleMetasForRun, entryScript.id);
        const compiledEntry = compileScriptHeadless(
          entryScript.workspace,
          language,
          activeChannelPoolConfigs,
        );
        runCode = compiledEntry.code;
        runDebugCode = compiledEntry.debugCode;
        runIsEventDriven = compiledEntry.isEventDriven;
        // Restore active-tab script metadata for editor diagnostics
        setActiveScriptVarInitials(activeScript.variableInitialValues ?? {});
        setActiveHandleScripts(handleMetasForRun, activeScript.id);
      }

      const scriptFileLabel = `${activeHandle.name}/${entryScript.name}.${adapter.extension}`;
      const siblingNames = handleForRun.scripts
        .filter((s) => s.id !== entryScript.id)
        .map((s) => `${s.name}.${adapter.extension}`);

      // Detect any export-only (`sandboxRunnable === false`) blocks in the active handle
      const exportOnlyBlocks = new Set<string>();
      const scanWorkspaceForNonRunnable = (node: unknown) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          for (const item of node) scanWorkspaceForNonRunnable(item);
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
            scanWorkspaceForNonRunnable(v);
          }
        }
        if (obj.next) scanWorkspaceForNonRunnable(obj.next);
        if (obj.block) scanWorkspaceForNonRunnable(obj.block);
      };
      for (const s of handleForRun.scripts) {
        scanWorkspaceForNonRunnable(s.workspace);
      }

      const runner = runnerManager.getForLanguage(language);
      runnerManager.setActive(runner);

      const siblingMocks = buildHandleScriptModules(
        handleForRun,
        entryScript.id,
        language,
        activeProject.defaultTimerCount,
        activeChannelPoolConfigs,
      );
      setActiveHandleSharedVarInitials(activeHandle.variableInitialValues ?? {});
      setActiveScriptVarInitials(activeScript.variableInitialValues ?? {});
      setActiveHandleScripts(handleMetasForRun, activeScript.id);

      const modResolution = resolveProjectModules({
        enabledCapabilities: activeProject.enabledCapabilities,
        localExtensions: activeProject.localExtensions,
        handleScripts: siblingMocks.map((m, idx) => ({
          scriptId: `${activeHandle.id}-sib-${idx}`,
          scriptName: m.moduleName,
          luaSource: m.luaSource,
          pythonSource: m.pythonSource,
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
          timerCount: activeTimerConfig.count,
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
      settings.autoOpenConsoleOnRun,
      settings.executionSpeed,
      settings.timeoutMs,
      settings.timeSliceMs,
      activeTimerConfig.count,
      activeChannelPoolConfigs,
      language,
      activeHandle,
      activeScript.id,
      activeScript.name,
      activeProject.enabledCapabilities,
      activeProject.localExtensions,
      activeProject.defaultTimerCount,
      generated,
      appendLog,
      handleDeviceEvent,
      notify,
      regenerateFromWorkspace,
    ],
  );

  const launchMultiHandleSimulation = useCallback(async () => {
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
      const hdlPools = getAllHandleChannelPoolConfigs(
        hdl,
        poolsForMulti,
        proj.defaultTimerCount,
      );
      setActiveChannelPoolConfigs(hdlPools);
      setActiveHandleSharedVariables(collectHandleSharedVariableNames(hdl));
      setActiveHandleSharedVarInitials(hdl.variableInitialValues ?? {});
      setActiveHandleSharedFunctions(hdl.sharedFunctions ?? []);
      const hdlMetas = buildHandleScriptsMeta(hdl);
      for (const scr of hdl.scripts) {
        setActiveScriptVarInitials(scr.variableInitialValues ?? {});
        setActiveHandleScripts(hdlMetas, scr.id);
        const res = compileScriptHeadless(scr.workspace, proj.language, hdlPools);
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
    // Restore active handle bridge context
    setActiveChannelPoolConfigs(activeChannelPoolConfigs);
    setActiveHandleSharedVariables(collectHandleSharedVariableNames(activeHandle));
    setActiveHandleSharedVarInitials(activeHandle.variableInitialValues ?? {});
    setActiveScriptVarInitials(activeScript.variableInitialValues ?? {});
    setActiveHandleSharedFunctions(activeHandle.sharedFunctions ?? []);
    setActiveHandleScripts(buildHandleScriptsMeta(activeHandle), activeScript.id);

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
    settings.autoOpenConsoleOnRun,
    settings.timeoutMs,
    settings.timeSliceMs,
    settings.executionSpeed,
    flushActiveCanvasIntoStore,
    appendLog,
    handleDeviceEvent,
    notify,
  ]);

  const handleStop = useCallback(() => {
    if (multiHandleRunning) {
      multiHandleOrchestrator.stopAll(false);
    } else {
      runnerManager.stopActive(false);
    }
    setExecutingBlockId(null);
  }, [multiHandleRunning]);

  const handleExportActiveScript = useCallback(() => {
    const adapter = backendRegistry.get(language);
    const outFile = `${activeHandle.name}_${activeScript.name}.${adapter.extension}`;
    triggerFileDownload(
      outFile,
      generated.code + '\n',
      'text/plain;charset=utf-8',
    );
    setIsDirty(false);
    notify(`已导出干净脚本 ${outFile}`);
  }, [language, activeHandle.name, activeScript.name, generated.code, notify]);

  const handleExportHandleBundle = useCallback(() => {
    const flushed = flushActiveCanvasIntoStore(storeRef.current);
    setStore(flushed);
    const proj = getActiveProject(flushed);
    const hdl = getActiveHandle(proj);
    try {
      const bundle = buildSingleHandleTargetBundle(proj, hdl);
      triggerBinaryDownload(bundle.fileName, bundle.zipBytes, 'application/zip');
      setIsDirty(false);
      notify(
        `已打包导出当前句柄真机包 ${bundle.fileName}（共 ${bundle.entries.length} 个文件，已剥离 ${bundle.strippedSandboxMocks.length} 个沙箱假桩）`,
      );
    } catch (err) {
      if (err instanceof ModuleConflictExportError) {
        setShowConsole(true);
        setLogs(
          err.conflicts.map((c, idx) => ({
            id: `export-conflict-${Date.now()}-${idx}`,
            timestamp: formatNowTime(),
            level: 'error' as const,
            message: c.message,
          })),
        );
        notify(`存在 ${err.conflicts.length} 处同层级模块名冲突，已阻止导出（请查看日志）`);
      } else {
        notify(`打包导出失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      // Restore active handle scripts metadata in bridge
      setActiveHandleSharedVariables(collectHandleSharedVariableNames(hdl));
      setActiveHandleSharedVarInitials(hdl.variableInitialValues ?? {});
      setActiveScriptVarInitials(getActiveScript(hdl).variableInitialValues ?? {});
      setActiveHandleSharedFunctions(hdl.sharedFunctions ?? []);
      setActiveHandleScripts(buildHandleScriptsMeta(hdl), getActiveScript(hdl).id);
    }
  }, [flushActiveCanvasIntoStore, notify]);

  const handleExportProjectBundle = useCallback(() => {
    const flushed = flushActiveCanvasIntoStore(storeRef.current);
    setStore(flushed);
    const proj = getActiveProject(flushed);
    const hdl = getActiveHandle(proj);
    try {
      const bundle = buildProjectTargetBundle(proj);
      triggerBinaryDownload(bundle.fileName, bundle.zipBytes, 'application/zip');
      setIsDirty(false);
      notify(
        `已打包导出整工程真机包 ${bundle.fileName}（${proj.handles.length} 句柄 · 共 ${bundle.entries.length} 个文件，已剥离沙箱假桩）`,
      );
    } catch (err) {
      if (err instanceof ModuleConflictExportError) {
        setShowConsole(true);
        setLogs(
          err.conflicts.map((c, idx) => ({
            id: `export-proj-conflict-${Date.now()}-${idx}`,
            timestamp: formatNowTime(),
            level: 'error' as const,
            message: c.message,
          })),
        );
        notify(`存在 ${err.conflicts.length} 处同层级模块名冲突，已阻止导出（请查看日志）`);
      } else {
        notify(`整工程打包导出失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setActiveHandleSharedVariables(collectHandleSharedVariableNames(hdl));
      setActiveHandleSharedVarInitials(hdl.variableInitialValues ?? {});
      setActiveScriptVarInitials(getActiveScript(hdl).variableInitialValues ?? {});
      setActiveHandleSharedFunctions(hdl.sharedFunctions ?? []);
      setActiveHandleScripts(buildHandleScriptsMeta(hdl), getActiveScript(hdl).id);
    }
  }, [flushActiveCanvasIntoStore, notify]);

  const handleCopyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(generated.code);
      notify(`已复制 ${activeScript.name}.${activeBackend.extension} 到剪贴板`);
    } catch {
      notify('复制失败，请手动选中代码复制');
    }
  }, [generated.code, activeScript.name, activeBackend.extension, notify]);

  const handleFocusBlock = useCallback((blockId: string) => {
    workbenchRef.current?.focusBlock(blockId);
  }, []);

  const handleJumpToSharedFunction = useCallback(
    (scriptId: string, blockId?: string) => {
      setViewingSharedModule(false);
      if (scriptId !== activeScriptIdRef.current) {
        handleSelectHandleAndScript(activeHandleIdRef.current, scriptId);
      }
      if (blockId) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            workbenchRef.current?.focusBlock(blockId);
          });
        });
      }
    },
    [handleSelectHandleAndScript],
  );

  const initialHandle = getActiveHandle(getActiveProject(initialStoreRef.current));
  const initialScriptWorkspace = syncHandleVariablesIntoWorkspaceJson(
    getActiveScript(initialHandle).workspace,
    collectHandleSharedVariableNames(initialHandle),
  );
  const activeHandleSharedVarNames = useMemo(
    () => collectHandleSharedVariableNames(activeHandle),
    [activeHandle, blocklyDialogReq],
  );
  const currentScriptVarNames = useMemo(() => {
    const fromStore = collectScriptVariableNames(activeScript.workspace);
    const liveVars =
      workbenchRef.current
        ?.getWorkspace()
        ?.getVariableMap()
        .getAllVariables()
        .map((v) => v.getName()) ?? [];
    return Array.from(new Set([...fromStore, ...liveVars]));
  }, [activeScript.workspace, blocklyDialogReq]);
  const allHandleVarNames = useMemo(
    () =>
      Array.from(
        new Set([
          ...collectAllVariableNamesInHandle(activeHandle),
          ...currentScriptVarNames,
        ]),
      ),
    [activeHandle, currentScriptVarNames],
  );
  const currentScriptFunctionNames = useMemo(() => {
    const names = new Set<string>();
    const activeMeta = buildHandleScriptsMeta(activeHandle).find(
      (m) => m.id === activeScript.id,
    );
    for (const fn of activeMeta?.declaredFunctions ?? []) {
      names.add(fn.name);
    }
    const liveWs = workbenchRef.current?.getWorkspace();
    if (liveWs) {
      const [noRet, withRet] = Blockly.Procedures.allProcedures(liveWs);
      for (const [name] of [...noRet, ...withRet]) names.add(name);
    }
    return Array.from(names);
  }, [activeHandle, activeScript.id, blocklyDialogReq]);
  const allHandleFunctionNames = useMemo(() => {
    const names = new Set<string>(activeHandle.sharedFunctions ?? []);
    for (const meta of buildHandleScriptsMeta(activeHandle)) {
      for (const fn of meta.declaredFunctions ?? []) {
        names.add(fn.name);
      }
    }
    for (const n of currentScriptFunctionNames) names.add(n);
    return Array.from(names);
  }, [activeHandle, currentScriptFunctionNames]);

  const settingsModalProject = settingsModal
    ? store.projects.find((p) => p.id === settingsModal.projectId) ?? null
    : null;

  return (
    <div className="app-shell">
      <TopBar
        projects={store.projects}
        activeProject={activeProject}
        activeHandleName={activeHandle.name}
        activeScriptName={activeScript.name}
        isDirty={isDirty}
        activePage={activePage}
        theme={settings.theme}
        runnerStatus={runnerStatus}
        multiHandleRunning={multiHandleRunning}
        executionSpeed={settings.executionSpeed}
        showCode={showCode}
        showConsole={showConsole}
        onSelectProject={handleSelectProject}
        onCreateBlankProject={handleCreateBlankProject}
        onRenameCurrentProject={(name) =>
          handleRenameProject(activeProject.id, name)
        }
        onOpenProjectSettings={() =>
          setSettingsModal({
            projectId: activeProject.id,
            initialTab: 'general',
            initialHandleId: activeHandle.id,
          })
        }
        onSaveProjectFile={() => handleSaveProjectFile(activeProject.id)}
        onOpenProjectsPage={() => navigateTo('projects')}
        onSelectLanguage={handleSelectLanguage}
        onSelectSpeed={handleSelectSpeed}
        onRun={() => launchSingleHandleExecution(false)}
        onRunAllHandles={launchMultiHandleSimulation}
        onStartStepMode={() => launchSingleHandleExecution(true)}
        onResume={() => runnerManager.resumeActive()}
        onStepNext={() => runnerManager.stepNextActive()}
        onPause={() => runnerManager.pauseActive()}
        onStop={handleStop}
        onExportActiveScript={handleExportActiveScript}
        onExportHandleBundle={handleExportHandleBundle}
        onExportProjectBundle={handleExportProjectBundle}
        onToggleCode={() => setShowCode((v) => !v)}
        onToggleConsole={() => setShowConsole((v) => !v)}
        onToggleTheme={() =>
          setSettings((prev) => ({
            ...prev,
            theme: prev.theme === 'light' ? 'dark' : 'light',
          }))
        }
      />

      <div className="app-body">
        <ActivityRail activePage={activePage} onSelectPage={navigateTo} />

        <main className="workspace-host">
          <div
            className={`workbench-center-col ${
              activePage !== 'blocks' ? 'hidden-pane' : ''
            }`}
          >
            <div className="workbench-split-row">
              {showExplorer && (
                <ProjectExplorer
                  project={activeProject}
                  activeHandleId={activeHandle.id}
                  activeScriptId={activeScript.id}
                  language={language}
                  extension={activeBackend.extension}
                  viewingSharedModule={viewingSharedModule}
                  hasTimersCapability={hasTimersCapability}
                  defaultTimerCount={activeProject.defaultTimerCount}
                  disabled={runnerStatus === 'running' || runnerStatus === 'paused'}
                  onSelectHandleScript={(hdlId, scrId) => {
                    setViewingSharedModule(false);
                    handleSelectHandleAndScript(hdlId, scrId);
                  }}
                  onSelectHandleSharedModule={(hdlId) => {
                    if (hdlId !== activeHandle.id) {
                      handleSelectHandleAndScript(hdlId);
                    }
                    setViewingSharedModule(true);
                  }}
                  onAddHandle={() => handleAddHandle(activeProject.id)}
                  onAddScriptInHandle={(hdlId) => handleAddScriptInHandle(hdlId)}
                  onOpenHandleSettings={(hdlId) =>
                    setSettingsModal({
                      projectId: activeProject.id,
                      initialTab: 'handles',
                      initialHandleId: hdlId,
                    })
                  }
                  onClose={() => setShowExplorer(false)}
                />
              )}

              <div className="blocks-main-col">
                <ScriptTabBar
                  handles={activeProject.handles}
                  activeHandle={activeHandle}
                  scripts={activeHandle.scripts}
                  activeScriptId={activeScript.id}
                  entryScriptId={activeHandle.entryScriptId}
                  extension={activeBackend.extension}
                  hasTimersCapability={hasTimersCapability}
                  defaultTimerCount={activeProject.defaultTimerCount}
                  showExplorer={showExplorer}
                  disabled={runnerStatus === 'running' || runnerStatus === 'paused'}
                  sharedModuleTab={
                    activeSharedModule
                      ? {
                          fileName: activeSharedModule.fileName,
                          itemCount:
                            activeSharedModule.variables.length +
                            activeSharedModule.functions.length,
                          varCount: activeSharedModule.variables.length,
                          fnCount: activeSharedModule.functions.length,
                        }
                      : null
                  }
                  viewingSharedModule={viewingSharedModule}
                  onSelectSharedModule={() => setViewingSharedModule(true)}
                  onToggleExplorer={() => setShowExplorer((v) => !v)}
                  onSelectHandle={(hdlId) => {
                    setViewingSharedModule(false);
                    handleSelectHandleAndScript(hdlId);
                  }}
                  onAddHandle={() => handleAddHandle(activeProject.id)}
                  onOpenHandleSettings={(hdlId) =>
                    setSettingsModal({
                      projectId: activeProject.id,
                      initialTab: 'handles',
                      initialHandleId: hdlId,
                    })
                  }
                  onSelectScript={(scrId) => {
                    setViewingSharedModule(false);
                    handleSelectHandleAndScript(activeHandle.id, scrId);
                  }}
                  onAddScript={() => handleAddScriptInHandle(activeHandle.id)}
                  onRenameScript={handleRenameScript}
                  onDuplicateScript={handleDuplicateScript}
                  onSetEntryScript={handleSetEntryScript}
                  onDeleteScript={handleDeleteScript}
                />

                {viewingSharedModule && activeSharedModule && (
                  <SharedVarsView
                    handleName={activeHandle.name}
                    handleColor={activeHandle.color}
                    language={language}
                    fileName={activeSharedModule.fileName}
                    moduleName={activeSharedModule.moduleName}
                    source={activeSharedModule.source}
                    variables={activeSharedModule.variables}
                    functions={activeSharedModule.functions}
                    disabled={runnerStatus === 'running' || runnerStatus === 'paused'}
                    onCreateSharedVariable={() =>
                      handleRequestCreateVariable('shared')
                    }
                    onCreateSharedFunction={() =>
                      handleRequestCreateFunction('shared')
                    }
                    onUpdateVarInitialValue={(varName, nextInit) =>
                      handleHandleVariableEvent({
                        kind: 'set-initial',
                        name: varName,
                        scope: 'shared',
                        initialValue: nextInit,
                      })
                    }
                    onJumpToFunction={handleJumpToSharedFunction}
                    onCopySource={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          activeSharedModule.source,
                        );
                        notify(`已复制 ${activeSharedModule.fileName} 到剪贴板`);
                      } catch {
                        notify('复制失败，请手动选中代码复制');
                      }
                    }}
                    onBackToCanvas={() => setViewingSharedModule(false)}
                  />
                )}

                <div
                  className={
                    viewingSharedModule && activeSharedModule
                      ? 'hidden-pane'
                      : 'blocks-canvas-host'
                  }
                >
                  <BlocklyWorkbench
                    ref={workbenchRef}
                    theme={settings.theme}
                    initialWorkspace={initialScriptWorkspace}
                    visible={
                      activePage === 'blocks' &&
                      !(viewingSharedModule && activeSharedModule)
                    }
                    executingBlockId={executingBlockId}
                    isPaused={runnerStatus === 'paused'}
                    breakpoints={breakpoints}
                    enabledCapabilities={activeProject.enabledCapabilities}
                    extraCategories={extraCategories}
                    channelPoolConfigs={activeChannelPoolConfigs}
                    onWorkspaceChange={handleWorkspaceChange}
                    onHandleVariableEvent={handleHandleVariableEvent}
                    onRequestCreateVariable={handleRequestCreateVariable}
                    onRequestCreateFunction={handleRequestCreateFunction}
                    onToggleSharedFunction={handleToggleSharedFunction}
                    onHandleFunctionEvent={handleHandleFunctionEvent}
                    onSelectBlock={setSelectedBlockId}
                    onToggleBreakpoint={handleToggleBreakpoint}
                    onEditChannelAlias={(req) => setAliasModalReq(req)}
                    onOpenHandleTimerSettings={() =>
                      setSettingsModal({
                        projectId: activeProject.id,
                        initialTab: 'handles',
                        initialHandleId: activeHandle.id,
                      })
                    }
                    onOpenExtensionsPage={() => navigateTo('extensions')}
                  />
                </div>
              </div>

              {showCode && (
                <CodeInspector
                  language={language}
                  scriptName={activeScript.name}
                  generated={generated}
                  selectedBlockId={selectedBlockId}
                  executingBlockId={executingBlockId}
                  isPaused={runnerStatus === 'paused'}
                  runnerStatus={runnerStatus}
                  multiHandleRunning={multiHandleRunning}
                  breakpoints={breakpoints}
                  variables={liveVariables}
                  errorLine={errorLine}
                  enabledCapabilities={activeProject.enabledCapabilities}
                  defaultTimerCount={activeProject.defaultTimerCount}
                  simPacks={activeSimPacks}
                  simState={simState}
                  projectHandles={activeProject.handles}
                  activeHandle={activeHandle}
                  handleTelemetries={handleTelemetries}
                  onUpdateSimValues={handleUpdateSimValues}
                  onEmitWidgetEvent={(ename, args) => handleEmitSimEvent(ename, args)}
                  onResetSimPack={handleResetSimPack}
                  onOpenHandleTimerSettings={(hdlId) =>
                    setSettingsModal({
                      projectId: activeProject.id,
                      initialTab: 'handles',
                      initialHandleId: hdlId,
                    })
                  }
                  onSelectBlockFromLine={handleFocusBlock}
                  onToggleBreakpoint={handleToggleBreakpoint}
                  onClearBreakpoints={handleClearBreakpoints}
                  onCopyCode={handleCopyCode}
                />
              )}
            </div>

            {showConsole && (
              <LogConsole
                logs={logs}
                lastDurationMs={lastDurationMs}
                onClear={() => setLogs([])}
                onCollapse={() => setShowConsole(false)}
                onJumpToBlock={handleFocusBlock}
              />
            )}
          </div>

          {activePage === 'projects' && (
            <ProjectsPage
              projects={store.projects}
              activeProjectId={activeProject.id}
              onSelectProject={handleSelectProject}
              onCreateBlankProject={handleCreateBlankProject}
              onCreateFromTemplate={handleCreateFromTemplate}
              onRenameProject={handleRenameProject}
              onDuplicateProject={handleDuplicateProject}
              onDeleteProject={handleDeleteProject}
              onSaveProjectFile={handleSaveProjectFile}
              onImportProject={handleImportProject}
              onOpenProjectSettings={(pid) =>
                setSettingsModal({ projectId: pid, initialTab: 'general' })
              }
              onReturnToBlocks={() => navigateTo('blocks')}
              onNotify={notify}
            />
          )}

          {activePage === 'devices' && (
            <DevicesPage
              onReturnToBlocks={() => navigateTo('blocks')}
              onNotify={notify}
            />
          )}

          {activePage === 'extensions' && (
            <ExtensionsPage
              activeProjectName={activeProject.name}
              activeProjectLanguage={activeProject.language}
              activeProfileId={activeProject.targetProfileId}
              allPacks={allExtensionPacks}
              allTargetProfiles={allTargetProfiles}
              enabledCapabilityIds={activeProject.enabledCapabilities}
              onToggleCapability={(capId) =>
                handleToggleCapabilityForProject(activeProject.id, capId)
              }
              onApplyTargetProfile={(profileId) =>
                handleApplyTargetProfile(activeProject.id, profileId)
              }
              onImportExtensionJson={handleImportExtensionJson}
              onOpenScriptLibImportModal={() =>
                setScriptLibModal({ targetScope: 'global' })
              }
              onAttachLibsToGlobalPack={handleAttachLibsToGlobalPack}
              onRemoveCustomPack={handleRemoveCustomPack}
              onImportBoardProfileJson={handleImportBoardProfileJson}
              onRemoveCustomProfile={handleRemoveCustomProfile}
              onReturnToBlocks={() => navigateTo('blocks')}
              onNotify={notify}
            />
          )}

          {activePage === 'settings' && (
            <SettingsPage
              settings={settings}
              onUpdateSettings={(patch) => {
                setSettings((prev) => ({ ...prev, ...patch }));
                if (typeof patch.timeSliceMs === 'number') {
                  runnerManager.updateActiveTimeSlice(patch.timeSliceMs);
                  multiHandleOrchestrator.updateTimeSlice(patch.timeSliceMs);
                }
              }}
              onResetWorkspace={handleResetWorkspace}
              onReturnToBlocks={() => navigateTo('blocks')}
            />
          )}
        </main>
      </div>

      <StatusBar
        projectName={activeProject.name}
        handleCount={activeProject.handles.length}
        activeHandleName={activeHandle.name}
        activeScriptName={activeScript.name}
        language={language}
        runnerStatus={runnerStatus}
        multiHandleRunning={multiHandleRunning}
        blockCount={generated.blockCount}
        diagnosticCount={generated.diagnostics.length}
        diagnosticErrorCount={
          generated.diagnostics.filter((d) => d.severity === 'error').length
        }
        breakpointCount={breakpoints.length}
        selectedBlockId={selectedBlockId}
      />

      {settingsModalProject && settingsModal && (
        <ProjectSettingsModal
          project={settingsModalProject}
          initialTab={settingsModal.initialTab}
          initialHandleId={settingsModal.initialHandleId}
          allExtensionPacks={allExtensionPacks}
          allTargetProfiles={allTargetProfiles}
          disableLanguageSwitch={
            settingsModalProject.id === activeProject.id &&
            (runnerStatus === 'running' || runnerStatus === 'paused')
          }
          onClose={() => setSettingsModal(null)}
          onUpdateProjectMeta={handleUpdateProjectMeta}
          onApplyTargetProfile={handleApplyTargetProfile}
          onImportBoardProfileJson={handleImportBoardProfileJson}
          onAddHandle={handleAddHandle}
          onRenameHandle={handleRenameHandle}
          onDuplicateHandle={handleDuplicateHandle}
          onDeleteHandle={handleDeleteHandle}
          onUpdateHandleConfig={handleUpdateHandleConfig}
          onToggleCapabilityForProject={handleToggleCapabilityForProject}
          onImportLocalExtensionJson={handleImportProjectLocalExtension}
          onOpenScriptLibImportModal={(pid) =>
            setScriptLibModal({ targetScope: 'project', projectId: pid })
          }
          onAttachLibsToLocalPack={handleAttachLibsToProjectPack}
          onRemoveLocalExtension={handleRemoveProjectLocalExtension}
          onPromoteLocalExtensionToGlobal={handlePromoteLocalExtensionToGlobal}
          onOpenExtensionsPage={() => navigateTo('extensions')}
          onNotify={notify}
        />
      )}

      {scriptLibModal && (
        <ScriptLibImportModal
          targetScope={scriptLibModal.targetScope}
          projectName={
            (scriptLibModal.projectId
              ? store.projects.find((p) => p.id === scriptLibModal.projectId)?.name
              : activeProject.name) ?? activeProject.name
          }
          defaultLanguage={
            (scriptLibModal.projectId
              ? store.projects.find((p) => p.id === scriptLibModal.projectId)?.language
              : activeProject.language) ?? activeProject.language
          }
          onConfirmPack={(pack) => {
            if (scriptLibModal.targetScope === 'project') {
              handleImportProjectLocalExtension(
                scriptLibModal.projectId ?? activeProject.id,
                pack,
              );
            } else {
              handleImportExtensionJson(pack);
            }
          }}
          onClose={() => setScriptLibModal(null)}
        />
      )}

      {aliasModalReq !== null && (
        <TimerAliasModal
          handleName={activeHandle.name}
          handleColor={activeHandle.color}
          timerId={aliasModalReq.channelId}
          prefix={aliasModalReq.prefix}
          poolLabel={aliasModalReq.label}
          currentAlias={
            activeChannelPoolConfigs[aliasModalReq.configKey]?.aliases[
              String(aliasModalReq.channelId)
            ] ?? ''
          }
          onSave={(alias) => handleSaveInlineChannelAlias(aliasModalReq, alias)}
          onClose={() => setAliasModalReq(null)}
        />
      )}

      {blocklyDialogReq !== null && (
        <BlocklyDialogModal
          request={blocklyDialogReq}
          handleName={activeHandle.name}
          handleColor={activeHandle.color}
          activeScriptLabel={`${activeScript.name}.${activeBackend.extension}`}
          handleSharedVars={activeHandleSharedVarNames}
          currentScriptVars={currentScriptVarNames}
          allHandleVars={allHandleVarNames}
          handleSharedFunctions={activeHandle.sharedFunctions ?? []}
          currentScriptFunctions={currentScriptFunctionNames}
          allHandleFunctions={allHandleFunctionNames}
          onClose={() => setBlocklyDialogReq(null)}
        />
      )}

      <div className={`toast ${toastMsg ? 'show' : ''}`} role="status">
        {toastMsg}
      </div>
    </div>
  );
}
