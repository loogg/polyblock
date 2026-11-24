import { AlertTriangle, CheckCircle2, Code2, Copy, Eye } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { backendRegistry } from '../core/backends/registry';
import type { GeneratedCodeResult } from '../core/backends/types';
import { highlightCodeLine } from '../core/highlight';
import type { ScriptLanguageId } from '../types/project';

interface CodeInspectorProps {
  language: ScriptLanguageId;
  generated: GeneratedCodeResult;
  selectedBlockId: string | null;
  executingBlockId: string | null;
  isPaused: boolean;
  breakpoints: string[];
  variables: Record<string, string>;
  errorLine: number | null;
  onSelectBlockFromLine: (blockId: string) => void;
  onToggleBreakpoint: (blockId: string) => void;
  onClearBreakpoints: () => void;
  onCopyCode: () => void;
}

export function CodeInspector({
  language,
  generated,
  selectedBlockId,
  executingBlockId,
  isPaused,
  breakpoints,
  variables,
  errorLine,
  onSelectBlockFromLine,
  onToggleBreakpoint,
  onClearBreakpoints,
  onCopyCode,
}: CodeInspectorProps) {
  const [activeTab, setActiveTab] = useState<'code' | 'vars' | 'diagnostics'>('code');
  const codeScrollRef = useRef<HTMLDivElement | null>(null);
  const backend = backendRegistry.get(language);
  const breakpointSet = useMemo(() => new Set(breakpoints), [breakpoints]);

  const lines = useMemo(() => generated.code.split('\n'), [generated.code]);

  const activeRange = selectedBlockId
    ? generated.sourceMap[selectedBlockId]
    : undefined;

  const execRange = executingBlockId
    ? generated.sourceMap[executingBlockId]
    : undefined;

  // Map each line to the start-line block that can hold a breakpoint
  const lineBreakpointBlock = useMemo(() => {
    const map: Record<number, string> = {};
    for (const [blockId, range] of Object.entries(generated.sourceMap)) {
      // Skip outer start-hat block so breakpoint targets actual executable statements
      if (generated.lineToBlock[range.startLine] === blockId) {
        const lineText = (lines[range.startLine - 1] ?? '').trim();
        if (!lineText.startsWith('-- 当程序启动') && !lineText.startsWith('# 当程序启动')) {
          map[range.startLine] = blockId;
        }
      }
    }
    return map;
  }, [generated.sourceMap, generated.lineToBlock, lines]);

  // Merged variable list: live runtime values + declared workspace variables
  const displayVariables = useMemo(() => {
    const merged: Array<{ name: string; value: string; live: boolean }> = [];
    const seen = new Set<string>();
    for (const name of generated.variableNames) {
      seen.add(name);
      if (Object.prototype.hasOwnProperty.call(variables, name)) {
        merged.push({ name, value: variables[name], live: true });
      } else {
        merged.push({ name, value: '未运行 / 未赋值', live: false });
      }
    }
    for (const [name, value] of Object.entries(variables)) {
      if (!seen.has(name)) {
        merged.push({ name, value, live: true });
      }
    }
    return merged;
  }, [generated.variableNames, variables]);

  const liveVarEntries = useMemo(
    () => Object.entries(variables),
    [variables],
  );

  // Follow executing block line smoothly during stepping/playback
  useEffect(() => {
    if (activeTab !== 'code' || !codeScrollRef.current) return;
    const targetLine = execRange?.startLine ?? activeRange?.startLine;
    if (!targetLine) return;
    const rowEl = codeScrollRef.current.querySelector<HTMLElement>(
      `[data-line="${targetLine}"]`,
    );
    rowEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeTab, execRange, activeRange]);

  return (
    <aside className="inspector-pane" aria-label="实时代码、变量与校验面板">
      <div className="pane-header">
        <div className="pane-tabs">
          <button
            type="button"
            className={`pane-tab ${activeTab === 'code' ? 'active' : ''}`}
            onClick={() => setActiveTab('code')}
          >
            <Code2 size={14} />
            <span>{backend.fileName}</span>
            {breakpoints.length > 0 && (
              <span className="count-badge err" title={`当前已设 ${breakpoints.length} 个断点`}>
                ● {breakpoints.length}
              </span>
            )}
          </button>

          <button
            type="button"
            className={`pane-tab ${activeTab === 'vars' ? 'active' : ''}`}
            onClick={() => setActiveTab('vars')}
          >
            <Eye size={13} />
            <span>变量</span>
            <span className="count-badge">{displayVariables.length}</span>
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
                ? '✓'
                : `${generated.diagnostics.length}`}
            </span>
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {breakpoints.length > 0 && activeTab === 'code' && (
            <button
              type="button"
              className="btn-ghost"
              onClick={onClearBreakpoints}
              title="清除全部断点"
              style={{ padding: '2px 6px', fontSize: 11 }}
            >
              清断点
            </button>
          )}
          <button
            type="button"
            className="btn-ghost"
            onClick={onCopyCode}
            title="复制当前干净脚本"
            aria-label="复制当前脚本"
            style={{ padding: '4px 6px' }}
          >
            <Copy size={13} />
          </button>
        </div>
      </div>

      {activeTab === 'code' && (
        <>
          <div className="code-body" ref={codeScrollRef}>
            {lines.map((line, idx) => {
              const lineNum = idx + 1;
              const isExec =
                execRange !== undefined &&
                lineNum >= execRange.startLine &&
                lineNum <= execRange.endLine;
              const isSelected =
                !isExec &&
                activeRange !== undefined &&
                lineNum >= activeRange.startLine &&
                lineNum <= activeRange.endLine;
              const isError = errorLine === lineNum;
              const mappedBlockId = generated.lineToBlock[lineNum];
              const bpBlockId = lineBreakpointBlock[lineNum];
              const hasBp = bpBlockId !== undefined && breakpointSet.has(bpBlockId);

              const lineClass = isError
                ? 'error-line'
                : isExec
                ? isPaused
                  ? 'paused-line'
                  : 'exec-line'
                : isSelected
                ? 'active-line'
                : '';

              return (
                <div
                  key={lineNum}
                  data-line={lineNum}
                  className={`code-line ${lineClass}`}
                  onClick={() => {
                    if (mappedBlockId) {
                      onSelectBlockFromLine(mappedBlockId);
                    }
                  }}
                >
                  <button
                    type="button"
                    className={`bp-gutter ${hasBp ? 'has-bp' : ''} ${
                      bpBlockId ? '' : 'disabled'
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (bpBlockId) onToggleBreakpoint(bpBlockId);
                    }}
                    title={
                      bpBlockId
                        ? hasBp
                          ? '点击取消断点'
                          : '点击设置断点'
                        : undefined
                    }
                    aria-label={
                      bpBlockId
                        ? `${hasBp ? '取消' : '设置'}第 ${lineNum} 行断点`
                        : undefined
                    }
                  >
                    <span className="bp-dot" />
                  </button>
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

          {isPaused && (
            <div className="paused-var-strip" aria-label="暂停态变量快照">
              <div className="paused-var-head">
                <span>
                  ⏸ 已暂停
                  {execRange ? ` · 第 ${execRange.startLine} 行` : ''}
                </span>
                <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                  实时变量快照
                </span>
              </div>
              <div className="paused-var-chips">
                {liveVarEntries.length === 0 ? (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    当前作用域暂无已赋值变量
                  </span>
                ) : (
                  liveVarEntries.map(([name, val]) => (
                    <span key={name} className="var-chip">
                      <span className="var-chip-name">{name}</span>
                      <span>=</span>
                      <span>{val}</span>
                    </span>
                  ))
                )}
              </div>
            </div>
          )}
        </>
      )}

      {activeTab === 'vars' && (
        <div className="var-table">
          {displayVariables.length === 0 ? (
            <div className="console-empty" style={{ padding: 24 }}>
              当前画布暂无变量；拖入变量积木并运行/单步调试后，可在此实时监视变量值。
            </div>
          ) : (
            displayVariables.map((item) => (
              <div key={item.name} className="var-row">
                <span className="var-row-name">{item.name}</span>
                <span
                  className="var-row-val"
                  style={
                    item.live
                      ? undefined
                      : { color: 'var(--text-muted)', fontWeight: 400 }
                  }
                >
                  {item.value}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'diagnostics' && (
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
