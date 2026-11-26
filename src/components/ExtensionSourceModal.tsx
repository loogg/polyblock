import { Check, Code2, Copy, Download, FileCode2, FileJson, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getAllPackBlocks } from '../core/extensions/registry';
import type { PolyExtensionPack } from '../core/extensions/types';

interface ExtensionSourceModalProps {
  pack: PolyExtensionPack;
  scopeLabel: string;
  onClose: () => void;
  onNotify: (msg: string) => void;
}

interface SourceTabItem {
  id: string;
  label: string;
  badge?: string;
  kind: 'json' | 'lua' | 'python';
  banner: string;
  content: string;
}

function downloadTextFile(fileName: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Lightweight syntax highlighter reusing PolyBlock's existing token palette. */
function renderHighlightedLine(line: string, kind: 'json' | 'lua' | 'python') {
  if (kind === 'json') {
    const parts: Array<{ text: string; cls?: string }> = [];
    const re =
      /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) parts.push({ text: line.slice(last, m.index) });
      if (m[1]) {
        parts.push({ text: m[1], cls: 'syn-fn' });
        parts.push({ text: line.slice(m.index + m[1].length, m.index + m[0].length) });
      } else if (m[2]) {
        parts.push({ text: m[2], cls: 'syn-str' });
      } else if (m[3]) {
        parts.push({ text: m[3], cls: 'syn-kw' });
      } else if (m[4]) {
        parts.push({ text: m[4], cls: 'syn-num' });
      }
      last = m.index + m[0].length;
    }
    if (last < line.length) parts.push({ text: line.slice(last) });
    return parts.map((p, idx) =>
      p.cls ? (
        <span key={idx} className={p.cls}>
          {p.text}
        </span>
      ) : (
        <span key={idx}>{p.text}</span>
      ),
    );
  }

  const trimmed = line.trimStart();
  if (
    (kind === 'lua' && trimmed.startsWith('--')) ||
    (kind === 'python' && trimmed.startsWith('#'))
  ) {
    return <span className="syn-cmt">{line}</span>;
  }

  const kwRe =
    kind === 'lua'
      ? /\b(local|function|end|return|if|then|elseif|else|for|while|do|and|or|not|true|false|nil)\b/g
      : /\b(def|class|return|import|from|as|if|elif|else|for|while|in|and|or|not|True|False|None|pass)\b/g;

  const parts: Array<{ text: string; cls?: string }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = kwRe.exec(line)) !== null) {
    if (m.index > last) parts.push({ text: line.slice(last, m.index) });
    parts.push({ text: m[0], cls: 'syn-kw' });
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push({ text: line.slice(last) });
  return parts.map((p, idx) =>
    p.cls ? (
      <span key={idx} className={p.cls}>
        {p.text}
      </span>
    ) : (
      <span key={idx}>{p.text}</span>
    ),
  );
}

export function ExtensionSourceModal({
  pack,
  scopeLabel,
  onClose,
  onNotify,
}: ExtensionSourceModalProps) {
  const [copied, setCopied] = useState(false);

  const tabs = useMemo<SourceTabItem[]>(() => {
    const list: SourceTabItem[] = [];
    const blockCount = getAllPackBlocks(pack).length;
    const hasMock = Boolean(pack.sandboxMock);
    const libCount = pack.libs?.length ?? 0;

    const jsonBanner =
      !hasMock && libCount === 0
        ? `纯原生语法模板包（${pack.sections.length} 个组件 · ${blockCount} 个积木）：积木通过 lua.template / python.template 直接展开为原生语言语法，无需额外模块文件。`
        : `标准单轨声明式协议（${pack.sections.length} 个组件 · ${blockCount} 个积木${
            hasMock ? ` · 含沙箱假桩 ${pack.sandboxMock!.moduleName}` : ''
          }${libCount > 0 ? ` · 含 ${libCount} 个真实脚本库` : ''}）。可点击右上角导出后修改并导入为项目内嵌覆写包。`;

    list.push({
      id: 'json',
      label: `${pack.id}.polyext.json`,
      badge: 'JSON 配置',
      kind: 'json',
      banner: jsonBanner,
      content: JSON.stringify(pack, null, 2),
    });

    if (pack.sandboxMock?.luaSource) {
      list.push({
        id: 'mock-lua',
        label: `${pack.sandboxMock.moduleName}.lua`,
        badge: 'sandboxMock',
        kind: 'lua',
        banner: `浏览器沙箱专用 Lua 假桩（moduleName="${pack.sandboxMock.moduleName}"）：仅在浏览器仿真时顶替真机 C 固件，打包导出真机 .zip 时严格剥离。`,
        content: pack.sandboxMock.luaSource,
      });
    }

    if (pack.sandboxMock?.pythonSource) {
      list.push({
        id: 'mock-py',
        label: `${pack.sandboxMock.moduleName}.py`,
        badge: 'sandboxMock',
        kind: 'python',
        banner: `浏览器沙箱专用 Python 假桩（moduleName="${pack.sandboxMock.moduleName}"）：仅在浏览器仿真时顶替真机固件，打包导出真机 .zip 时严格剥离。`,
        content: pack.sandboxMock.pythonSource,
      });
    }

    for (const lib of pack.libs ?? []) {
      const roleText = lib.role === 'helper' ? '辅助依赖库' : '入口脚本库';
      if (lib.luaSource) {
        list.push({
          id: `lib-lua-${lib.moduleName}`,
          label: `${lib.moduleName}.lua`,
          badge: lib.role === 'helper' ? 'libs · 辅' : 'libs',
          kind: 'lua',
          banner: `真实 Lua 脚本库（moduleName="${lib.moduleName}" · ${roleText}）：浏览器沙箱直接运行此源码，打包导出真机 .zip 时同步输出。`,
          content: lib.luaSource,
        });
      }
      if (lib.pythonSource) {
        list.push({
          id: `lib-py-${lib.moduleName}`,
          label: `${lib.moduleName}.py`,
          badge: lib.role === 'helper' ? 'libs · 辅' : 'libs',
          kind: 'python',
          banner: `真实 Python 脚本库（moduleName="${lib.moduleName}" · ${roleText}）：浏览器沙箱直接运行此源码，打包导出真机 .zip 时同步输出。`,
          content: lib.pythonSource,
        });
      }
    }

    return list;
  }, [pack]);

  const [activeTabId, setActiveTabId] = useState<string>('json');
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const lines = useMemo(() => activeTab.content.split('\n'), [activeTab.content]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(activeTab.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
      onNotify(`已复制 ${activeTab.label}（${lines.length} 行）`);
    } catch {
      onNotify('复制失败，请手动选中代码复制');
    }
  };

  const handleDownloadJson = () => {
    downloadTextFile(
      `${pack.id}.polyext.json`,
      `${JSON.stringify(pack, null, 2)}\n`,
      'application/json;charset=utf-8',
    );
    onNotify(`已导出 ${pack.id}.polyext.json（修改后可导入为项目内嵌覆写包）`);
  };

  return (
    <div
      className="modal-backdrop source-viewer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`查看扩展包源码：${pack.name}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-shell source-viewer-modal">
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span
              className="card-icon"
              style={{
                background: pack.color,
                width: 26,
                height: 24,
                fontSize: 10,
                borderRadius: 6,
                flexShrink: 0,
              }}
            >
              {pack.iconLabel}
            </span>
            <span className="modal-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {pack.name}
            </span>
            <span className="count-badge">{scopeLabel}</span>
            <span className="status-pill idle" style={{ fontSize: 10.5 }}>
              只读
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              className="btn-outline"
              style={{ padding: '4px 9px', fontSize: 11.5 }}
              onClick={handleCopy}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span>{copied ? '已复制' : '复制当前页'}</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              style={{ padding: '4px 9px', fontSize: 11.5 }}
              title="导出完整 .polyext.json 供参考或修改为项目内嵌覆写包"
              onClick={handleDownloadJson}
            >
              <Download size={12} />
              <span>导出 JSON</span>
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={onClose}
              aria-label="关闭扩展包源码查看器"
              style={{ padding: '4px 6px' }}
            >
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="source-viewer-tabs" role="tablist" aria-label="源码文件切换">
          {tabs.map((t) => {
            const isActive = t.id === activeTab.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`source-viewer-tab ${isActive ? 'active' : ''}`}
                onClick={() => setActiveTabId(t.id)}
              >
                {t.kind === 'json' ? (
                  <FileJson size={12} />
                ) : t.kind === 'lua' ? (
                  <Code2 size={12} />
                ) : (
                  <FileCode2 size={12} />
                )}
                <span>{t.label}</span>
                {t.badge && <span className="source-tab-badge">{t.badge}</span>}
              </button>
            );
          })}
        </div>

        <div className="source-viewer-banner">
          <span>{activeTab.banner}</span>
          <span className="source-viewer-lines-meta">
            v{pack.packVersion} · ID: <code>{pack.id}</code> · {lines.length} 行
          </span>
        </div>

        <div className="source-viewer-code" role="region" aria-label={`${activeTab.label} 只读源码`}>
          {lines.map((line, idx) => (
            <div key={idx} className="code-line readonly">
              <span className="ln">{idx + 1}</span>
              <span className="lc">{renderHighlightedLine(line, activeTab.kind)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
