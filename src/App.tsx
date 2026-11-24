import type * as Blockly from 'blockly';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { StatusBar } from './components/StatusBar';
import { TopBar } from './components/TopBar';
import { backendRegistry } from './core/backends/registry';
import type { GeneratedCodeResult } from './core/backends/types';
import { PROJECT_TEMPLATES } from './core/blocks/templates';
import { runnerManager } from './core/runners/manager';
import type { RunnerStatus } from './core/runners/types';
import type {
  AppSettings,
  LogEntry,
  LogLevel,
  PageId,
  ProjectFileData,
  ScriptLanguageId,
} from './types/project';

const STORAGE_PROJECT_KEY = 'polyblock.workspace.v1';
const STORAGE_SETTINGS_KEY = 'polyblock.settings.v1';

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
      return {
        theme: parsed.theme === 'dark' ? 'dark' : 'light',
        timeoutMs:
          typeof parsed.timeoutMs === 'number' && parsed.timeoutMs >= 1000
            ? parsed.timeoutMs
            : 5000,
        autoOpenConsoleOnRun: parsed.autoOpenConsoleOnRun ?? true,
      };
    }
  } catch {
    // ignore storage errors
  }
  return {
    theme: 'light',
    timeoutMs: 5000,
    autoOpenConsoleOnRun: true,
  };
}

function loadInitialProject(): {
  name: string;
  language: ScriptLanguageId;
  templateId: string;
  workspace: Record<string, unknown>;
} {
  try {
    const raw = localStorage.getItem(STORAGE_PROJECT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ProjectFileData> & {
        templateId?: string;
      };
      if (parsed && parsed.workspace && typeof parsed.workspace === 'object') {
        return {
          name: parsed.name || 'demo_logger.polyblock.json',
          language: parsed.language === 'python' ? 'python' : 'lua',
          templateId: parsed.templateId ?? '',
          workspace: parsed.workspace,
        };
      }
    }
  } catch {
    // fallback to default template
  }

  const def = PROJECT_TEMPLATES[0];
  return {
    name: def.fileName,
    language: def.recommendedLang,
    templateId: def.id,
    workspace: def.workspace,
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
  const initialProjectRef = useRef(loadInitialProject());
  const workbenchRef = useRef<BlocklyWorkbenchHandle | null>(null);

  const [settings, setSettings] = useState<AppSettings>(loadSavedSettings);
  const [activePage, setActivePage] = useState<PageId>(readPageFromHash);
  const [projectName, setProjectName] = useState<string>(
    initialProjectRef.current.name,
  );
  const [activeTemplateId, setActiveTemplateId] = useState<string>(
    initialProjectRef.current.templateId,
  );
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [language, setLanguage] = useState<ScriptLanguageId>(
    initialProjectRef.current.language,
  );

  const [showCode, setShowCode] = useState<boolean>(true);
  const [showConsole, setShowConsole] = useState<boolean>(true);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [errorLine, setErrorLine] = useState<number | null>(null);

  const [runnerStatus, setRunnerStatus] = useState<RunnerStatus>('ready');
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: 'boot-log',
      timestamp: formatNowTime(),
      level: 'system',
      message:
        'PolyBlock 纯前端工作台就绪：内置 Lua 5.4 (Wasmoon) 与 Python 3 (MicroPython WASM) 沙箱，点击「▶ 运行」查看实时打印日志。',
    },
  ]);

  const [generated, setGenerated] = useState<GeneratedCodeResult>({
    language: initialProjectRef.current.language,
    code: '',
    sourceMap: {},
    lineToBlock: {},
    diagnostics: [],
    blockCount: 0,
  });

  const [toastMsg, setToastMsg] = useState<string>('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const languageRef = useRef<ScriptLanguageId>(language);
  const projectNameRef = useRef<string>(projectName);
  const templateIdRef = useRef<string>(activeTemplateId);

  languageRef.current = language;
  projectNameRef.current = projectName;
  templateIdRef.current = activeTemplateId;

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

  // Sync HTML theme attribute & persist settings
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
    try {
      localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // ignore storage errors
    }
  }, [settings]);

  // Hash routing sync (GitHub Pages safe)
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

  // Dispose workers on unmount
  useEffect(() => {
    return () => {
      runnerManager.disposeAll();
    };
  }, []);

  // Trigger Blockly SVG resize when panels toggle
  useEffect(() => {
    const id = requestAnimationFrame(() => workbenchRef.current?.resize());
    return () => cancelAnimationFrame(id);
  }, [showCode, showConsole, activePage]);

  const regenerate = useCallback(
    (ws: Blockly.WorkspaceSvg, lang: ScriptLanguageId, persist: boolean) => {
      const adapter = backendRegistry.get(lang);
      const result = adapter.generate(ws);
      setGenerated(result);
      setErrorLine(null);

      if (persist) {
        try {
          const snapshot = workbenchRef.current?.saveWorkspaceJson();
          if (snapshot) {
            localStorage.setItem(
              STORAGE_PROJECT_KEY,
              JSON.stringify({
                format: 'polyblock-project',
                version: 1,
                name: projectNameRef.current,
                language: lang,
                templateId: templateIdRef.current,
                updatedAt: new Date().toISOString(),
                workspace: snapshot,
              }),
            );
          }
        } catch {
          // ignore storage quota errors
        }
      }
    },
    [],
  );

  const handleWorkspaceChange = useCallback(
    (ws: Blockly.WorkspaceSvg) => {
      regenerate(ws, languageRef.current, true);
      setIsDirty(true);
    },
    [regenerate],
  );

  const handleSelectLanguage = useCallback(
    (nextLang: ScriptLanguageId) => {
      setLanguage(nextLang);
      const ws = workbenchRef.current?.getWorkspace();
      if (ws) {
        regenerate(ws, nextLang, true);
      }
      const backend = backendRegistry.get(nextLang);
      notify(`已切换目标后端为 ${backend.name} ${backend.version}`);
    },
    [regenerate, notify],
  );

  const handleRunOrStop = useCallback(async () => {
    if (runnerStatus === 'running') {
      runnerManager.stopActive();
      return;
    }

    if (activePage !== 'blocks') {
      navigateTo('blocks');
    }
    if (settings.autoOpenConsoleOnRun) {
      setShowConsole(true);
    }

    const ws = workbenchRef.current?.getWorkspace();
    const adapter = backendRegistry.get(language);
    const latest = ws ? adapter.generate(ws) : generated;
    setGenerated(latest);
    setErrorLine(null);

    const runner = runnerManager.getForLanguage(language);
    runnerManager.setActive(runner);

    setLogs([
      {
        id: `start-${Date.now()}`,
        timestamp: formatNowTime(),
        level: 'system',
        message: `启动 ${runner.name} ...`,
      },
    ]);

    const result = await runner.run(
      {
        language,
        code: latest.code,
        timeoutMs: settings.timeoutMs,
      },
      {
        onClear: () => setLogs([]),
        onLog: (level, message, line) => {
          const mappedBlock = line ? latest.lineToBlock[line] : undefined;
          appendLog(level, message, line, mappedBlock);
        },
        onStatusChange: (status) => setRunnerStatus(status),
      },
    );

    setLastDurationMs(result.durationMs);
    runnerManager.setActive(null);

    if (result.ok) {
      appendLog(
        'system',
        `执行完成，耗时 ${result.durationMs}ms（可随时点击右上角导出 ${adapter.fileName}）。`,
      );
    } else if (result.errorLine) {
      setErrorLine(result.errorLine);
      const mappedBlock = latest.lineToBlock[result.errorLine];
      if (mappedBlock) {
        workbenchRef.current?.focusBlock(mappedBlock);
      }
    }
  }, [
    runnerStatus,
    activePage,
    navigateTo,
    settings.autoOpenConsoleOnRun,
    settings.timeoutMs,
    language,
    generated,
    appendLog,
  ]);

  const handleExportScript = useCallback(() => {
    const adapter = backendRegistry.get(language);
    const baseName = projectName.replace(/\.polyblock\.json$|\.json$/i, '');
    const outFile = `${baseName || 'main'}.${adapter.extension}`;
    triggerFileDownload(outFile, generated.code + '\n', 'text/plain;charset=utf-8');
    setIsDirty(false);
    notify(`已导出 ${outFile}`);
  }, [language, projectName, generated.code, notify]);

  const handleCopyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(generated.code);
      const adapter = backendRegistry.get(language);
      notify(`已复制 ${adapter.fileName} 到剪贴板`);
    } catch {
      notify('复制失败，请手动选中代码复制');
    }
  }, [generated.code, language, notify]);

  const handleLoadTemplate = useCallback(
    (templateId: string) => {
      const tpl = PROJECT_TEMPLATES.find((t) => t.id === templateId);
      if (!tpl) return;
      setProjectName(tpl.fileName);
      setActiveTemplateId(tpl.id);
      setLanguage(tpl.recommendedLang);
      languageRef.current = tpl.recommendedLang;
      projectNameRef.current = tpl.fileName;
      templateIdRef.current = tpl.id;
      workbenchRef.current?.loadWorkspaceJson(tpl.workspace);
      setIsDirty(false);
      notify(`已载入示例模板：${tpl.name}`);
    },
    [notify],
  );

  const handleCreateBlank = useCallback(() => {
    const blank = {
      blocks: {
        languageVersion: 0,
        blocks: [{ type: 'poly_on_start', id: 'start_blank', x: 36, y: 28 }],
      },
    };
    setProjectName('untitled.polyblock.json');
    setActiveTemplateId('');
    projectNameRef.current = 'untitled.polyblock.json';
    templateIdRef.current = '';
    workbenchRef.current?.loadWorkspaceJson(blank);
    setIsDirty(false);
    navigateTo('blocks');
    notify('已创建空白积木项目');
  }, [navigateTo, notify]);

  const handleSaveProjectFile = useCallback(() => {
    const wsJson = workbenchRef.current?.saveWorkspaceJson() ?? {};
    const payload: ProjectFileData = {
      format: 'polyblock-project',
      version: 1,
      name: projectName,
      language,
      updatedAt: new Date().toISOString(),
      workspace: wsJson,
    };
    triggerFileDownload(
      projectName.endsWith('.json') ? projectName : `${projectName}.polyblock.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8',
    );
    setIsDirty(false);
    notify(`已保存工程文件 ${projectName}`);
  }, [projectName, language, notify]);

  const handleImportProjectFile = useCallback(
    (data: ProjectFileData) => {
      setProjectName(data.name);
      setActiveTemplateId('');
      setLanguage(data.language);
      languageRef.current = data.language;
      projectNameRef.current = data.name;
      templateIdRef.current = '';
      workbenchRef.current?.loadWorkspaceJson(data.workspace);
      setIsDirty(false);
      navigateTo('blocks');
      notify(`已导入工程：${data.name}`);
    },
    [navigateTo, notify],
  );

  const handleResetWorkspace = useCallback(() => {
    localStorage.removeItem(STORAGE_PROJECT_KEY);
    handleLoadTemplate(PROJECT_TEMPLATES[0].id);
    navigateTo('blocks');
  }, [handleLoadTemplate, navigateTo]);

  const handleFocusBlock = useCallback((blockId: string) => {
    workbenchRef.current?.focusBlock(blockId);
  }, []);

  return (
    <div className="app-shell">
      <TopBar
        projectName={projectName}
        isDirty={isDirty}
        activePage={activePage}
        language={language}
        theme={settings.theme}
        running={runnerStatus === 'running'}
        showCode={showCode}
        showConsole={showConsole}
        activeTemplateId={activeTemplateId}
        onSelectLanguage={handleSelectLanguage}
        onRunOrStop={handleRunOrStop}
        onExportScript={handleExportScript}
        onToggleCode={() => setShowCode((v) => !v)}
        onToggleConsole={() => setShowConsole((v) => !v)}
        onToggleTheme={() =>
          setSettings((prev) => ({
            ...prev,
            theme: prev.theme === 'light' ? 'dark' : 'light',
          }))
        }
        onSelectTemplate={handleLoadTemplate}
      />

      <div className="app-body">
        <ActivityRail activePage={activePage} onSelectPage={navigateTo} />

        <main className="workspace-host">
          {/* Keep Blockly workbench persistently mounted for instant page switching & undo history */}
          <div
            className={`workbench-center-col ${
              activePage !== 'blocks' ? 'hidden-pane' : ''
            }`}
          >
            <div className="workbench-split-row">
              <BlocklyWorkbench
                ref={workbenchRef}
                theme={settings.theme}
                initialWorkspace={initialProjectRef.current.workspace}
                visible={activePage === 'blocks'}
                onWorkspaceChange={handleWorkspaceChange}
                onSelectBlock={setSelectedBlockId}
              />

              {showCode && (
                <CodeInspector
                  language={language}
                  generated={generated}
                  selectedBlockId={selectedBlockId}
                  errorLine={errorLine}
                  onSelectBlockFromLine={handleFocusBlock}
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
              currentProjectName={projectName}
              activeTemplateId={activeTemplateId}
              onLoadTemplate={handleLoadTemplate}
              onCreateBlank={handleCreateBlank}
              onSaveProjectFile={handleSaveProjectFile}
              onImportProjectFile={handleImportProjectFile}
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
            <ExtensionsPage onReturnToBlocks={() => navigateTo('blocks')} />
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
        language={language}
        runnerStatus={runnerStatus}
        blockCount={generated.blockCount}
        diagnosticCount={generated.diagnostics.length}
        selectedBlockId={selectedBlockId}
      />

      <div className={`toast ${toastMsg ? 'show' : ''}`} role="status">
        {toastMsg}
      </div>
    </div>
  );
}
