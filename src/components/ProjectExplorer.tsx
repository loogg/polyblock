import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Lock,
  Plus,
  Settings2,
  Star,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { buildHandleSharedModule } from '../core/backends/sharedModule';
import type { ResolvedHandleChannelPoolSpec } from '../core/extensions/types';
import { formatHandleChannelPoolsSummary } from '../core/projects/store';
import type { ProjectModel, ScriptLanguageId } from '../types/project';

interface ProjectExplorerProps {
  project: ProjectModel;
  activeHandleId: string;
  activeScriptId: string;
  language: ScriptLanguageId;
  extension: string;
  viewingSharedModule?: boolean;
  channelPools: ResolvedHandleChannelPoolSpec[];
  disabled?: boolean;
  runningHandleIds?: string[];
  onSelectHandleScript: (handleId: string, scriptId: string) => void;
  onSelectHandleSharedModule?: (handleId: string) => void;
  onAddHandle: () => void;
  onAddScriptInHandle: (handleId: string) => void;
  onOpenHandleSettings: (handleId: string) => void;
  onClose: () => void;
}

export function ProjectExplorer({
  project,
  activeHandleId,
  activeScriptId,
  language,
  extension,
  viewingSharedModule = false,
  channelPools,
  disabled = false,
  runningHandleIds = [],
  onSelectHandleScript,
  onSelectHandleSharedModule,
  onAddHandle,
  onAddScriptInHandle,
  onOpenHandleSettings,
  onClose,
}: ProjectExplorerProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <aside className="explorer-pane" aria-label="工程结构树（项目 / 句柄 / 脚本）">
      <div className="explorer-header">
        <span className="explorer-title" title={project.name}>
          工程结构树
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <button
            type="button"
            className="script-tab-icon-btn"
            disabled={disabled}
            onClick={onAddHandle}
            title="新建隔离句柄"
            aria-label="新建隔离句柄"
          >
            <Plus size={13} />
          </button>
          <button
            type="button"
            className="script-tab-icon-btn"
            onClick={onClose}
            title="收起结构树"
            aria-label="收起工程结构树"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      <div className="explorer-body">
        {project.handles.map((handle) => {
          const isCollapsed = Boolean(collapsed[handle.id]);
          const isActiveHandle = handle.id === activeHandleId;

          return (
            <div key={handle.id} className="explorer-handle-group">
              <div
                className={`explorer-handle-row ${isActiveHandle ? 'active' : ''}`}
                role="button"
                tabIndex={0}
                aria-expanded={!isCollapsed}
                onClick={() =>
                  setCollapsed((prev) => ({
                    ...prev,
                    [handle.id]: !prev[handle.id],
                  }))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setCollapsed((prev) => ({
                      ...prev,
                      [handle.id]: !prev[handle.id],
                    }));
                  }
                }}
              >
                <div className="explorer-handle-top">
                  {isCollapsed ? (
                    <ChevronRight size={12} style={{ flexShrink: 0 }} />
                  ) : (
                    <ChevronDown size={12} style={{ flexShrink: 0 }} />
                  )}
                  <span
                    className="lang-dot"
                    style={{ background: handle.color, flexShrink: 0 }}
                  />
                  <span className="explorer-handle-name" title={handle.name}>
                    {handle.name}
                  </span>
                  {runningHandleIds.includes(handle.id) && (
                    <span
                      className="running-handle-dot"
                      title="此句柄正在运行"
                      aria-label="运行中"
                    />
                  )}
                  <div
                    className="explorer-row-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="script-tab-icon-btn"
                      disabled={disabled}
                      onClick={() => onAddScriptInHandle(handle.id)}
                      title={`在句柄 ${handle.name} 内新建脚本`}
                      aria-label={`在句柄 ${handle.name} 内新建脚本`}
                    >
                      <Plus size={11} />
                    </button>
                    <button
                      type="button"
                      className="script-tab-icon-btn"
                      onClick={() => onOpenHandleSettings(handle.id)}
                      title={`配置句柄 ${handle.name}`}
                      aria-label={`配置句柄 ${handle.name}`}
                    >
                      <Settings2 size={11} />
                    </button>
                  </div>
                </div>
                {channelPools.length > 0 && (() => {
                  const poolSummary = formatHandleChannelPoolsSummary(
                    handle,
                    channelPools,
                  );
                  return poolSummary ? (
                    <span className="explorer-handle-meta" title={poolSummary}>
                      {poolSummary}
                    </span>
                  ) : null;
                })()}
              </div>

              {!isCollapsed && (
                <div className="explorer-script-list">
                  {handle.scripts.map((scr) => {
                    const isActiveScript =
                      isActiveHandle && !viewingSharedModule && scr.id === activeScriptId;
                    const isEntry = scr.id === handle.entryScriptId;
                    return (
                      <button
                        key={scr.id}
                        type="button"
                        className={`explorer-script-row ${
                          isActiveScript ? 'active' : ''
                        }`}
                        onClick={() => onSelectHandleScript(handle.id, scr.id)}
                      >
                        <FileCode2 size={12} style={{ flexShrink: 0, opacity: 0.7 }} />
                        <span className="explorer-script-name">
                          {scr.name}.{extension}
                        </span>
                        {isEntry && (
                          <Star
                            size={10}
                            className="entry-star"
                            fill="currentColor"
                          />
                        )}
                        {scr.breakpoints.length > 0 && (
                          <span className="script-tab-bp" />
                        )}
                      </button>
                    );
                  })}
                  {(() => {
                    const sharedMod = buildHandleSharedModule(handle, language);
                    if (!sharedMod || !onSelectHandleSharedModule) return null;
                    const isActiveShared = isActiveHandle && viewingSharedModule;
                    const totalItems =
                      sharedMod.variables.length + sharedMod.functions.length;
                    return (
                      <button
                        type="button"
                        className={`explorer-script-row explorer-script-readonly ${
                          isActiveShared ? 'active' : ''
                        }`}
                        onClick={() => onSelectHandleSharedModule(handle.id)}
                        title={`只读自动生成模块 ${sharedMod.fileName}（${sharedMod.variables.length} 跨文件变量 · ${sharedMod.functions.length} 公共函数）`}
                      >
                        <Lock size={11} style={{ flexShrink: 0, opacity: 0.75 }} />
                        <span className="explorer-script-name">
                          {sharedMod.fileName}
                        </span>
                        <span className="count-badge" style={{ marginLeft: 'auto' }}>
                          {totalItems}
                        </span>
                      </button>
                    );
                  })()}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="explorer-footer">
        <button
          type="button"
          className="btn-outline"
          disabled={disabled}
          style={{ width: '100%', justifyContent: 'center', fontSize: 11.5, padding: '5px 8px' }}
          onClick={onAddHandle}
        >
          <Plus size={12} />
          <span>新建隔离句柄</span>
        </button>
      </div>
    </aside>
  );
}
