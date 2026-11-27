import {
  ChevronDown,
  Copy,
  FileCode2,
  FolderTree,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings2,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getHandleTimerConfig } from '../core/projects/store';
import type { ProjectScript, RuntimeHandle } from '../types/project';

interface ScriptTabBarProps {
  handles: RuntimeHandle[];
  activeHandle: RuntimeHandle;
  scripts: ProjectScript[];
  activeScriptId: string;
  entryScriptId: string;
  extension: string;
  hasTimersCapability: boolean;
  defaultTimerCount: number;
  showExplorer: boolean;
  disabled?: boolean;
  sharedModuleTab?: {
    fileName: string;
    itemCount: number;
    varCount: number;
    fnCount: number;
  } | null;
  viewingSharedModule?: boolean;
  onSelectSharedModule?: () => void;
  onToggleExplorer: () => void;
  onSelectHandle: (handleId: string) => void;
  onAddHandle: () => void;
  onOpenHandleSettings: (handleId: string) => void;
  onSelectScript: (scriptId: string) => void;
  onAddScript: () => void;
  onRenameScript: (scriptId: string, nextName: string) => void;
  onDuplicateScript: (scriptId: string) => void;
  onSetEntryScript: (scriptId: string) => void;
  onDeleteScript: (scriptId: string) => void;
}

export function ScriptTabBar({
  handles,
  activeHandle,
  scripts,
  activeScriptId,
  entryScriptId,
  extension,
  hasTimersCapability,
  defaultTimerCount,
  showExplorer,
  disabled = false,
  sharedModuleTab = null,
  viewingSharedModule = false,
  onSelectSharedModule,
  onToggleExplorer,
  onSelectHandle,
  onAddHandle,
  onOpenHandleSettings,
  onSelectScript,
  onAddScript,
  onRenameScript,
  onDuplicateScript,
  onSetEntryScript,
  onDeleteScript,
}: ScriptTabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string>('');
  const [menuState, setMenuState] = useState<{
    scriptId: string;
    left: number;
  } | null>(null);
  const [showHandleMenu, setShowHandleMenu] = useState<boolean>(false);
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setMenuState(null);
        setShowHandleMenu(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const openScriptMenu = (scriptId: string, anchorEl: HTMLElement) => {
    if (disabled) return;
    setShowHandleMenu(false);
    const barRect = barRef.current?.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const rawLeft = barRect ? anchorRect.left - barRect.left : 0;
    const clampedLeft = barRect
      ? Math.max(8, Math.min(rawLeft, barRect.width - 176))
      : rawLeft;
    setMenuState((prev) =>
      prev?.scriptId === scriptId ? null : { scriptId, left: clampedLeft },
    );
  };

  const startRename = (script: ProjectScript) => {
    setMenuState(null);
    setEditingId(script.id);
    setDraftName(script.name);
  };

  const commitRename = () => {
    if (editingId && draftName.trim()) {
      onRenameScript(editingId, draftName.trim());
    }
    setEditingId(null);
  };

  const menuScript = menuState
    ? scripts.find((s) => s.id === menuState.scriptId) ?? null
    : null;
  const activeHandleTimer = getHandleTimerConfig(activeHandle, defaultTimerCount);

  return (
    <div
      className="script-tabbar"
      ref={barRef}
      style={{ position: 'relative' }}
      role="tablist"
      aria-label="句柄与脚本标签栏"
    >
      {/* Collapsible Project Explorer toggle */}
      <button
        type="button"
        className={`script-list-btn ${showExplorer ? 'active' : ''}`}
        onClick={onToggleExplorer}
        title={showExplorer ? '收起工程结构树' : '展开工程结构树（查看全部句柄与脚本）'}
        aria-label="展开或收起工程结构树"
      >
        <FolderTree size={13} />
      </button>

      {/* Compact Handle Switcher Pill (zero extra vertical bar height!) */}
      <div className="popover-anchor">
        <button
          type="button"
          className="handle-switcher-pill"
          onClick={() => {
            setShowHandleMenu((v) => !v);
            setMenuState(null);
          }}
          title={`当前隔离句柄：${activeHandle.name}（共 ${handles.length} 个句柄${
            hasTimersCapability ? ` · 定时器 0~${activeHandleTimer.count - 1}` : ''
          }），点击切换或新建`}
          aria-label="切换或管理运行句柄"
        >
          <span
            className="lang-dot"
            style={{ background: activeHandle.color, flexShrink: 0 }}
          />
          <span className="handle-switcher-name">{activeHandle.name}</span>
          {handles.length > 1 && (
            <span className="count-badge">{handles.length}</span>
          )}
          <ChevronDown size={11} style={{ opacity: 0.65, flexShrink: 0 }} />
        </button>

        {showHandleMenu && (
          <div className="dropdown-menu" style={{ left: 0, minWidth: 248 }}>
            <div className="dropdown-section-label">
              项目内隔离句柄 ({handles.length} 个独立 VM)
            </div>
            {handles.map((h) => {
              const hTimer = getHandleTimerConfig(h, defaultTimerCount);
              return (
                <button
                  key={h.id}
                  type="button"
                  className={`dropdown-item ${h.id === activeHandle.id ? 'active' : ''}`}
                  disabled={disabled && h.id !== activeHandle.id}
                  onClick={() => {
                    onSelectHandle(h.id);
                    setShowHandleMenu(false);
                  }}
                >
                  <span
                    className="lang-dot"
                    style={{ background: h.color, flexShrink: 0 }}
                  />
                  <span className="dropdown-item-label">{h.name}</span>
                  <span className="count-badge">
                    {h.scripts.length} 脚本
                    {hasTimersCapability ? ` · T0~${hTimer.count - 1}` : ''}
                  </span>
                </button>
              );
            })}

            <div className="dropdown-divider" />
            <div className="dropdown-section-label">
              当前句柄 [{activeHandle.name}] 脚本 ({scripts.length})
            </div>
            {scripts.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`dropdown-item ${s.id === activeScriptId ? 'active' : ''}`}
                disabled={disabled && s.id !== activeScriptId}
                onClick={() => {
                  onSelectScript(s.id);
                  setShowHandleMenu(false);
                }}
              >
                <FileCode2 size={12} />
                <span className="dropdown-item-label">
                  {s.name}.{extension}
                </span>
                {s.id === entryScriptId && (
                  <Star size={11} className="entry-star" fill="currentColor" />
                )}
              </button>
            ))}

            <div className="dropdown-divider" />
            <button
              type="button"
              className="dropdown-item"
              disabled={disabled}
              onClick={() => {
                setShowHandleMenu(false);
                onAddHandle();
              }}
            >
              <Plus size={13} />
              <span>新建隔离句柄</span>
            </button>
            <button
              type="button"
              className="dropdown-item"
              onClick={() => {
                setShowHandleMenu(false);
                onOpenHandleSettings(activeHandle.id);
              }}
            >
              <Settings2 size={13} />
              <span>配置句柄与能力...</span>
            </button>
          </div>
        )}
      </div>

      {/* Horizontal Script Tabs for Active Handle */}
      <div className="script-tabs-scroll">
        {scripts.map((script) => {
          const isActive = !viewingSharedModule && script.id === activeScriptId;
          const isEntry = script.id === entryScriptId;
          const isEditing = editingId === script.id;

          return (
            <div
              key={script.id}
              className={`script-tab ${isActive ? 'active' : ''}`}
              role="tab"
              aria-selected={isActive}
              onClick={() => {
                if (!isEditing && (!disabled || isActive)) {
                  onSelectScript(script.id);
                }
              }}
              onDoubleClick={() => {
                if (!disabled) startRename(script);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openScriptMenu(script.id, e.currentTarget);
              }}
              title={`${script.name}.${extension}${
                isEntry ? '（句柄入口脚本）' : '（同句柄辅助模块）'
              } · 双击重命名`}
            >
              {isEntry && (
                <Star
                  size={11}
                  className="entry-star"
                  fill="currentColor"
                  aria-label="入口脚本"
                />
              )}

              {isEditing ? (
                <input
                  type="text"
                  className="script-tab-input"
                  value={draftName}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <span className="script-tab-name">
                  {script.name}
                  <span className="script-tab-ext">.{extension}</span>
                </span>
              )}

              {script.breakpoints.length > 0 && (
                <span
                  className="script-tab-bp"
                  title={`${script.breakpoints.length} 个断点`}
                />
              )}

              {!isEditing && (
                <div className="script-tab-actions">
                  <button
                    type="button"
                    className="script-tab-icon-btn"
                    disabled={disabled}
                    onClick={(e) => {
                      e.stopPropagation();
                      openScriptMenu(script.id, e.currentTarget);
                    }}
                    title="脚本操作"
                    aria-label={`脚本 ${script.name} 操作菜单`}
                  >
                    <MoreHorizontal size={12} />
                  </button>
                  {scripts.length > 1 && (
                    <button
                      type="button"
                      className="script-tab-icon-btn danger"
                      disabled={disabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuState(null);
                        onDeleteScript(script.id);
                      }}
                      title="删除此脚本"
                      aria-label={`删除脚本 ${script.name}`}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        <button
          type="button"
          className="script-add-btn"
          disabled={disabled}
          onClick={onAddScript}
          title={`在句柄 ${activeHandle.name} 内新建模块脚本`}
          aria-label="新建积木脚本"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Pinned Far-Right Read-Only `shared.lua` / `shared.py` Tab (Style A1) */}
      {sharedModuleTab && onSelectSharedModule && (
        <button
          type="button"
          role="tab"
          aria-selected={viewingSharedModule}
          className={`script-tab-pinned ${viewingSharedModule ? 'active' : ''}`}
          onClick={onSelectSharedModule}
          title={`自动生成的同句柄跨文件共享模块 ${sharedModuleTab.fileName}（${sharedModuleTab.varCount} 变量 · ${sharedModuleTab.fnCount} 公共函数 · 只读，随目标运行包一起导出）`}
        >
          <Lock size={11} className="script-tab-lock" />
          <span className="script-tab-name">
            {sharedModuleTab.fileName.replace(/\.(lua|py)$/, '')}
            <span className="script-tab-ext">.{extension}</span>
          </span>
          <span className="count-badge">{sharedModuleTab.itemCount}</span>
        </button>
      )}

      {/* Unclipped Tab Context Menu */}
      {menuState && menuScript && (
        <div
          className="dropdown-menu"
          style={{ left: menuState.left, top: 38, minWidth: 168 }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="dropdown-item"
            onClick={() => startRename(menuScript)}
          >
            <Pencil size={13} />
            <span>重命名</span>
          </button>
          <button
            type="button"
            className="dropdown-item"
            onClick={() => {
              setMenuState(null);
              onDuplicateScript(menuScript.id);
            }}
          >
            <Copy size={13} />
            <span>复制脚本</span>
          </button>
          {menuScript.id !== entryScriptId && (
            <button
              type="button"
              className="dropdown-item"
              onClick={() => {
                setMenuState(null);
                onSetEntryScript(menuScript.id);
              }}
            >
              <Star size={13} />
              <span>设为句柄入口 (★)</span>
            </button>
          )}
          {scripts.length > 1 && (
            <>
              <div className="dropdown-divider" />
              <button
                type="button"
                className="dropdown-item danger"
                onClick={() => {
                  setMenuState(null);
                  onDeleteScript(menuScript.id);
                }}
              >
                <Trash2 size={13} />
                <span>删除脚本</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
