import {
  Check,
  ChevronDown,
  Code2,
  Download,
  FolderGit2,
  FolderKanban,
  Moon,
  Pause,
  Pencil,
  Play,
  Plus,
  Save,
  Square,
  StepForward,
  Sun,
  Terminal,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { backendRegistry } from '../core/backends/registry';
import type { RunnerStatus } from '../core/runners/types';
import type {
  ExecutionSpeedId,
  PageId,
  ProjectModel,
  ScriptLanguageId,
  ThemeMode,
} from '../types/project';

interface TopBarProps {
  projects: ProjectModel[];
  activeProject: ProjectModel;
  activeScriptName: string;
  isDirty: boolean;
  activePage: PageId;
  theme: ThemeMode;
  runnerStatus: RunnerStatus;
  executionSpeed: ExecutionSpeedId;
  showCode: boolean;
  showConsole: boolean;
  onSelectProject: (projectId: string) => void;
  onCreateBlankProject: () => void;
  onRenameCurrentProject: (nextName: string) => void;
  onSaveProjectFile: () => void;
  onOpenProjectsPage: () => void;
  onSelectLanguage: (lang: ScriptLanguageId) => void;
  onSelectSpeed: (speed: ExecutionSpeedId) => void;
  onRun: () => void;
  onStartStepMode: () => void;
  onResume: () => void;
  onStepNext: () => void;
  onPause: () => void;
  onStop: () => void;
  onExportActiveScript: () => void;
  onToggleCode: () => void;
  onToggleConsole: () => void;
  onToggleTheme: () => void;
}

export function TopBar({
  projects,
  activeProject,
  activeScriptName,
  isDirty,
  activePage,
  theme,
  runnerStatus,
  executionSpeed,
  showCode,
  showConsole,
  onSelectProject,
  onCreateBlankProject,
  onRenameCurrentProject,
  onSaveProjectFile,
  onOpenProjectsPage,
  onSelectLanguage,
  onSelectSpeed,
  onRun,
  onStartStepMode,
  onResume,
  onStepNext,
  onPause,
  onStop,
  onExportActiveScript,
  onToggleCode,
  onToggleConsole,
  onToggleTheme,
}: TopBarProps) {
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [renamingProject, setRenamingProject] = useState(false);
  const [draftProjectName, setDraftProjectName] = useState(activeProject.name);
  const projectMenuRef = useRef<HTMLDivElement | null>(null);

  const backends = backendRegistry.list();
  const activeBackend = backendRegistry.get(activeProject.language);
  const isRunning = runnerStatus === 'running';
  const isPaused = runnerStatus === 'paused';
  const activeFileName = `${activeScriptName}.${activeBackend.extension}`;

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (
        projectMenuRef.current &&
        !projectMenuRef.current.contains(e.target as Node)
      ) {
        setProjectMenuOpen(false);
        setRenamingProject(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const commitProjectRename = () => {
    if (draftProjectName.trim()) {
      onRenameCurrentProject(draftProjectName.trim());
    }
    setRenamingProject(false);
    setProjectMenuOpen(false);
  };

  return (
    <header className="app-topbar">
      <div className="topbar-group">
        <div className="brand-mark">
          <img
            src="./favicon.svg"
            alt="PolyBlock Logo"
            className="brand-logo"
          />
          <span>PolyBlock</span>
        </div>

        {/* Project-as-Root Switcher */}
        <div className="popover-anchor" ref={projectMenuRef}>
          <button
            type="button"
            className="project-switcher-btn"
            onClick={() => {
              setDraftProjectName(activeProject.name);
              setRenamingProject(false);
              setProjectMenuOpen((v) => !v);
            }}
            aria-expanded={projectMenuOpen}
            aria-label="切换或管理当前项目"
            title={`当前项目：${activeProject.name}（共 ${activeProject.scripts.length} 个脚本）`}
          >
            <FolderGit2 size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            {isDirty && <span className="dirty-dot" title="有未导出修改" />}
            <span className="project-switcher-name">{activeProject.name}</span>
            <span className="project-script-count">
              {activeProject.scripts.length} 脚本
            </span>
            <ChevronDown size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          </button>

          {projectMenuOpen && (
            <div className="dropdown-menu" style={{ left: 0, minWidth: 264 }}>
              <div className="dropdown-section-label">
                切换项目 ({projects.length})
              </div>
              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                {projects.map((p) => {
                  const isCurrent = p.id === activeProject.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`dropdown-item ${isCurrent ? 'active' : ''}`}
                      disabled={(isRunning || isPaused) && !isCurrent}
                      onClick={() => {
                        onSelectProject(p.id);
                        setProjectMenuOpen(false);
                      }}
                    >
                      <span style={{ width: 14, display: 'inline-flex' }}>
                        {isCurrent && <Check size={13} />}
                      </span>
                      <span className="dropdown-item-label">{p.name}</span>
                      <span className="count-badge">
                        {p.language === 'lua' ? 'Lua' : 'Py'} · {p.scripts.length}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="dropdown-divider" />

              {renamingProject ? (
                <div className="dropdown-rename-row">
                  <input
                    type="text"
                    className="dropdown-rename-input"
                    value={draftProjectName}
                    autoFocus
                    onChange={(e) => setDraftProjectName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitProjectRename();
                      if (e.key === 'Escape') setRenamingProject(false);
                    }}
                  />
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ padding: '4px 8px', fontSize: 11.5 }}
                    onClick={commitProjectRename}
                  >
                    确定
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="dropdown-item"
                  onClick={() => {
                    setDraftProjectName(activeProject.name);
                    setRenamingProject(true);
                  }}
                >
                  <Pencil size={13} />
                  <span>重命名当前项目</span>
                </button>
              )}

              <button
                type="button"
                className="dropdown-item"
                disabled={isRunning || isPaused}
                onClick={() => {
                  setProjectMenuOpen(false);
                  onCreateBlankProject();
                }}
              >
                <Plus size={13} />
                <span>新建空白项目</span>
              </button>

              <button
                type="button"
                className="dropdown-item"
                onClick={() => {
                  setProjectMenuOpen(false);
                  onSaveProjectFile();
                }}
              >
                <Save size={13} />
                <span>保存整项目工程 (.polyblock.json)</span>
              </button>

              <div className="dropdown-divider" />

              <button
                type="button"
                className="dropdown-item"
                onClick={() => {
                  setProjectMenuOpen(false);
                  onOpenProjectsPage();
                }}
              >
                <FolderKanban size={13} />
                <span>打开项目管理与模板页 →</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="topbar-group">
        <div
          className="seg-control"
          role="tablist"
          aria-label="项目统一目标脚本后端"
        >
          {backends.map((b) => (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={activeProject.language === b.id}
              className={`seg-btn ${activeProject.language === b.id ? 'active' : ''}`}
              onClick={() => onSelectLanguage(b.id)}
              disabled={isRunning || isPaused}
              title={
                isRunning || isPaused
                  ? '请先停止当前运行再切换语言'
                  : `将整个项目切换为 ${b.name} ${b.version}`
              }
            >
              <span
                className="lang-dot"
                style={{ background: b.accentColor }}
              />
              <span>
                {b.name} {b.version}
              </span>
            </button>
          ))}
        </div>

        <select
          className="speed-select"
          aria-label="执行速度档位"
          title="调节沙箱逐块高亮节奏（极速仍会在断点处暂停）"
          value={executionSpeed}
          onChange={(e) => onSelectSpeed(e.target.value as ExecutionSpeedId)}
        >
          <option value="normal">正常</option>
          <option value="slow">慢放</option>
          <option value="fast">极速</option>
        </select>

        {!isRunning && !isPaused && (
          <>
            <button
              type="button"
              className="btn-run"
              onClick={onRun}
              title={`运行当前脚本 ${activeFileName}`}
            >
              <Play size={12} fill="currentColor" />
              <span>运行</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={onStartStepMode}
              title={`从第 1 块积木单步调试 ${activeFileName}`}
            >
              <StepForward size={13} />
              <span>单步</span>
            </button>
          </>
        )}

        {isRunning && (
          <>
            <button
              type="button"
              className="btn-pause"
              onClick={onPause}
              title="在下一块积木处暂停"
            >
              <Pause size={12} />
              <span>暂停</span>
            </button>
            <button
              type="button"
              className="btn-run running"
              onClick={onStop}
              title="立即停止脚本执行"
            >
              <Square size={12} fill="currentColor" />
              <span>停止</span>
            </button>
          </>
        )}

        {isPaused && (
          <>
            <button
              type="button"
              className="btn-run"
              onClick={onResume}
              title="继续执行直到下一个断点或结束"
            >
              <Play size={12} fill="currentColor" />
              <span>继续</span>
            </button>
            <button
              type="button"
              className="btn-step"
              onClick={onStepNext}
              title="执行当前积木并停在下一块"
            >
              <StepForward size={13} />
              <span>单步</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={onStop}
              title="停止调试"
              style={{ color: 'var(--danger)' }}
            >
              <Square size={12} fill="currentColor" />
              <span>停止</span>
            </button>
          </>
        )}

        <button
          type="button"
          className="btn-outline"
          onClick={onExportActiveScript}
          title={`导出当前脚本 ${activeFileName}（干净无插桩）`}
        >
          <Download size={14} />
          <span>导出 .{activeBackend.extension}</span>
        </button>
      </div>

      <div className="topbar-group">
        {activePage === 'blocks' && (
          <>
            <button
              type="button"
              className={`btn-ghost ${showCode ? 'active' : ''}`}
              onClick={onToggleCode}
              title="显示/隐藏右侧代码面板"
            >
              <Code2 size={14} />
              <span>代码</span>
            </button>
            <button
              type="button"
              className={`btn-ghost ${showConsole ? 'active' : ''}`}
              onClick={onToggleConsole}
              title="显示/隐藏底部打印日志台"
            >
              <Terminal size={14} />
              <span>日志</span>
            </button>
          </>
        )}
        <button
          type="button"
          className="btn-outline"
          onClick={onToggleTheme}
          title={theme === 'light' ? '切换深色主题' : '切换浅色主题'}
          aria-label={theme === 'light' ? '切换深色主题' : '切换浅色主题'}
          style={{
            padding: '5px 7px',
            color: theme === 'dark' ? '#fbbf24' : 'var(--text-secondary)',
          }}
        >
          {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
        </button>
      </div>
    </header>
  );
}
