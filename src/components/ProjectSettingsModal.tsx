import { Cpu, Puzzle, Settings2, Sliders, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { UploadedScriptLibFile } from '../core/extensions/scriptLibScanner';
import type { PolyExtensionPack } from '../core/extensions/types';
import { countProjectScripts } from '../core/projects/store';
import { useModalFocusTrap } from '../hooks/useModalFocusTrap';
import type { HandleConfigPatch } from '../hooks/useProjectStore';
import type {
  ProjectModel,
  ScriptLanguageId,
  TargetProfile,
} from '../types/project';
import { ExtensionSourceModal } from './ExtensionSourceModal';
import { CapabilitiesTab } from './settings/CapabilitiesTab';
import { GeneralProfileTab } from './settings/GeneralProfileTab';
import { HandlesTab } from './settings/HandlesTab';

export type ProjectSettingsTab = 'general' | 'capabilities' | 'handles';

interface ProjectSettingsModalProps {
  project: ProjectModel;
  initialTab?: ProjectSettingsTab;
  initialHandleId?: string;
  allExtensionPacks: PolyExtensionPack[];
  allTargetProfiles: TargetProfile[];
  editingLocked?: boolean;
  suppressed?: boolean;
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
    patch: HandleConfigPatch,
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
  editingLocked = false,
  suppressed = false,
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
  const [viewingPack, setViewingPack] = useState<{
    pack: PolyExtensionPack;
    scopeLabel: string;
  } | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);

  const isOverlaySuppressed = Boolean(viewingPack) || suppressed;
  useModalFocusTrap(modalRef, !isOverlaySuppressed);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isOverlaySuppressed) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, isOverlaySuppressed]);

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
      <div className="modal-shell settings-modal" ref={modalRef} tabIndex={-1}>
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
              <GeneralProfileTab
                project={project}
                allTargetProfiles={allTargetProfiles}
                editingLocked={editingLocked}
                onUpdateProjectMeta={onUpdateProjectMeta}
                onApplyTargetProfile={onApplyTargetProfile}
                onImportBoardProfileJson={onImportBoardProfileJson}
                onNotify={onNotify}
              />
            )}

            {tab === 'capabilities' && (
              <CapabilitiesTab
                project={project}
                allExtensionPacks={allExtensionPacks}
                editingLocked={editingLocked}
                onToggleCapabilityForProject={onToggleCapabilityForProject}
                onImportLocalExtensionJson={onImportLocalExtensionJson}
                onOpenScriptLibImportModal={onOpenScriptLibImportModal}
                onAttachLibsToLocalPack={onAttachLibsToLocalPack}
                onRemoveLocalExtension={onRemoveLocalExtension}
                onPromoteLocalExtensionToGlobal={onPromoteLocalExtensionToGlobal}
                onViewPack={(pack, scopeLabel) =>
                  setViewingPack({ pack, scopeLabel })
                }
                onOpenExtensionsPage={onOpenExtensionsPage}
                onCloseModal={onClose}
                onNotify={onNotify}
              />
            )}

            {tab === 'handles' && (
              <HandlesTab
                project={project}
                selectedHandleId={selectedHandleId}
                editingLocked={editingLocked}
                onSelectHandleId={setSelectedHandleId}
                onAddHandle={onAddHandle}
                onRenameHandle={onRenameHandle}
                onDuplicateHandle={onDuplicateHandle}
                onDeleteHandle={onDeleteHandle}
                onUpdateHandleConfig={onUpdateHandleConfig}
                onSwitchToCapabilitiesTab={() => setTab('capabilities')}
              />
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
