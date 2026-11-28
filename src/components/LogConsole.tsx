import { ChevronDown, Terminal, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogEntry, LogLevel } from '../types/project';

interface LogConsoleProps {
  logs: LogEntry[];
  lastDurationMs: number | null;
  onClear: () => void;
  onCollapse: () => void;
  onJumpToBlock: (blockId: string) => void;
}

type LogFilter = 'all' | 'print' | 'info' | 'warn' | 'error';

const FILTER_OPTIONS: Array<{ id: LogFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'print', label: 'PRINT' },
  { id: 'info', label: 'INFO' },
  { id: 'warn', label: 'WARN' },
  { id: 'error', label: 'ERR' },
];

function matchesFilter(level: LogLevel, filter: LogFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'info') return level === 'info' || level === 'ok' || level === 'system';
  return level === filter;
}

export function LogConsole({
  logs,
  lastDurationMs,
  onClear,
  onCollapse,
  onJumpToBlock,
}: LogConsoleProps) {
  const [filter, setFilter] = useState<LogFilter>('all');
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const visibleLogs = useMemo(
    () => logs.filter((item) => matchesFilter(item.level, filter)),
    [logs, filter],
  );

  const lastVisibleLogId = visibleLogs[visibleLogs.length - 1]?.id ?? null;

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [visibleLogs.length, lastVisibleLogId]);

  return (
    <section className="console-pane" aria-label="打印日志控制台">
      <div className="pane-header">
        <div className="pane-tabs" style={{ gap: 10 }}>
          <span className="pane-tab active" style={{ cursor: 'default' }}>
            <Terminal size={14} />
            <span>打印日志控制台</span>
            <span className="count-badge">{logs.length}</span>
          </span>

          <div className="filter-pills" role="group" aria-label="日志级别过滤">
            {FILTER_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                aria-pressed={filter === opt.id}
                className={`filter-pill ${filter === opt.id ? 'active' : ''}`}
                onClick={() => setFilter(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {lastDurationMs !== null && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              上次耗时 {lastDurationMs}ms
            </span>
          )}
          <button
            type="button"
            className="btn-ghost"
            onClick={onClear}
            style={{ padding: '2px 7px', fontSize: 11.5 }}
            title="清空日志"
          >
            <Trash2 size={12} />
            <span>清空</span>
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={onCollapse}
            style={{ padding: '2px 6px', fontSize: 11.5 }}
            title="收起日志面板"
            aria-label="收起日志面板"
          >
            <ChevronDown size={14} />
          </button>
        </div>
      </div>

      <div className="console-body" ref={bodyRef}>
        {visibleLogs.length === 0 ? (
          <div className="console-empty">
            点击顶部「▶ 运行」即可在纯前端浏览器沙箱中执行脚本并查看实时打印日志
          </div>
        ) : (
          visibleLogs.map((entry) => (
            <div key={entry.id} className="log-row">
              <span className="log-time">{entry.timestamp}</span>
              {entry.handleName && (
                <span
                  className="log-handle-badge"
                  style={{
                    borderColor: entry.handleColor || 'var(--accent)',
                    color: entry.handleColor || 'var(--accent)',
                  }}
                >
                  {entry.handleName}
                </span>
              )}
              <span className={`log-lvl ${entry.level}`}>
                {entry.level.toUpperCase()}
              </span>
              <span className="log-msg">{entry.message}</span>
              {entry.blockId && (
                <button
                  type="button"
                  className="log-jump"
                  onClick={() => onJumpToBlock(entry.blockId!)}
                  title="跳转到报错积木"
                >
                  定位积木{entry.line ? ` (第 ${entry.line} 行)` : ''}
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
