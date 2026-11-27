import { Download, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { backendRegistry } from '../../core/backends/registry';
import {
  SAMPLE_CUSTOM_BOARD_TEMPLATE,
  targetProfileRegistry,
} from '../../core/capabilities/registry';
import { triggerJsonDownload } from '../../hooks/fileDownload';
import type {
  ProjectModel,
  ScriptLanguageId,
  TargetProfile,
} from '../../types/project';
import { PolySelect } from '../PolySelect';

interface GeneralProfileTabProps {
  project: ProjectModel;
  allTargetProfiles: TargetProfile[];
  disableLanguageSwitch: boolean;
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
  onNotify: (msg: string) => void;
}

export function GeneralProfileTab({
  project,
  allTargetProfiles,
  disableLanguageSwitch,
  onUpdateProjectMeta,
  onApplyTargetProfile,
  onImportBoardProfileJson,
  onNotify,
}: GeneralProfileTabProps) {
  const [nameDraft, setNameDraft] = useState(project.name);
  const [descDraft, setDescDraft] = useState(project.description ?? '');
  const profileFileRef = useRef<HTMLInputElement | null>(null);

  const activeProfile = targetProfileRegistry.get(project.targetProfileId);
  const backends = backendRegistry.list();

  useEffect(() => {
    setNameDraft(project.name);
    setDescDraft(project.description ?? '');
  }, [project.id, project.name, project.description]);

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
    const fileName = `${SAMPLE_CUSTOM_BOARD_TEMPLATE.id}.polyboard.json`;
    triggerJsonDownload(fileName, SAMPLE_CUSTOM_BOARD_TEMPLATE);
    onNotify(`已下载目标板型示例模板 ${fileName}`);
  };

  return (
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
        <PolySelect
          size="md"
          fullWidth
          ariaLabel="选择目标板型规格"
          value={project.targetProfileId}
          options={allTargetProfiles.map((prof) => ({
            value: prof.id,
            label: `${prof.name}${targetProfileRegistry.isBuiltin(prof.id) ? '' : ' [自定义]'}`,
            badge: `${prof.capabilities.length} 能力`,
          }))}
          onChange={(profileId) => onApplyTargetProfile(project.id, profileId)}
        />
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
  );
}
