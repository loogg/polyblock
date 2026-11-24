import { backendRegistry } from '../core/backends/registry';
import { runnerManager } from '../core/runners/manager';
import type { RunnerStatus } from '../core/runners/types';
import type { ScriptLanguageId } from '../types/project';

interface StatusBarProps {
  language: ScriptLanguageId;
  runnerStatus: RunnerStatus;
  blockCount: number;
  diagnosticCount: number;
  selectedBlockId: string | null;
}

export function StatusBar({
  language,
  runnerStatus,
  blockCount,
  diagnosticCount,
  selectedBlockId,
}: StatusBarProps) {
  const backend = backendRegistry.get(language);
  const runner = runnerManager.getForLanguage(language);

  const statusText =
    runnerStatus === 'running'
      ? `正在运行 (${runner.shortLabel})...`
      : runnerStatus === 'error'
      ? `上次运行出错 · ${runner.shortLabel}`
      : `沙箱就绪 · ${runner.shortLabel}`;

  return (
    <footer className="status-bar">
      <div className="status-group">
        <span>
          <span
            className={`status-dot ${
              runnerStatus === 'running'
                ? 'running'
                : runnerStatus === 'error'
                ? 'error'
                : ''
            }`}
          />
          {statusText}
        </span>
        <span>
          目标后端: {backend.name} {backend.version}
        </span>
        <span>积木数: {blockCount}</span>
        <span>
          {diagnosticCount === 0 ? '校验通过' : `${diagnosticCount} 条提醒`}
        </span>
      </div>

      <div className="status-group">
        {selectedBlockId && <span>选中块: {selectedBlockId.slice(0, 12)}</span>}
        <span>单向生成</span>
        <span>UTF-8</span>
      </div>
    </footer>
  );
}
