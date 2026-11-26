import { ArrowLeft, Copy, Lock, Plus, Variable } from 'lucide-react';

interface SharedVarsViewProps {
  handleName: string;
  handleColor: string;
  fileName: string;
  moduleName: string;
  pythonSource: string;
  entries: Array<{ name: string; attr: string; usedInScripts: string[] }>;
  disabled?: boolean;
  onCreateSharedVariable: () => void;
  onCopySource: () => void;
  onBackToCanvas: () => void;
}

export function SharedVarsView({
  handleName,
  handleColor,
  fileName,
  moduleName,
  pythonSource,
  entries,
  disabled = false,
  onCreateSharedVariable,
  onCopySource,
  onBackToCanvas,
}: SharedVarsViewProps) {
  const lines = pythonSource.replace(/\n$/, '').split('\n');

  return (
    <section
      className="shared-vars-view"
      aria-label={`只读共享变量模块 ${fileName}`}
    >
      <div className="shared-vars-header">
        <div className="shared-vars-title-row">
          <Lock size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <strong style={{ fontSize: 14 }}>{fileName}</strong>
          <span className="var-chip">
            <span className="lang-dot" style={{ background: handleColor }} />
            <span>{handleName}</span>
          </span>
          <span className="count-badge">自动生成 · 只读</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            className="btn-outline"
            disabled={disabled}
            onClick={onCreateSharedVariable}
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            <Plus size={13} />
            <span>新建跨文件变量</span>
          </button>
          <button
            type="button"
            className="btn-outline"
            onClick={onCopySource}
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            <Copy size={13} />
            <span>复制源码</span>
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={onBackToCanvas}
            style={{ fontSize: 12, padding: '4px 9px' }}
          >
            <ArrowLeft size={13} />
            <span>返回画布</span>
          </button>
        </div>
      </div>

      <div className="shared-vars-body">
        <div className="shared-vars-banner">
          该模块由 PolyBlock 根据当前句柄「{handleName}」的<strong>跨文件全局变量</strong>自动生成，保证 Python 多脚本运行时与 Lua <code>_G</code> 语义 100% 一致；在导出单句柄或整项目 Python 目标运行包（<code>.zip</code>）时将自动一并打包。
        </div>

        <div className="shared-vars-section">
          <div className="shared-vars-section-title">
            <Variable size={13} style={{ color: '#db2777' }} />
            <span>跨文件共享变量清单 ({entries.length})</span>
          </div>
          <div className="shared-vars-grid">
            {entries.map((entry) => (
              <div key={entry.name} className="shared-var-card">
                <div className="shared-var-card-top">
                  <span className="shared-var-name">{entry.name}</span>
                  <code className="shared-var-code">
                    {moduleName}.{entry.attr}
                  </code>
                </div>
                <div className="shared-var-usage">
                  {entry.usedInScripts.length > 0 ? (
                    <>
                      <span>引用脚本：</span>
                      {entry.usedInScripts.map((s) => (
                        <span key={s} className="count-badge">
                          {s}.py
                        </span>
                      ))}
                    </>
                  ) : (
                    <span style={{ opacity: 0.7 }}>
                      尚未在积木中引用（可在任意脚本的「变量 → 跨文件全局」拖入使用）
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="shared-vars-section" style={{ flex: 1, minHeight: 0 }}>
          <div className="shared-vars-section-title">
            <span>只读生成源码预览 ({fileName})</span>
          </div>
          <div className="shared-vars-code-box">
            {lines.map((line, idx) => (
              <div key={idx} className="code-line">
                <span className="code-ln">{idx + 1}</span>
                <span className="code-text">
                  {line.startsWith('#') ? (
                    <span className="tok-comment">{line}</span>
                  ) : (
                    line || ' '
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
