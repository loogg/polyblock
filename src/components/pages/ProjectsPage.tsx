import { Download, FilePlus2, FolderOpen, Upload } from 'lucide-react';
import { useRef } from 'react';
import { PROJECT_TEMPLATES } from '../../core/blocks/templates';
import type { ProjectFileData } from '../../types/project';

interface ProjectsPageProps {
  currentProjectName: string;
  activeTemplateId: string;
  onLoadTemplate: (templateId: string) => void;
  onCreateBlank: () => void;
  onSaveProjectFile: () => void;
  onImportProjectFile: (data: ProjectFileData) => void;
  onReturnToBlocks: () => void;
  onNotify: (msg: string) => void;
}

export function ProjectsPage({
  currentProjectName,
  activeTemplateId,
  onLoadTemplate,
  onCreateBlank,
  onSaveProjectFile,
  onImportProjectFile,
  onReturnToBlocks,
  onNotify,
}: ProjectsPageProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as ProjectFileData;
        if (!parsed || typeof parsed.workspace !== 'object') {
          throw new Error('缺少 workspace 字段');
        }
        onImportProjectFile({
          format: 'polyblock-project',
          version: 1,
          name: parsed.name || file.name,
          language: parsed.language === 'python' ? 'python' : 'lua',
          updatedAt: parsed.updatedAt || new Date().toISOString(),
          workspace: parsed.workspace,
        });
      } catch (err) {
        onNotify(
          `导入失败：无效的 .polyblock.json 文件 (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  };

  return (
    <div className="subpage-wrap">
      <div className="subpage-inner">
        <div className="subpage-header">
          <div>
            <h1 className="subpage-title">项目管理与示例模板</h1>
            <p className="subpage-sub">
              工程以语言无关的统一 JSON（<code>.polyblock.json</code>）持久化，可随时切换生成 Lua 5.4 或 Python 3 脚本。当前打开：
              <strong>{currentProjectName}</strong>
            </p>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn-primary" onClick={onCreateBlank}>
              <FilePlus2 size={14} />
              <span>新建空白项目</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={14} />
              <span>导入工程 JSON</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={onSaveProjectFile}
            >
              <Download size={14} />
              <span>保存当前工程</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.polyblock.json"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </div>
        </div>

        <h2 className="section-heading">内置入门示例模板</h2>
        <div className="card-grid">
          {PROJECT_TEMPLATES.map((tpl) => {
            const isActive = activeTemplateId === tpl.id;
            return (
              <div key={tpl.id} className="ui-card">
                <div className="card-top">
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>{tpl.name}</div>
                  <span className={`status-pill ${isActive ? 'ok' : 'idle'}`}>
                    {isActive ? '当前模板' : '内置模板'}
                  </span>
                </div>
                <p className="card-desc">{tpl.description}</p>
                <div className="card-footer">
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                    推荐试跑：{tpl.recommendedLang === 'lua' ? 'Lua 5.4' : 'Python 3'}
                  </span>
                  <button
                    type="button"
                    className="btn-outline"
                    onClick={() => {
                      onLoadTemplate(tpl.id);
                      onReturnToBlocks();
                    }}
                  >
                    <FolderOpen size={13} />
                    <span>载入并编辑</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
