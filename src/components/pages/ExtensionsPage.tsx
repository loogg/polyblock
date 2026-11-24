import { ArrowLeft } from 'lucide-react';
import { backendRegistry } from '../../core/backends/registry';
import { BLOCK_CATEGORIES } from '../../core/blocks/catalog';

interface ExtensionsPageProps {
  onReturnToBlocks: () => void;
}

export function ExtensionsPage({ onReturnToBlocks }: ExtensionsPageProps) {
  const backends = backendRegistry.list();

  return (
    <div className="subpage-wrap">
      <div className="subpage-inner">
        <div className="subpage-header">
          <div>
            <h1 className="subpage-title">扩展积木库与脚本后端管理</h1>
            <p className="subpage-sub">
              通过统一 <code>ScriptBackendAdapter</code> 与声明式积木目录，支持自由新增目标脚本语言或领域积木包。
            </p>
          </div>
          <button type="button" className="btn-outline" onClick={onReturnToBlocks}>
            <ArrowLeft size={14} />
            <span>返回编程画布</span>
          </button>
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

          <div className="ui-card">
            <div className="card-top">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  className="card-icon"
                  style={{ background: 'linear-gradient(135deg, #64748b, #475569)' }}
                >
                  +DSL
                </div>
                <div>
                  <div style={{ fontWeight: 700 }}>更多脚本后端（可扩展）</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    JavaScript / Shell / C++ / 自定义 DSL
                  </div>
                </div>
              </div>
              <span className="status-pill accent">插件位</span>
            </div>
            <p className="card-desc">
              只需新增一个实现 <code>ScriptBackendAdapter</code> 的类并调用{' '}
              <code>backendRegistry.register(...)</code>，顶栏切换器与导出流程自动识别。
            </p>
          </div>
        </div>

        <h2 className="section-heading">
          当前已加载积木分类（{BLOCK_CATEGORIES.length} 个基础模块）
        </h2>
        <div className="card-grid">
          {BLOCK_CATEGORIES.map((cat) => (
            <div key={cat.id} className="ui-card" style={{ padding: 13 }}>
              <div className="card-top">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    className="cat-dot"
                    style={{ '--cat-color': cat.color } as React.CSSProperties}
                  />
                  <span style={{ fontWeight: 700 }}>{cat.label}</span>
                </div>
                <span className="status-pill ok">
                  {cat.custom ? '动态积木' : `${cat.blocks.length} 个积木`}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
