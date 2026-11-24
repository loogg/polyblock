import { AlertTriangle, CheckCircle2, Code2, Copy } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { backendRegistry } from '../core/backends/registry';
import type { GeneratedCodeResult } from '../core/backends/types';
import { highlightCodeLine } from '../core/highlight';
import type { ScriptLanguageId } from '../types/project';

interface CodeInspectorProps {
  language: ScriptLanguageId;
  generated: GeneratedCodeResult;
  selectedBlockId: string | null;
  errorLine: number | null;
  onSelectBlockFromLine: (blockId: string) => void;
  onCopyCode: () => void;
}

export function CodeInspector({
  language,
  generated,
  selectedBlockId,
  errorLine,
  onSelectBlockFromLine,
  onCopyCode,
}: CodeInspectorProps) {
  const [activeTab, setActiveTab] = useState<'code' | 'diagnostics'>('code');
  const codeScrollRef = useRef<HTMLDivElement | null>(null);
  const backend = backendRegistry.get(language);

  const lines = useMemo(
    () => generated.code.split('\n'),
    [generated.code],
  );

  const activeRange = selectedBlockId
    ? generated.sourceMap[selectedBlockId]
    : undefined;

  useEffect(() => {
    if (activeTab !== 'code' || !activeRange || !codeScrollRef.current) return;
    const rowEl = codeScrollRef.current.querySelector<HTMLElement>(
      `[data-line="${activeRange.startLine}"]`,
    );
    rowEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeTab, activeRange]);

  return (
    <aside className="inspector-pane" aria-label="实时代码与校验面板">
      <div className="pane-header">
        <div className="pane-tabs">
          <button
            type="button"
            className={`pane-tab ${activeTab === 'code' ? 'active' : ''}`}
            onClick={() => setActiveTab('code')}
          >
            <Code2 size={14} />
            <span>{backend.fileName}</span>
            <span className="count-badge">只读</span>
          </button>

          <button
            type="button"
            className={`pane-tab ${activeTab === 'diagnostics' ? 'active' : ''}`}
            onClick={() => setActiveTab('diagnostics')}
          >
            <span>校验</span>
            <span
              className={`count-badge ${
                generated.diagnostics.length === 0 ? 'ok' : 'warn'
              }`}
            >
              {generated.diagnostics.length === 0
                ? '通过'
                : `${generated.diagnostics.length} 提醒`}
            </span>
          </button>
        </div>

        <button
          type="button"
          className="btn-ghost"
          onClick={onCopyCode}
          title="复制当前脚本"
          aria-label="复制当前脚本"
          style={{ padding: '4px 6px' }}
        >
          <Copy size={13} />
        </button>
      </div>

      {activeTab === 'code' ? (
        <div className="code-body" ref={codeScrollRef}>
          {lines.map((line, idx) => {
            const lineNum = idx + 1;
            const isHighlighted =
              activeRange !== undefined &&
              lineNum >= activeRange.startLine &&
              lineNum <= activeRange.endLine;
            const isError = errorLine === lineNum;
            const mappedBlockId = generated.lineToBlock[lineNum];

            return (
              <div
                key={lineNum}
                data-line={lineNum}
                className={`code-line ${isHighlighted ? 'active-line' : ''} ${
                  isError ? 'error-line' : ''
                }`}
                onClick={() => {
                  if (mappedBlockId) {
                    onSelectBlockFromLine(mappedBlockId);
                  }
                }}
                title={mappedBlockId ? '点击定位到画布对应积木' : undefined}
              >
                <span className="ln">{lineNum}</span>
                <span
                  className="lc"
                  dangerouslySetInnerHTML={{
                    __html: highlightCodeLine(line, language),
                  }}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="diag-list">
          {generated.diagnostics.length === 0 ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                color: 'var(--success)',
                fontSize: 12.5,
                padding: '10px 4px',
              }}
            >
              <CheckCircle2 size={16} />
              <span>静态检查通过：结构完整，无悬空积木或空入口块。</span>
            </div>
          ) : (
            generated.diagnostics.map((d) => (
              <button
                key={d.id}
                type="button"
                className="diag-item"
                onClick={() => {
                  if (d.blockId) onSelectBlockFromLine(d.blockId);
                }}
              >
                <AlertTriangle
                  size={15}
                  style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 2 }}
                />
                <span>{d.message}</span>
              </button>
            ))
          )}
        </div>
      )}
    </aside>
  );
}
