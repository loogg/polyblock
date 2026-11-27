import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Cpu,
  Eye,
  Settings2,
  Timer,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { backendRegistry } from '../core/backends/registry';
import type { GeneratedCodeResult } from '../core/backends/types';
import { formatChannelLabel } from '../core/blocks/workspaceContextBridge';
import {
  readPackWidgetValue,
  resolveTricolorState,
} from '../core/extensions/simState';
import type {
  PolyExtensionPack,
  ResolvedHandleChannelPoolSpec,
  SimStateMap,
  SimWidgetSpec,
} from '../core/extensions/types';
import { highlightCodeLine } from '../core/highlight';
import { getHandleChannelPoolConfig } from '../core/projects/store';
import type { RunnerStatus } from '../core/runners/types';
import type {
  RuntimeHandle,
  RuntimeTelemetry,
  ScriptLanguageId,
} from '../types/project';
import { SimWidgetPanel } from './SimWidgetPanel';

interface CodeInspectorProps {
  language: ScriptLanguageId;
  scriptName: string;
  generated: GeneratedCodeResult;
  selectedBlockId: string | null;
  executingBlockId: string | null;
  isPaused: boolean;
  runnerStatus: RunnerStatus;
  multiHandleRunning: boolean;
  runningHandleIds?: string[];
  breakpoints: string[];
  variables: Record<string, string>;
  errorLine: number | null;
  runtimeMonitorSummary: {
    hasSchedulerMonitor: boolean;
    hasTimerMonitor: boolean;
    timerPoolConfigKey: string | null;
  };
  channelPools: ResolvedHandleChannelPoolSpec[];
  simPacks: PolyExtensionPack[];
  simState: SimStateMap;
  projectHandles: RuntimeHandle[];
  activeHandle: RuntimeHandle;
  handleTelemetries: Record<string, RuntimeTelemetry>;
  onUpdateSimValues: (patch: Record<string, unknown>) => void;
  onEmitWidgetEvent?: (eventName: string, args: unknown[]) => void;
  onResetSimPack: (pack: PolyExtensionPack) => void;
  onOpenHandleTimerSettings: (handleId: string) => void;
  onSelectBlockFromLine: (blockId: string) => void;
  onToggleBreakpoint: (blockId: string) => void;
  onClearBreakpoints: () => void;
  onCopyCode: () => void;
}

const KIND_BADGE: Record<string, { text: string; cls: string }> = {
  shared: { text: '共享', cls: 'scope-tag shared' },
  local: { text: '局部', cls: 'scope-tag local' },
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
  runningHandleIds = [],
  breakpoints,
  variables,
  errorLine,
  runtimeMonitorSummary,
  channelPools,
  simPacks,
  simState,
  projectHandles,
  activeHandle,
  handleTelemetries,
  onUpdateSimValues,
  onEmitWidgetEvent,
  onResetSimPack,
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

  const hasSimPacks = simPacks.length > 0;
  const { hasSchedulerMonitor, hasTimerMonitor, timerPoolConfigKey } =
    runtimeMonitorSummary;
  const showRtMonitor =
    hasSchedulerMonitor || hasTimerMonitor || anyEventLoopRunning;

  const showSimTab = hasSimPacks || showRtMonitor;

  const allSimWidgets = useMemo<Array<{ pack: PolyExtensionPack; widget: SimWidgetSpec }>>(
    () =>
      simPacks.flatMap((pack) =>
        (pack.simWidgets ?? []).map((widget) => ({ pack, widget })),
      ),
    [simPacks],
  );

  const anySimLedActive = useMemo(
    () =>
      allSimWidgets.some(
        ({ pack, widget }) =>
          widget.kind === 'led' &&
          Boolean(readPackWidgetValue(simState, pack.id, widget)),
      ),
    [allSimWidgets, simState],
  );

  const miniPreviewWidgets = useMemo(() => {
    const picked: Array<{ pack: PolyExtensionPack; widget: SimWidgetSpec }> = [];
    for (const item of allSimWidgets) {
      const k = item.widget.kind;
      if (k === 'led' || k === 'tricolor' || k === 'rgb' || k === 'bar' || k === 'slider') {
        picked.push(item);
        if (picked.length >= 3) break;
      }
    }
    return picked;
  }, [allSimWidgets]);

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

  // Determine which handles to display in the Runtime Monitor card
  const monitoredHandles = useMemo(() => {
    if (runningHandleIds.length > 0) {
      const running = projectHandles.filter((h) =>
        runningHandleIds.includes(h.id),
      );
      if (running.length > 0) return running;
    }
    if (multiHandleRunning) {
      const running = projectHandles.filter((h) => h.autoStart);
      return running.length > 0 ? running : [activeHandle];
    }
    return [activeHandle];
  }, [runningHandleIds, multiHandleRunning, projectHandles, activeHandle]);

  return (
    <aside className="inspector-pane" aria-label="实时代码、模拟外设、变量与校验面板">
      <div className={`pane-header ${showSimTab ? 'has-board' : ''}`}>
        <div className="pane-tabs" role="tablist" aria-label="检视面板切换">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'code'}
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
              role="tab"
              aria-selected={activeTab === 'board'}
              className={`pane-tab ${activeTab === 'board' ? 'active' : ''}`}
              onClick={() => setActiveTab('board')}
              title="虚拟硬件外设与多句柄事件定时器模拟面板"
            >
              <Cpu size={12} style={{ flexShrink: 0 }} />
              <span>模拟</span>
              {(anySimLedActive || anyEventLoopRunning) && (
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
            role="tab"
            aria-selected={activeTab === 'vars'}
            className={`pane-tab ${activeTab === 'vars' ? 'active' : ''}`}
            onClick={() => setActiveTab('vars')}
          >
            <Eye size={12} style={{ flexShrink: 0 }} />
            <span>变量</span>
            <span className="count-badge">{totalScopedVarCount}</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'diagnostics'}
            className={`pane-tab ${activeTab === 'diagnostics' ? 'active' : ''}`}
            onClick={() => setActiveTab('diagnostics')}
          >
            <span>校验</span>
            <span
              className={`count-badge ${
                generated.diagnostics.length === 0
                  ? 'ok'
                  : generated.diagnostics.some((d) => d.severity === 'error')
                    ? 'err'
                    : 'warn'
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
                        ? multiHandleRunning
                          ? hasBp
                            ? '点击取消断点（并发模式不触发暂停）'
                            : '点击保存断点（并发模式不触发暂停，单句柄运行时生效）'
                          : hasBp
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
              role="button"
              tabIndex={0}
              onClick={() => setActiveTab('board')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActiveTab('board');
                }
              }}
              title="点击展开虚拟外设与定时器调度面板"
            >
              <div className="vboard-mini-items">
                {miniPreviewWidgets.map(({ pack, widget: w }) => {
                  const val = readPackWidgetValue(simState, pack.id, w);
                  const itemKey = `${pack.id}:${w.key}`;
                  const tip = `${pack.name} · ${w.label}`;
                  if (w.kind === 'led') {
                    const on = Boolean(val);
                    const litColor = w.color || '#22c55e';
                    return (
                      <span
                        key={itemKey}
                        title={tip}
                        className="vboard-mini-item"
                      >
                        <span
                          className={`vboard-led ${on ? 'on' : ''}`}
                          style={{
                            width: 9,
                            height: 9,
                            ...(on
                              ? {
                                  background: litColor,
                                  boxShadow: `0 0 8px ${litColor}`,
                                }
                              : {}),
                          }}
                        />
                        <span>{w.label.slice(0, 6)}</span>
                      </span>
                    );
                  }
                  if (w.kind === 'tricolor') {
                    const tri = resolveTricolorState(val);
                    return (
                      <span
                        key={itemKey}
                        title={`${tip}：${tri.labelZh}（三色灯）`}
                        className="vboard-mini-item"
                      >
                        <span
                          className="vboard-rgb"
                          style={{
                            width: 10,
                            height: 10,
                            background: tri.hex,
                            boxShadow: tri.active ? `0 0 8px ${tri.hex}` : 'none',
                          }}
                        />
                        <span>{w.label.slice(0, 4)}</span>
                      </span>
                    );
                  }
                  if (w.kind === 'rgb') {
                    const hex = String(val || '#1e293b');
                    const isLit = hex !== '#1e293b' && hex !== '#334155';
                    return (
                      <span
                        key={itemKey}
                        title={tip}
                        className="vboard-mini-item"
                      >
                        <span
                          className="vboard-rgb"
                          style={{
                            width: 10,
                            height: 10,
                            background: hex,
                            boxShadow: isLit ? `0 0 8px ${hex}` : 'none',
                          }}
                        />
                        <span>{w.label.slice(0, 4)}</span>
                      </span>
                    );
                  }
                  return (
                    <span
                      key={itemKey}
                      title={tip}
                      className="vboard-mini-item"
                      style={{ fontFamily: 'var(--font-mono)' }}
                    >
                      {String(val ?? 0)}
                      {w.unit ?? ''}
                    </span>
                  );
                })}
                {!hasSimPacks &&
                  (hasSchedulerMonitor || hasTimerMonitor) &&
                  !anyEventLoopRunning && (
                    <span
                      className="vboard-mini-item"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {hasTimerMonitor ? 'RT 周期与多路定时器' : 'RT 周期调度'}
                    </span>
                  )}
                {anyEventLoopRunning && (
                  <span
                    className="vboard-mini-item"
                    style={{
                      color: 'var(--success-text)',
                      fontWeight: 600,
                    }}
                  >
                    <span className="rt-pulse-dot" />
                    <span>
                      {multiHandleRunning
                        ? `${monitoredHandles.length}句柄并发`
                        : '事件循环'}
                    </span>
                  </span>
                )}
              </div>
              <span className="vboard-mini-link">模拟面板 →</span>
            </div>
          )}
        </>
      )}

      {activeTab === 'board' && showSimTab && (
        <div className="vboard-wrap">
          {hasSimPacks && (
            <SimWidgetPanel
              packs={simPacks}
              simState={simState}
              onUpdateSimValues={onUpdateSimValues}
              onEmitWidgetEvent={onEmitWidgetEvent}
              onResetPack={onResetSimPack}
            />
          )}

          {/* Per-Handle Runtime & Timer Monitor Card(s) — driven declaratively by section.runtimeMonitor metadata */}
          {showRtMonitor &&
            monitoredHandles.map((hdl) => {
              const tele =
                handleTelemetries[hdl.id] ??
                (hdl.id === activeHandle.id ? activeTelemetry : null);
              const hRunning =
                (runnerStatus === 'running' || runnerStatus === 'paused') &&
                Boolean(tele?.eventLoopActive);
              const timerPoolSpec = timerPoolConfigKey
                ? channelPools.find((p) => p.configKey === timerPoolConfigKey)
                : undefined;
              const hdlTimerCfg = timerPoolConfigKey
                ? getHandleChannelPoolConfig(
                    hdl,
                    timerPoolConfigKey,
                    timerPoolSpec?.defaultCount,
                    timerPoolSpec?.min,
                    timerPoolSpec?.max,
                  )
                : null;

              return (
                <div
                  key={hdl.id}
                  className="vboard-control-card rt-monitor-card"
                  aria-label={`句柄 ${hdl.name} 运行时调度监控`}
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
                        {hdl.name}
                        {hasTimerMonitor && hdlTimerCfg
                          ? ` (0~${hdlTimerCfg.count - 1})`
                          : ''}
                      </span>
                    </span>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        flexShrink: 0,
                      }}
                    >
                      <span
                        className={`status-pill ${hRunning ? 'ok' : 'idle'}`}
                        style={{ fontSize: 10.5, padding: '1px 7px' }}
                      >
                        {hRunning ? '事件循环中' : '待机'}
                      </span>
                      <button
                        type="button"
                        className="script-tab-icon-btn"
                        title={`配置句柄 ${hdl.name}`}
                        aria-label={`配置句柄 ${hdl.name}`}
                        onClick={() => onOpenHandleTimerSettings(hdl.id)}
                      >
                        <Settings2 size={12} />
                      </button>
                    </div>
                  </div>

                  {tele?.startCoState && tele.startCoState !== 'idle' && (
                    <div className="rt-run-meta">
                      <span>
                        <code>on_start</code> 协程：
                        {tele.startCoState === 'running'
                          ? '运行中'
                          : tele.startCoState === 'sleeping'
                            ? '休眠中 (sleep_ms)'
                            : tele.startCoState === 'ready'
                              ? `就绪 · 时间片 ${tele.timeSliceMs ?? 20}ms`
                              : '已结束'}
                      </span>
                    </div>
                  )}

                  {(hasSchedulerMonitor || Boolean(tele?.hasOnRun)) && (
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
                  )}

                  {hasTimerMonitor &&
                    (tele && tele.timers.length > 0 ? (
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
                                  {formatChannelLabel(
                                    t.id,
                                    hdlTimerCfg ?? { count: 0, aliases: {} },
                                    timerPoolSpec?.prefix ?? 'T',
                                  )}
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
                    ))}
                </div>
              );
            })}
        </div>
      )}

      {activeTab === 'vars' && (
        <div className="var-tree" aria-label="作用域树形变量监视器">
          {scopeNodes.length === 0 ? (
            <div className="console-empty" style={{ padding: 24 }}>
              当前脚本暂无变量或回调作用域；拖入「共享变量」或「局部变量」积木后将在此按作用域树形展示。
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
                color: 'var(--success-text)',
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
