import {
  AlertTriangle,
  CheckSquare,
  Download,
  Eye,
  Globe,
  Paperclip,
  Square,
  Trash2,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { formatSupportedExtensionsLabel } from '../../core/backends/registry';
import { hasCapability } from '../../core/capabilities/registry';
import { inspectPackImportSourceMatch } from '../../core/extensions/moduleResolver';
import {
  derivePackBadges,
  formatPackPlacementSummary,
  formatSectionPlacement,
  getAllPackBlocks,
  getPackEnableState,
  resolvePackSections,
} from '../../core/extensions/registry';
import type { PolyExtensionPack } from '../../core/extensions/types';

export type ExtensionPackRowVariant = 'local' | 'global';

interface ExtensionPackRowProps {
  pack: PolyExtensionPack;
  variant: ExtensionPackRowVariant;
  enabledCapabilities: string[];
  editingLocked?: boolean;
  overridesGlobal?: boolean;
  overriddenByLocal?: boolean;
  onViewSource: () => void;
  onToggleCapability: (capId: string) => void;
  onAttachLibs?: () => void;
  onPromoteToGlobal?: () => void;
  onExportPack?: () => void;
  onRemoveLocal?: () => void;
}

export function ExtensionPackRow({
  pack,
  variant,
  enabledCapabilities,
  editingLocked = false,
  overridesGlobal = false,
  overriddenByLocal = false,
  onViewSource,
  onToggleCapability,
  onAttachLibs,
  onPromoteToGlobal,
  onExportPack,
  onRemoveLocal,
}: ExtensionPackRowProps) {
  const enableState = getPackEnableState(pack, enabledCapabilities);
  const badges = derivePackBadges(pack);
  const placementLabel = formatPackPlacementSummary(pack);
  const sections = resolvePackSections(pack);
  const importMatch =
    variant === 'local' ? inspectPackImportSourceMatch(pack) : null;

  const toggleBtnClass =
    enableState.status === 'full'
      ? 'enabled'
      : enableState.status === 'partial'
        ? 'partial'
        : 'disabled';
  const toggleBtnText = overriddenByLocal
    ? '已覆盖'
    : enableState.status === 'full'
      ? '已启用'
      : enableState.status === 'partial'
        ? `部分 (${enableState.enabledCount}/${enableState.totalCount})`
        : '启用';

  const hasBadgeRow =
    badges.length > 0 ||
    (variant === 'local' &&
      ((pack.libs && pack.libs.length > 0) ||
        (importMatch !== null && importMatch.unmatchedImports.length > 0)));

  return (
    <div
      className="settings-ext-row multi"
      style={overriddenByLocal ? { opacity: 0.65 } : undefined}
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
            {variant === 'local' ? (
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
                <span className="count-badge">
                  {overridesGlobal ? '项目锁定' : '项目私有'}
                </span>
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
            ) : (
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>{pack.name}</div>
            )}

            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              v{pack.packVersion} · {getAllPackBlocks(pack).length} 个积木 ·{' '}
              {placementLabel} · ID: {pack.id}
              {variant === 'global' && overriddenByLocal
                ? ' · 已被本项目锁定包覆盖'
                : ''}
            </div>

            {hasBadgeRow && (
              <div className="pack-attr-row" style={{ marginTop: 4 }}>
                {badges.map((badge) => (
                  <span
                    key={badge.id}
                    className={`pack-attr-badge tone-${badge.tone}`}
                  >
                    {badge.label}
                  </span>
                ))}
                {variant === 'local' &&
                  (pack.libs ?? []).map((lib) => (
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
            title="只读查看扩展包 .polyext.json 与脚本源码"
            aria-label={`查看 ${pack.name} 源码`}
            onClick={onViewSource}
          >
            <Eye size={13} />
          </button>

          {variant === 'local' && onAttachLibs && (
            <button
              type="button"
              className="btn-ghost"
              style={{ padding: '4px 6px' }}
              disabled={editingLocked}
              title={
                editingLocked
                  ? '请先停止当前运行再修改库源码'
                  : `附加或替换此包的真实库源码 (${formatSupportedExtensionsLabel()} -> libs[])`
              }
              aria-label={`为 ${pack.name} 附加库源码`}
              onClick={onAttachLibs}
            >
              <Paperclip size={13} />
            </button>
          )}

          {variant === 'local' && onPromoteToGlobal && (
            <button
              type="button"
              className="btn-ghost"
              style={{ padding: '4px 6px' }}
              disabled={editingLocked}
              title={
                editingLocked
                  ? '请先停止当前运行再保存到全局库'
                  : '复制一份保存到全局扩展库（供其他项目复用）'
              }
              aria-label={`将 ${pack.name} 保存到全局扩展库`}
              onClick={onPromoteToGlobal}
            >
              <Globe size={13} />
            </button>
          )}

          {variant === 'local' && onExportPack && (
            <button
              type="button"
              className="btn-ghost"
              style={{ padding: '4px 6px' }}
              title="导出为独立 .polyext.json"
              aria-label={`导出 ${pack.name}`}
              onClick={onExportPack}
            >
              <Download size={13} />
            </button>
          )}

          {variant === 'local' && onRemoveLocal && (
            <button
              type="button"
              className="btn-ghost"
              style={{ padding: '4px 6px', color: 'var(--danger)' }}
              disabled={editingLocked}
              title={
                editingLocked
                  ? '请先停止当前运行再移除锁定包'
                  : overridesGlobal
                    ? '移出项目锁定（回退使用全局版本）'
                    : '从当前项目移除此私有包'
              }
              aria-label={
                overridesGlobal
                  ? `移出项目锁定 ${pack.name}`
                  : `移除项目私有包 ${pack.name}`
              }
              onClick={onRemoveLocal}
            >
              <Trash2 size={13} />
            </button>
          )}

          <button
            type="button"
            className={`ext-toggle-btn ${toggleBtnClass}`}
            style={{ padding: '4px 10px', fontSize: 11.5, flexShrink: 0 }}
            disabled={editingLocked || overriddenByLocal}
            title={
              editingLocked
                ? '请先停止当前运行再切换扩展开关'
                : overriddenByLocal
                  ? '已被上方同名项目锁定包覆盖，可移除上方锁定以回退使用全局版'
                  : undefined
            }
            onClick={() => onToggleCapability(pack.id)}
          >
            {toggleBtnText}
          </button>
        </div>
      </div>

      {sections.length > 1 && (
        <div
          className="pack-sections-bar compact"
          role="group"
          aria-label={`${pack.name} 按组件勾选启用`}
        >
          <span className="pack-sections-title">按组件勾选：</span>
          {sections.map((sec) => {
            const secOn = hasCapability(enabledCapabilities, sec.capId);
            const posText = formatSectionPlacement(sec);
            return (
              <button
                key={sec.capId}
                type="button"
                disabled={editingLocked || overriddenByLocal}
                aria-pressed={secOn}
                className={`pack-section-chip ${secOn ? 'active' : ''}`}
                style={
                  secOn
                    ? ({ '--chip-accent': sec.color } as CSSProperties)
                    : undefined
                }
                title={
                  editingLocked
                    ? '请先停止当前运行再修改启用组件'
                    : `${sec.label}（${posText}）${sec.description ? `：${sec.description}` : ''} · 点击单独${secOn ? '取消勾选' : '勾选启用'}`
                }
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
    </div>
  );
}
