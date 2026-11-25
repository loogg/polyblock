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
import { ScriptTabBar } from './components/ScriptTabBar';
import { StatusBar } from './components/StatusBar';
import { TopBar } from './components/TopBar';
import { backendRegistry } from './core/backends/registry';
import type { GeneratedCodeResult } from './core/backends/types';
import {
  normalizeTimerConfig,
  setActiveTimerConfig,
} from './core/blocks/timerConfigBridge';
import { extensionRegistry } from './core/extensions/registry';
import type {
  VirtualBoardInputs,
  VirtualBoardState,
} from './core/extensions/types';
import {
  addScriptToProject,
  deleteProjectFromStore,
  deleteScriptFromProject,
  duplicateProjectInStore,
  duplicateScriptInProject,
  getActiveProject,
  getActiveScript,
  getProjectTimerConfig,
  instantiateProjectFromTemplate,
  loadWorkspaceStore,
  makeUniqueProjectName,
  renameScriptInProject,
  saveWorkspaceStore,
  STORAGE_STORE_V2_KEY,
  updateProjectById,
} from './core/projects/store';
import { runnerManager } from './core/runners/manager';
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
  WorkspaceStoreState,
} from './types/project';

const STORAGE_SETTINGS_KEY = 'polyblock.settings.v1';

const SPEED_DELAY_MS: Record<ExecutionSpeedId, number> = {
  fast: 0,
  normal: 180,
  slow: 450,
};

const DEFAULT_VIRTUAL_BOARD: VirtualBoardState = {
  led: false,
  rgb: '#1e293b',
  oledLines: ['PolyBlock OLED', '等待脚本输出...'],
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
  // Ensure built-in & saved custom extension packs are registered before Blockly loads
  extensionRegistry.ensureInitialized();

  const initialStoreRef = useRef<WorkspaceStoreState>(loadWorkspaceStore());
  const workbenchRef = useRef<BlocklyWorkbenchHandle | null>(null);

  const [store, setStore] = useState<WorkspaceStoreState>(initialStoreRef.current);
  const [settings, setSettings] = useState<AppSettings>(loadSavedSettings);
  const [activePage, setActivePage] = useState<PageId>(readPageFromHash);
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [extRevision, setExtRevision] = useState<number>(0);

  const [showCode, setShowCode] = useState<boolean>(true);
  const [showConsole, setShowConsole] = useState<boolean>(true);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [executingBlockId, setExecutingBlockId] = useState<string | null>(null);
  const [liveVariables, setLiveVariables] = useState<Record<string, string>>({});
  const [errorLine, setErrorLine] = useState<number | null>(null);

  const [virtualBoard, setVirtualBoard] = useState<VirtualBoardState>(
    DEFAULT_VIRTUAL_BOARD,
  );
  const [mockInputs, setMockInputs] = useState<VirtualBoardInputs>({
    temp: 28,
    btnA: false,
    btnB: false,
  });

  const [runnerStatus, setRunnerStatus] = useState<RunnerStatus>('ready');
  const [runtimeTelemetry, setRuntimeTelemetry] =
    useState<RuntimeTelemetry | null>(null);
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: 'boot-log',
      timestamp: formatNowTime(),
      level: 'system',
      message:
        'PolyBlock 多脚本工程工作台就绪：支持事件回调/多路定时器、扩展积木包、虚拟硬件模拟与双语言断点调试。',
    },
  ]);

  const activeProject = getActiveProject(store);
  const activeScript = getActiveScript(activeProject);
  const activeTimerConfig = useMemo(
    () => getProjectTimerConfig(activeProject),
    [activeProject],
  );
  // Keep synchronous Blockly dropdown bridge aligned before first render/load
  setActiveTimerConfig(activeTimerConfig);
  const language = activeProject.language;
  const breakpoints = activeScript.breakpoints;
  const activeBackend = backendRegistry.get(language);

  const allExtensionPacks = useMemo(
    () => extensionRegistry.listAll(),
    [extRevision],
  );

  const extraCategories = useMemo(
    () => extensionRegistry.toCategorySpecs(activeProject.enabledExtensions),
    [activeProject.enabledExtensions, extRevision],
  );

  const showVirtualBoard = useMemo(
    () =>
      extensionRegistry
        .getEnabledPacks(activeProject.enabledExtensions)
        .some((p) => p.hasVirtualBoardUi),
    [activeProject.enabledExtensions, extRevision],
  );

  const [generated, setGenerated] = useState<GeneratedCodeResult>({
    language,
    code: '',
    debugCode: '',
    sourceMap: {},
    lineToBlock: {},
    diagnostics: [],
    blockCount: 0,
    variableNames: [],
  });

  const [toastMsg, setToastMsg] = useState<string>('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const storeRef = useRef<WorkspaceStoreState>(store);
  storeRef.current = store;

  const activeProjectIdRef = useRef<string>(activeProject.id);
  const activeScriptIdRef = useRef<string>(activeScript.id);
  const languageRef = useRef<ScriptLanguageId>(language);
  const breakpointsRef = useRef<string[]>(breakpoints);
  const mockInputsRef = useRef<VirtualBoardInputs>(mockInputs);

  activeProjectIdRef.current = activeProject.id;
  activeScriptIdRef.current = activeScript.id;
  languageRef.current = language;
  breakpointsRef.current = breakpoints;
  mockInputsRef.current = mockInputs;

  const notify = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(''), 2400);
  }, []);

  const appendLog = useCallback(
    (level: LogLevel, message: string, line?: number, blockId?: string) => {
      setLogs((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: formatNowTime(),
          level,
          message,
          line,
          blockId,
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
    };
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => workbenchRef.current?.resize());
    return () => cancelAnimationFrame(id);
  }, [showCode, showConsole, activePage]);

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
      const scrId = activeScriptIdRef.current;
      const now = new Date().toISOString();

      return updateProjectById(baseStore, projId, (proj) => ({
        ...proj,
        scripts: proj.scripts.map((s) =>
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
      }));
    },
    [],
  );

  const mountScriptIntoCanvas = useCallback(
    (nextStore: WorkspaceStoreState) => {
      const nextProj = getActiveProject(nextStore);
      const nextScript = getActiveScript(nextProj);
      setActiveTimerConfig(getProjectTimerConfig(nextProj));
      activeProjectIdRef.current = nextProj.id;
      activeScriptIdRef.current = nextScript.id;
      languageRef.current = nextProj.language;
      breakpointsRef.current = nextScript.breakpoints;

      setSelectedBlockId(null);
      setExecutingBlockId(null);
      setLiveVariables({});
      setRuntimeTelemetry(null);
      setErrorLine(null);

      workbenchRef.current?.loadWorkspaceJson(nextScript.workspace);
      const ws = workbenchRef.current?.getWorkspace();
      if (ws) {
        regenerateFromWorkspace(ws, nextProj.language);
      }
    },
    [regenerateFromWorkspace],
  );

  const handleUpdateProjectTimerConfig = useCallback(
    (projectId: string, rawCfg: ProjectTimerConfig) => {
      const normalized = normalizeTimerConfig(rawCfg);
      setStore((prev) =>
        updateProjectById(prev, projectId, (p) => ({
          ...p,
          timerConfig: normalized,
          updatedAt: new Date().toISOString(),
        })),
      );
      if (projectId === activeProjectIdRef.current) {
        setActiveTimerConfig(normalized);
        const ws = workbenchRef.current?.getWorkspace();
        if (ws) {
          regenerateFromWorkspace(ws, languageRef.current);
        }
      }
      notify(`已更新定时器通道配置（0~${normalized.count - 1}）`);
    },
    [regenerateFromWorkspace, notify],
  );

  const stopIfRunning = useCallback(() => {
    if (runnerStatus === 'running' || runnerStatus === 'paused') {
      runnerManager.stopActive(true);
      setExecutingBlockId(null);
      setRuntimeTelemetry(null);
    }
  }, [runnerStatus]);

  const handleWorkspaceChange = useCallback(
    (ws: Blockly.WorkspaceSvg) => {
      regenerateFromWorkspace(ws, languageRef.current);
      setIsDirty(true);

      const snapshot = workbenchRef.current?.saveWorkspaceJson();
      if (!snapshot) return;
      const projId = activeProjectIdRef.current;
      const scrId = activeScriptIdRef.current;
      const now = new Date().toISOString();

      setStore((prev) =>
        updateProjectById(prev, projId, (proj) => ({
          ...proj,
          scripts: proj.scripts.map((s) => {
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
      );
    },
    [regenerateFromWorkspace],
  );

  /* ========================================================================
     Extension Pack Operations (Project-Scoped + Custom .polyext.json Import)
     ======================================================================== */
  const handleToggleExtension = useCallback(
    (packId: string) => {
      const pack = extensionRegistry.get(packId);
      if (!pack) return;
      setStore((prev) => {
        const proj = getActiveProject(prev);
        const exists = proj.enabledExtensions.includes(packId);
        const nextExts = exists
          ? proj.enabledExtensions.filter((id) => id !== packId)
          : [...proj.enabledExtensions, packId];
        notify(
          exists
            ? `已从当前项目停用「${pack.name}」`
            : `已为当前项目启用「${pack.name}」，左侧分类栏新增「${pack.categoryLabel}」`,
        );
        return updateProjectById(prev, proj.id, (p) => ({
          ...p,
          enabledExtensions: nextExts,
          updatedAt: new Date().toISOString(),
        }));
      });
    },
    [notify],
  );

  const handleImportExtensionJson = useCallback(
    (raw: unknown) => {
      try {
        const imported = extensionRegistry.importCustomPack(raw);
        setExtRevision((r) => r + 1);
        // Auto-enable newly imported pack on the active project
        setStore((prev) =>
          updateProjectById(prev, activeProjectIdRef.current, (p) => ({
            ...p,
            enabledExtensions: p.enabledExtensions.includes(imported.id)
              ? p.enabledExtensions
              : [...p.enabledExtensions, imported.id],
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
          enabledExtensions: p.enabledExtensions.filter((id) => id !== packId),
        })),
      }));
      notify('已删除自定义扩展包');
    },
    [notify],
  );

  const handleUpdateMockInputs = useCallback(
    (patch: Partial<VirtualBoardInputs>) => {
      setMockInputs((prev) => {
        const next = { ...prev, ...patch };
        runnerManager.updateActiveMockInputs(next as unknown as Record<string, unknown>);
        return next;
      });
    },
    [],
  );

  const handleDeviceEvent = useCallback((kind: string, value: unknown) => {
    setVirtualBoard((prev) => {
      if (kind === 'led') {
        return { ...prev, led: Boolean(value) };
      }
      if (kind === 'rgb') {
        return { ...prev, rgb: String(value || '#1e293b') };
      }
      if (kind === 'oled_clear') {
        return { ...prev, oledLines: [] };
      }
      if (kind === 'oled_show') {
        const nextLines = [...prev.oledLines, String(value)].slice(-4);
        return { ...prev, oledLines: nextLines };
      }
      return prev;
    });
  }, []);

  /* ========================================================================
     Multi-Script Tab Operations
     ======================================================================== */
  const handleSelectScript = useCallback(
    (scriptId: string) => {
      if (scriptId === activeScriptIdRef.current) return;
      stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const nextStore = updateProjectById(flushed, activeProjectIdRef.current, (p) => ({
        ...p,
        activeScriptId: scriptId,
      }));
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
    },
    [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas],
  );

  const handleAddScript = useCallback(() => {
    stopIfRunning();
    const flushed = flushActiveCanvasIntoStore(storeRef.current);
    const nextStore = updateProjectById(flushed, activeProjectIdRef.current, (p) =>
      addScriptToProject(p),
    );
    setStore(nextStore);
    mountScriptIntoCanvas(nextStore);
    const added = getActiveScript(getActiveProject(nextStore));
    notify(
      `已新建脚本 ${added.name}.${backendRegistry.get(languageRef.current).extension}`,
    );
  }, [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify]);

  const handleRenameScript = useCallback((scriptId: string, nextName: string) => {
    setStore((prev) =>
      updateProjectById(prev, activeProjectIdRef.current, (p) =>
        renameScriptInProject(p, scriptId, nextName),
      ),
    );
  }, []);

  const handleDuplicateScript = useCallback(
    (scriptId: string) => {
      stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const nextStore = updateProjectById(flushed, activeProjectIdRef.current, (p) =>
        duplicateScriptInProject(p, scriptId),
      );
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
      const copied = getActiveScript(getActiveProject(nextStore));
      notify(`已复制脚本为 ${copied.name}`);
    },
    [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  const handleSetEntryScript = useCallback(
    (scriptId: string) => {
      setStore((prev) =>
        updateProjectById(prev, activeProjectIdRef.current, (p) => ({
          ...p,
          entryScriptId: scriptId,
          updatedAt: new Date().toISOString(),
        })),
      );
      notify('已设为项目入口脚本 (★)');
    },
    [notify],
  );

  const handleDeleteScript = useCallback(
    (scriptId: string) => {
      const currentProj = getActiveProject(storeRef.current);
      if (currentProj.scripts.length <= 1) {
        notify('项目内至少需要保留 1 个脚本');
        return;
      }
      stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const wasActive = scriptId === activeScriptIdRef.current;
      const nextStore = updateProjectById(flushed, activeProjectIdRef.current, (p) =>
        deleteScriptFromProject(p, scriptId),
      );
      setStore(nextStore);
      if (wasActive) {
        mountScriptIntoCanvas(nextStore);
      }
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
        version: 2,
        activeProjectId: created.id,
        projects: [created, ...flushed.projects],
      };
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
      setIsDirty(false);
      navigateTo('blocks');
      notify(`已创建项目：${created.name}`);
    },
    [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas, navigateTo, notify],
  );

  const handleCreateBlankProject = useCallback(() => {
    handleCreateFromTemplate('blank_project');
  }, [handleCreateFromTemplate]);

  const handleRenameProject = useCallback((projectId: string, nextName: string) => {
    setStore((prev) => {
      const target = prev.projects.find((p) => p.id === projectId);
      if (!target) return prev;
      const unique = makeUniqueProjectName(
        nextName,
        prev.projects.map((p) => p.name),
        target.name,
      );
      return updateProjectById(prev, projectId, (p) => ({
        ...p,
        name: unique,
        updatedAt: new Date().toISOString(),
      }));
    });
  }, []);

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
      if (wasActive) {
        mountScriptIntoCanvas(nextStore);
      }
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
      triggerFileDownload(
        fileName,
        JSON.stringify(target, null, 2),
        'application/json;charset=utf-8',
      );
      setIsDirty(false);
      notify(`已保存整项目工程 ${fileName}（含 ${target.scripts.length} 个脚本）`);
    },
    [flushActiveCanvasIntoStore, notify],
  );

  const handleImportProject = useCallback(
    (imported: ProjectModel) => {
      stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const nextStore: WorkspaceStoreState = {
        version: 2,
        activeProjectId: imported.id,
        projects: [imported, ...flushed.projects],
      };
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
      setIsDirty(false);
      navigateTo('blocks');
      notify(`已导入项目：${imported.name}（${imported.scripts.length} 个脚本）`);
    },
    [stopIfRunning, flushActiveCanvasIntoStore, mountScriptIntoCanvas, navigateTo, notify],
  );

  const handleResetWorkspace = useCallback(() => {
    stopIfRunning();
    localStorage.removeItem(STORAGE_STORE_V2_KEY);
    const starter = instantiateProjectFromTemplate('starter_suite');
    const freshStore: WorkspaceStoreState = {
      version: 2,
      activeProjectId: starter.id,
      projects: [starter],
    };
    setStore(freshStore);
    mountScriptIntoCanvas(freshStore);
    setVirtualBoard(DEFAULT_VIRTUAL_BOARD);
    setIsDirty(false);
    navigateTo('blocks');
    notify('已恢复默认多脚本示例项目');
  }, [stopIfRunning, mountScriptIntoCanvas, navigateTo, notify]);

  /* ========================================================================
     Language, Breakpoints & Execution
     ======================================================================== */
  const handleSelectLanguage = useCallback(
    (nextLang: ScriptLanguageId) => {
      if (runnerStatus === 'running' || runnerStatus === 'paused') return;
      languageRef.current = nextLang;
      setStore((prev) =>
        updateProjectById(prev, activeProjectIdRef.current, (p) => ({
          ...p,
          language: nextLang,
          updatedAt: new Date().toISOString(),
        })),
      );
      const ws = workbenchRef.current?.getWorkspace();
      if (ws) {
        regenerateFromWorkspace(ws, nextLang);
      }
      const backend = backendRegistry.get(nextLang);
      notify(`已将整个项目切换为 ${backend.name} ${backend.version}`);
    },
    [runnerStatus, regenerateFromWorkspace, notify],
  );

  const handleToggleBreakpoint = useCallback((blockId: string) => {
    setStore((prev) => {
      const proj = getActiveProject(prev);
      const scr = getActiveScript(proj);
      const exists = scr.breakpoints.includes(blockId);
      const nextBps = exists
        ? scr.breakpoints.filter((id) => id !== blockId)
        : [...scr.breakpoints, blockId];
      runnerManager.updateActiveBreakpoints(nextBps);
      return updateProjectById(prev, proj.id, (p) => ({
        ...p,
        scripts: p.scripts.map((s) =>
          s.id === scr.id ? { ...s, breakpoints: nextBps } : s,
        ),
      }));
    });
  }, []);

  const handleClearBreakpoints = useCallback(() => {
    setStore((prev) =>
      updateProjectById(prev, activeProjectIdRef.current, (p) => ({
        ...p,
        scripts: p.scripts.map((s) =>
          s.id === activeScriptIdRef.current ? { ...s, breakpoints: [] } : s,
        ),
      })),
    );
    runnerManager.updateActiveBreakpoints([]);
    notify('已清除当前脚本的全部断点');
  }, [notify]);

  const handleSelectSpeed = useCallback((speed: ExecutionSpeedId) => {
    setSettings((prev) => ({ ...prev, executionSpeed: speed }));
    runnerManager.updateActiveStepDelay(SPEED_DELAY_MS[speed]);
  }, []);

  const launchExecution = useCallback(
    async (startInStepMode: boolean) => {
      if (activePage !== 'blocks') {
        navigateTo('blocks');
      }
      if (settings.autoOpenConsoleOnRun) {
        setShowConsole(true);
      }

      const ws = workbenchRef.current?.getWorkspace();
      const adapter = backendRegistry.get(language);
      const latest = ws ? adapter.generate(ws) : generated;
      const scriptFileLabel = `${activeScript.name}.${adapter.extension}`;
      setGenerated(latest);
      setErrorLine(null);
      setExecutingBlockId(null);
      setLiveVariables({});
      setRuntimeTelemetry(null);

      const runner = runnerManager.getForLanguage(language);
      runnerManager.setActive(runner);

      // Mount sandbox mocks for ALL registered packs (so scripts run cleanly even if a pack was toggled)
      const allMocks = extensionRegistry
        .listAll()
        .map((p) => p.sandboxMock)
        .filter((m): m is NonNullable<typeof m> => Boolean(m));

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
          breakpoints: breakpointsRef.current,
          stepDelayMs: speedDelay,
          startInStepMode,
          timerCount: activeTimerConfig.count,
          mockModules: allMocks,
          mockInputs: mockInputsRef.current as unknown as Record<string, unknown>,
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
          onRuntimeTelemetry: setRuntimeTelemetry,
          onStatusChange: (status) => setRunnerStatus(status),
        },
      );

      setLastDurationMs(result.durationMs);
      setExecutingBlockId(null);
      setRuntimeTelemetry(null);
      if (result.finalVars) {
        setLiveVariables(result.finalVars);
      }
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
        if (mappedBlock) {
          workbenchRef.current?.focusBlock(mappedBlock);
        }
      }
    },
    [
      activePage,
      navigateTo,
      settings.autoOpenConsoleOnRun,
      settings.executionSpeed,
      settings.timeoutMs,
      activeTimerConfig.count,
      language,
      activeScript.name,
      generated,
      appendLog,
      handleDeviceEvent,
    ],
  );

  const handleStop = useCallback(() => {
    runnerManager.stopActive();
    setExecutingBlockId(null);
  }, []);

  const handleExportActiveScript = useCallback(() => {
    const adapter = backendRegistry.get(language);
    const outFile = `${activeScript.name}.${adapter.extension}`;
    triggerFileDownload(
      outFile,
      generated.code + '\n',
      'text/plain;charset=utf-8',
    );
    setIsDirty(false);
    notify(`已导出干净脚本 ${outFile}`);
  }, [language, activeScript.name, generated.code, notify]);

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
    getActiveProject(initialStoreRef.current),
  ).workspace;

  return (
    <div className="app-shell">
      <TopBar
        projects={store.projects}
        activeProject={activeProject}
        activeScriptName={activeScript.name}
        isDirty={isDirty}
        activePage={activePage}
        theme={settings.theme}
        runnerStatus={runnerStatus}
        executionSpeed={settings.executionSpeed}
        showCode={showCode}
        showConsole={showConsole}
        onSelectProject={handleSelectProject}
        onCreateBlankProject={handleCreateBlankProject}
        onRenameCurrentProject={(name) =>
          handleRenameProject(activeProject.id, name)
        }
        onSaveProjectFile={() => handleSaveProjectFile(activeProject.id)}
        onOpenProjectsPage={() => navigateTo('projects')}
        onSelectLanguage={handleSelectLanguage}
        onSelectSpeed={handleSelectSpeed}
        onRun={() => launchExecution(false)}
        onStartStepMode={() => launchExecution(true)}
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
              <div className="blocks-main-col">
                <ScriptTabBar
                  scripts={activeProject.scripts}
                  activeScriptId={activeScript.id}
                  entryScriptId={activeProject.entryScriptId}
                  extension={activeBackend.extension}
                  disabled={runnerStatus === 'running' || runnerStatus === 'paused'}
                  onSelectScript={handleSelectScript}
                  onAddScript={handleAddScript}
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
                  extraCategories={extraCategories}
                  timerConfig={activeTimerConfig}
                  onWorkspaceChange={handleWorkspaceChange}
                  onSelectBlock={setSelectedBlockId}
                  onToggleBreakpoint={handleToggleBreakpoint}
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
                  breakpoints={breakpoints}
                  variables={liveVariables}
                  errorLine={errorLine}
                  showVirtualBoard={showVirtualBoard}
                  virtualBoard={virtualBoard}
                  mockInputs={mockInputs}
                  timerConfig={activeTimerConfig}
                  runtimeTelemetry={runtimeTelemetry}
                  onUpdateMockInputs={handleUpdateMockInputs}
                  onResetVirtualBoard={() => setVirtualBoard(DEFAULT_VIRTUAL_BOARD)}
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
              onUpdateProjectTimerConfig={handleUpdateProjectTimerConfig}
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
              allPacks={allExtensionPacks}
              enabledExtensionIds={activeProject.enabledExtensions}
              onToggleExtension={handleToggleExtension}
              onImportExtensionJson={handleImportExtensionJson}
              onRemoveCustomPack={handleRemoveCustomPack}
              onReturnToBlocks={() => navigateTo('blocks')}
              onNotify={notify}
            />
          )}

          {activePage === 'settings' && (
            <SettingsPage
              settings={settings}
              onUpdateSettings={(patch) =>
                setSettings((prev) => ({ ...prev, ...patch }))
              }
              onResetWorkspace={handleResetWorkspace}
              onReturnToBlocks={() => navigateTo('blocks')}
            />
          )}
        </main>
      </div>

      <StatusBar
        projectName={activeProject.name}
        scriptCount={activeProject.scripts.length}
        activeScriptName={activeScript.name}
        language={language}
        runnerStatus={runnerStatus}
        blockCount={generated.blockCount}
        diagnosticCount={generated.diagnostics.length}
        breakpointCount={breakpoints.length}
        selectedBlockId={selectedBlockId}
      />

      <div className={`toast ${toastMsg ? 'show' : ''}`} role="status">
        {toastMsg}
      </div>
    </div>
  );
}
