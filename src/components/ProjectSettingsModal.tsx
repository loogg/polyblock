import {
  AlertTriangle,
  CheckSquare,
  Copy,
  Cpu,
  Download,
  Eye,
  FileCode2,
  Globe,
  Paperclip,
  Plus,
  Puzzle,
  Settings2,
  Sliders,
  Square,
  Timer,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { backendRegistry } from '../core/backends/registry';
import {
  CORE_TOOLBOX_ORDERS,
  DEFAULT_EXTENSION_TOOLBOX_ORDER,
} from '../core/blocks/catalog';
import {
  hasCapability,
  SAMPLE_CUSTOM_BOARD_TEMPLATE,
  targetProfileRegistry,
} from '../core/capabilities/registry';
import { SAMPLE_CUSTOM_EXTENSION_TEMPLATE } from '../core/extensions/builtinPacks';
import { inspectPackImportSourceMatch } from '../core/extensions/moduleResolver';
import {
  derivePackBadges,
  extensionRegistry,
  formatPackPlacementSummary,
  formatSectionPlacement,
  getAllPackBlocks,
  getPackEnableState,
  resolvePackSections,
} from '../core/extensions/registry';
import {
  scanScriptLibraryFile,
  type UploadedScriptLibFile,
} from '../core/extensions/scriptLibScanner';
import type {
  PolyExtensionPack,
  ResolvedHandleChannelPoolSpec,
} from '../core/extensions/types';
import {
  countProjectScripts,
  getHandleChannelPoolConfig,
} from '../core/projects/store';
import type {
  ChannelPoolConfig,
  ProjectModel,
  RuntimeHandle,
  ScriptLanguageId,
  TargetProfile,
} from '../types/project';
import { ExtensionSourceModal } from './ExtensionSourceModal';

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
      channelPoolUpdate?: {
        configKey: string;
        config: ChannelPoolConfig;
        min?: number;
        max?: number;
      };
    },
  ) => void;
  onToggleCapabilityForProject: (projectId: string, capId: string) => void;
  onImportLocalExtensionJson: (projectId: string, raw: unknown) => void;
  onOpenScriptLibImportModal: (projectId: string) => void;
  onAttachLibsToLocalPack: (
    projectId: string,
    packId: string,
    files: UploadedScriptLibFile[],
  ) => void;
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
  onOpenScriptLibImportModal,
  onAttachLibsToLocalPack,
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
  const [aliasSlotsByPool, setAliasSlotsByPool] = useState<Record<string, string>>({});
  const [aliasDraftsByPool, setAliasDraftsByPool] = useState<Record<string, string>>({});
  const profileFileRef = useRef<HTMLInputElement | null>(null);
  const localExtFileRef = useRef<HTMLInputElement | null>(null);
  const attachLibsInputRef = useRef<HTMLInputElement | null>(null);
  const [attachTargetPackId, setAttachTargetPackId] = useState<string | null>(null);
  const [viewingPack, setViewingPack] = useState<{
    pack: PolyExtensionPack;
    scopeLabel: string;
  } | null>(null);

  const selectedHandle: RuntimeHandle =
    project.handles.find((h) => h.id === selectedHandleId) ?? project.handles[0];
  const activeProfile = targetProfileRegistry.get(project.targetProfileId);

  useEffect(() => {
    setNameDraft(project.name);
    setDescDraft(project.description ?? '');
  }, [project.id, project.name, project.description]);

  useEffect(() => {
    if (selectedHandle) {
      setHandleNameDraft(selectedHandle.name);
    }
  }, [selectedHandle?.id, selectedHandle?.name]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !viewingPack) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, viewingPack]);

  const backends = backendRegistry.list();
  const localPacks = project.localExtensions ?? [];
  const localPackIds = new Set(localPacks.map((p) => p.id));
  const builtinPacks = allExtensionPacks.filter((p) => Boolean(p.builtin));
  const customGlobalPacks = allExtensionPacks.filter((p) => !p.builtin);
  const globalPackIds = new Set(allExtensionPacks.map((p) => p.id));
  const channelPools = extensionRegistry.getChannelPools(
    project.enabledCapabilities,
    project.localExtensions,
  );

  const renderSectionChips = (pack: PolyExtensionPack, disabled = false) => {
    const sections = resolvePackSections(pack);
    if (sections.length <= 1) return null;
    return (
      <div
        className="pack-sections-bar compact"
        role="group"
        aria-label={`${pack.name} 按组件勾选启用`}
      >
        <span className="pack-sections-title">按组件勾选：</span>
        {sections.map((sec) => {
          const secOn = hasCapability(project.enabledCapabilities, sec.capId);
          const posText = formatSectionPlacement(sec);
          return (
            <button
              key={sec.capId}
              type="button"
              disabled={disabled}
              aria-pressed={secOn}
              className={`pack-section-chip ${secOn ? 'active' : ''}`}
              style={
                secOn
                  ? {
                      borderColor: `${sec.color}99`,
                      color: sec.color,
                      background: `${sec.color}12`,
                    }
                  : undefined
              }
              title={`${sec.label}（${posText}）${sec.description ? `：${sec.description}` : ''} · 点击单独${secOn ? '取消勾选' : '勾选启用'}`}
              onClick={() =>
                onToggleCapabilityForProject(project.id, sec.capId)
              }
            >
              {secOn ? (
                <CheckSquare size={12} style={{ flexShrink: 0 }} />
              ) : (
                <Square size={12} style={{ flexShrink: 0, opacity: 0.7 }} />
              )}
              <span>{sec.label}</span>
              <span className="pack-section-pos">{posText}</span>
            </button>
          );
        })}
      </div>
    );
  };

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

  const handleAttachLibsInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (picked.length === 0 || !attachTargetPackId) return;
    const scanned: UploadedScriptLibFile[] = [];
    for (const file of picked) {
      const text = await file.text();
      scanned.push(scanScriptLibraryFile(file.name, text, project.language));
    }
    onAttachLibsToLocalPack(project.id, attachTargetPackId, scanned);
    setAttachTargetPackId(null);
  };

  const readPoolCfg = (pool: ResolvedHandleChannelPoolSpec): ChannelPoolConfig =>
    getHandleChannelPoolConfig(
      selectedHandle,
      pool.configKey,
      pool.defaultCount,
      pool.min,
      pool.max,
    );

  const handleSetPoolCount = (pool: ResolvedHandleChannelPoolSpec, nextCount: number) => {
    if (!selectedHandle) return;
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
    if (!selectedHandle) return;
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

  const handleRemovePoolAlias = (pool: ResolvedHandleChannelPoolSpec, slotKey: string) => {
    if (!selectedHandle) return;
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
              </div>
            )}

            {tab === 'capabilities' && (
              <div className="settings-section-stack">
                <div className="toolbox-order-legend compact" aria-label="工具箱分类序号参考">
                  <span className="toolbox-order-legend-title">分类序参考：</span>
                  {CORE_TOOLBOX_ORDERS.map((c) => (
                    <span key={c.id} className="toolbox-order-chip">
                      {c.label} <code>#{c.order}</code>
                    </span>
                  ))}
                  <span className="toolbox-order-chip ext">
                    扩展默认 <code>#{DEFAULT_EXTENSION_TOOLBOX_ORDER}+</code>
                  </span>
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
                    <label className="settings-label">
                      本项目内嵌扩展包（{localPacks.length} · 随工程文件导出，不污染全局库）
                    </label>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn-primary"
                        style={{ fontSize: 11.5, padding: '4px 9px', flexShrink: 0 }}
                        onClick={() => onOpenScriptLibImportModal(project.id)}
                      >
                        <FileCode2 size={11} />
                        <span>导入脚本库 (.lua/.py)</span>
                      </button>
                      <button
                        type="button"
                        className="btn-outline"
                        style={{ fontSize: 11.5, padding: '4px 9px', flexShrink: 0 }}
                        onClick={() => localExtFileRef.current?.click()}
                      >
                        <Upload size={11} />
                        <span>导入 .polyext.json</span>
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ fontSize: 11.5, padding: '4px 7px', flexShrink: 0 }}
                        title="下载自定义扩展包示例模板"
                        onClick={() =>
                          downloadPackJson(
                            'my-robot-api.polyext.json',
                            SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
                            '已下载自定义扩展包模板 my-robot-api.polyext.json',
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
                      <input
                        ref={attachLibsInputRef}
                        type="file"
                        accept=".lua,.py"
                        multiple
                        style={{ display: 'none' }}
                        onChange={handleAttachLibsInput}
                      />
                    </div>
                  </div>
                  <p className="settings-hint">
                    支持直接导入 <code>.lua/.py</code> 脚本库自动扫描生成积木，或导入手写 <code>.polyext.json</code>。仅保存在本项目内，按「句柄 &gt; 项目 &gt; 全局」作用域无条件覆盖全局包（含预装包）。
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
                      当前项目暂无内嵌扩展包。点击右上角「导入到本项目」即可按项目隔离挂载，不会出现在左侧全局「扩展」页。
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {localPacks.map((pack) => {
                        const enableState = getPackEnableState(
                          pack,
                          project.enabledCapabilities,
                        );
                        const overridesGlobal = globalPackIds.has(pack.id);
                        const badges = derivePackBadges(pack);
                        const placementLabel = formatPackPlacementSummary(pack);
                        const importMatch = inspectPackImportSourceMatch(pack);
                        const toggleBtnClass =
                          enableState.status === 'full'
                            ? 'enabled'
                            : enableState.status === 'partial'
                              ? 'partial'
                              : 'disabled';
                        const toggleBtnText =
                          enableState.status === 'full'
                            ? '已启用'
                            : enableState.status === 'partial'
                              ? `部分 (${enableState.enabledCount}/${enableState.totalCount})`
                              : '启用';
                        return (
                          <div key={pack.id} className="settings-ext-row multi">
                            <div className="settings-ext-row-main">
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
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
                                  {pack.iconLabel}
                                </span>
                                <div style={{ minWidth: 0 }}>
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
                                    v{pack.packVersion} · {getAllPackBlocks(pack).length} 个积木 · {placementLabel} · ID: {pack.id}
                                  </div>
                                  {(badges.length > 0 || (pack.libs && pack.libs.length > 0) || importMatch.unmatchedImports.length > 0) && (
                                    <div className="pack-attr-row" style={{ marginTop: 4 }}>
                                      {badges.map((badge) => (
                                        <span
                                          key={badge.id}
                                          className={`pack-attr-badge tone-${badge.tone}`}
                                        >
                                          {badge.label}
                                        </span>
                                      ))}
                                      {(pack.libs ?? []).map((lib) => (
                                        <span
                                          key={lib.moduleName}
                                          className="lib-file-chip"
                                          title={`真实库模块 moduleName="${lib.moduleName}"（沙箱运行 + 真机导出随行）`}
                                        >
                                          {lib.moduleName}
                                          {lib.role === 'helper' ? '·辅' : ''}
                                        </span>
                                      ))}
                                      {importMatch.unmatchedImports.length > 0 && (
                                        <span
                                          className="lib-warn-chip"
                                          title={`imports 引用了 ${importMatch.unmatchedImports.join(', ')}，包内未附带对应 libs[]/sandboxMock（若由真机 C 固件提供则导出正常）`}
                                        >
                                          <AlertTriangle size={10} />
                                          <span>
                                            无本地源码: {importMatch.unmatchedImports.join(', ')}
                                          </span>
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                                <button
                                  type="button"
                                  className="btn-ghost"
                                  style={{ padding: '4px 6px' }}
                                  title="只读查看扩展包 .polyext.json 与 Lua/Python 源码"
                                  aria-label={`查看 ${pack.name} 源码`}
                                  onClick={() =>
                                    setViewingPack({ pack, scopeLabel: '项目内嵌包' })
                                  }
                                >
                                  <Eye size={13} />
                                </button>
                                <button
                                  type="button"
                                  className="btn-ghost"
                                  style={{ padding: '4px 6px' }}
                                  title="附加或替换此包的真实库源码 (.lua / .py -> libs[])"
                                  aria-label={`为 ${pack.name} 附加库源码`}
                                  onClick={() => {
                                    setAttachTargetPackId(pack.id);
                                    attachLibsInputRef.current?.click();
                                  }}
                                >
                                  <Paperclip size={13} />
                                </button>
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
                                  className={`ext-toggle-btn ${toggleBtnClass}`}
                                  style={{ padding: '4px 10px', fontSize: 11.5 }}
                                  onClick={() =>
                                    onToggleCapabilityForProject(project.id, pack.id)
                                  }
                                >
                                  {toggleBtnText}
                                </button>
                              </div>
                            </div>
                            {renderSectionChips(pack)}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="settings-field-group" style={{ marginTop: 4 }}>
                  <label className="settings-label">
                    内置扩展包（{builtinPacks.length} · 统一声明式协议，支持整包或按组件裁剪）
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {builtinPacks.map((pack) => {
                      const enableState = getPackEnableState(
                        pack,
                        project.enabledCapabilities,
                      );
                      const overridden = localPackIds.has(pack.id);
                      const badges = derivePackBadges(pack);
                      const placementLabel = formatPackPlacementSummary(pack);
                      const toggleBtnClass =
                        enableState.status === 'full'
                          ? 'enabled'
                          : enableState.status === 'partial'
                            ? 'partial'
                            : 'disabled';
                      const toggleBtnText = overridden
                        ? '已覆盖'
                        : enableState.status === 'full'
                          ? '已启用'
                          : enableState.status === 'partial'
                            ? `部分 (${enableState.enabledCount}/${enableState.totalCount})`
                            : '启用';
                      return (
                        <div
                          key={pack.id}
                          className="settings-ext-row multi"
                          style={overridden ? { opacity: 0.65 } : undefined}
                        >
                          <div className="settings-ext-row-main">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
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
                                {pack.iconLabel}
                              </span>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                                  {pack.name}
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                  {getAllPackBlocks(pack).length} 个积木 · {placementLabel} · ID: {pack.id}
                                  {overridden ? ' · 已被本项目内嵌包覆盖' : ''}
                                </div>
                                {badges.length > 0 && (
                                  <div className="pack-attr-row" style={{ marginTop: 4 }}>
                                    {badges.map((badge) => (
                                      <span
                                        key={badge.id}
                                        className={`pack-attr-badge tone-${badge.tone}`}
                                      >
                                        {badge.label}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                              <button
                                type="button"
                                className="btn-ghost"
                                style={{ padding: '4px 6px' }}
                                title="只读查看扩展包 .polyext.json 与 Lua/Python 源码"
                                aria-label={`查看 ${pack.name} 源码`}
                                onClick={() =>
                                  setViewingPack({ pack, scopeLabel: '预装全局包' })
                                }
                              >
                                <Eye size={13} />
                              </button>
                              <button
                                type="button"
                                className={`ext-toggle-btn ${toggleBtnClass}`}
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
                                {toggleBtnText}
                              </button>
                            </div>
                          </div>
                          {renderSectionChips(pack, overridden)}
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
                    }}
                  >
                    <label className="settings-label">
                      自定义全局扩展包（{customGlobalPacks.length} · 跨项目共享，导出项目自动附带快照）
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
                  {customGlobalPacks.length === 0 ? (
                    <div
                      className="settings-ext-row"
                      style={{
                        background: 'var(--bg-subtle)',
                        borderStyle: 'dashed',
                        fontSize: 11.5,
                        color: 'var(--text-muted)',
                      }}
                    >
                      全局库暂无自定义扩展包。可在左侧「扩展」页导入团队复用的 .polyext.json。
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {customGlobalPacks.map((pack) => {
                        const enableState = getPackEnableState(
                          pack,
                          project.enabledCapabilities,
                        );
                        const overridden = localPackIds.has(pack.id);
                        const badges = derivePackBadges(pack);
                        const placementLabel = formatPackPlacementSummary(pack);
                        const toggleBtnClass =
                          enableState.status === 'full'
                            ? 'enabled'
                            : enableState.status === 'partial'
                              ? 'partial'
                              : 'disabled';
                        const toggleBtnText = overridden
                          ? '已覆盖'
                          : enableState.status === 'full'
                            ? '已启用'
                            : enableState.status === 'partial'
                              ? `部分 (${enableState.enabledCount}/${enableState.totalCount})`
                              : '启用';
                        return (
                          <div
                            key={pack.id}
                            className="settings-ext-row multi"
                            style={overridden ? { opacity: 0.65 } : undefined}
                          >
                            <div className="settings-ext-row-main">
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
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
                                  {pack.iconLabel}
                                </span>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                                    {pack.name}
                                  </div>
                                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                    v{pack.packVersion} · {getAllPackBlocks(pack).length} 个积木 · {placementLabel}
                                    {overridden ? ' · 已被本项目内嵌包覆盖' : ''}
                                  </div>
                                  {badges.length > 0 && (
                                    <div className="pack-attr-row" style={{ marginTop: 4 }}>
                                      {badges.map((badge) => (
                                        <span
                                          key={badge.id}
                                          className={`pack-attr-badge tone-${badge.tone}`}
                                        >
                                          {badge.label}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                                <button
                                  type="button"
                                  className="btn-ghost"
                                  style={{ padding: '4px 6px' }}
                                  title="只读查看扩展包 .polyext.json 与 Lua/Python 源码"
                                  aria-label={`查看 ${pack.name} 源码`}
                                  onClick={() =>
                                    setViewingPack({ pack, scopeLabel: '自定义全局包' })
                                  }
                                >
                                  <Eye size={13} />
                                </button>
                                <button
                                  type="button"
                                  className={`ext-toggle-btn ${toggleBtnClass}`}
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
                                  {toggleBtnText}
                                </button>
                              </div>
                            </div>
                            {renderSectionChips(pack, overridden)}
                          </div>
                        );
                      })}
                    </div>
                  )}
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

                  {channelPools.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 6 }}>
                      {channelPools.map(({ pack: poolPack, section: poolSection, pool }) => {
                        const poolCfg = readPoolCfg(pool);
                        const rawSlot = aliasSlotsByPool[pool.configKey] ?? '0';
                        const curSlotId =
                          Number(rawSlot) < poolCfg.count ? rawSlot : '0';
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
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
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
                                        poolCfg.count === preset ? 'btn-primary' : 'btn-outline'
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
                                      <span key={slotKey} className="var-chip timer-alias-chip">
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
                        background: 'var(--bg-subtle)',
                        borderStyle: 'dashed',
                      }}
                    >
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                        当前项目未启用任何带<strong>每句柄通道池</strong>的扩展包（如多路编号定时器或自定义 PWM 通道包）。若目标板卡支持此类资源，可按需启用。
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
      {viewingPack && (
        <ExtensionSourceModal
          pack={viewingPack.pack}
          scopeLabel={viewingPack.scopeLabel}
          onClose={() => setViewingPack(null)}
          onNotify={onNotify}
        />
      )}
    </div>
  );
}
