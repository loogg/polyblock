import { Download, FileCode2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  formatSupportedExtensionsLabel,
  getSupportedScriptAcceptAttr,
} from '../../core/backends/registry';
import {
  CORE_TOOLBOX_ORDERS,
  DEFAULT_EXTENSION_TOOLBOX_ORDER,
} from '../../core/blocks/catalog';
import { SAMPLE_CUSTOM_EXTENSION_TEMPLATE } from '../../core/extensions/defaultPacks';
import {
  scanScriptLibraryFile,
  type UploadedScriptLibFile,
} from '../../core/extensions/scriptLibScanner';
import type { PolyExtensionPack } from '../../core/extensions/types';
import { triggerJsonDownload } from '../../hooks/fileDownload';
import type { ProjectModel } from '../../types/project';
import { ExtensionPackRow } from './ExtensionPackRow';

interface CapabilitiesTabProps {
  project: ProjectModel;
  allExtensionPacks: PolyExtensionPack[];
  editingLocked?: boolean;
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
  onViewPack: (pack: PolyExtensionPack, scopeLabel: string) => void;
  onOpenExtensionsPage: () => void;
  onCloseModal: () => void;
  onNotify: (msg: string) => void;
}

export function CapabilitiesTab({
  project,
  allExtensionPacks,
  editingLocked = false,
  onToggleCapabilityForProject,
  onImportLocalExtensionJson,
  onOpenScriptLibImportModal,
  onAttachLibsToLocalPack,
  onRemoveLocalExtension,
  onPromoteLocalExtensionToGlobal,
  onViewPack,
  onOpenExtensionsPage,
  onCloseModal,
  onNotify,
}: CapabilitiesTabProps) {
  const localExtFileRef = useRef<HTMLInputElement | null>(null);
  const attachLibsInputRef = useRef<HTMLInputElement | null>(null);
  const [attachTargetPackId, setAttachTargetPackId] = useState<string | null>(
    null,
  );

  const localPacks = project.localExtensions ?? [];
  const localPackIds = new Set(localPacks.map((p) => p.id));
  const globalPackIds = new Set(allExtensionPacks.map((p) => p.id));

  const supportedExtAccept = getSupportedScriptAcceptAttr();
  const supportedExtLabel = formatSupportedExtensionsLabel();

  const downloadPackJson = (
    fileName: string,
    data: unknown,
    toastText: string,
  ) => {
    triggerJsonDownload(fileName, data);
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
          `导入项目扩展包失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  };

  const handleAttachLibsInput = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (picked.length === 0 || !attachTargetPackId) return;
    try {
      const scanned: UploadedScriptLibFile[] = [];
      for (const file of picked) {
        const text = await file.text();
        scanned.push(scanScriptLibraryFile(file.name, text, project.language));
      }
      onAttachLibsToLocalPack(project.id, attachTargetPackId, scanned);
    } catch (err) {
      onNotify(
        `读取或解析脚本库文件失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setAttachTargetPackId(null);
    }
  };

  return (
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
            本项目私有 / 锁定扩展包（{localPacks.length} · 不污染全局库，导出 .polyblock.zip 时随行）
          </label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-primary"
              style={{ fontSize: 11.5, padding: '4px 9px', flexShrink: 0 }}
              disabled={editingLocked}
              title={editingLocked ? '请先停止当前运行再导入脚本库' : undefined}
              onClick={() => onOpenScriptLibImportModal(project.id)}
            >
              <FileCode2 size={11} />
              <span>导入脚本库 ({supportedExtLabel})</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              style={{ fontSize: 11.5, padding: '4px 9px', flexShrink: 0 }}
              disabled={editingLocked}
              title={editingLocked ? '请先停止当前运行再导入扩展包' : undefined}
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
              accept={supportedExtAccept}
              multiple
              style={{ display: 'none' }}
              onChange={handleAttachLibsInput}
            />
          </div>
        </div>
        <p className="settings-hint">
          支持直接导入 <code>{supportedExtLabel}</code> 脚本库自动扫描生成积木，或导入{' '}
          <code>.polyext.json</code>。仅保存在本项目作用域内，按「句柄 &gt; 项目 &gt; 全局」优先覆盖同名全局包（导出 <code>.polyblock.zip</code> 时随工程独立打包）。
        </p>
        {localPacks.length === 0 ? (
          <div
            className="settings-ext-row"
            style={{
              background: 'var(--bg-panel-subtle)',
              borderStyle: 'dashed',
              fontSize: 11.5,
              color: 'var(--text-muted)',
            }}
          >
            当前项目暂无私有/锁定扩展包。点击上方「导入脚本库」或「导入 .polyext.json」即可仅在本项目作用域挂载，不会污染左侧全局「扩展」页。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {localPacks.map((pack) => (
              <ExtensionPackRow
                key={pack.id}
                pack={pack}
                variant="local"
                enabledCapabilities={project.enabledCapabilities}
                editingLocked={editingLocked}
                overridesGlobal={globalPackIds.has(pack.id)}
                onViewSource={() => onViewPack(pack, '项目私有包')}
                onToggleCapability={(capId) =>
                  onToggleCapabilityForProject(project.id, capId)
                }
                onAttachLibs={() => {
                  setAttachTargetPackId(pack.id);
                  attachLibsInputRef.current?.click();
                }}
                onPromoteToGlobal={() => onPromoteLocalExtensionToGlobal(pack)}
                onExportPack={() =>
                  downloadPackJson(
                    `${pack.id}.polyext.json`,
                    pack,
                    `已导出项目扩展包 ${pack.id}.polyext.json`,
                  )
                }
                onRemoveLocal={() => onRemoveLocalExtension(project.id, pack.id)}
              />
            ))}
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
            全局扩展库（{allExtensionPacks.length} · 跨项目共享，支持整包或按组件裁剪）
          </label>
          <button
            type="button"
            className="btn-outline"
            style={{ fontSize: 11.5, padding: '4px 9px', flexShrink: 0 }}
            onClick={() => {
              onCloseModal();
              onOpenExtensionsPage();
            }}
          >
            管理全局扩展库 →
          </button>
        </div>
        {allExtensionPacks.length === 0 ? (
          <div
            className="settings-ext-row"
            style={{
              background: 'var(--bg-panel-subtle)',
              borderStyle: 'dashed',
              fontSize: 11.5,
              color: 'var(--text-muted)',
            }}
          >
            全局扩展库暂无扩展包。可在左侧「扩展」页导入 .polyext.json 或恢复出厂默认包。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {allExtensionPacks.map((pack) => (
              <ExtensionPackRow
                key={pack.id}
                pack={pack}
                variant="global"
                enabledCapabilities={project.enabledCapabilities}
                editingLocked={editingLocked}
                overriddenByLocal={localPackIds.has(pack.id)}
                onViewSource={() => onViewPack(pack, '全局扩展包')}
                onToggleCapability={(capId) =>
                  onToggleCapabilityForProject(project.id, capId)
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
