import { ArrowLeft, Download, Trash2, Upload } from 'lucide-react';
import { useRef } from 'react';
import { backendRegistry } from '../../core/backends/registry';
import { SAMPLE_CUSTOM_EXTENSION_TEMPLATE } from '../../core/extensions/builtinPacks';
import type { PolyExtensionPack } from '../../core/extensions/types';

interface ExtensionsPageProps {
  activeProjectName: string;
  allPacks: PolyExtensionPack[];
  enabledExtensionIds: string[];
  onToggleExtension: (packId: string) => void;
  onImportExtensionJson: (raw: unknown) => void;
  onRemoveCustomPack: (packId: string) => void;
  onReturnToBlocks: () => void;
  onNotify: (msg: string) => void;
}

export function ExtensionsPage({
  activeProjectName,
  allPacks,
  enabledExtensionIds,
  onToggleExtension,
  onImportExtensionJson,
  onRemoveCustomPack,
  onReturnToBlocks,
  onNotify,
}: ExtensionsPageProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const enabledSet = new Set(enabledExtensionIds);
  const backends = backendRegistry.list();

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as unknown;
        onImportExtensionJson(parsed);
      } catch (err) {
        onNotify(
          `导入扩展包失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  };

  const handleDownloadSample = () => {
    const blob = new Blob(
      [JSON.stringify(SAMPLE_CUSTOM_EXTENSION_TEMPLATE, null, 2)],
      { type: 'application/json;charset=utf-8' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'my-robot-api.polyext.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    onNotify('已下载自定义扩展包示例模板 my-robot-api.polyext.json');
  };

  return (
    <div className="subpage-wrap">
      <div className="subpage-inner">
        <div className="subpage-header">
          <div>
            <h1 className="subpage-title">扩展积木库与脚本后端管理</h1>
            <p className="subpage-sub">
              为当前项目 <strong>{activeProjectName}</strong> 按需启用扩展积木包，或导入声明式 <code>.polyext.json</code> 接入自己的板载/业务 API。
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-primary"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={14} />
              <span>导入扩展包 (.polyext.json)</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={handleDownloadSample}
            >
              <Download size={14} />
              <span>下载示例模板</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={onReturnToBlocks}
            >
              <ArrowLeft size={14} />
              <span>返回画布</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.polyext.json"
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
          </div>
        </div>

        <h2 className="section-heading">
          可用扩展积木包（已为当前项目启用 {enabledExtensionIds.length} / {allPacks.length}）
        </h2>
        <div className="card-grid">
          {allPacks.map((pack) => {
            const isEnabled = enabledSet.has(pack.id);
            return (
              <div
                key={pack.id}
                className="ui-card"
                style={
                  isEnabled
                    ? {
                        borderColor: pack.color,
                        boxShadow: `0 0 0 1px ${pack.color}33`,
                      }
                    : undefined
                }
              >
                <div className="card-top">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div
                      className="card-icon"
                      style={{ background: pack.color, fontSize: 12 }}
                    >
                      {pack.categoryLabel}
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                        {pack.name}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        v{pack.packVersion} · {pack.blocks.length} 个积木
                        {pack.sandboxMock ? ' · 含沙箱模拟' : ''}
                      </div>
                    </div>
                  </div>
                  <span className={`status-pill ${pack.builtin ? 'idle' : 'accent'}`}>
                    {pack.builtin ? '内置包' : '自定义'}
                  </span>
                </div>

                <p className="card-desc">{pack.description}</p>

                <div className="paused-var-chips">
                  {pack.blocks.slice(0, 4).map((b) => (
                    <span key={b.type} className="var-chip" style={{ fontSize: 10.5 }}>
                      {b.message0.replace(/%\d/g, '▢')}
                    </span>
                  ))}
                  {pack.blocks.length > 4 && (
                    <span className="var-chip" style={{ fontSize: 10.5 }}>
                      +{pack.blocks.length - 4} 项
                    </span>
                  )}
                </div>

                <div className="card-footer">
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    支持 Lua 5.4 / Python 3
                  </span>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {!pack.builtin && (
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ padding: '4px 6px', color: 'var(--danger)' }}
                        title="删除自定义扩展包"
                        onClick={() => onRemoveCustomPack(pack.id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      className={`ext-toggle-btn ${
                        isEnabled ? 'enabled' : 'disabled'
                      }`}
                      onClick={() => onToggleExtension(pack.id)}
                    >
                      {isEnabled ? '已启用（点击停用）' : '+ 启用到当前项目'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <h2 className="section-heading">已注册脚本生成后端（BackendRegistry）</h2>
        <div className="card-grid">
          {backends.map((b) => (
            <div key={b.id} className="ui-card">
              <div className="card-top">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div className="card-icon" style={{ background: b.accentColor }}>
                    .{b.extension.toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontWeight: 700 }}>
                      {b.name} {b.version}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      默认导出：{b.fileName}
                    </div>
                  </div>
                </div>
                <span className="status-pill ok">已启用</span>
              </div>
              <p className="card-desc">{b.description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
