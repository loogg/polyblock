import {
  Code2,
  Download,
  Moon,
  Pause,
  Play,
  Square,
  StepForward,
  Sun,
  Terminal,
} from 'lucide-react';
import { backendRegistry } from '../core/backends/registry';
import { PROJECT_TEMPLATES } from '../core/blocks/templates';
import type { RunnerStatus } from '../core/runners/types';
import type {
  ExecutionSpeedId,
  PageId,
  ScriptLanguageId,
  ThemeMode,
} from '../types/project';

interface TopBarProps {
  projectName: string;
  isDirty: boolean;
  activePage: PageId;
  language: ScriptLanguageId;
  theme: ThemeMode;
  runnerStatus: RunnerStatus;
  executionSpeed: ExecutionSpeedId;
  showCode: boolean;
  showConsole: boolean;
  activeTemplateId: string;
  onSelectLanguage: (lang: ScriptLanguageId) => void;
  onSelectSpeed: (speed: ExecutionSpeedId) => void;
  onRun: () => void;
  onStartStepMode: () => void;
  onResume: () => void;
  onStepNext: () => void;
  onPause: () => void;
  onStop: () => void;
  onExportScript: () => void;
  onToggleCode: () => void;
  onToggleConsole: () => void;
  onToggleTheme: () => void;
  onSelectTemplate: (templateId: string) => void;
}

export function TopBar({
  projectName,
  isDirty,
  activePage,
  language,
  theme,
  runnerStatus,
  executionSpeed,
  showCode,
  showConsole,
  activeTemplateId,
  onSelectLanguage,
  onSelectSpeed,
  onRun,
  onStartStepMode,
  onResume,
  onStepNext,
  onPause,
  onStop,
  onExportScript,
  onToggleCode,
  onToggleConsole,
  onToggleTheme,
  onSelectTemplate,
}: TopBarProps) {
  const backends = backendRegistry.list();
  const activeBackend = backendRegistry.get(language);
  const isRunning = runnerStatus === 'running';
  const isPaused = runnerStatus === 'paused';

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

        <div className="project-pill" title={projectName}>
          {isDirty && <span className="dirty-dot" title="有未导出修改" />}
          <span>{projectName}</span>
        </div>

        <select
          className="template-select"
          aria-label="切换示例模板"
          value={activeTemplateId}
          onChange={(e) => {
            if (e.target.value) onSelectTemplate(e.target.value);
          }}
        >
          <option value="">示例模板...</option>
          {PROJECT_TEMPLATES.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name}
            </option>
          ))}
        </select>
      </div>

      <div className="topbar-group">
        <div className="seg-control" role="tablist" aria-label="目标脚本后端">
          {backends.map((b) => (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={language === b.id}
              className={`seg-btn ${language === b.id ? 'active' : ''}`}
              onClick={() => onSelectLanguage(b.id)}
              disabled={isRunning || isPaused}
              title={
                isRunning || isPaused
                  ? '请先停止当前运行再切换语言'
                  : `切换到 ${b.name} ${b.version}`
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
              title={`在沙箱中逐块运行 ${activeBackend.name} 脚本`}
            >
              <Play size={12} fill="currentColor" />
              <span>运行</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={onStartStepMode}
              title="从第 1 块积木开始单步调试"
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
          onClick={onExportScript}
          title={`导出干净标准 ${activeBackend.fileName} 文件（无调试插桩）`}
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
