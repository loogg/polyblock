import {
  Copy,
  Download,
  FilePlus2,
  FolderOpen,
  Pencil,
  Star,
  Trash2,
  Upload,
} from 'lucide-react';
import { useRef, useState } from 'react';
import {
  MULTI_SCRIPT_PROJECT_TEMPLATES,
  parseImportedProject,
} from '../../core/projects/store';
import type { ProjectModel } from '../../types/project';

interface ProjectsPageProps {
  projects: ProjectModel[];
  activeProjectId: string;
  onSelectProject: (projectId: string) => void;
  onCreateBlankProject: () => void;
  onCreateFromTemplate: (templateId: string) => void;
  onRenameProject: (projectId: string, nextName: string) => void;
  onDuplicateProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onSaveProjectFile: (projectId: string) => void;
  onImportProject: (project: ProjectModel) => void;
  onReturnToBlocks: () => void;
  onNotify: (msg: string) => void;
}

export function ProjectsPage({
  projects,
  activeProjectId,
  onSelectProject,
  onCreateBlankProject,
  onCreateFromTemplate,
  onRenameProject,
  onDuplicateProject,
  onDeleteProject,
  onSaveProjectFile,
  onImportProject,
  onReturnToBlocks,
  onNotify,
}: ProjectsPageProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string>('');

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result)) as unknown;
        const imported = parseImportedProject(
          raw,
          file.name.replace(/\.polyblock\.json$|\.json$/i, ''),
          projects.map((p) => p.name),
        );
        onImportProject(imported);
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

  const commitRename = () => {
    if (editingId && draftName.trim()) {
      onRenameProject(editingId, draftName.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="subpage-wrap">
      <div className="subpage-inner">
        <div className="subpage-header">
          <div>
            <h1 className="subpage-title">项目管理（以项目为根 · 多脚本工程）</h1>
            <p className="subpage-sub">
              每个项目统一管理目标语言与多个积木脚本标签（<code>.polyblock.json</code> v2，向下兼容导入旧版 v1 文件）。
            </p>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-primary"
              onClick={onCreateBlankProject}
            >
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
              onClick={() => onSaveProjectFile(activeProjectId)}
            >
              <Download size={14} />
              <span>导出当前项目</span>
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

        <h2 className="section-heading">我的项目（{projects.length}）</h2>
        <div className="card-grid">
          {projects.map((proj) => {
            const isActive = proj.id === activeProjectId;
            const ext = proj.language === 'lua' ? 'lua' : 'py';
            const isEditing = editingId === proj.id;

            return (
              <div
                key={proj.id}
                className="ui-card"
                style={
                  isActive
                    ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 1px var(--accent-soft)' }
                    : undefined
                }
              >
                <div className="card-top">
                  {isEditing ? (
                    <input
                      type="text"
                      className="dropdown-rename-input"
                      value={draftName}
                      autoFocus
                      onChange={(e) => setDraftName(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                    />
                  ) : (
                    <div style={{ fontWeight: 700, fontSize: 14 }}>
                      {proj.name}
                    </div>
                  )}
                  <span className={`status-pill ${isActive ? 'ok' : 'idle'}`}>
                    {isActive ? '当前打开' : proj.language === 'lua' ? 'Lua 5.4' : 'Python 3'}
                  </span>
                </div>

                {proj.description && (
                  <p className="card-desc">{proj.description}</p>
                )}

                <div className="paused-var-chips">
                  {proj.scripts.map((s) => (
                    <span key={s.id} className="var-chip">
                      {s.id === proj.entryScriptId && (
                        <Star size={10} className="entry-star" fill="currentColor" />
                      )}
                      <span>
                        {s.name}.{ext}
                      </span>
                    </span>
                  ))}
                </div>

                <div className="card-footer">
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      type="button"
                      className="btn-ghost"
                      style={{ padding: '4px 6px' }}
                      title="重命名项目"
                      onClick={() => {
                        setEditingId(proj.id);
                        setDraftName(proj.name);
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      style={{ padding: '4px 6px' }}
                      title="复制项目"
                      onClick={() => onDuplicateProject(proj.id)}
                    >
                      <Copy size={13} />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      style={{ padding: '4px 6px' }}
                      title="导出整项目 .polyblock.json"
                      onClick={() => onSaveProjectFile(proj.id)}
                    >
                      <Download size={13} />
                    </button>
                    {projects.length > 1 && (
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ padding: '4px 6px', color: 'var(--danger)' }}
                        title="删除项目"
                        onClick={() => onDeleteProject(proj.id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    className={isActive ? 'btn-primary' : 'btn-outline'}
                    style={{ padding: '5px 10px', fontSize: 12 }}
                    onClick={() => {
                      if (!isActive) onSelectProject(proj.id);
                      onReturnToBlocks();
                    }}
                  >
                    <FolderOpen size={13} />
                    <span>{isActive ? '继续编辑' : '打开项目'}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <h2 className="section-heading">从内置多脚本模板新建项目</h2>
        <div className="card-grid">
          {MULTI_SCRIPT_PROJECT_TEMPLATES.map((tpl) => (
            <div key={tpl.id} className="ui-card">
              <div className="card-top">
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{tpl.name}</div>
                <span className="status-pill accent">
                  {tpl.scripts.length} 个脚本 · {tpl.language === 'lua' ? 'Lua' : 'Python'}
                </span>
              </div>
              <p className="card-desc">{tpl.description}</p>
              <div className="card-footer">
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  包含：{tpl.scripts.map((s) => s.name).join(' / ')}
                </span>
                <button
                  type="button"
                  className="btn-outline"
                  onClick={() => {
                    onCreateFromTemplate(tpl.id);
                    onReturnToBlocks();
                  }}
                >
                  <FilePlus2 size={13} />
                  <span>由此新建</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
