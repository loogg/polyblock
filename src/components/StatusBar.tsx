import { backendRegistry } from '../core/backends/registry';
import { runnerManager } from '../core/runners/manager';
import type { RunnerStatus } from '../core/runners/types';
import type { ScriptLanguageId } from '../types/project';

interface StatusBarProps {
  projectName: string;
  scriptCount: number;
  activeScriptName: string;
  language: ScriptLanguageId;
  runnerStatus: RunnerStatus;
  blockCount: number;
  diagnosticCount: number;
  breakpointCount: number;
  selectedBlockId: string | null;
}

export function StatusBar({
  projectName,
  scriptCount,
  activeScriptName,
  language,
  runnerStatus,
  blockCount,
  diagnosticCount,
  breakpointCount,
  selectedBlockId,
}: StatusBarProps) {
  const backend = backendRegistry.get(language);
  const runner = runnerManager.getForLanguage(language);

  const statusText =
    runnerStatus === 'paused'
      ? `已暂停（断点 / 单步）· ${runner.shortLabel}`
      : runnerStatus === 'running'
      ? `正在逐块运行 (${runner.shortLabel})...`
      : runnerStatus === 'error'
      ? `上次运行出错 · ${runner.shortLabel}`
      : `沙箱就绪 · ${runner.shortLabel}`;

  return (
    <footer className="status-bar">
      <div className="status-group">
        <span>
          <span
            className={`status-dot ${
              runnerStatus === 'paused'
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
          项目: {projectName} ({scriptCount} 脚本)
        </span>
        <span>
          当前: {activeScriptName}.{backend.extension}
        </span>
        <span>积木数: {blockCount}</span>
        {breakpointCount > 0 && (
          <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
            断点: {breakpointCount}
          </span>
        )}
        <span>
          {diagnosticCount === 0 ? '校验通过' : `${diagnosticCount} 条提醒`}
        </span>
      </div>

      <div className="status-group">
        {selectedBlockId && <span>选中块: {selectedBlockId.slice(0, 12)}</span>}
        <span>纯净导出 / 沙箱调试分离</span>
        <span>UTF-8</span>
      </div>
    </footer>
  );
}
