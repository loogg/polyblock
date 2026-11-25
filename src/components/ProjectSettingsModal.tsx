import {
  Copy,
  Cpu,
  Download,
  Globe,
  Plus,
  Puzzle,
  Settings2,
  Sliders,
  Timer,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { backendRegistry } from '../core/backends/registry';
import {
  BUILTIN_RUNTIME_CAPABILITIES,
  CAP_RT_TIMERS,
  hasCapability,
  SAMPLE_CUSTOM_BOARD_TEMPLATE,
  targetProfileRegistry,
} from '../core/capabilities/registry';
import { SAMPLE_CUSTOM_EXTENSION_TEMPLATE } from '../core/extensions/builtinPacks';
import type { PolyExtensionPack } from '../core/extensions/types';
import {
  countProjectScripts,
  getHandleTimerConfig,
} from '../core/projects/store';
import type {
  ProjectModel,
  ProjectTimerConfig,
  RuntimeHandle,
  ScriptLanguageId,
  TargetProfile,
} from '../types/project';

export type ProjectSettingsTab = 'general' | 'capabilities' | 'handles';

interface ProjectSettingsModalProps {
  project: ProjectModel;
  initialTab?: ProjectSettingsTab;
  initialHandleId?: string;
  allExtensionPacks: PolyExtensionPack[];
  allTargetProfiles: TargetProfile[];
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
  onApplyTargetProfile: (projectId: string, profileId: string) => void;
  onImportBoardProfileJson: (raw: unknown) => TargetProfile | null;
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
  onToggleCapabilityForProject: (projectId: string, capId: string) => void;
  onImportLocalExtensionJson: (projectId: string, raw: unknown) => void;
  onRemoveLocalExtension: (projectId: string, packId: string) => void;
  onPromoteLocalExtensionToGlobal: (pack: PolyExtensionPack) => void;
  onOpenExtensionsPage: () => void;
  onNotify: (msg: string) => void;
}

export function ProjectSettingsModal({
  project,
  initialTab = 'general',
  initialHandleId,
  allExtensionPacks,
  allTargetProfiles,
  disableLanguageSwitch = false,
  onClose,
  onUpdateProjectMeta,
  onApplyTargetProfile,
  onImportBoardProfileJson,
  onAddHandle,
  onRenameHandle,
  onDuplicateHandle,
  onDeleteHandle,
  onUpdateHandleConfig,
  onToggleCapabilityForProject,
  onImportLocalExtensionJson,
  onRemoveLocalExtension,
  onPromoteLocalExtensionToGlobal,
  onOpenExtensionsPage,
  onNotify,
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
  const profileFileRef = useRef<HTMLInputElement | null>(null);
  const localExtFileRef = useRef<HTMLInputElement | null>(null);

  const selectedHandle: RuntimeHandle =
    project.handles.find((h) => h.id === selectedHandleId) ?? project.handles[0];
  const hasTimers = hasCapability(project.enabledCapabilities, CAP_RT_TIMERS);
  const timerCfg = getHandleTimerConfig(selectedHandle, project.defaultTimerCount);
  const activeProfile = targetProfileRegistry.get(project.targetProfileId);

  useEffect(() => {
    setNameDraft(project.name);
    setDescDraft(project.description ?? '');
  }, [project.id, project.name, project.description]);

  useEffect(() => {
    if (selectedHandle) {
      setHandleNameDraft(selectedHandle.name);
      if (Number(aliasSlotId) >= timerCfg.count) {
        setAliasSlotId('0');
      }
    }
  }, [selectedHandle?.id, selectedHandle?.name, timerCfg.count, aliasSlotId]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const backends = backendRegistry.list();
  const enabledSet = new Set(project.enabledCapabilities);
  const localPacks = project.localExtensions ?? [];
  const localPackIds = new Set(localPacks.map((p) => p.id));
  const globalPackIds = new Set(allExtensionPacks.map((p) => p.id));

  const downloadPackJson = (fileName: string, data: unknown, toastText: string) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    onNotify(toastText);
  };

  const handleLocalExtFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as unknown;
        onImportLocalExtensionJson(project.id, parsed);
      } catch (err) {
        onNotify(
          `导入项目内嵌外设包失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  };

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

  const handleBoardFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as unknown;
        const imported = onImportBoardProfileJson(parsed);
        if (imported) {
          onApplyTargetProfile(project.id, imported.id);
        }
      } catch (err) {
        onNotify(
          `导入板型规格失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  };

  const handleDownloadSampleProfile = () => {
    const blob = new Blob(
      [JSON.stringify(SAMPLE_CUSTOM_BOARD_TEMPLATE, null, 2)],
      { type: 'application/json;charset=utf-8' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${SAMPLE_CUSTOM_BOARD_TEMPLATE.id}.polyboard.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    onNotify(`已下载目标板型示例模板 ${SAMPLE_CUSTOM_BOARD_TEMPLATE.id}.polyboard.json`);
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
            <span className="modal-title">项目配置 · {project.name}</span>
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
              <span>常规与板型</span>
            </button>
            <button
              type="button"
              className={`settings-nav-item ${tab === 'capabilities' ? 'active' : ''}`}
              onClick={() => setTab('capabilities')}
            >
              <Puzzle size={14} />
              <span>能力与外设 ({project.enabledCapabilities.length})</span>
            </button>
            <button
              type="button"
              className={`settings-nav-item ${tab === 'handles' ? 'active' : ''}`}
              onClick={() => setTab('handles')}
            >
              <Cpu size={14} />
              <span>运行句柄 ({project.handles.length})</span>
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
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <label className="settings-label">目标板型规格 (Target Profile)</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="btn-outline"
                        style={{ padding: '3px 8px', fontSize: 11.5 }}
                        onClick={() => profileFileRef.current?.click()}
                      >
                        <Upload size={11} />
                        <span>导入 .polyboard.json</span>
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ padding: '3px 7px', fontSize: 11.5 }}
                        onClick={handleDownloadSampleProfile}
                        title="下载目标板型 JSON 模板"
                      >
                        <Download size={11} />
                        <span>模板</span>
                      </button>
                      <input
                        ref={profileFileRef}
                        type="file"
                        accept=".json,.polyboard.json"
                        style={{ display: 'none' }}
                        onChange={handleBoardFileImport}
                      />
                    </div>
                  </div>
                  <select
                    aria-label="选择目标板型规格"
                    className="template-select"
                    style={{ width: '100%', height: 32 }}
                    value={project.targetProfileId}
                    onChange={(e) => onApplyTargetProfile(project.id, e.target.value)}
                  >
                    {allTargetProfiles.map((prof) => (
                      <option key={prof.id} value={prof.id}>
                        {prof.name}
                        {prof.builtin ? '' : ' [自定义]'} ({prof.capabilities.length} 项能力)
                      </option>
                    ))}
                  </select>
                  <p className="settings-hint">
                    {activeProfile.description} 切换板型会自动装配预设能力清单，你仍可在「能力与外设」中自由微调单一项开关。
                  </p>
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

                {hasTimers && (
                  <div className="settings-field-group">
                    <label className="settings-label">新建句柄默认定时器通道数</label>
                    <p className="settings-hint">
                      新建隔离句柄时默认分配的定时器通道数（1~32 路，各句柄仍可在「运行句柄」中独立调整）。
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
                )}
              </div>
            )}

            {tab === 'capabilities' && (
              <div className="settings-section-stack">
                <div className="settings-field-group">
                  <label className="settings-label">运行时能力模块（按项目按需装配）</label>
                  <p className="settings-hint">
                    核心语言积木零硬编码硬件概念；只有当目标设备/固件提供 <code>rt</code> 周期循环或编号定时器时才勾选启用。
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {BUILTIN_RUNTIME_CAPABILITIES.map((cap) => {
                      const enabled = enabledSet.has(cap.id);
                      return (
                        <div key={cap.id} className="settings-ext-row">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span
                              className="card-icon"
                              style={{
                                background: cap.color,
                                width: 32,
                                height: 28,
                                fontSize: 10,
                                borderRadius: 7,
                                flexShrink: 0,
                              }}
                            >
                              {cap.shortLabel.slice(0, 2)}
                            </span>
                            <div>
                              <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                                {cap.name}
                              </div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                {cap.description}
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            className={`ext-toggle-btn ${enabled ? 'enabled' : 'disabled'}`}
                            style={{ padding: '4px 10px', fontSize: 11.5, flexShrink: 0 }}
                            onClick={() =>
                              onToggleCapabilityForProject(project.id, cap.id)
                            }
                          >
                            {enabled ? '已启用' : '启用'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="settings-field-group" style={{ marginTop: 4 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <label className="settings-label">
                      本项目内嵌外设包（{localPacks.length} · 随工程文件导出，不污染全局库）
                    </label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className="btn-primary"
                        style={{ fontSize: 11.5, padding: '4px 9px', flexShrink: 0 }}
                        onClick={() => localExtFileRef.current?.click()}
                      >
                        <Upload size={11} />
                        <span>导入到本项目 (.polyext.json)</span>
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ fontSize: 11.5, padding: '4px 7px', flexShrink: 0 }}
                        title="下载自定义外设包示例模板"
                        onClick={() =>
                          downloadPackJson(
                            'my-robot-api.polyext.json',
                            SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
                            '已下载自定义外设包模板 my-robot-api.polyext.json',
                          )
                        }
                      >
                        <Download size={11} />
                        <span>模板</span>
                      </button>
                      <input
                        ref={localExtFileRef}
                        type="file"
                        accept=".json,.polyext.json"
                        style={{ display: 'none' }}
                        onChange={handleLocalExtFileImport}
                      />
                    </div>
                  </div>
                  <p className="settings-hint">
                    适合当前项目专用的板载/业务 C 接口描述。仅保存在本项目 <code>.polyblock.json</code> 内，发给他人开箱即用；同名 ID 时优先覆盖全局包。
                  </p>
                  {localPacks.length === 0 ? (
                    <div
                      className="settings-ext-row"
                      style={{
                        background: 'var(--bg-subtle)',
                        borderStyle: 'dashed',
                        fontSize: 11.5,
                        color: 'var(--text-muted)',
                      }}
                    >
                      当前项目暂无内嵌外设包。点击右上角「导入到本项目」即可按项目隔离挂载，不会出现在左侧全局「扩展」页。
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {localPacks.map((pack) => {
                        const enabled = enabledSet.has(pack.id);
                        const overridesGlobal = globalPackIds.has(pack.id);
                        return (
                          <div key={pack.id} className="settings-ext-row">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span
                                className="card-icon"
                                style={{
                                  background: pack.color,
                                  width: 32,
                                  height: 28,
                                  fontSize: 10.5,
                                  borderRadius: 7,
                                  flexShrink: 0,
                                }}
                              >
                                {pack.categoryLabel}
                              </span>
                              <div>
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    fontWeight: 600,
                                    fontSize: 12.5,
                                    flexWrap: 'wrap',
                                  }}
                                >
                                  <span>{pack.name}</span>
                                  <span className="count-badge">项目内嵌</span>
                                  {overridesGlobal && (
                                    <span
                                      className="count-badge"
                                      style={{
                                        color: 'var(--warning)',
                                        borderColor: 'var(--warning)',
                                      }}
                                    >
                                      覆盖同名全局包
                                    </span>
                                  )}
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                  v{pack.packVersion} · {pack.blocks.length} 个积木
                                  {(pack.simWidgets?.length ?? 0) > 0
                                    ? ` · ${pack.simWidgets!.length} 模拟控件`
                                    : ''}{' '}
                                  · ID: {pack.id}
                                </div>
                              </div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                              <button
                                type="button"
                                className="btn-ghost"
                                style={{ padding: '4px 6px' }}
                                title="复制一份保存到全局扩展库（供其他项目复用）"
                                aria-label={`将 ${pack.name} 保存到全局扩展库`}
                                onClick={() => onPromoteLocalExtensionToGlobal(pack)}
                              >
                                <Globe size={13} />
                              </button>
                              <button
                                type="button"
                                className="btn-ghost"
                                style={{ padding: '4px 6px' }}
                                title="导出为独立 .polyext.json"
                                aria-label={`导出 ${pack.name}`}
                                onClick={() =>
                                  downloadPackJson(
                                    `${pack.id}.polyext.json`,
                                    pack,
                                    `已导出项目内嵌包 ${pack.id}.polyext.json`,
                                  )
                                }
                              >
                                <Download size={13} />
                              </button>
                              <button
                                type="button"
                                className="btn-ghost"
                                style={{ padding: '4px 6px', color: 'var(--danger)' }}
                                title="从当前项目移除此内嵌包"
                                aria-label={`移除项目内嵌包 ${pack.name}`}
                                onClick={() => onRemoveLocalExtension(project.id, pack.id)}
                              >
                                <Trash2 size={13} />
                              </button>
                              <button
                                type="button"
                                className={`ext-toggle-btn ${enabled ? 'enabled' : 'disabled'}`}
                                style={{ padding: '4px 10px', fontSize: 11.5 }}
                                onClick={() =>
                                  onToggleCapabilityForProject(project.id, pack.id)
                                }
                              >
                                {enabled ? '已启用' : '启用'}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="settings-field-group" style={{ marginTop: 4 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <label className="settings-label">
                      全局扩展库（内置 + 全局导入 · 多项目共享）
                    </label>
                    <button
                      type="button"
                      className="btn-outline"
                      style={{ fontSize: 11.5, padding: '4px 9px', flexShrink: 0 }}
                      onClick={() => {
                        onClose();
                        onOpenExtensionsPage();
                      }}
                    >
                      管理全局扩展库 →
                    </button>
                  </div>
                  <p className="settings-hint">
                    通用 SDK / 协议包统一在全局扩展页维护，此处按项目勾选启用；导出项目时若使用了全局自定义包，会自动附带快照保证他人打开开箱即用。
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {allExtensionPacks.map((pack) => {
                      const enabled = enabledSet.has(pack.id);
                      const overridden = localPackIds.has(pack.id);
                      return (
                        <div
                          key={pack.id}
                          className="settings-ext-row"
                          style={overridden ? { opacity: 0.65 } : undefined}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span
                              className="card-icon"
                              style={{
                                background: pack.color,
                                width: 32,
                                height: 28,
                                fontSize: 10.5,
                                borderRadius: 7,
                                flexShrink: 0,
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
                                {pack.builtin
                                  ? '内置包'
                                  : '全局自定义包（导出项目自动附带快照）'}
                                {overridden ? ' · 已被本项目内嵌包覆盖' : ''}
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            className={`ext-toggle-btn ${enabled ? 'enabled' : 'disabled'}`}
                            style={{ padding: '4px 10px', fontSize: 11.5, flexShrink: 0 }}
                            disabled={overridden}
                            title={
                              overridden
                                ? '已被上方同名项目内嵌包覆盖，请操作上方条目'
                                : undefined
                            }
                            onClick={() =>
                              onToggleCapabilityForProject(project.id, pack.id)
                            }
                          >
                            {overridden ? '已覆盖' : enabled ? '已启用' : '启用'}
                          </button>
                        </div>
                      );
                    })}
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

                  {hasTimers ? (
                    <>
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
                    </>
                  ) : (
                    <div
                      className="settings-ext-row"
                      style={{
                        marginTop: 6,
                        background: 'var(--bg-subtle)',
                        borderStyle: 'dashed',
                      }}
                    >
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                        当前项目未启用 <strong>多路编号定时器 (rt.timer)</strong> 能力，因此本句柄不分配定时器通道。若目标板卡支持定时回调，可按需启用。
                      </div>
                      <button
                        type="button"
                        className="btn-outline"
                        style={{ padding: '4px 10px', fontSize: 11.5, flexShrink: 0 }}
                        onClick={() => setTab('capabilities')}
                      >
                        去能力清单启用 →
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
