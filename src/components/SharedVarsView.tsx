import {
  ArrowLeft,
  ArrowUpRight,
  Code2,
  Copy,
  Lock,
  Plus,
  Variable,
} from 'lucide-react';
import type {
  HandleSharedModuleFnEntry,
  HandleSharedModuleVarEntry,
} from '../core/backends/sharedModule';
import {
  formatInitialValueForLanguage,
  LANGUAGE_DIALECTS,
} from '../core/backends/types';
import { highlightCodeLine } from '../core/highlight';
import type {
  ScriptLanguageId,
  VariableInitialValue,
} from '../types/project';

interface SharedVarsViewProps {
  handleName: string;
  handleColor: string;
  language: ScriptLanguageId;
  fileName: string;
  moduleName: string;
  source: string;
  variables: HandleSharedModuleVarEntry[];
  functions: HandleSharedModuleFnEntry[];
  disabled?: boolean;
  onCreateSharedVariable: () => void;
  onCreateSharedFunction: () => void;
  onUpdateVarInitialValue: (
    varName: string,
    nextInit: VariableInitialValue,
  ) => void;
  onJumpToFunction: (scriptId: string, blockId?: string) => void;
  onCopySource: () => void;
  onBackToCanvas: () => void;
}

export function SharedVarsView({
  handleName,
  handleColor,
  language,
  fileName,
  moduleName,
  source,
  variables,
  functions,
  disabled = false,
  onCreateSharedVariable,
  onCreateSharedFunction,
  onUpdateVarInitialValue,
  onJumpToFunction,
  onCopySource,
  onBackToCanvas,
}: SharedVarsViewProps) {
  const lines = source.replace(/\n$/, '').split('\n');
  const dialect = LANGUAGE_DIALECTS[language];
  const ext = dialect.extension;
  const initKindOptions: Array<{
    kind: VariableInitialValue['kind'];
    label: string;
  }> = [
    { kind: 'null', label: `空值 (${dialect.nullLiteral})` },
    { kind: 'number', label: '数字' },
    { kind: 'boolean', label: '布尔' },
    { kind: 'string', label: '文本' },
    { kind: 'list', label: `空列表 ${dialect.listLiteral}` },
    { kind: 'dict', label: `空字典 ${dialect.dictLiteral}` },
  ];

  const handleInitKindChange = (
    varName: string,
    nextKind: VariableInitialValue['kind'],
  ) => {
    switch (nextKind) {
      case 'number':
        onUpdateVarInitialValue(varName, { kind: 'number', value: 0 });
        break;
      case 'boolean':
        onUpdateVarInitialValue(varName, { kind: 'boolean', value: false });
        break;
      case 'string':
        onUpdateVarInitialValue(varName, { kind: 'string', value: '' });
        break;
      case 'list':
        onUpdateVarInitialValue(varName, { kind: 'list' });
        break;
      case 'dict':
        onUpdateVarInitialValue(varName, { kind: 'dict' });
        break;
      default:
        onUpdateVarInitialValue(varName, { kind: 'null' });
        break;
    }
  };

  return (
    <section
      className="shared-vars-view"
      aria-label={`只读共享模块 ${fileName}`}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
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
            disabled={disabled}
            onClick={onCreateSharedFunction}
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            <Code2 size={13} />
            <span>新建跨文件函数</span>
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
          该模块由 PolyBlock 根据当前句柄「{handleName}」的
          <strong>跨文件全局变量</strong>与<strong>跨文件公共函数</strong>
          自动生成（只读共享模块，当前目标语言 {dialect.displayName} 导出为{' '}
          <code>{fileName}</code>）；任意引用它的脚本顶部会自动引入，导出目标运行包（
          <code>.zip</code>）时一并打包。
        </div>

        <div className="shared-vars-section">
          <div className="shared-vars-section-title">
            <Variable size={13} style={{ color: '#db2777' }} />
            <span>跨文件共享变量清单 ({variables.length})</span>
          </div>
          {variables.length === 0 ? (
            <div className="shared-vars-empty">
              暂无跨文件全局变量（点击右上角「新建跨文件变量」或在任意画布「变量」分类创建）
            </div>
          ) : (
            <div className="shared-vars-grid">
              {variables.map((entry) => {
                const initLiteral = formatInitialValueForLanguage(
                  entry.initialValue,
                  language,
                );
                return (
                  <div key={entry.name} className="shared-var-card">
                    <div className="shared-var-card-top">
                      <span className="shared-var-name">{entry.name}</span>
                      <code className="shared-var-code">
                        {moduleName}.{entry.attr} = {initLiteral}
                      </code>
                    </div>

                    <div className="shared-var-init-row">
                      <span className="shared-var-init-label">初始值：</span>
                      <select
                        className="shared-var-init-select"
                        aria-label={`修改 ${entry.name} 初始值类型`}
                        disabled={disabled}
                        value={entry.initialValue.kind}
                        onChange={(e) =>
                          handleInitKindChange(
                            entry.name,
                            e.target.value as VariableInitialValue['kind'],
                          )
                        }
                      >
                        {initKindOptions.map((opt) => (
                          <option key={opt.kind} value={opt.kind}>
                            {opt.label}
                          </option>
                        ))}
                      </select>

                      {entry.initialValue.kind === 'number' && (
                        <input
                          type="number"
                          step="any"
                          className="shared-var-init-input"
                          aria-label={`修改 ${entry.name} 初始数值`}
                          disabled={disabled}
                          value={entry.initialValue.value}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            onUpdateVarInitialValue(entry.name, {
                              kind: 'number',
                              value: Number.isFinite(n) ? n : 0,
                            });
                          }}
                        />
                      )}

                      {entry.initialValue.kind === 'boolean' && (
                        <select
                          className="shared-var-init-select"
                          aria-label={`修改 ${entry.name} 初始布尔值`}
                          disabled={disabled}
                          value={entry.initialValue.value ? 'true' : 'false'}
                          onChange={(e) =>
                            onUpdateVarInitialValue(entry.name, {
                              kind: 'boolean',
                              value: e.target.value === 'true',
                            })
                          }
                        >
                          <option value="false">{dialect.boolFalse}</option>
                          <option value="true">{dialect.boolTrue}</option>
                        </select>
                      )}

                      {entry.initialValue.kind === 'string' && (
                        <input
                          type="text"
                          className="shared-var-init-input"
                          aria-label={`修改 ${entry.name} 初始文本`}
                          placeholder="空文本"
                          disabled={disabled}
                          value={entry.initialValue.value}
                          onChange={(e) =>
                            onUpdateVarInitialValue(entry.name, {
                              kind: 'string',
                              value: e.target.value,
                            })
                          }
                        />
                      )}
                    </div>

                    <div className="shared-var-usage">
                      {entry.usedInScripts.length > 0 ? (
                        <>
                          <span>引用脚本：</span>
                          {entry.usedInScripts.map((s) => (
                            <span key={s} className="count-badge">
                              {s}.{ext}
                            </span>
                          ))}
                        </>
                      ) : (
                        <span style={{ opacity: 0.7 }}>
                          尚未在积木中引用（可在任意脚本「变量 → 跨文件全局」拖入使用）
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="shared-vars-section">
          <div className="shared-vars-section-title">
            <Code2 size={13} style={{ color: '#4f46e5' }} />
            <span>跨文件公共函数清单 ({functions.length})</span>
          </div>
          {functions.length === 0 ? (
            <div className="shared-vars-empty">
              暂无跨文件公共函数（点击「新建跨文件函数」，或右键任意函数定义块切换为跨文件公共函数）
            </div>
          ) : (
            <div className="shared-vars-grid">
              {functions.map((fn) => (
                <div key={fn.name} className="shared-var-card">
                  <div className="shared-var-card-top">
                    <span className="shared-var-name">{fn.name}</span>
                    <code className="shared-var-code">
                      {moduleName}.{fn.ident}({fn.params.join(', ')})
                    </code>
                  </div>
                  <div className="shared-var-usage">
                    <span className="count-badge">
                      定义于 {fn.scriptName}.{ext}
                    </span>
                    {fn.hasReturn && <span className="count-badge">返回值</span>}
                    {fn.usesSleep && dialect.explicitAsyncCoroutine && (
                      <span className="count-badge warn">async</span>
                    )}
                    <button
                      type="button"
                      className="btn-ghost shared-fn-jump-btn"
                      onClick={() => onJumpToFunction(fn.scriptId, fn.blockId)}
                      title={`跳转到 ${fn.scriptName}.${ext} 编辑该函数积木`}
                    >
                      <span>定位编辑</span>
                      <ArrowUpRight size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="shared-vars-section" style={{ flex: 1, minHeight: 0 }}>
          <div className="shared-vars-section-title">
            <span>只读生成源码预览 ({fileName})</span>
          </div>
          <div className="shared-vars-code-box">
            {lines.map((line, idx) => (
              <div key={idx} className="code-line">
                <span className="code-ln">{idx + 1}</span>
                <span
                  className="code-text"
                  dangerouslySetInnerHTML={{
                    __html: highlightCodeLine(line, language) || ' ',
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
