import {
  Code2,
  Download,
  Moon,
  Play,
  Square,
  Sun,
  Terminal,
} from 'lucide-react';
import { backendRegistry } from '../core/backends/registry';
import { PROJECT_TEMPLATES } from '../core/blocks/templates';
import type { PageId, ScriptLanguageId, ThemeMode } from '../types/project';

interface TopBarProps {
  projectName: string;
  isDirty: boolean;
  activePage: PageId;
  language: ScriptLanguageId;
  theme: ThemeMode;
  running: boolean;
  showCode: boolean;
  showConsole: boolean;
  activeTemplateId: string;
  onSelectLanguage: (lang: ScriptLanguageId) => void;
  onRunOrStop: () => void;
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
  running,
  showCode,
  showConsole,
  activeTemplateId,
  onSelectLanguage,
  onRunOrStop,
  onExportScript,
  onToggleCode,
  onToggleConsole,
  onToggleTheme,
  onSelectTemplate,
}: TopBarProps) {
  const backends = backendRegistry.list();
  const activeBackend = backendRegistry.get(language);

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

        <button
          type="button"
          className={`btn-run ${running ? 'running' : ''}`}
          onClick={onRunOrStop}
          title={running ? '停止当前脚本执行' : `运行生成的 ${activeBackend.name} 脚本`}
        >
          {running ? <Square size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
          <span>{running ? '停止' : '运行'}</span>
        </button>

        <button
          type="button"
          className="btn-outline"
          onClick={onExportScript}
          title={`导出标准 ${activeBackend.fileName} 文件`}
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
