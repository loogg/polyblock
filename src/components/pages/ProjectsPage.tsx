import {
  Copy,
  Download,
  FilePlus2,
  FolderArchive,
  FolderOpen,
  Pencil,
  Settings2,
  Trash2,
  Upload,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { getLanguageDialect } from '../../core/backends/registry';
import {
  parseImportedProjectArchive,
  parseImportedPureProjectFile,
  type ImportedProjectResult,
} from '../../core/export/projectArchive';
import { isZipBuffer } from '../../core/export/zipReader';
import { extensionRegistry } from '../../core/extensions/registry';
import {
  countProjectScripts,
  DEMO_PROJECTS,
  formatHandleChannelPoolsSummary,
  resolveProjectTargetProfile,
} from '../../core/projects/store';
import type { ProjectModel } from '../../types/project';

interface ProjectsPageProps {
  projects: ProjectModel[];
  activeProjectId: string;
  editingLocked?: boolean;
  onSelectProject: (projectId: string) => void;
  onCreateBlankProject: () => void;
  onCreateFromTemplate: (templateId: string) => void;
  onRenameProject: (projectId: string, nextName: string) => void;
  onDuplicateProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onSaveProjectFile: (projectId: string) => void;
  onSaveProjectArchive: (projectId: string) => void;
  onImportProject: (result: ImportedProjectResult) => void;
  onOpenProjectSettings: (projectId: string) => void;
  onReturnToBlocks: () => void;
  onNotify: (msg: string) => void;
}

export function ProjectsPage({
  projects,
  activeProjectId,
  editingLocked = false,
  onSelectProject,
  onCreateBlankProject,
  onCreateFromTemplate,
  onRenameProject,
  onDuplicateProject,
  onDeleteProject,
  onSaveProjectFile,
  onSaveProjectArchive,
  onImportProject,
  onOpenProjectSettings,
  onReturnToBlocks,
  onNotify,
}: ProjectsPageProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string>('');

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const existingNames = projects.map((p) => p.name);
      const fallbackName = file.name.replace(
        /\.polyblock\.(json|zip)$|\.(json|zip)$/i,
        '',
      );
      if (isZipBuffer(bytes) || /\.zip$/i.test(file.name)) {
        const result = await parseImportedProjectArchive(
          bytes,
          fallbackName,
          existingNames,
        );
        onImportProject(result);
      } else {
        const text = new TextDecoder('utf-8').decode(bytes);
        const raw = JSON.parse(text) as unknown;
        const result = parseImportedPureProjectFile(
          raw,
          fallbackName,
          existingNames,
        );
        onImportProject(result);
      }
    } catch (err) {
      onNotify(
        `导入失败：无效的工程文件 (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
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
            <h1 className="subpage-title">项目管理（三层工程 · 多句柄隔离）</h1>
            <p className="subpage-sub">
              以项目为根管理目标板型规格、按需装配的能力/外设以及多个独立隔离运行句柄；点击项目卡片左下配置按钮可调整板型与句柄。
            </p>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-primary"
              disabled={editingLocked}
              title={editingLocked ? '请先停止当前运行再新建项目' : undefined}
              onClick={onCreateBlankProject}
            >
              <FilePlus2 size={14} />
              <span>新建空白项目</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              disabled={editingLocked}
              title={editingLocked ? '请先停止当前运行再导入项目' : '支持纯 .polyblock.json 或含依赖包的 .polyblock.zip'}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={14} />
              <span>导入工程 (.json / .zip)</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              title="导出含全部依赖扩展包与板型的自包含工程压缩包（开箱即用）"
              onClick={() => onSaveProjectArchive(activeProjectId)}
            >
              <FolderArchive size={14} />
              <span>导出工程包 (.zip)</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              title="仅导出纯净 project.polyblock.json（仅引用 ID，轻量无内嵌包）"
              onClick={() => onSaveProjectFile(activeProjectId)}
            >
              <Download size={14} />
              <span>导出纯配置 (.json)</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.polyblock.json,.zip,.polyblock.zip"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </div>
        </div>

        <h2 className="section-heading">我的项目（{projects.length}）</h2>
        <div className="card-grid">
          {projects.map((proj) => {
            const isActive = proj.id === activeProjectId;
            const isEditing = editingId === proj.id;
            const totalScripts = countProjectScripts(proj);
            const profile = resolveProjectTargetProfile(proj);
            const projPools = extensionRegistry
              .getChannelPools(proj.enabledCapabilities, proj.localExtensions)
              .map((entry) => entry.pool);

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
                    {isActive
                      ? '当前打开'
                      : getLanguageDialect(proj.language).displayName}
                  </span>
                </div>

                {proj.description && (
                  <p className="card-desc">{proj.description}</p>
                )}

                <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {profile.name} · {getLanguageDialect(proj.language).displayName} ·{' '}
                  {proj.handles.length} 句柄 · {totalScripts} 脚本 ·{' '}
                  {proj.enabledCapabilities.length} 能力
                  {(proj.localExtensions?.length ?? 0) > 0
                    ? ` · ${proj.localExtensions!.length} 项目包`
                    : ''}
                </div>

                <div className="meta-chip-list">
                  {proj.handles.map((h) => {
                    const poolSummary = formatHandleChannelPoolsSummary(h, projPools);
                    return (
                      <span key={h.id} className="meta-chip">
                        <span
                          className="lang-dot"
                          style={{ background: h.color, width: 6, height: 6 }}
                        />
                        <span>{h.name}</span>
                        <span style={{ opacity: 0.7 }}>
                          ({h.scripts.length}
                          {poolSummary ? ` · ${poolSummary}` : ''})
                        </span>
                      </span>
                    );
                  })}
                </div>

                <div className="card-footer">
                  <div style={{ display: 'flex', gap: 3 }}>
                    <button
                      type="button"
                      className="btn-ghost"
                      style={{ padding: '4px 6px' }}
                      title="配置此项目的句柄、定时器与扩展"
                      aria-label={`配置项目 ${proj.name}`}
                      onClick={() => onOpenProjectSettings(proj.id)}
                    >
                      <Settings2 size={13} />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      style={{ padding: '4px 6px' }}
                      disabled={editingLocked}
                      title={editingLocked ? '请先停止当前运行再重命名项目' : '重命名项目'}
                      aria-label={`重命名项目 ${proj.name}`}
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
                      disabled={editingLocked}
                      title={editingLocked ? '请先停止当前运行再复制项目' : '复制项目'}
                      aria-label={`复制项目 ${proj.name}`}
                      onClick={() => onDuplicateProject(proj.id)}
                    >
                      <Copy size={13} />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      style={{ padding: '4px 6px' }}
                      title="导出完整工程包 (.polyblock.zip · 含全部依赖包与板型)"
                      aria-label={`导出完整工程包 ${proj.name}`}
                      onClick={() => onSaveProjectArchive(proj.id)}
                    >
                      <FolderArchive size={13} />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      style={{ padding: '4px 6px' }}
                      title="导出纯工程文件 (.polyblock.json · 仅引用 ID)"
                      aria-label={`导出纯工程文件 ${proj.name}`}
                      onClick={() => onSaveProjectFile(proj.id)}
                    >
                      <Download size={13} />
                    </button>
                    {projects.length > 1 && (
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ padding: '4px 6px', color: 'var(--danger)' }}
                        disabled={editingLocked}
                        title={editingLocked ? '请先停止当前运行再删除项目' : '删除项目'}
                        aria-label={`删除项目 ${proj.name}`}
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
                    disabled={editingLocked && !isActive}
                    title={
                      editingLocked && !isActive
                        ? '请先停止当前运行再切换项目'
                        : undefined
                    }
                    onClick={() => {
                      if (!isActive) onSelectProject(proj.id);
                      onReturnToBlocks();
                    }}
                  >
                    <FolderOpen size={13} />
                    <span>
                      {isActive
                        ? editingLocked
                          ? '返回运行画布'
                          : '继续编辑'
                        : '打开项目'}
                    </span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <h2 className="section-heading">
          出厂演示项目（{DEMO_PROJECTS.length} 个标准目录工程 · 可导出/复刻）
        </h2>
        <div className="card-grid">
          {DEMO_PROJECTS.map(({ id: demoId, project: demo }) => {
            const scriptTotal = demo.handles.reduce(
              (acc, h) => acc + h.scripts.length,
              0,
            );
            const localCount = demo.localExtensions?.length ?? 0;
            const capCount = demo.enabledCapabilities.length;
            const factBadges: string[] = [
              capCount === 0 ? '纯脚本内核' : `${capCount} 项能力`,
              ...(demo.handles.length > 1 ? [`${demo.handles.length} 句柄并发`] : []),
              ...(localCount > 0 ? [`含 ${localCount} 项目扩展包`] : []),
            ];
            return (
              <div key={demoId} className="ui-card">
                <div className="card-top">
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>{demo.name}</div>
                  <span className="status-pill accent" style={{ flexShrink: 0 }}>
                    {demo.handles.length} 句柄 · {scriptTotal} 脚本 ·{' '}
                    {getLanguageDialect(demo.language).shortLabel}
                  </span>
                </div>
                {demo.description && (
                  <p className="card-desc">{demo.description}</p>
                )}
                <div className="pack-attr-row">
                  {factBadges.map((hl) => (
                    <span key={hl} className="pack-attr-badge tone-tag">
                      {hl}
                    </span>
                  ))}
                </div>
                <div className="card-footer">
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                    {resolveProjectTargetProfile(demo).name} · 句柄：
                    {demo.handles.map((h) => h.name).join(' / ')}
                  </span>
                  <button
                    type="button"
                    className="btn-outline"
                    style={{ flexShrink: 0 }}
                    disabled={editingLocked}
                    title={editingLocked ? '请先停止当前运行再新建演示项目' : undefined}
                    onClick={() => {
                      onCreateFromTemplate(demoId);
                      onReturnToBlocks();
                    }}
                  >
                    <FilePlus2 size={13} />
                    <span>由此新建</span>
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
