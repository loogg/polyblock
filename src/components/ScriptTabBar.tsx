import {
  Copy,
  FileCode2,
  List,
  MoreHorizontal,
  Pencil,
  Plus,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ProjectScript } from '../types/project';

interface ScriptTabBarProps {
  scripts: ProjectScript[];
  activeScriptId: string;
  entryScriptId: string;
  extension: string;
  disabled?: boolean;
  onSelectScript: (scriptId: string) => void;
  onAddScript: () => void;
  onRenameScript: (scriptId: string, nextName: string) => void;
  onDuplicateScript: (scriptId: string) => void;
  onSetEntryScript: (scriptId: string) => void;
  onDeleteScript: (scriptId: string) => void;
}

export function ScriptTabBar({
  scripts,
  activeScriptId,
  entryScriptId,
  extension,
  disabled = false,
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
  const [showListMenu, setShowListMenu] = useState<boolean>(false);
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setMenuState(null);
        setShowListMenu(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const openScriptMenu = (scriptId: string, anchorEl: HTMLElement) => {
    if (disabled) return;
    setShowListMenu(false);
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

  return (
    <div
      className="script-tabbar"
      ref={barRef}
      style={{ position: 'relative' }}
      role="tablist"
      aria-label="项目脚本标签栏"
    >
      {/* Quick all-scripts picker button */}
      <div className="popover-anchor">
        <button
          type="button"
          className="script-list-btn"
          onClick={() => {
            setShowListMenu((v) => !v);
            setMenuState(null);
          }}
          title={`当前项目共 ${scripts.length} 个脚本，点击快速切换`}
          aria-label="展开项目脚本列表"
        >
          <List size={13} />
          <span>{scripts.length}</span>
        </button>

        {showListMenu && (
          <div className="dropdown-menu" style={{ left: 0, minWidth: 215 }}>
            <div className="dropdown-section-label">
              项目内全部脚本 ({scripts.length})
            </div>
            {scripts.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`dropdown-item ${s.id === activeScriptId ? 'active' : ''}`}
                disabled={disabled && s.id !== activeScriptId}
                onClick={() => {
                  onSelectScript(s.id);
                  setShowListMenu(false);
                }}
              >
                <FileCode2 size={13} />
                <span className="dropdown-item-label">
                  {s.name}.{extension}
                </span>
                {s.id === entryScriptId && (
                  <Star size={11} className="entry-star" fill="currentColor" />
                )}
                {s.breakpoints.length > 0 && (
                  <span className="count-badge err">● {s.breakpoints.length}</span>
                )}
              </button>
            ))}
            <div className="dropdown-divider" />
            <button
              type="button"
              className="dropdown-item"
              disabled={disabled}
              onClick={() => {
                setShowListMenu(false);
                onAddScript();
              }}
            >
              <Plus size={13} />
              <span>新建积木脚本</span>
            </button>
          </div>
        )}
      </div>

      {/* Horizontal Tab Strip */}
      <div className="script-tabs-scroll">
        {scripts.map((script) => {
          const isActive = script.id === activeScriptId;
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
                isEntry ? '（项目入口脚本）' : ''
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
          title="在当前项目中新建积木脚本"
          aria-label="新建积木脚本"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Unclipped Tab Context Menu rendered at TabBar level */}
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
              <span>设为入口脚本 (★)</span>
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
