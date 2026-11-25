import { ArrowLeft, Cpu, Download, Trash2, Upload } from 'lucide-react';
import { useRef } from 'react';
import { backendRegistry } from '../../core/backends/registry';
import { SAMPLE_CUSTOM_BOARD_TEMPLATE } from '../../core/capabilities/registry';
import { SAMPLE_CUSTOM_EXTENSION_TEMPLATE } from '../../core/extensions/builtinPacks';
import type { PolyExtensionPack } from '../../core/extensions/types';
import type { TargetProfile } from '../../types/project';

interface ExtensionsPageProps {
  activeProjectName: string;
  activeProfileId: string;
  allPacks: PolyExtensionPack[];
  allTargetProfiles: TargetProfile[];
  enabledCapabilityIds: string[];
  onToggleCapability: (capId: string) => void;
  onApplyTargetProfile: (profileId: string) => void;
  onImportExtensionJson: (raw: unknown) => void;
  onRemoveCustomPack: (packId: string) => void;
  onImportBoardProfileJson: (raw: unknown) => void;
  onRemoveCustomProfile: (profileId: string) => void;
  onReturnToBlocks: () => void;
  onNotify: (msg: string) => void;
}

function downloadJsonFile(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ExtensionsPage({
  activeProjectName,
  activeProfileId,
  allPacks,
  allTargetProfiles,
  enabledCapabilityIds,
  onToggleCapability,
  onApplyTargetProfile,
  onImportExtensionJson,
  onRemoveCustomPack,
  onImportBoardProfileJson,
  onRemoveCustomProfile,
  onReturnToBlocks,
  onNotify,
}: ExtensionsPageProps) {
  const extFileInputRef = useRef<HTMLInputElement | null>(null);
  const boardFileInputRef = useRef<HTMLInputElement | null>(null);
  const enabledSet = new Set(enabledCapabilityIds);
  const runtimePacks = allPacks.filter((p) => p.packKind === 'runtime');
  const peripheralPacks = allPacks.filter(
    (p) => (p.packKind ?? 'peripheral') !== 'runtime',
  );
  const backends = backendRegistry.list();

  const handleImportExtFile = (e: React.ChangeEvent<HTMLInputElement>) => {
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

  const handleImportBoardFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as unknown;
        onImportBoardProfileJson(parsed);
      } catch (err) {
        onNotify(
          `导入目标板型规格失败：${err instanceof Error ? err.message : String(err)}`,
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
            <h1 className="subpage-title">全局扩展库、能力模块与板型预设</h1>
            <p className="subpage-sub">
              此处管理<strong>跨项目共享的全局扩展库</strong>（可为当前项目 <strong>{activeProjectName}</strong> 勾选启用）。若外设包仅归属单个项目，请在「项目配置 → 能力与外设」导入为<strong>项目内嵌包</strong>，不会污染此页。
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-primary"
              onClick={() => extFileInputRef.current?.click()}
            >
              <Upload size={14} />
              <span>导入到全局库 (.polyext.json)</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={() => boardFileInputRef.current?.click()}
            >
              <Cpu size={14} />
              <span>导入板型 (.polyboard.json)</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={() => {
                downloadJsonFile(
                  'my-robot-api.polyext.json',
                  SAMPLE_CUSTOM_EXTENSION_TEMPLATE,
                );
                onNotify('已下载自定义外设包示例模板 my-robot-api.polyext.json');
              }}
            >
              <Download size={14} />
              <span>外设模板</span>
            </button>
            <button
              type="button"
              className="btn-outline"
              onClick={() => {
                downloadJsonFile(
                  `${SAMPLE_CUSTOM_BOARD_TEMPLATE.id}.polyboard.json`,
                  SAMPLE_CUSTOM_BOARD_TEMPLATE,
                );
                onNotify(
                  `已下载自定义板型示例模板 ${SAMPLE_CUSTOM_BOARD_TEMPLATE.id}.polyboard.json`,
                );
              }}
            >
              <Download size={14} />
              <span>板型模板</span>
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
              ref={extFileInputRef}
              type="file"
              accept=".json,.polyext.json"
              style={{ display: 'none' }}
              onChange={handleImportExtFile}
            />
            <input
              ref={boardFileInputRef}
              type="file"
              accept=".json,.polyboard.json"
              style={{ display: 'none' }}
              onChange={handleImportBoardFile}
            />
          </div>
        </div>

        <h2 className="section-heading">
          内置运行时扩展包（与外设包统一声明式协议 · 不污染纯脚本项目）
        </h2>
        <div className="card-grid">
          {runtimePacks.map((pack) => {
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
                      style={{ background: pack.color, fontSize: 11.5 }}
                    >
                      {pack.categoryLabel}
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13.5 }}>
                        {pack.name}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        v{pack.packVersion} · {pack.blocks.length} 个积木
                        {pack.handleChannelPool ? ' · 句柄通道池' : ''}
                      </div>
                    </div>
                  </div>
                  <span className="status-pill idle">运行时扩展包</span>
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
                    支持 Lua 5.4 / Python 3 顶层零闭包 ABI
                  </span>
                  <button
                    type="button"
                    className={`ext-toggle-btn ${isEnabled ? 'enabled' : 'disabled'}`}
                    style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                    title={isEnabled ? '点击从当前项目停用' : '启用到当前项目'}
                    onClick={() => onToggleCapability(pack.id)}
                  >
                    {isEnabled ? '已启用' : '+ 启用'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <h2 className="section-heading">
          全局硬件外设与扩展积木包（多项目复用 · 当前项目启用{' '}
          {peripheralPacks.filter((p) => enabledSet.has(p.id)).length} /{' '}
          {peripheralPacks.length}）
        </h2>
        <div className="card-grid">
          {peripheralPacks.map((pack) => {
            const isEnabled = enabledSet.has(pack.id);
            const hasHat = pack.blocks.some((b) => b.kind === 'hat');
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
                        {hasHat ? ' · 含事件回调' : ''}
                        {pack.sandboxMock ? ' · 含沙箱模拟' : ''}
                        {(pack.simWidgets?.length ?? 0) > 0
                          ? ` · ${pack.simWidgets!.length} 模拟控件`
                          : ''}
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
                      <>
                        <button
                          type="button"
                          className="btn-ghost"
                          style={{ padding: '4px 6px' }}
                          title="导出此全局外设包 (.polyext.json) 分享给他人"
                          onClick={() => {
                            downloadJsonFile(`${pack.id}.polyext.json`, pack);
                            onNotify(`已导出全局扩展包 ${pack.id}.polyext.json`);
                          }}
                        >
                          <Download size={13} />
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          style={{ padding: '4px 6px', color: 'var(--danger)' }}
                          title="删除自定义扩展包"
                          onClick={() => onRemoveCustomPack(pack.id)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className={`ext-toggle-btn ${
                        isEnabled ? 'enabled' : 'disabled'
                      }`}
                      style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                      title={isEnabled ? '点击从当前项目停用' : '启用到当前项目'}
                      onClick={() => onToggleCapability(pack.id)}
                    >
                      {isEnabled ? '已启用' : '+ 启用'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <h2 className="section-heading">
          目标板型规格预设（.polyboard.json · 共 {allTargetProfiles.length} 种）
        </h2>
        <div className="card-grid">
          {allTargetProfiles.map((prof) => {
            const isActive = prof.id === activeProfileId;
            return (
              <div
                key={prof.id}
                className="ui-card"
                style={
                  isActive
                    ? {
                        borderColor: 'var(--accent)',
                        boxShadow: '0 0 0 1px var(--accent-soft)',
                      }
                    : undefined
                }
              >
                <div className="card-top">
                  <div style={{ fontWeight: 700, fontSize: 13.5 }}>{prof.name}</div>
                  <span className={`status-pill ${isActive ? 'ok' : prof.builtin ? 'idle' : 'accent'}`}>
                    {isActive ? '当前板型' : prof.builtin ? '内置预设' : '自定义'}
                  </span>
                </div>
                <p className="card-desc">{prof.description}</p>
                <div className="paused-var-chips">
                  <span className="var-chip" style={{ fontSize: 10.5 }}>
                    上限 {prof.maxHandles} 句柄
                  </span>
                  {prof.capabilities.length === 0 ? (
                    <span className="var-chip" style={{ fontSize: 10.5 }}>
                      零附加能力（纯语言）
                    </span>
                  ) : (
                    prof.capabilities.map((cid) => (
                      <span key={cid} className="var-chip" style={{ fontSize: 10.5 }}>
                        {cid}
                      </span>
                    ))
                  )}
                </div>
                <div className="card-footer">
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    ID: {prof.id}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {!prof.builtin && (
                      <>
                        <button
                          type="button"
                          className="btn-ghost"
                          style={{ padding: '4px 6px' }}
                          title="导出此目标板型规格 (.polyboard.json)"
                          onClick={() => {
                            downloadJsonFile(`${prof.id}.polyboard.json`, prof);
                            onNotify(`已导出板型规格 ${prof.id}.polyboard.json`);
                          }}
                        >
                          <Download size={13} />
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          style={{ padding: '4px 6px', color: 'var(--danger)' }}
                          title="删除自定义板型"
                          onClick={() => onRemoveCustomProfile(prof.id)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className={isActive ? 'btn-primary' : 'btn-outline'}
                      style={{ padding: '4px 10px', fontSize: 11.5 }}
                      onClick={() => onApplyTargetProfile(prof.id)}
                    >
                      {isActive ? '重新应用此板型' : '应用到当前项目'}
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
