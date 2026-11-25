import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Copy,
  Cpu,
  Eye,
  RotateCcw,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { backendRegistry } from '../core/backends/registry';
import type { GeneratedCodeResult } from '../core/backends/types';
import type {
  VirtualBoardInputs,
  VirtualBoardState,
} from '../core/extensions/types';
import { highlightCodeLine } from '../core/highlight';
import type { ScriptLanguageId } from '../types/project';

interface CodeInspectorProps {
  language: ScriptLanguageId;
  scriptName: string;
  generated: GeneratedCodeResult;
  selectedBlockId: string | null;
  executingBlockId: string | null;
  isPaused: boolean;
  breakpoints: string[];
  variables: Record<string, string>;
  errorLine: number | null;
  showVirtualBoard: boolean;
  virtualBoard: VirtualBoardState;
  mockInputs: VirtualBoardInputs;
  onUpdateMockInputs: (patch: Partial<VirtualBoardInputs>) => void;
  onResetVirtualBoard: () => void;
  onSelectBlockFromLine: (blockId: string) => void;
  onToggleBreakpoint: (blockId: string) => void;
  onClearBreakpoints: () => void;
  onCopyCode: () => void;
}

export function CodeInspector({
  language,
  scriptName,
  generated,
  selectedBlockId,
  executingBlockId,
  isPaused,
  breakpoints,
  variables,
  errorLine,
  showVirtualBoard,
  virtualBoard,
  mockInputs,
  onUpdateMockInputs,
  onResetVirtualBoard,
  onSelectBlockFromLine,
  onToggleBreakpoint,
  onClearBreakpoints,
  onCopyCode,
}: CodeInspectorProps) {
  const [activeTab, setActiveTab] = useState<
    'code' | 'vars' | 'board' | 'diagnostics'
  >('code');
  const codeScrollRef = useRef<HTMLDivElement | null>(null);
  const backend = backendRegistry.get(language);
  const displayFileName = `${scriptName}.${backend.extension}`;
  const breakpointSet = useMemo(() => new Set(breakpoints), [breakpoints]);

  // Fall back to code tab if virtual board pack gets disabled
  useEffect(() => {
    if (!showVirtualBoard && activeTab === 'board') {
      setActiveTab('code');
    }
  }, [showVirtualBoard, activeTab]);

  const lines = useMemo(() => generated.code.split('\n'), [generated.code]);

  const activeRange = selectedBlockId
    ? generated.sourceMap[selectedBlockId]
    : undefined;

  const execRange = executingBlockId
    ? generated.sourceMap[executingBlockId]
    : undefined;

  const lineBreakpointBlock = useMemo(() => {
    const map: Record<number, string> = {};
    for (const [blockId, range] of Object.entries(generated.sourceMap)) {
      if (generated.lineToBlock[range.startLine] === blockId) {
        const lineText = (lines[range.startLine - 1] ?? '').trim();
        if (
          !lineText.startsWith('-- 当程序启动') &&
          !lineText.startsWith('# 当程序启动')
        ) {
          map[range.startLine] = blockId;
        }
      }
    }
    return map;
  }, [generated.sourceMap, generated.lineToBlock, lines]);

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

  const liveVarEntries = useMemo(() => Object.entries(variables), [variables]);

  useEffect(() => {
    if (activeTab !== 'code' || !codeScrollRef.current) return;
    const targetLine = execRange?.startLine ?? activeRange?.startLine;
    if (!targetLine) return;
    const rowEl = codeScrollRef.current.querySelector<HTMLElement>(
      `[data-line="${targetLine}"]`,
    );
    rowEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeTab, execRange, activeRange]);

  const rgbActive = virtualBoard.rgb !== '#1e293b' && virtualBoard.rgb !== '#334155';

  return (
    <aside className="inspector-pane" aria-label="实时代码、模拟外设、变量与校验面板">
      <div className={`pane-header ${showVirtualBoard ? 'has-board' : ''}`}>
        <div className="pane-tabs">
          <button
            type="button"
            className={`pane-tab pane-tab-code ${activeTab === 'code' ? 'active' : ''}`}
            onClick={() => setActiveTab('code')}
          >
            <Code2 size={13} style={{ flexShrink: 0 }} />
            <span className="code-tab-filename" title={displayFileName}>
              {displayFileName}
            </span>
            {breakpoints.length > 0 && (
              <span
                className="count-badge err"
                title={`当前已设 ${breakpoints.length} 个断点`}
              >
                ● {breakpoints.length}
              </span>
            )}
          </button>

          {showVirtualBoard && (
            <button
              type="button"
              className={`pane-tab ${activeTab === 'board' ? 'active' : ''}`}
              onClick={() => setActiveTab('board')}
              title="虚拟硬件外设模拟面板"
            >
              <Cpu size={12} style={{ flexShrink: 0 }} />
              <span>模拟</span>
              {virtualBoard.led && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: '#22c55e',
                    display: 'inline-block',
                    flexShrink: 0,
                  }}
                />
              )}
            </button>
          )}

          <button
            type="button"
            className={`pane-tab ${activeTab === 'vars' ? 'active' : ''}`}
            onClick={() => setActiveTab('vars')}
          >
            <Eye size={12} style={{ flexShrink: 0 }} />
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          {breakpoints.length > 0 && activeTab === 'code' && (
            <button
              type="button"
              className="btn-ghost"
              onClick={onClearBreakpoints}
              title="清除全部断点"
              style={{ padding: '2px 5px', fontSize: 11 }}
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
              const hasBp =
                bpBlockId !== undefined && breakpointSet.has(bpBlockId);

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

          {showVirtualBoard && !isPaused && (
            <div
              className="vboard-mini-strip"
              onClick={() => setActiveTab('board')}
              title="点击展开虚拟外设模拟面板"
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span
                    className={`vboard-led ${virtualBoard.led ? 'on' : ''}`}
                    style={{ width: 9, height: 9 }}
                  />
                  LED
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span
                    className="vboard-rgb"
                    style={{
                      width: 10,
                      height: 10,
                      background: virtualBoard.rgb,
                      boxShadow: rgbActive ? `0 0 8px ${virtualBoard.rgb}` : 'none',
                    }}
                  />
                  RGB
                </span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>
                  {mockInputs.temp}°C
                </span>
              </div>
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                打开模拟面板 →
              </span>
            </div>
          )}
        </>
      )}

      {activeTab === 'board' && showVirtualBoard && (
        <div className="vboard-wrap">
          <div className="vboard-pcb">
            <div className="vboard-top-row">
              <span className="vboard-title" title="POLYBLOCK VIRTUAL BOARD v1">
                POLYBLOCK VIRTUAL BOARD v1
              </span>
              <button
                type="button"
                className="vboard-reset-btn"
                onClick={onResetVirtualBoard}
                title="复位虚拟外设输出"
              >
                <RotateCcw size={11} style={{ flexShrink: 0 }} />
                <span>复位</span>
              </button>
            </div>

            <div className="vboard-indicators">
              <div className="vboard-lamp-item">
                <span
                  className={`vboard-led ${virtualBoard.led ? 'on' : ''}`}
                  aria-label={virtualBoard.led ? 'LED 已点亮' : 'LED 已熄灭'}
                />
                <span>板载 LED：{virtualBoard.led ? 'ON' : 'OFF'}</span>
              </div>

              <div className="vboard-lamp-item">
                <span
                  className="vboard-rgb"
                  style={{
                    background: virtualBoard.rgb,
                    boxShadow: rgbActive
                      ? `0 0 14px ${virtualBoard.rgb}, 0 0 4px #ffffff`
                      : 'none',
                  }}
                />
                <span>RGB</span>
              </div>
            </div>

            <div className="vboard-oled" aria-label="虚拟 OLED 显示屏">
              {virtualBoard.oledLines.length === 0 ? (
                <span style={{ opacity: 0.45 }}>[OLED 已清空]</span>
              ) : (
                virtualBoard.oledLines.map((line, i) => (
                  <div key={i}>{line}</div>
                ))
              )}
            </div>
          </div>

          <div className="vboard-control-card">
            <div className="vboard-slider-head">
              <span>模拟温度传感器 (board.read_temp)</span>
              <span className="vboard-temp-val">{mockInputs.temp}°C</span>
            </div>
            <input
              type="range"
              aria-label="模拟温度传感器滑块"
              min={15}
              max={95}
              step={1}
              value={mockInputs.temp}
              onChange={(e) =>
                onUpdateMockInputs({ temp: Number(e.target.value) })
              }
              style={{ width: '100%', accentColor: 'var(--accent)' }}
            />
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 10.5,
                color: 'var(--text-muted)',
              }}
            >
              <span>15°C (低温)</span>
              <span>35°C (演示阈值)</span>
              <span>95°C (高温)</span>
            </div>
          </div>

          <div className="vboard-control-card">
            <div className="vboard-slider-head">
              <span>模拟板载按键 (board.is_pressed)</span>
            </div>
            <div className="vboard-btn-row">
              <button
                type="button"
                className={`vboard-key-btn ${mockInputs.btnA ? 'pressed' : ''}`}
                onClick={() => onUpdateMockInputs({ btnA: !mockInputs.btnA })}
              >
                按键 A · {mockInputs.btnA ? '按下中' : '释放'}
              </button>
              <button
                type="button"
                className={`vboard-key-btn ${mockInputs.btnB ? 'pressed' : ''}`}
                onClick={() => onUpdateMockInputs({ btnB: !mockInputs.btnB })}
              >
                按键 B · {mockInputs.btnB ? '按下中' : '释放'}
              </button>
            </div>
          </div>
        </div>
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
