import { ArrowLeft, Cpu, Globe, Terminal } from 'lucide-react';
import { backendRegistry } from '../../core/backends/registry';
import {
  PLANNED_RUNNER_SLOTS,
  runnerManager,
} from '../../core/runners/manager';

const DEFAULT_RUNNER_GRADIENT = 'linear-gradient(135deg, #475569, #334155)';

interface DevicesPageProps {
  onReturnToBlocks: () => void;
  onNotify: (msg: string) => void;
}

export function DevicesPage({ onReturnToBlocks, onNotify }: DevicesPageProps) {
  const builtinRunners = runnerManager.listBuiltin();

  return (
    <div className="subpage-wrap">
      <div className="subpage-inner">
        <div className="subpage-header">
          <div>
            <h1 className="subpage-title">执行目标与设备下载（可插拔 Runner 管理）</h1>
            <p className="subpage-sub">
              PolyBlock 采用统一 <code>ScriptRunner</code> 契约：已内置纯前端 WASM 沙箱；后续接入网络设备、本机桥接或串口烧录只需注册新 Runner，画布与日志控制台零改动复用。
            </p>
          </div>
          <button type="button" className="btn-outline" onClick={onReturnToBlocks}>
            <ArrowLeft size={14} />
            <span>返回编程画布</span>
          </button>
        </div>

        <h2 className="section-heading">当前可用执行器（内置 · 零后端）</h2>
        <div className="card-grid">
          {builtinRunners.map((runner) => {
            const primaryLang = runner.supportedLanguages[0];
            const iconBackground =
              (primaryLang
                ? backendRegistry.tryGetDialect(primaryLang)?.accentGradient
                : undefined) ?? DEFAULT_RUNNER_GRADIENT;
            return (
              <div key={runner.id} className="ui-card">
                <div className="card-top">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div
                      className="card-icon"
                      style={{ background: iconBackground }}
                    >
                      WASM
                    </div>
                    <div>
                      <div style={{ fontWeight: 700 }}>{runner.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        Web Worker 沙箱 · 兼容 GitHub Pages
                      </div>
                    </div>
                  </div>
                  <span className="status-pill ok">已就绪</span>
                </div>
                <p className="card-desc">{runner.description}</p>
                <div className="card-footer">
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: 11.5,
                      color: 'var(--text-muted)',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span>支持：</span>
                    {runner.supportedLanguages.map((lang) => (
                      <span key={lang} className="count-badge">
                        {backendRegistry.tryGetDialect(lang)?.shortLabel ?? lang}
                      </span>
                    ))}
                  </span>
                  <button
                    type="button"
                    className="btn-outline"
                    onClick={onReturnToBlocks}
                  >
                    <Terminal size={13} />
                    <span>前往试跑</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <h2 className="section-heading">预留扩展槽位（按需接入）</h2>
        <div className="card-grid">
          {PLANNED_RUNNER_SLOTS.map((slot) => (
            <div key={slot.id} className="ui-card">
              <div className="card-top">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div
                    className="card-icon"
                    style={{
                      background:
                        slot.kind === 'network-ws'
                          ? 'linear-gradient(135deg, #6366f1, #8b5cf6)'
                          : slot.kind === 'local-bridge'
                          ? 'linear-gradient(135deg, #f59e0b, #ea580c)'
                          : 'linear-gradient(135deg, #0891b2, #2563eb)',
                    }}
                  >
                    {slot.kind === 'network-ws' ? (
                      <Globe size={16} />
                    ) : (
                      <Cpu size={16} />
                    )}
                  </div>
                  <div>
                    <div style={{ fontWeight: 700 }}>{slot.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {slot.protocol}
                    </div>
                  </div>
                </div>
                <span className="status-pill accent">接口预留</span>
              </div>
              <p className="card-desc">{slot.description}</p>
              <p className="card-desc" style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>
                接入方式：{slot.upgradePath}
              </p>
              <div className="card-footer">
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  暂未接入设备通信协议
                </span>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() =>
                    onNotify(`${slot.name} 已预留 ScriptRunner 接口，后续按协议直接接入`)
                  }
                >
                  查看说明
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
