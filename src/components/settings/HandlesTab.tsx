import { Copy, Plus, Timer, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { extensionRegistry } from '../../core/extensions/registry';
import type { ResolvedHandleChannelPoolSpec } from '../../core/extensions/types';
import { getHandleChannelPoolConfig } from '../../core/projects/store';
import type { HandleConfigPatch } from '../../hooks/useProjectStore';
import type {
  ChannelPoolConfig,
  ProjectModel,
  RuntimeHandle,
} from '../../types/project';

interface HandlesTabProps {
  project: ProjectModel;
  selectedHandleId: string;
  onSelectHandleId: (handleId: string) => void;
  onAddHandle: (projectId: string) => void;
  onRenameHandle: (projectId: string, handleId: string, nextName: string) => void;
  onDuplicateHandle: (projectId: string, handleId: string) => void;
  onDeleteHandle: (projectId: string, handleId: string) => void;
  onUpdateHandleConfig: (
    projectId: string,
    handleId: string,
    patch: HandleConfigPatch,
  ) => void;
  onSwitchToCapabilitiesTab: () => void;
}

export function HandlesTab({
  project,
  selectedHandleId,
  onSelectHandleId,
  onAddHandle,
  onRenameHandle,
  onDuplicateHandle,
  onDeleteHandle,
  onUpdateHandleConfig,
  onSwitchToCapabilitiesTab,
}: HandlesTabProps) {
  const [handleNameDraft, setHandleNameDraft] = useState('');
  const [aliasSlotsByPool, setAliasSlotsByPool] = useState<Record<string, string>>(
    {},
  );
  const [aliasDraftsByPool, setAliasDraftsByPool] = useState<
    Record<string, string>
  >({});

  const selectedHandle: RuntimeHandle | undefined =
    project.handles.find((h) => h.id === selectedHandleId) ?? project.handles[0];

  const channelPools = extensionRegistry.getChannelPools(
    project.enabledCapabilities,
    project.localExtensions,
  );

  useEffect(() => {
    if (selectedHandle) {
      setHandleNameDraft(selectedHandle.name);
    }
  }, [selectedHandle?.id, selectedHandle?.name]);

  if (!selectedHandle) return null;

  const readPoolCfg = (pool: ResolvedHandleChannelPoolSpec): ChannelPoolConfig =>
    getHandleChannelPoolConfig(
      selectedHandle,
      pool.configKey,
      pool.defaultCount,
      pool.min,
      pool.max,
    );

  const handleSetPoolCount = (
    pool: ResolvedHandleChannelPoolSpec,
    nextCount: number,
  ) => {
    const cur = readPoolCfg(pool);
    const clamped = Math.max(
      pool.min,
      Math.min(pool.max, Math.trunc(nextCount || pool.defaultCount)),
    );
    onUpdateHandleConfig(project.id, selectedHandle.id, {
      channelPoolUpdate: {
        configKey: pool.configKey,
        config: { ...cur, count: clamped },
        min: pool.min,
        max: pool.max,
      },
    });
  };

  const handleSavePoolAlias = (pool: ResolvedHandleChannelPoolSpec) => {
    const cur = readPoolCfg(pool);
    const rawSlot = aliasSlotsByPool[pool.configKey] ?? '0';
    const slotKey = Number(rawSlot) < cur.count ? rawSlot : '0';
    const trimmed = (aliasDraftsByPool[pool.configKey] ?? '').trim();
    const nextAliases = { ...cur.aliases };
    if (trimmed) {
      nextAliases[slotKey] = trimmed.slice(0, 16);
    } else {
      delete nextAliases[slotKey];
    }
    onUpdateHandleConfig(project.id, selectedHandle.id, {
      channelPoolUpdate: {
        configKey: pool.configKey,
        config: { ...cur, aliases: nextAliases },
        min: pool.min,
        max: pool.max,
      },
    });
    setAliasDraftsByPool((prev) => ({ ...prev, [pool.configKey]: '' }));
  };

  const handleRemovePoolAlias = (
    pool: ResolvedHandleChannelPoolSpec,
    slotKey: string,
  ) => {
    const cur = readPoolCfg(pool);
    const nextAliases = { ...cur.aliases };
    delete nextAliases[slotKey];
    onUpdateHandleConfig(project.id, selectedHandle.id, {
      channelPoolUpdate: {
        configKey: pool.configKey,
        config: { ...cur, aliases: nextAliases },
        min: pool.min,
        max: pool.max,
      },
    });
  };

  return (
    <div className="settings-section-stack">
      <div className="handle-selector-bar">
        <div className="handle-pill-list">
          {project.handles.map((h) => (
            <button
              key={h.id}
              type="button"
              className={`handle-chip-btn ${
                h.id === selectedHandle.id ? 'active' : ''
              }`}
              onClick={() => onSelectHandleId(h.id)}
            >
              <span className="lang-dot" style={{ background: h.color }} />
              <span>{h.name}</span>
              <span className="count-badge">{h.scripts.length}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn-outline"
          style={{ height: 28, padding: '0 9px', fontSize: 11.5 }}
          onClick={() => onAddHandle(project.id)}
        >
          <Plus size={13} />
          <span>新建隔离句柄</span>
        </button>
      </div>

      <div className="handle-detail-card">
        <div className="handle-detail-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
            <span
              className="lang-dot"
              style={{ background: selectedHandle.color, width: 9, height: 9 }}
            />
            <input
              type="text"
              aria-label="句柄名称"
              className="dropdown-rename-input"
              style={{ width: 170, height: 28 }}
              value={handleNameDraft}
              onChange={(e) => setHandleNameDraft(e.target.value)}
              onBlur={() => {
                if (
                  handleNameDraft.trim() &&
                  handleNameDraft.trim() !== selectedHandle.name
                ) {
                  onRenameHandle(
                    project.id,
                    selectedHandle.id,
                    handleNameDraft.trim(),
                  );
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && handleNameDraft.trim()) {
                  onRenameHandle(
                    project.id,
                    selectedHandle.id,
                    handleNameDraft.trim(),
                  );
                }
              }}
            />
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 12,
                color: 'var(--text-secondary)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={selectedHandle.autoStart}
                onChange={(e) =>
                  onUpdateHandleConfig(project.id, selectedHandle.id, {
                    autoStart: e.target.checked,
                  })
                }
              />
              <span>多句柄并发时自启动</span>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              className="btn-ghost"
              style={{ padding: '4px 6px' }}
              title="复制此句柄"
              onClick={() => onDuplicateHandle(project.id, selectedHandle.id)}
            >
              <Copy size={13} />
            </button>
            {project.handles.length > 1 && (
              <button
                type="button"
                className="btn-ghost"
                style={{ padding: '4px 6px', color: 'var(--danger)' }}
                title="删除此句柄"
                onClick={() => {
                  const remaining = project.handles.find(
                    (h) => h.id !== selectedHandle.id,
                  );
                  onDeleteHandle(project.id, selectedHandle.id);
                  if (remaining) onSelectHandleId(remaining.id);
                }}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        </div>

        {channelPools.length > 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              marginTop: 6,
            }}
          >
            {channelPools.map(({ pack: poolPack, section: poolSection, pool }) => {
              const poolCfg = readPoolCfg(pool);
              const rawSlot = aliasSlotsByPool[pool.configKey] ?? '0';
              const curSlotId = Number(rawSlot) < poolCfg.count ? rawSlot : '0';
              const curDraft = aliasDraftsByPool[pool.configKey] ?? '';
              const ownerLabel = poolSection.isMultiSection
                ? `${poolPack.name} · ${poolSection.label}`
                : poolPack.name;
              return (
                <div
                  key={pool.configKey}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    paddingTop: 8,
                    borderTop: '1px solid var(--border)',
                  }}
                >
                  <div className="settings-field-group">
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span
                        className="settings-label"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                        }}
                      >
                        <Timer size={13} style={{ color: poolSection.color }} />
                        <span>
                          {ownerLabel} · {pool.label}（{pool.prefix}0 ~{' '}
                          {pool.prefix}
                          {poolCfg.count - 1}）
                        </span>
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        {(pool.presets ?? [4, 8, 16]).map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            className={
                              poolCfg.count === preset
                                ? 'btn-primary'
                                : 'btn-outline'
                            }
                            style={{ padding: '3px 8px', fontSize: 11.5 }}
                            onClick={() => handleSetPoolCount(pool, preset)}
                          >
                            {preset} 路
                          </button>
                        ))}
                        <input
                          type="number"
                          aria-label={`句柄自定义${pool.label}数`}
                          className="template-select"
                          style={{ width: 58, height: 26, textAlign: 'center' }}
                          min={pool.min}
                          max={pool.max}
                          value={poolCfg.count}
                          onChange={(e) =>
                            handleSetPoolCount(pool, Number(e.target.value))
                          }
                        />
                      </div>
                    </div>
                    <p className="settings-hint">
                      {pool.hint ??
                        `槽位键 capabilityConfigs["${pool.configKey}"] 独立存储，与其他通道池及句柄完全隔离；画布上右键对应积木也可就地修改别名。`}
                    </p>
                  </div>

                  <div className="timer-alias-editor">
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        flexWrap: 'wrap',
                      }}
                    >
                      <select
                        aria-label={`选择${pool.label}`}
                        className="template-select"
                        value={curSlotId}
                        onChange={(e) =>
                          setAliasSlotsByPool((prev) => ({
                            ...prev,
                            [pool.configKey]: e.target.value,
                          }))
                        }
                      >
                        {Array.from({ length: poolCfg.count }, (_, idx) => (
                          <option key={idx} value={String(idx)}>
                            {pool.prefix}
                            {idx} (ID {idx})
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        aria-label={`${pool.label}别名输入框`}
                        className="dropdown-rename-input"
                        style={{ width: 168, height: 28 }}
                        placeholder={`如：${pool.prefix}0 用途标注`}
                        maxLength={16}
                        value={curDraft}
                        onChange={(e) =>
                          setAliasDraftsByPool((prev) => ({
                            ...prev,
                            [pool.configKey]: e.target.value,
                          }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSavePoolAlias(pool);
                        }}
                      />
                      <button
                        type="button"
                        className="btn-outline"
                        style={{ height: 28, padding: '0 10px', fontSize: 11.5 }}
                        onClick={() => handleSavePoolAlias(pool)}
                      >
                        <Plus size={12} />
                        <span>保存别名</span>
                      </button>
                    </div>

                    <div className="paused-var-chips">
                      {Object.keys(poolCfg.aliases).length === 0 ? (
                        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          当前句柄「{pool.label}」暂无别名（也可在画布右键积木就地标注）。
                        </span>
                      ) : (
                        Object.entries(poolCfg.aliases)
                          .sort((a, b) => Number(a[0]) - Number(b[0]))
                          .map(([slotKey, label]) => (
                            <span
                              key={slotKey}
                              className="var-chip timer-alias-chip"
                            >
                              <span className="var-chip-name">
                                {pool.prefix}
                                {slotKey}
                              </span>
                              <span>· {label}</span>
                              <button
                                type="button"
                                className="script-tab-icon-btn"
                                title={`移除 ${pool.prefix}${slotKey} 别名`}
                                onClick={() =>
                                  handleRemovePoolAlias(pool, slotKey)
                                }
                              >
                                <X size={10} />
                              </button>
                            </span>
                          ))
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div
            className="settings-ext-row"
            style={{
              marginTop: 6,
              background: 'var(--bg-panel-subtle)',
              borderStyle: 'dashed',
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-secondary)',
                lineHeight: 1.5,
              }}
            >
              当前项目未启用任何带<strong>每句柄通道池</strong>
              的扩展包（如多路编号定时器或自定义 PWM
              通道包）。若目标板卡支持此类资源，可按需启用。
            </div>
            <button
              type="button"
              className="btn-outline"
              style={{ padding: '4px 10px', fontSize: 11.5, flexShrink: 0 }}
              onClick={onSwitchToCapabilitiesTab}
            >
              去能力清单启用 →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
