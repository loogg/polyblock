import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  CheckSquare,
  Cpu,
  Download,
  FileCode2,
  Paperclip,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { backendRegistry } from '../../core/backends/registry';
import {
  CORE_TOOLBOX_ORDERS,
  DEFAULT_EXTENSION_TOOLBOX_ORDER,
} from '../../core/blocks/catalog';
import {
  hasCapability,
  SAMPLE_CUSTOM_BOARD_TEMPLATE,
} from '../../core/capabilities/registry';
import { SAMPLE_CUSTOM_EXTENSION_TEMPLATE } from '../../core/extensions/builtinPacks';
import { inspectPackImportSourceMatch } from '../../core/extensions/moduleResolver';
import {
  derivePackBadges,
  formatPackPlacementSummary,
  formatSectionPlacement,
  getAllPackBlocks,
  getPackEnableState,
  resolvePackSections,
} from '../../core/extensions/registry';
import {
  scanScriptLibraryFile,
  type UploadedScriptLibFile,
} from '../../core/extensions/scriptLibScanner';
import type { PolyExtensionPack } from '../../core/extensions/types';
import type { ScriptLanguageId, TargetProfile } from '../../types/project';
import { ExtensionSpecModal } from '../ExtensionSpecModal';

interface ExtensionsPageProps {
  activeProjectName: string;
  activeProjectLanguage: ScriptLanguageId;
  activeProfileId: string;
  allPacks: PolyExtensionPack[];
  allTargetProfiles: TargetProfile[];
  enabledCapabilityIds: string[];
  onToggleCapability: (capId: string) => void;
  onApplyTargetProfile: (profileId: string) => void;
  onImportExtensionJson: (raw: unknown) => void;
  onOpenScriptLibImportModal: () => void;
  onAttachLibsToGlobalPack: (
    packId: string,
    files: UploadedScriptLibFile[],
  ) => void;
  onRemoveCustomPack: (packId: string) => void;
  onImportBoardProfileJson: (raw: unknown) => void;
  onRemoveCustomProfile: (profileId: string) => void;
  onReturnToBlocks: () => void;
  onNotify: (msg: string) => void;
}

function downloadJsonFile(fileName: string, data: unknown): void {
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
}

export function ExtensionsPage({
  activeProjectName,
  activeProjectLanguage,
  activeProfileId,
  allPacks,
  allTargetProfiles,
  enabledCapabilityIds,
  onToggleCapability,
  onApplyTargetProfile,
  onImportExtensionJson,
  onOpenScriptLibImportModal,
  onAttachLibsToGlobalPack,
  onRemoveCustomPack,
  onImportBoardProfileJson,
  onRemoveCustomProfile,
  onReturnToBlocks,
  onNotify,
}: ExtensionsPageProps) {
  const [showSpecModal, setShowSpecModal] = useState(false);
  const extFileInputRef = useRef<HTMLInputElement | null>(null);
  const boardFileInputRef = useRef<HTMLInputElement | null>(null);
  const attachLibsInputRef = useRef<HTMLInputElement | null>(null);
  const [attachTargetPackId, setAttachTargetPackId] = useState<string | null>(null);
  const builtinPacks = allPacks.filter((p) => Boolean(p.builtin));
  const customPacks = allPacks.filter((p) => !p.builtin);
  const backends = backendRegistry.list();

  const handleImportExtFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as unknown;
        onImportExtensionJson(parsed);
      } catch (err) {
        onNotify(
          `导入扩展包失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  };

  const handleImportBoardFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as unknown;
        onImportBoardProfileJson(parsed);
      } catch (err) {
        onNotify(
          `导入目标板型规格失败：${err instanceof Error ? err.message : String(err)}`,
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
      scanned.push(scanScriptLibraryFile(file.name, text, activeProjectLanguage));
    }
    onAttachLibsToGlobalPack(attachTargetPackId, scanned);
    setAttachTargetPackId(null);
  };

  const renderPackCard = (pack: PolyExtensionPack, isCustom: boolean) => {
    const enableState = getPackEnableState(pack, enabledCapabilityIds);
    const isAnyEnabled = enableState.status !== 'none';
    const badges = derivePackBadges(pack);
    const sections = resolvePackSections(pack);
    const allBlocks = getAllPackBlocks(pack);
    const placementLabel = formatPackPlacementSummary(pack);
    const importMatch = isCustom ? inspectPackImportSourceMatch(pack) : null;
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
          ? `部分启用 (${enableState.enabledCount}/${enableState.totalCount})`
          : '+ 启用';

    return (
      <div
        key={pack.id}
        className="ui-card"
        style={
          isAnyEnabled
            ? {
                borderColor: pack.color,
                boxShadow: `0 0 0 1px ${pack.color}33`,
              }
            : undefined
        }
      >
        <div className="card-top">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              className="card-icon"
              style={{ background: pack.color, fontSize: 11.5 }}
            >
              {pack.iconLabel}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13.5 }}>{pack.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                v{pack.packVersion} · {allBlocks.length} 个积木 · {placementLabel}
              </div>
            </div>
          </div>
          <span className={`status-pill ${isCustom ? 'accent' : 'idle'}`}>
            {isCustom ? '自定义' : '内置'}
          </span>
        </div>

        {(badges.length > 0 || (pack.libs && pack.libs.length > 0) || (importMatch && importMatch.unmatchedImports.length > 0)) && (
          <div className="pack-attr-row">
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
            {importMatch && importMatch.unmatchedImports.length > 0 && (
              <span
                className="lib-warn-chip"
                title={`imports 引用了 ${importMatch.unmatchedImports.join(', ')}，包内未附带对应 libs[]/sandboxMock（若由真机 C 固件提供则导出正常）`}
              >
                <AlertTriangle size={10} />
                <span>无本地源码: {importMatch.unmatchedImports.join(', ')}</span>
              </span>
            )}
          </div>
        )}

        <p className="card-desc">{pack.description}</p>

        {sections.length > 1 && (
          <div
            className="pack-sections-bar"
            role="group"
            aria-label={`${pack.name} 按组件勾选启用`}
          >
            <span className="pack-sections-title">按组件勾选：</span>
            {sections.map((sec) => {
              const secOn = hasCapability(enabledCapabilityIds, sec.capId);
              const posText = formatSectionPlacement(sec);
              return (
                <button
                  key={sec.capId}
                  type="button"
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
                  onClick={() => onToggleCapability(sec.capId)}
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
        )}

        <div className="paused-var-chips">
          {allBlocks.slice(0, 4).map((b) => (
            <span key={b.type} className="var-chip" style={{ fontSize: 10.5 }}>
              {b.message0.replace(/%\d/g, '▢')}
            </span>
          ))}
          {allBlocks.length > 4 && (
            <span className="var-chip" style={{ fontSize: 10.5 }}>
              +{allBlocks.length - 4} 项
            </span>
          )}
        </div>

        <div className="card-footer">
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            ID: {pack.id} · Lua 5.4 / Python 3
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {isCustom && (
              <>
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
                  title="导出此全局扩展包 (.polyext.json) 分享给他人"
                  onClick={() => {
                    downloadJsonFile(`${pack.id}.polyext.json`, pack);
                    onNotify(`已导出全局扩展包 ${pack.id}.polyext.json`);
                  }}
                >
                  <Download size={13} />
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ padding: '4px 6px', color: 'var(--danger)' }}
                  title="删除自定义扩展包"
                  onClick={() => onRemoveCustomPack(pack.id)}
                >
                  <Trash2 size={13} />
                </button>
              </>
            )}
            <button
              type="button"
              className={`ext-toggle-btn ${toggleBtnClass}`}
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
              title={
                enableState.status === 'full'
                  ? '点击从当前项目停用整个扩展包'
                  : '点击为当前项目启用整个扩展包'
              }
              onClick={() => onToggleCapability(pack.id)}
            >
              {toggleBtnText}
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="subpage-wrap">
      <div className="subpage-inner">
        <div className="subpage-header">
          <div>
            <h1 className="subpage-title">全局扩展库、能力模块与板型预设</h1>
            <p className="subpage-sub">
              此处管理<strong>跨项目共享的全局扩展库</strong>（可为当前项目{' '}
              <strong>{activeProjectName}</strong> 整包开关，或直接点击多组件卡片中的勾选框按组件部分启用）。若外设包仅归属单个项目，请在「项目配置 → 能力与外设」导入为
              <strong>项目内嵌包</strong>，不会污染此页。
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-primary"
              onClick={onOpenScriptLibImportModal}
            >
              <FileCode2 size={14} />
              <span>导入脚本库 (.lua/.py)</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={() => extFileInputRef.current?.click()}
            >
              <Upload size={14} />
              <span>导入 .polyext.json</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={() => boardFileInputRef.current?.click()}
            >
              <Cpu size={14} />
              <span>导入板型 (.polyboard.json)</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={() => setShowSpecModal(true)}
            >
              <BookOpen size={14} />
              <span>扩展包规范</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={() => {
                downloadJsonFile(
                  'my-robot-api.polyext.json',
                  SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
                );
                onNotify('已下载自定义外设包示例模板 my-robot-api.polyext.json');
              }}
            >
              <Download size={14} />
              <span>外设模板</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={() => {
                downloadJsonFile(
                  `${SAMPLE_CUSTOM_BOARD_TEMPLATE.id}.polyboard.json`,
                  SAMPLE_CUSTOM_BOARD_TEMPLATE,
                );
                onNotify(
                  `已下载自定义板型示例模板 ${SAMPLE_CUSTOM_BOARD_TEMPLATE.id}.polyboard.json`,
                );
              }}
            >
              <Download size={14} />
              <span>板型模板</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={onReturnToBlocks}
            >
              <ArrowLeft size={14} />
              <span>返回画布</span>
            </button>
            <input
              ref={extFileInputRef}
              type="file"
              accept=".json,.polyext.json"
              style={{ display: 'none' }}
              onChange={handleImportExtFile}
            />
            <input
              ref={boardFileInputRef}
              type="file"
              accept=".json,.polyboard.json"
              style={{ display: 'none' }}
              onChange={handleImportBoardFile}
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

        <div className="toolbox-order-legend" aria-label="工具箱分类序号参考">
          <span className="toolbox-order-legend-title">工具箱默认分类序：</span>
          {CORE_TOOLBOX_ORDERS.map((c) => (
            <span key={c.id} className="toolbox-order-chip">
              {c.label} <code>#{c.order}</code>
            </span>
          ))}
          <span className="toolbox-order-chip ext">
            扩展包默认 <code>#{DEFAULT_EXTENSION_TOOLBOX_ORDER}+</code>
          </span>
        </div>

        <h2 className="section-heading">
          内置扩展包（随 IDE 提供 · 当前项目启用{' '}
          {
            builtinPacks.filter(
              (p) => getPackEnableState(p, enabledCapabilityIds).status !== 'none',
            ).length
          }{' '}
          / {builtinPacks.length}）
        </h2>
        <div className="card-grid">
          {builtinPacks.map((pack) => renderPackCard(pack, false))}
        </div>

        <h2 className="section-heading">
          自定义全局扩展包（跨项目复用 · 当前项目启用{' '}
          {
            customPacks.filter(
              (p) => getPackEnableState(p, enabledCapabilityIds).status !== 'none',
            ).length
          }{' '}
          / {customPacks.length}）
        </h2>
        {customPacks.length === 0 ? (
          <div className="ui-card" style={{ borderStyle: 'dashed', opacity: 0.9 }}>
            <div
              style={{
                fontSize: 12.5,
                color: 'var(--text-secondary)',
                lineHeight: 1.6,
              }}
            >
              暂未导入自定义全局扩展包。点击右上角{' '}
              <strong>「导入到全局库 (.polyext.json)」</strong>{' '}
              可导入团队复用的硬件驱动、底层 C 接口或纯脚本算法库（点击「扩展包规范」可随时查看全部字段说明）；若仅归属单个项目，请在「项目配置 → 能力与外设」导入为项目内嵌包。
            </div>
          </div>
        ) : (
          <div className="card-grid">
            {customPacks.map((pack) => renderPackCard(pack, true))}
          </div>
        )}

        <h2 className="section-heading">
          目标板型规格预设（.polyboard.json · 共 {allTargetProfiles.length} 种）
        </h2>
        <div className="card-grid">
          {allTargetProfiles.map((prof) => {
            const isActive = prof.id === activeProfileId;
            return (
              <div
                key={prof.id}
                className="ui-card"
                style={
                  isActive
                    ? {
                        borderColor: 'var(--accent)',
                        boxShadow: '0 0 0 1px var(--accent-soft)',
                      }
                    : undefined
                }
              >
                <div className="card-top">
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>{prof.name}</div>
                  <span
                    className={`status-pill ${
                      isActive ? 'ok' : prof.builtin ? 'idle' : 'accent'
                    }`}
                  >
                    {isActive ? '当前板型' : prof.builtin ? '内置预设' : '自定义'}
                  </span>
                </div>
                <p className="card-desc">{prof.description}</p>
                <div className="paused-var-chips">
                  <span className="var-chip" style={{ fontSize: 10.5 }}>
                    上限 {prof.maxHandles} 句柄
                  </span>
                  {prof.capabilities.length === 0 ? (
                    <span className="var-chip" style={{ fontSize: 10.5 }}>
                      零附加能力（纯语言）
                    </span>
                  ) : (
                    prof.capabilities.map((cid) => (
                      <span key={cid} className="var-chip" style={{ fontSize: 10.5 }}>
                        {cid}
                      </span>
                    ))
                  )}
                </div>
                <div className="card-footer">
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    ID: {prof.id}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {!prof.builtin && (
                      <>
                        <button
                          type="button"
                          className="btn-ghost"
                          style={{ padding: '4px 6px' }}
                          title="导出此目标板型规格 (.polyboard.json)"
                          onClick={() => {
                            downloadJsonFile(`${prof.id}.polyboard.json`, prof);
                            onNotify(`已导出板型规格 ${prof.id}.polyboard.json`);
                          }}
                        >
                          <Download size={13} />
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          style={{ padding: '4px 6px', color: 'var(--danger)' }}
                          title="删除自定义板型"
                          onClick={() => onRemoveCustomProfile(prof.id)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className={isActive ? 'btn-primary' : 'btn-outline'}
                      style={{ padding: '4px 10px', fontSize: 11.5 }}
                      onClick={() => onApplyTargetProfile(prof.id)}
                    >
                      {isActive ? '重新应用此板型' : '应用到当前项目'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <h2 className="section-heading">已注册脚本生成后端（BackendRegistry）</h2>
        <div className="card-grid">
          {backends.map((b) => (
            <div key={b.id} className="ui-card">
              <div className="card-top">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div className="card-icon" style={{ background: b.accentColor }}>
                    .{b.extension.toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontWeight: 700 }}>
                      {b.name} {b.version}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      默认导出：{b.fileName}
                    </div>
                  </div>
                </div>
                <span className="status-pill ok">已启用</span>
              </div>
              <p className="card-desc">{b.description}</p>
            </div>
          ))}
        </div>
      </div>

      {showSpecModal && (
        <ExtensionSpecModal onClose={() => setShowSpecModal(false)} />
      )}
    </div>
  );
}
