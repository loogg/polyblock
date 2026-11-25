import {
  Copy,
  Cpu,
  Plus,
  Puzzle,
  Settings2,
  Sliders,
  Timer,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { backendRegistry } from '../core/backends/registry';
import { normalizeTimerConfig } from '../core/blocks/timerConfigBridge';
import type { PolyExtensionPack } from '../core/extensions/types';
import { countProjectScripts } from '../core/projects/store';
import type {
  ProjectModel,
  ProjectTimerConfig,
  RuntimeHandle,
  ScriptLanguageId,
} from '../types/project';

export type ProjectSettingsTab = 'general' | 'handles' | 'extensions';

interface ProjectSettingsModalProps {
  project: ProjectModel;
  initialTab?: ProjectSettingsTab;
  initialHandleId?: string;
  allExtensionPacks: PolyExtensionPack[];
  disableLanguageSwitch?: boolean;
  onClose: () => void;
  onUpdateProjectMeta: (
    projectId: string,
    patch: {
      name?: string;
      description?: string;
      language?: ScriptLanguageId;
      defaultTimerCount?: number;
    },
  ) => void;
  onAddHandle: (projectId: string) => void;
  onRenameHandle: (projectId: string, handleId: string, nextName: string) => void;
  onDuplicateHandle: (projectId: string, handleId: string) => void;
  onDeleteHandle: (projectId: string, handleId: string) => void;
  onUpdateHandleConfig: (
    projectId: string,
    handleId: string,
    patch: {
      autoStart?: boolean;
      description?: string;
      timerConfig?: ProjectTimerConfig;
    },
  ) => void;
  onToggleExtensionForProject: (projectId: string, packId: string) => void;
  onOpenExtensionsPage: () => void;
}

export function ProjectSettingsModal({
  project,
  initialTab = 'handles',
  initialHandleId,
  allExtensionPacks,
  disableLanguageSwitch = false,
  onClose,
  onUpdateProjectMeta,
  onAddHandle,
  onRenameHandle,
  onDuplicateHandle,
  onDeleteHandle,
  onUpdateHandleConfig,
  onToggleExtensionForProject,
  onOpenExtensionsPage,
}: ProjectSettingsModalProps) {
  const [tab, setTab] = useState<ProjectSettingsTab>(initialTab);
  const [selectedHandleId, setSelectedHandleId] = useState<string>(
    initialHandleId ?? project.activeHandleId ?? project.handles[0]?.id,
  );
  const [nameDraft, setNameDraft] = useState(project.name);
  const [descDraft, setDescDraft] = useState(project.description ?? '');
  const [handleNameDraft, setHandleNameDraft] = useState('');
  const [aliasSlotId, setAliasSlotId] = useState('0');
  const [aliasDraft, setAliasDraft] = useState('');

  const selectedHandle: RuntimeHandle =
    project.handles.find((h) => h.id === selectedHandleId) ?? project.handles[0];

  useEffect(() => {
    setNameDraft(project.name);
    setDescDraft(project.description ?? '');
  }, [project.id, project.name, project.description]);

  useEffect(() => {
    if (selectedHandle) {
      setHandleNameDraft(selectedHandle.name);
      if (Number(aliasSlotId) >= selectedHandle.timerConfig.count) {
        setAliasSlotId('0');
      }
    }
  }, [selectedHandle?.id, selectedHandle?.name, selectedHandle?.timerConfig.count, aliasSlotId]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const backends = backendRegistry.list();
  const enabledSet = new Set(project.enabledExtensions);
  const timerCfg = normalizeTimerConfig(selectedHandle?.timerConfig);

  const handleSetCount = (nextCount: number) => {
    if (!selectedHandle) return;
    const clamped = Math.max(1, Math.min(32, Math.trunc(nextCount || 8)));
    onUpdateHandleConfig(project.id, selectedHandle.id, {
      timerConfig: { ...timerCfg, count: clamped },
    });
  };

  const handleSaveAlias = () => {
    if (!selectedHandle) return;
    const trimmed = aliasDraft.trim();
    const nextAliases = { ...timerCfg.aliases };
    if (trimmed) {
      nextAliases[aliasSlotId] = trimmed.slice(0, 16);
    } else {
      delete nextAliases[aliasSlotId];
    }
    onUpdateHandleConfig(project.id, selectedHandle.id, {
      timerConfig: { ...timerCfg, aliases: nextAliases },
    });
    setAliasDraft('');
  };

  const handleRemoveAlias = (slotKey: string) => {
    if (!selectedHandle) return;
    const nextAliases = { ...timerCfg.aliases };
    delete nextAliases[slotKey];
    onUpdateHandleConfig(project.id, selectedHandle.id, {
      timerConfig: { ...timerCfg, aliases: nextAliases },
    });
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`项目配置：${project.name}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-shell settings-modal">
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Settings2 size={16} style={{ color: 'var(--accent)' }} />
            <span className="modal-title">项目与句柄配置 · {project.name}</span>
            <span className="count-badge">
              {project.handles.length} 句柄 · {countProjectScripts(project)} 脚本
            </span>
          </div>
          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            aria-label="关闭项目配置弹窗"
            style={{ padding: '4px 6px' }}
          >
            <X size={15} />
          </button>
        </div>

        <div className="settings-modal-body">
          <nav className="settings-modal-nav" aria-label="项目配置分类">
            <button
              type="button"
              className={`settings-nav-item ${tab === 'general' ? 'active' : ''}`}
              onClick={() => setTab('general')}
            >
              <Sliders size={14} />
              <span>常规与语言</span>
            </button>
            <button
              type="button"
              className={`settings-nav-item ${tab === 'handles' ? 'active' : ''}`}
              onClick={() => setTab('handles')}
            >
              <Cpu size={14} />
              <span>句柄与定时 ({project.handles.length})</span>
            </button>
            <button
              type="button"
              className={`settings-nav-item ${tab === 'extensions' ? 'active' : ''}`}
              onClick={() => setTab('extensions')}
            >
              <Puzzle size={14} />
              <span>扩展外设 ({project.enabledExtensions.length})</span>
            </button>
          </nav>

          <div className="settings-modal-content">
            {tab === 'general' && (
              <div className="settings-section-stack">
                <div className="settings-field-group">
                  <label className="settings-label">项目名称</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text"
                      className="dropdown-rename-input"
                      style={{ flex: 1, height: 32 }}
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn-primary"
                      style={{ padding: '0 12px', height: 32 }}
                      onClick={() => {
                        if (nameDraft.trim()) {
                          onUpdateProjectMeta(project.id, {
                            name: nameDraft.trim(),
                            description: descDraft.trim() || undefined,
                          });
                        }
                      }}
                    >
                      保存信息
                    </button>
                  </div>
                </div>

                <div className="settings-field-group">
                  <label className="settings-label">项目说明</label>
                  <input
                    type="text"
                    className="dropdown-rename-input"
                    style={{ width: '100%', height: 32 }}
                    placeholder="可选：描述设备用途或架构备注"
                    value={descDraft}
                    onChange={(e) => setDescDraft(e.target.value)}
                  />
                </div>

                <div className="settings-field-group">
                  <label className="settings-label">项目统一目标脚本语言</label>
                  <p className="settings-hint">
                    项目内所有句柄与脚本共享同一目标脚本后端，保证导出与真机固件一致。
                  </p>
                  <div className="seg-control" style={{ alignSelf: 'flex-start' }}>
                    {backends.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        className={`seg-btn ${project.language === b.id ? 'active' : ''}`}
                        disabled={disableLanguageSwitch}
                        onClick={() =>
                          onUpdateProjectMeta(project.id, { language: b.id })
                        }
                      >
                        <span
                          className="lang-dot"
                          style={{ background: b.accentColor }}
                        />
                        <span>
                          {b.name} {b.version}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-field-group">
                  <label className="settings-label">新建句柄默认定时器通道数</label>
                  <p className="settings-hint">
                    新建隔离句柄时默认分配的定时器通道数（1~32 路，各句柄仍可在「句柄与定时」中独立调整）。
                  </p>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {[4, 8, 16, 32].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className={
                          project.defaultTimerCount === preset
                            ? 'btn-primary'
                            : 'btn-outline'
                        }
                        style={{ padding: '4px 10px', fontSize: 12 }}
                        onClick={() =>
                          onUpdateProjectMeta(project.id, {
                            defaultTimerCount: preset,
                          })
                        }
                      >
                        {preset} 路
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {tab === 'handles' && selectedHandle && (
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
                        onClick={() => setSelectedHandleId(h.id)}
                      >
                        <span
                          className="lang-dot"
                          style={{ background: h.color }}
                        />
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
                            if (remaining) setSelectedHandleId(remaining.id);
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="settings-field-group" style={{ marginTop: 6 }}>
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
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
                      >
                        <Timer size={13} style={{ color: 'var(--accent)' }} />
                        <span>
                          本句柄独立定时器通道数（ID 0 ~ {timerCfg.count - 1}）
                        </span>
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        {[4, 8, 16, 32].map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            className={
                              timerCfg.count === preset ? 'btn-primary' : 'btn-outline'
                            }
                            style={{ padding: '3px 8px', fontSize: 11.5 }}
                            onClick={() => handleSetCount(preset)}
                          >
                            {preset} 路
                          </button>
                        ))}
                        <input
                          type="number"
                          aria-label="句柄自定义定时器通道数"
                          className="template-select"
                          style={{ width: 58, height: 26, textAlign: 'center' }}
                          min={1}
                          max={32}
                          value={timerCfg.count}
                          onChange={(e) => handleSetCount(Number(e.target.value))}
                        />
                      </div>
                    </div>
                    <p className="settings-hint">
                      每个隔离句柄（独立 <code>lua_State*</code>）独享自己的定时器池与别名，彼此绝不窜扰；在画布上右键任意定时器积木也可就地修改别名。
                    </p>
                  </div>

                  <div className="timer-alias-editor">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <select
                        aria-label="选择定时器通道"
                        className="template-select"
                        value={aliasSlotId}
                        onChange={(e) => setAliasSlotId(e.target.value)}
                      >
                        {Array.from({ length: timerCfg.count }, (_, idx) => (
                          <option key={idx} value={String(idx)}>
                            T{idx} (ID {idx})
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        aria-label="通道别名输入框"
                        className="dropdown-rename-input"
                        style={{ width: 168, height: 28 }}
                        placeholder="如：心跳灯 / 电机巡检"
                        maxLength={16}
                        value={aliasDraft}
                        onChange={(e) => setAliasDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveAlias();
                        }}
                      />
                      <button
                        type="button"
                        className="btn-outline"
                        style={{ height: 28, padding: '0 10px', fontSize: 11.5 }}
                        onClick={handleSaveAlias}
                      >
                        <Plus size={12} />
                        <span>保存别名</span>
                      </button>
                    </div>

                    <div className="paused-var-chips">
                      {Object.keys(timerCfg.aliases).length === 0 ? (
                        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                          当前句柄暂无通道别名（也可在画布右键定时器积木就地标注）。
                        </span>
                      ) : (
                        Object.entries(timerCfg.aliases)
                          .sort((a, b) => Number(a[0]) - Number(b[0]))
                          .map(([slotKey, label]) => (
                            <span key={slotKey} className="var-chip timer-alias-chip">
                              <span className="var-chip-name">T{slotKey}</span>
                              <span>· {label}</span>
                              <button
                                type="button"
                                className="script-tab-icon-btn"
                                title={`移除 T${slotKey} 别名`}
                                onClick={() => handleRemoveAlias(slotKey)}
                              >
                                <X size={10} />
                              </button>
                            </span>
                          ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {tab === 'extensions' && (
              <div className="settings-section-stack">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <p className="settings-hint" style={{ margin: 0 }}>
                    扩展包对应底层固件/C 层注册的原生外设或 API 模块（如 <code>board</code>），所有句柄共用项目启用清单。
                  </p>
                  <button
                    type="button"
                    className="btn-outline"
                    style={{ fontSize: 11.5, padding: '4px 9px', flexShrink: 0 }}
                    onClick={() => {
                      onClose();
                      onOpenExtensionsPage();
                    }}
                  >
                    导入自定义包 →
                  </button>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {allExtensionPacks.map((pack) => {
                    const enabled = enabledSet.has(pack.id);
                    return (
                      <div key={pack.id} className="settings-ext-row">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span
                            className="card-icon"
                            style={{
                              background: pack.color,
                              width: 28,
                              height: 28,
                              fontSize: 10.5,
                              borderRadius: 7,
                            }}
                          >
                            {pack.categoryLabel}
                          </span>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                              {pack.name}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              {pack.blocks.length} 个积木 ·{' '}
                              {pack.builtin ? '内置扩展包' : '自定义包'}
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          className={`ext-toggle-btn ${enabled ? 'enabled' : 'disabled'}`}
                          style={{ padding: '4px 10px', fontSize: 11.5 }}
                          onClick={() =>
                            onToggleExtensionForProject(project.id, pack.id)
                          }
                        >
                          {enabled ? '已启用' : '启用'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
