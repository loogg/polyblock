import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import {
  qualifySimKey,
  readPackWidgetValue,
  resolveTricolorState,
  resolveWidgetEventArgs,
} from '../core/extensions/simState';
import type {
  PolyExtensionPack,
  SimStateMap,
  SimWidgetSpec,
} from '../core/extensions/types';

interface SimWidgetPanelProps {
  packs: PolyExtensionPack[];
  simState: SimStateMap;
  onUpdateSimValues: (patch: Record<string, unknown>) => void;
  onEmitWidgetEvent?: (eventName: string, args: unknown[]) => void;
  onResetPack: (pack: PolyExtensionPack) => void;
}

type WidgetGroup =
  | { kind: 'lamps'; widgets: SimWidgetSpec[] }
  | { kind: 'buttons'; widgets: SimWidgetSpec[] }
  | { kind: 'toggles'; widgets: SimWidgetSpec[] }
  | { kind: 'single'; widget: SimWidgetSpec };

function groupWidgets(widgets: SimWidgetSpec[]): WidgetGroup[] {
  const groups: WidgetGroup[] = [];
  for (const w of widgets) {
    const last = groups[groups.length - 1];
    if (w.kind === 'led' || w.kind === 'tricolor' || w.kind === 'rgb') {
      if (last && last.kind === 'lamps') {
        last.widgets.push(w);
      } else {
        groups.push({ kind: 'lamps', widgets: [w] });
      }
    } else if (w.kind === 'button') {
      if (last && last.kind === 'buttons') {
        last.widgets.push(w);
      } else {
        groups.push({ kind: 'buttons', widgets: [w] });
      }
    } else if (w.kind === 'toggle') {
      if (last && last.kind === 'toggles') {
        last.widgets.push(w);
      } else {
        groups.push({ kind: 'toggles', widgets: [w] });
      }
    } else {
      groups.push({ kind: 'single', widget: w });
    }
  }
  return groups;
}

export function SimWidgetPanel({
  packs,
  simState,
  onUpdateSimValues,
  onEmitWidgetEvent,
  onResetPack,
}: SimWidgetPanelProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const triggerBooleanWidget = (
    pack: PolyExtensionPack,
    w: SimWidgetSpec,
    nextVal: boolean,
  ) => {
    const fullKey = qualifySimKey(pack.id, w.key);
    onUpdateSimValues({ [fullKey]: nextVal });
    if (w.emitEvent) {
      const shouldFire =
        w.emitEvent.trigger === 'rising' ? nextVal === true : true;
      if (shouldFire) {
        const nextSnapshot = { ...simState, [fullKey]: nextVal };
        const args = resolveWidgetEventArgs(pack.id, w, nextVal, nextSnapshot);
        onEmitWidgetEvent?.(w.emitEvent.eventName, args);
      }
    }
  };

  return (
    <>
      {packs.map((pack) => {
        const widgets = pack.simWidgets ?? [];
        if (widgets.length === 0) return null;
        const isCollapsed = Boolean(collapsed[pack.id]);
        const groups = groupWidgets(widgets);

        return (
          <section
            key={pack.id}
            className="sim-pack-card"
            aria-label={`外设模拟卡片：${pack.name}`}
          >
            <div className="sim-pack-header">
              <button
                type="button"
                className="sim-pack-title-btn"
                onClick={() =>
                  setCollapsed((prev) => ({ ...prev, [pack.id]: !prev[pack.id] }))
                }
              >
                {isCollapsed ? (
                  <ChevronRight size={13} style={{ flexShrink: 0 }} />
                ) : (
                  <ChevronDown size={13} style={{ flexShrink: 0 }} />
                )}
                <span
                  className="lang-dot"
                  style={{ background: pack.color, flexShrink: 0 }}
                />
                <span className="sim-pack-title" title={pack.name}>
                  {pack.name}
                </span>
                <span className="count-badge">{widgets.length}</span>
              </button>
              <button
                type="button"
                className="sim-pack-reset-btn"
                onClick={() => onResetPack(pack)}
                title={`复位「${pack.name}」所有模拟控件`}
              >
                <RotateCcw size={11} style={{ flexShrink: 0 }} />
                <span>复位</span>
              </button>
            </div>

            {!isCollapsed && (
              <div className="sim-pack-body">
                {groups.map((grp, gIdx) => {
                  if (grp.kind === 'lamps') {
                    return (
                      <div key={`lamps-${gIdx}`} className="sim-lamp-bar">
                        {grp.widgets.map((w) => {
                          if (w.kind === 'led') {
                            const on = Boolean(readPackWidgetValue(simState, pack.id, w));
                            const litColor = w.color || '#22c55e';
                            return (
                              <div key={w.key} className="vboard-lamp-item">
                                <span
                                  className={`vboard-led ${on ? 'on' : ''}`}
                                  style={
                                    on
                                      ? {
                                          background: litColor,
                                          borderColor: '#ffffffcc',
                                          boxShadow: `0 0 12px ${litColor}, 0 0 4px #ffffff`,
                                        }
                                      : undefined
                                  }
                                  aria-label={`${w.label}：${on ? 'ON' : 'OFF'}`}
                                />
                                <span>
                                  {w.label}：{on ? 'ON' : 'OFF'}
                                </span>
                              </div>
                            );
                          }
                          if (w.kind === 'tricolor') {
                            const tri = resolveTricolorState(
                              readPackWidgetValue(simState, pack.id, w),
                            );
                            return (
                              <div
                                key={w.key}
                                className="vboard-lamp-item"
                                title="三色指示灯（仅红 / 绿 / 蓝三色 + 关闭）"
                              >
                                <span
                                  className="vboard-rgb vboard-tricolor"
                                  style={{
                                    background: tri.hex,
                                    boxShadow: tri.active
                                      ? `0 0 14px ${tri.hex}, 0 0 4px #ffffff`
                                      : 'none',
                                  }}
                                  aria-label={`${w.label}：${tri.labelZh}`}
                                />
                                <span>
                                  {w.label}：{tri.labelZh}
                                </span>
                              </div>
                            );
                          }
                          const hex = String(
                            readPackWidgetValue(simState, pack.id, w) || '#1e293b',
                          );
                          const active = hex !== '#1e293b' && hex !== '#334155';
                          return (
                            <div
                              key={w.key}
                              className="vboard-lamp-item"
                              title={`全彩 RGB 灯：${hex}`}
                            >
                              <span
                                className="vboard-rgb"
                                style={{
                                  background: hex,
                                  boxShadow: active
                                    ? `0 0 14px ${hex}, 0 0 4px #ffffff`
                                    : 'none',
                                }}
                                aria-label={`${w.label}（全彩）：${hex}`}
                              />
                              <span>{w.label}</span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  }

                  if (grp.kind === 'buttons') {
                    return (
                      <div key={`btns-${gIdx}`} className="sim-sub-card">
                        <div className="vboard-btn-row">
                          {grp.widgets.map((w) => {
                            const pressed = Boolean(
                              readPackWidgetValue(simState, pack.id, w),
                            );
                            const statusText = pressed
                              ? (w.activeLabel ?? '按下中')
                              : (w.idleLabel ?? '释放');
                            return (
                              <button
                                key={w.key}
                                type="button"
                                className={`vboard-key-btn ${pressed ? 'pressed' : ''}`}
                                onClick={() => triggerBooleanWidget(pack, w, !pressed)}
                              >
                                {w.label} · {statusText}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }

                  if (grp.kind === 'toggles') {
                    return (
                      <div key={`toggles-${gIdx}`} className="sim-sub-card">
                        {grp.widgets.map((w) => {
                          const on = Boolean(readPackWidgetValue(simState, pack.id, w));
                          const litColor = w.color || 'var(--accent)';
                          return (
                            <div key={w.key} className="sim-toggle-row">
                              <div className="sim-toggle-info">
                                <span>{w.label}</span>
                                {w.hint && (
                                  <span className="sim-widget-hint">{w.hint}</span>
                                )}
                              </div>
                              <button
                                type="button"
                                role="switch"
                                aria-checked={on}
                                aria-label={w.label}
                                className={`sim-switch-btn ${on ? 'on' : ''}`}
                                style={
                                  on
                                    ? { background: litColor, borderColor: litColor }
                                    : undefined
                                }
                                onClick={() => triggerBooleanWidget(pack, w, !on)}
                              >
                                <span className="sim-switch-thumb" />
                                <span className="sim-switch-label">
                                  {on ? 'ON' : 'OFF'}
                                </span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    );
                  }

                  const w = grp.widget;
                  if (w.kind === 'screen') {
                    const rawVal = readPackWidgetValue(simState, pack.id, w);
                    const screenLines = Array.isArray(rawVal)
                      ? rawVal.map((item) => String(item))
                      : rawVal !== undefined && rawVal !== null && String(rawVal) !== ''
                        ? [String(rawVal)]
                        : [];
                    return (
                      <div
                        key={w.key}
                        className="vboard-oled"
                        aria-label={w.label}
                      >
                        {screenLines.length === 0 ? (
                          <span style={{ opacity: 0.45 }}>[{w.label} 已清空]</span>
                        ) : (
                          screenLines.map((line, i) => <div key={i}>{line}</div>)
                        )}
                      </div>
                    );
                  }

                  if (w.kind === 'bar') {
                    const min = w.min ?? 0;
                    const max = w.max ?? 100;
                    const rawNum = Number(readPackWidgetValue(simState, pack.id, w));
                    const num = Number.isFinite(rawNum) ? rawNum : min;
                    const span = Math.max(1e-6, max - min);
                    const pct = Math.max(
                      0,
                      Math.min(100, Math.round(((num - min) / span) * 100)),
                    );
                    const fillColor = w.color || pack.color || 'var(--accent)';
                    return (
                      <div key={w.key} className="sim-sub-card">
                        <div className="vboard-slider-head">
                          <span>
                            {w.label}
                            {w.hint ? ` (${w.hint})` : ''}
                          </span>
                          <span className="vboard-temp-val">
                            {num}
                            {w.unit ?? ''}
                          </span>
                        </div>
                        <div className="rt-timer-bar-track" style={{ height: 7 }}>
                          <div
                            className="rt-timer-bar-fill"
                            style={{ width: `${pct}%`, background: fillColor }}
                          />
                        </div>
                      </div>
                    );
                  }

                  // slider
                  const min = w.min ?? 0;
                  const max = w.max ?? 100;
                  const step = w.step ?? 1;
                  const rawNum = Number(readPackWidgetValue(simState, pack.id, w));
                  const num = Number.isFinite(rawNum) ? rawNum : min;
                  const fullKey = qualifySimKey(pack.id, w.key);
                  return (
                    <div key={w.key} className="sim-sub-card">
                      <div className="vboard-slider-head">
                        <span>
                          {w.label}
                          {w.hint ? ` (${w.hint})` : ''}
                        </span>
                        <span className="vboard-temp-val">
                          {num}
                          {w.unit ?? ''}
                        </span>
                      </div>
                      <input
                        type="range"
                        aria-label={`${w.label}滑块`}
                        min={min}
                        max={max}
                        step={step}
                        value={num}
                        onChange={(e) =>
                          onUpdateSimValues({ [fullKey]: Number(e.target.value) })
                        }
                        style={{
                          width: '100%',
                          accentColor: w.color || pack.color || 'var(--accent)',
                        }}
                      />
                      {w.marks && w.marks.length > 0 && (
                        <div className="sim-slider-marks">
                          {w.marks.map((m, idx) => (
                            <span key={idx}>{m}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
