import { backendRegistry } from '../core/backends/registry';
import { runnerManager } from '../core/runners/manager';
import type { RunnerStatus } from '../core/runners/types';
import { useLanguagePluginsRevision } from '../hooks/useLanguagePlugins';
import type { ScriptLanguageId } from '../types/project';

interface StatusBarProps {
  projectName: string;
  handleCount: number;
  activeHandleName: string;
  activeScriptName: string;
  activeFileLabel?: string;
  language: ScriptLanguageId;
  runnerStatus: RunnerStatus;
  multiHandleRunning?: boolean;
  runningHandleCount?: number;
  blockCount: number;
  diagnosticCount: number;
  diagnosticErrorCount?: number;
  breakpointCount: number;
  selectedBlockId: string | null;
}

export function StatusBar({
  projectName,
  handleCount,
  activeHandleName,
  activeScriptName,
  activeFileLabel,
  language,
  runnerStatus,
  multiHandleRunning = false,
  runningHandleCount,
  blockCount,
  diagnosticCount,
  diagnosticErrorCount = 0,
  breakpointCount,
  selectedBlockId,
}: StatusBarProps) {
  useLanguagePluginsRevision();
  const dialect = backendRegistry.tryGetDialect(language);
  const ext = dialect?.extension ?? language;
  const runner = runnerManager.findForLanguage(language);

  const activeRunCount = runningHandleCount || handleCount;
  const statusText = !runner
    ? '仅代码生成与导出（无浏览器沙箱）'
    : runnerStatus === 'paused'
      ? `已暂停（断点 / 单步）· ${runner.shortLabel}`
      : runnerStatus === 'running'
        ? multiHandleRunning
          ? `${activeRunCount} 句柄并发仿真中 (${runner.shortLabel})...`
          : `正在运行 [${activeHandleName}] (${runner.shortLabel})...`
        : runnerStatus === 'error'
          ? `上次运行出错 · ${runner.shortLabel}`
          : `沙箱就绪 · ${runner.shortLabel}`;

  return (
    <footer className="status-bar">
      <div className="status-group">
        <span>
          <span
            className={`status-dot ${
              !runner
                ? ''
                : runnerStatus === 'paused'
                  ? 'paused'
                  : runnerStatus === 'running'
                    ? 'running'
                    : runnerStatus === 'error'
                      ? 'error'
                      : ''
            }`}
          />
          {statusText}
        </span>
        <span>
          项目: {projectName} ({handleCount} 句柄)
        </span>
        <span>
          当前: {activeHandleName}/
          {activeFileLabel ?? `${activeScriptName}.${ext}`}
        </span>
        <span>积木数: {blockCount}</span>
        {breakpointCount > 0 && (
          <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
            断点: {breakpointCount}
          </span>
        )}
        {diagnosticErrorCount > 0 ? (
          <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
            {diagnosticErrorCount} 处错误
          </span>
        ) : (
          <span>
            {diagnosticCount === 0 ? '校验通过' : `${diagnosticCount} 条提醒`}
          </span>
        )}
      </div>

      <div className="status-group">
        {selectedBlockId && <span>选中块: {selectedBlockId.slice(0, 12)}</span>}
        <span>{runner ? '纯净导出 / 沙箱调试分离' : '仅代码生成与导出'}</span>
        <span>UTF-8</span>
      </div>
    </footer>
  );
}
