import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Cpu,
  Eye,
  RotateCcw,
  Settings2,
  Timer,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { backendRegistry } from '../core/backends/registry';
import type { GeneratedCodeResult } from '../core/backends/types';
import { formatTimerLabel } from '../core/blocks/timerConfigBridge';
import type {
  VirtualBoardInputs,
  VirtualBoardState,
} from '../core/extensions/types';
import { highlightCodeLine } from '../core/highlight';
import type { RunnerStatus } from '../core/runners/types';
import type {
  RuntimeHandle,
  RuntimeTelemetry,
  ScriptLanguageId,
} from '../types/project';

interface CodeInspectorProps {
  language: ScriptLanguageId;
  scriptName: string;
  generated: GeneratedCodeResult;
  selectedBlockId: string | null;
  executingBlockId: string | null;
  isPaused: boolean;
  runnerStatus: RunnerStatus;
  multiHandleRunning: boolean;
  breakpoints: string[];
  variables: Record<string, string>;
  errorLine: number | null;
  showVirtualBoard: boolean;
  virtualBoard: VirtualBoardState;
  mockInputs: VirtualBoardInputs;
  projectHandles: RuntimeHandle[];
  activeHandle: RuntimeHandle;
  handleTelemetries: Record<string, RuntimeTelemetry>;
  onUpdateMockInputs: (patch: Partial<VirtualBoardInputs>) => void;
  onResetVirtualBoard: () => void;
  onOpenHandleTimerSettings: (handleId: string) => void;
  onSelectBlockFromLine: (blockId: string) => void;
  onToggleBreakpoint: (blockId: string) => void;
  onClearBreakpoints: () => void;
  onCopyCode: () => void;
}

const KIND_BADGE: Record<string, { text: string; cls: string }> = {
  shared: { text: '共享', cls: 'scope-tag shared' },
  local: { text: 'local', cls: 'scope-tag local' },
  param: { text: '形参', cls: 'scope-tag param' },
  'scope-global': { text: '本域', cls: 'scope-tag single' },
};

export function CodeInspector({
  language,
  scriptName,
  generated,
  selectedBlockId,
  executingBlockId,
  isPaused,
  runnerStatus,
  multiHandleRunning,
  breakpoints,
  variables,
  errorLine,
  showVirtualBoard,
  virtualBoard,
  mockInputs,
  projectHandles,
  activeHandle,
  handleTelemetries,
  onUpdateMockInputs,
  onResetVirtualBoard,
  onOpenHandleTimerSettings,
  onSelectBlockFromLine,
  onToggleBreakpoint,
  onClearBreakpoints,
  onCopyCode,
}: CodeInspectorProps) {
  const [activeTab, setActiveTab] = useState<
    'code' | 'vars' | 'board' | 'diagnostics'
  >('code');
  const [collapsedScopes, setCollapsedScopes] = useState<Record<string, boolean>>({});
  const codeScrollRef = useRef<HTMLDivElement | null>(null);
  const backend = backendRegistry.get(language);
  const displayFileName = `${scriptName}.${backend.extension}`;
  const breakpointSet = useMemo(() => new Set(breakpoints), [breakpoints]);

  const activeTelemetry = handleTelemetries[activeHandle.id] ?? null;
  const anyEventLoopRunning = useMemo(
    () =>
      (runnerStatus === 'running' || runnerStatus === 'paused') &&
      Object.values(handleTelemetries).some((t) => t.eventLoopActive),
    [runnerStatus, handleTelemetries],
  );

  const showSimTab =
    showVirtualBoard ||
    Boolean(generated.isEventDriven) ||
    anyEventLoopRunning ||
    projectHandles.length > 1;

  useEffect(() => {
    if (!showSimTab && activeTab === 'board') {
      setActiveTab('code');
    }
  }, [showSimTab, activeTab]);

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
          !lineText.startsWith('# 当程序启动') &&
          !lineText.startsWith('function on_') &&
          !lineText.startsWith('def on_') &&
          !lineText.startsWith('if id ==') &&
          !lineText.startsWith('elseif id ==') &&
          !lineText.startsWith('elif id ==') &&
          !lineText.startsWith('if key ==') &&
          !lineText.startsWith('elseif key ==') &&
          !lineText.startsWith('elif key ==')
        ) {
          map[range.startLine] = blockId;
        }
      }
    }
    return map;
  }, [generated.sourceMap, generated.lineToBlock, lines]);

  const scopeNodes = generated.variableScopes ?? [];
  const totalScopedVarCount = useMemo(() => {
    const uniqueNames = new Set<string>();
    for (const node of scopeNodes) {
      for (const v of node.variables) {
        uniqueNames.add(`${node.id}:${v.name}`);
      }
    }
    return uniqueNames.size || generated.variableNames.length;
  }, [scopeNodes, generated.variableNames.length]);

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

  // Determine which handles to display in the Runtime Monitor card
  const monitoredHandles = useMemo(() => {
    if (multiHandleRunning) {
      const running = projectHandles.filter((h) => h.autoStart);
      return running.length > 0 ? running : [activeHandle];
    }
    return [activeHandle];
  }, [multiHandleRunning, projectHandles, activeHandle]);

  return (
    <aside className="inspector-pane" aria-label="实时代码、模拟外设、变量与校验面板">
      <div className={`pane-header ${showSimTab ? 'has-board' : ''}`}>
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

          {showSimTab && (
            <button
              type="button"
              className={`pane-tab ${activeTab === 'board' ? 'active' : ''}`}
              onClick={() => setActiveTab('board')}
              title="虚拟硬件外设与多句柄事件定时器模拟面板"
            >
              <Cpu size={12} style={{ flexShrink: 0 }} />
              <span>模拟</span>
              {(virtualBoard.led || anyEventLoopRunning) && (
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
            <span className="count-badge">{totalScopedVarCount}</span>
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
                    className={`bp-gutter ${bpBlockId ? 'can-bp' : ''} ${
                      hasBp ? 'has-bp' : ''
                    }`}
                    disabled={!bpBlockId}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (bpBlockId) {
                        onToggleBreakpoint(bpBlockId);
                      }
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

          {showSimTab && !isPaused && (
            <div
              className="vboard-mini-strip"
              onClick={() => setActiveTab('board')}
              title="点击展开虚拟外设与定时器调度面板"
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {showVirtualBoard && (
                  <>
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
                  </>
                )}
                {anyEventLoopRunning && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      color: 'var(--success)',
                      fontWeight: 600,
                    }}
                  >
                    <span className="rt-pulse-dot" />
                    {multiHandleRunning
                      ? `${monitoredHandles.length}句柄并发`
                      : '事件循环'}
                  </span>
                )}
              </div>
              <span style={{ color: 'var(--accent)', fontWeight: 600, flexShrink: 0 }}>
                打开模拟面板 →
              </span>
            </div>
          )}
        </>
      )}

      {activeTab === 'board' && showSimTab && (
        <div className="vboard-wrap">
          {showVirtualBoard && (
            <>
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
                  <span>模拟按键 (board / on_button)</span>
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
            </>
          )}

          {/* Per-Handle Runtime & Timer Monitor Card(s) */}
          {monitoredHandles.map((hdl) => {
            const tele = handleTelemetries[hdl.id] ?? (hdl.id === activeHandle.id ? activeTelemetry : null);
            const hRunning =
              (runnerStatus === 'running' || runnerStatus === 'paused') &&
              Boolean(tele?.eventLoopActive);

            return (
              <div
                key={hdl.id}
                className="vboard-control-card rt-monitor-card"
                aria-label={`句柄 ${hdl.name} 定时器监控`}
              >
                <div className="vboard-slider-head">
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      minWidth: 0,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span
                      className="lang-dot"
                      style={{ background: hdl.color, flexShrink: 0 }}
                    />
                    <Timer size={12} style={{ flexShrink: 0 }} />
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {hdl.name} (0~{hdl.timerConfig.count - 1})
                    </span>
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <span
                      className={`status-pill ${hRunning ? 'ok' : 'idle'}`}
                      style={{ fontSize: 10.5, padding: '1px 7px' }}
                    >
                      {hRunning ? '事件循环中' : '待机'}
                    </span>
                    <button
                      type="button"
                      className="script-tab-icon-btn"
                      title={`配置句柄 ${hdl.name} 定时器`}
                      onClick={() => onOpenHandleTimerSettings(hdl.id)}
                    >
                      <Settings2 size={12} />
                    </button>
                  </div>
                </div>

                <div className="rt-run-meta">
                  <span>
                    <code>on_run</code>：
                    {tele?.hasOnRun
                      ? tele.runActive
                        ? `每 ${tele.runPeriodMs}ms（已执行 ${tele.runCount} 次）`
                        : `已暂停（周期 ${tele.runPeriodMs}ms）`
                      : '未定义 / 待机'}
                  </span>
                </div>

                {tele && tele.timers.length > 0 ? (
                  <div className="rt-timer-list">
                    {tele.timers.map((t) => {
                      const pct = Math.min(
                        100,
                        Math.round((t.elapsedMs / Math.max(1, t.periodMs)) * 100),
                      );
                      const repText =
                        t.repeat === 0
                          ? `循环 · 第 ${t.firedCount} 次`
                          : `${t.firedCount}/${t.repeat} 次`;
                      return (
                        <div key={t.id} className="rt-timer-row">
                          <div className="rt-timer-head">
                            <span className="rt-timer-label">
                              {formatTimerLabel(t.id, hdl.timerConfig)}
                            </span>
                            <span className="rt-timer-meta">
                              {t.elapsedMs}/{t.periodMs}ms · {repText}
                            </span>
                          </div>
                          <div className="rt-timer-bar-track">
                            <div
                              className="rt-timer-bar-fill"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    暂无活跃定时器；启动 <code>rt.start_timer</code> 后在此实时显示各通道进度。
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {activeTab === 'vars' && (
        <div className="var-tree" aria-label="作用域树形变量监视器">
          {scopeNodes.length === 0 ? (
            <div className="console-empty" style={{ padding: 24 }}>
              当前脚本暂无变量或回调作用域；拖入「共享变量」或「局部变量 (local)」积木后将在此按作用域树形展示。
            </div>
          ) : (
            scopeNodes.map((node) => {
              const isCollapsed = Boolean(collapsedScopes[node.id]);
              return (
                <div key={node.id} className="scope-tree-group">
                  <button
                    type="button"
                    className={`scope-tree-header ${node.category}`}
                    onClick={() =>
                      setCollapsedScopes((prev) => ({
                        ...prev,
                        [node.id]: !prev[node.id],
                      }))
                    }
                  >
                    {isCollapsed ? (
                      <ChevronRight size={13} style={{ flexShrink: 0 }} />
                    ) : (
                      <ChevronDown size={13} style={{ flexShrink: 0 }} />
                    )}
                    <span className="scope-tree-title">{node.label}</span>
                    <span className="count-badge">{node.variables.length}</span>
                  </button>

                  {!isCollapsed && (
                    <div className="scope-tree-body">
                      {node.variables.length === 0 ? (
                        <div className="scope-empty-row">此作用域内无独占变量</div>
                      ) : (
                        node.variables.map((v) => {
                          const hasLive = Object.prototype.hasOwnProperty.call(
                            variables,
                            v.name,
                          );
                          const liveVal = hasLive
                            ? variables[v.name]
                            : '未运行 / 未赋值';
                          const badge = KIND_BADGE[v.kind] ?? KIND_BADGE.shared;

                          return (
                            <div
                              key={`${node.id}-${v.kind}-${v.name}`}
                              className={`scope-var-row ${v.firstBlockId ? 'clickable' : ''}`}
                              onClick={() => {
                                if (v.firstBlockId) {
                                  onSelectBlockFromLine(v.firstBlockId);
                                }
                              }}
                              title={
                                v.usedInScopes && v.usedInScopes.length > 0
                                  ? `跨作用域共享：${v.usedInScopes.join(' · ')}（点击定位积木）`
                                  : v.firstBlockId
                                    ? '点击定位到声明/赋值积木'
                                    : undefined
                              }
                            >
                              <div className="scope-var-left">
                                <span className={badge.cls}>{badge.text}</span>
                                <span className="var-row-name">{v.name}</span>
                                {v.usedInScopes && v.usedInScopes.length > 1 && (
                                  <span className="scope-usage-hint">
                                    {v.usedInScopes.join('·')}
                                  </span>
                                )}
                              </div>
                              <span
                                className="var-row-val"
                                style={
                                  hasLive
                                    ? undefined
                                    : { color: 'var(--text-muted)', fontWeight: 400 }
                                }
                              >
                                {liveVal}
                              </span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })
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
              <span>静态检查通过：结构完整，无悬空积木、重复回调或越界通道。</span>
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
                  style={{
                    color: d.severity === 'error' ? 'var(--danger)' : 'var(--warning)',
                    flexShrink: 0,
                    marginTop: 2,
                  }}
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
