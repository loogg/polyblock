import type * as Blockly from 'blockly';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityRail } from './components/ActivityRail';
import {
  BlocklyWorkbench,
  type BlocklyWorkbenchHandle,
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
import { ScriptTabBar } from './components/ScriptTabBar';
import { StatusBar } from './components/StatusBar';
import { TimerAliasModal } from './components/TimerAliasModal';
import { TopBar } from './components/TopBar';
import { backendRegistry } from './core/backends/registry';
import type { GeneratedCodeResult } from './core/backends/types';
import {
  normalizeTimerConfig,
  setActiveChannelPoolConfig,
  setActiveChannelPoolConfigs,
  setActiveProjectCapabilities,
  type ChannelAliasPromptRequest,
} from './core/blocks/timerConfigBridge';
import {
  CAP_RT_TIMERS,
  hasCapability,
  targetProfileRegistry,
} from './core/capabilities/registry';
import { extensionRegistry } from './core/extensions/registry';
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
  STORAGE_STORE_V2_KEY,
  STORAGE_STORE_V3_KEY,
  updateHandleById,
  updateProjectById,
} from './core/projects/store';
import { runnerManager } from './core/runners/manager';
import {
  buildHandleScriptModules,
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
  const [aliasModalReq, setAliasModalReq] =
    useState<ChannelAliasPromptRequest | null>(null);

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
  const activeChannelPoolPacks = useMemo(
    () =>
      extensionRegistry.getChannelPoolPacks(
        activeProject.enabledCapabilities,
        activeProject.localExtensions,
      ),
    [activeProject.enabledCapabilities, activeProject.localExtensions, extRevision],
  );
  const activeChannelPoolConfigs = useMemo(
    () =>
      getAllHandleChannelPoolConfigs(
        activeHandle,
        activeChannelPoolPacks,
        activeProject.defaultTimerCount,
      ),
    [activeHandle, activeChannelPoolPacks, activeProject.defaultTimerCount],
  );
  const activeTimerConfig =
    activeChannelPoolConfigs[CAP_RT_TIMERS] ??
    getHandleTimerConfig(activeHandle, activeProject.defaultTimerCount);
  const hasTimersCapability = hasCapability(
    activeProject.enabledCapabilities,
    CAP_RT_TIMERS,
  );
  setActiveChannelPoolConfigs(activeChannelPoolConfigs);
  setActiveProjectCapabilities(activeProject.enabledCapabilities);
  extensionRegistry.setActiveProjectLocalPacks(activeProject.localExtensions ?? []);

  const language = activeProject.language;
  const breakpoints = activeScript.breakpoints;
  const activeBackend = backendRegistry.get(language);

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
      extensionRegistry
        .getEnabledPacks(
          activeProject.enabledCapabilities,
          activeProject.localExtensions,
        )
        .filter((p) => (p.simWidgets?.length ?? 0) > 0),
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
      const nextPoolPacks = extensionRegistry.getChannelPoolPacks(
        nextProj.enabledCapabilities,
        nextProj.localExtensions,
      );
      setActiveChannelPoolConfigs(
        getAllHandleChannelPoolConfigs(
          nextHandle,
          nextPoolPacks,
          nextProj.defaultTimerCount,
        ),
      );
      setActiveProjectCapabilities(nextProj.enabledCapabilities);

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

      workbenchRef.current?.loadWorkspaceJson(nextScript.workspace);
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
          updateHandleById(proj, hdlId, (hdl) => ({
            ...hdl,
            scripts: hdl.scripts.map((s) => {
              if (s.id !== scrId) return s;
              const pruned = s.breakpoints.filter((bid) =>
                Boolean(ws.getBlockById(bid)),
              );
              if (pruned.length !== s.breakpoints.length) {
                runnerManager.updateActiveBreakpoints(pruned);
              }
              return {
                ...s,
                workspace: snapshot,
                breakpoints: pruned,
                updatedAt: now,
              };
            }),
            updatedAt: now,
          })),
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
      const extPack = extensionRegistry.resolvePack(capId, curProj.localExtensions);
      const displayName = extPack?.name ?? capId;

      const exists = curProj.enabledCapabilities.includes(capId);
      const nextCaps = exists
        ? curProj.enabledCapabilities.filter((id) => id !== capId)
        : [...curProj.enabledCapabilities, capId];

      setStore((prev) =>
        updateProjectById(prev, projectId, (p) => ({
          ...p,
          enabledCapabilities: nextCaps,
          updatedAt: new Date().toISOString(),
        })),
      );

      if (projectId === activeProjectIdRef.current) {
        setActiveProjectCapabilities(nextCaps);
        const ws = workbenchRef.current?.getWorkspace();
        if (ws) regenerateFromWorkspace(ws, languageRef.current);
      }

      notify(
        exists
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
        : curProj.enabledCapabilities.filter((id) => id !== packId);

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
          `已导入并启用自定义扩展包「${imported.name}」（${imported.blocks.length} 个积木）`,
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
      const poolPack = extensionRegistry
        .getChannelPoolPacks(proj.enabledCapabilities, proj.localExtensions)
        .find((p) => p.handleChannelPool?.configKey === req.configKey);
      const poolSpec = poolPack?.handleChannelPool;
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
    localStorage.removeItem(STORAGE_STORE_V3_KEY);
    localStorage.removeItem(STORAGE_STORE_V2_KEY);
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
      runnerManager.updateActiveBreakpoints(nextBps);
      return updateProjectById(prev, proj.id, (p) =>
        updateHandleById(p, hdl.id, (h) => ({
          ...h,
          scripts: h.scripts.map((s) =>
            s.id === scr.id ? { ...s, breakpoints: nextBps } : s,
          ),
        })),
      );
    });
  }, []);

  const handleClearBreakpoints = useCallback(() => {
    setStore((prev) =>
      updateProjectById(prev, activeProjectIdRef.current, (p) =>
        updateHandleById(p, activeHandleIdRef.current, (h) => ({
          ...h,
          scripts: h.scripts.map((s) =>
            s.id === activeScriptIdRef.current ? { ...s, breakpoints: [] } : s,
          ),
        })),
      ),
    );
    runnerManager.updateActiveBreakpoints([]);
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
      const scriptFileLabel = `${activeHandle.name}/${activeScript.name}.${adapter.extension}`;
      setGenerated(latest);
      setErrorLine(null);
      setExecutingBlockId(null);
      setLiveVariables({});
      setHandleTelemetries({});
      setMultiHandleRunning(false);

      const runner = runnerManager.getForLanguage(language);
      runnerManager.setActive(runner);

      const extensionMocks = extensionRegistry.getSandboxMocks(
        activeProject.enabledCapabilities,
        activeProject.localExtensions,
      );
      const siblingMocks = buildHandleScriptModules(
        activeHandle,
        activeScript.id,
        language,
        activeProject.sharedModules,
        activeProject.defaultTimerCount,
      );

      const speedDelay = SPEED_DELAY_MS[settings.executionSpeed];
      setLogs([
        {
          id: `start-${Date.now()}`,
          timestamp: formatNowTime(),
          level: 'system',
          message: startInStepMode
            ? `启动单步调试 [${scriptFileLabel}] · ${runner.shortLabel}`
            : `运行 [${scriptFileLabel}] · ${runner.shortLabel}（${
                latest.isEventDriven ? '事件循环 · ' : ''
              }步进 ${speedDelay}ms${
                breakpointsRef.current.length > 0
                  ? ` · ${breakpointsRef.current.length} 断点`
                  : ''
              }）...`,
        },
      ]);

      const result = await runner.run(
        {
          language,
          code: latest.code,
          debugCode: latest.debugCode || latest.code,
          timeoutMs: settings.timeoutMs,
          timeSliceMs: settings.timeSliceMs,
          breakpoints: breakpointsRef.current,
          stepDelayMs: speedDelay,
          startInStepMode,
          timerCount: activeTimerConfig.count,
          mockModules: [...extensionMocks, ...siblingMocks],
          mockInputs: simStateRef.current,
        },
        {
          onClear: () => setLogs([]),
          onLog: (level, message, line) => {
            const mappedBlock = line ? latest.lineToBlock[line] : undefined;
            appendLog(level, message, line, mappedBlock);
          },
          onStep: (blockId, vars) => {
            setExecutingBlockId(blockId);
            setLiveVariables(vars);
          },
          onPaused: (blockId, vars, reason) => {
            setExecutingBlockId(blockId);
            setLiveVariables(vars);
            const range = latest.sourceMap[blockId];
            if (reason === 'breakpoint') {
              appendLog(
                'warn',
                `[${scriptFileLabel}] 命中断点并暂停${
                  range ? `（第 ${range.startLine} 行）` : ''
                }，可查看变量或点击「继续 / 单步」。`,
                range?.startLine,
                blockId,
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
      language,
      activeHandle,
      activeScript.id,
      activeScript.name,
      activeProject.enabledCapabilities,
      activeProject.localExtensions,
      activeProject.defaultTimerCount,
      activeProject.sharedModules,
      generated,
      appendLog,
      handleDeviceEvent,
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

    setErrorLine(null);
    setExecutingBlockId(null);
    setLiveVariables({});
    setHandleTelemetries({});
    setMultiHandleRunning(true);

    const extensionMocks = extensionRegistry.getSandboxMocks(
      proj.enabledCapabilities,
      proj.localExtensions,
    );

    setLogs([
      {
        id: `mstart-${Date.now()}`,
        timestamp: formatNowTime(),
        level: 'system',
        message: `启动多句柄并发仿真：${runList.map((h) => h.name).join(' + ')}（共 ${runList.length} 个独立 WASM Worker，定时器与全局变量完全隔离）...`,
      },
    ]);

    const t0 = performance.now();
    await multiHandleOrchestrator.runAllHandles(
      {
        project: proj,
        timeoutMs: settings.timeoutMs,
        timeSliceMs: settings.timeSliceMs,
        stepDelayMs: SPEED_DELAY_MS[settings.executionSpeed],
        extensionMocks,
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

  const initialScriptWorkspace = getActiveScript(
    getActiveHandle(getActiveProject(initialStoreRef.current)),
  ).workspace;

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
                  extension={activeBackend.extension}
                  hasTimersCapability={hasTimersCapability}
                  defaultTimerCount={activeProject.defaultTimerCount}
                  disabled={runnerStatus === 'running' || runnerStatus === 'paused'}
                  onSelectHandleScript={(hdlId, scrId) =>
                    handleSelectHandleAndScript(hdlId, scrId)
                  }
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
                  onToggleExplorer={() => setShowExplorer((v) => !v)}
                  onSelectHandle={(hdlId) => handleSelectHandleAndScript(hdlId)}
                  onAddHandle={() => handleAddHandle(activeProject.id)}
                  onOpenHandleSettings={(hdlId) =>
                    setSettingsModal({
                      projectId: activeProject.id,
                      initialTab: 'handles',
                      initialHandleId: hdlId,
                    })
                  }
                  onSelectScript={(scrId) =>
                    handleSelectHandleAndScript(activeHandle.id, scrId)
                  }
                  onAddScript={() => handleAddScriptInHandle(activeHandle.id)}
                  onRenameScript={handleRenameScript}
                  onDuplicateScript={handleDuplicateScript}
                  onSetEntryScript={handleSetEntryScript}
                  onDeleteScript={handleDeleteScript}
                />

                <BlocklyWorkbench
                  ref={workbenchRef}
                  theme={settings.theme}
                  initialWorkspace={initialScriptWorkspace}
                  visible={activePage === 'blocks'}
                  executingBlockId={executingBlockId}
                  isPaused={runnerStatus === 'paused'}
                  breakpoints={breakpoints}
                  enabledCapabilities={activeProject.enabledCapabilities}
                  extraCategories={extraCategories}
                  channelPoolConfigs={activeChannelPoolConfigs}
                  onWorkspaceChange={handleWorkspaceChange}
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
          onRemoveLocalExtension={handleRemoveProjectLocalExtension}
          onPromoteLocalExtensionToGlobal={handlePromoteLocalExtensionToGlobal}
          onOpenExtensionsPage={() => navigateTo('extensions')}
          onNotify={notify}
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

      <div className={`toast ${toastMsg ? 'show' : ''}`} role="status">
        {toastMsg}
      </div>
    </div>
  );
}
