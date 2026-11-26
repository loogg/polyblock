import {
  AlertTriangle,
  Code2,
  FileCode2,
  Globe,
  Info,
  Variable,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  validateSharedVariableName,
  type VariableScopeKind,
} from '../core/projects/handleVariables';

export type BlocklyDialogRequest =
  | {
      kind: 'create-variable';
      initialScope: VariableScopeKind;
      onConfirm: (name: string, scope: VariableScopeKind) => void;
    }
  | {
      kind: 'create-function';
      onConfirm: (name: string, hasReturn: boolean) => void;
    }
  | {
      kind: 'prompt';
      message: string;
      defaultValue: string;
      callback: (value: string | null) => void;
    }
  | {
      kind: 'confirm';
      message: string;
      callback: (confirmed: boolean) => void;
    }
  | {
      kind: 'alert';
      message: string;
      callback?: () => void;
    };

interface BlocklyDialogModalProps {
  request: BlocklyDialogRequest;
  handleName: string;
  handleColor: string;
  activeScriptLabel: string;
  handleSharedVars: string[];
  currentScriptVars: string[];
  allHandleVars: string[];
  allHandleFunctions?: string[];
  onClose: () => void;
}

export function BlocklyDialogModal({
  request,
  handleName,
  handleColor,
  activeScriptLabel,
  handleSharedVars,
  currentScriptVars,
  allHandleVars,
  allHandleFunctions = [],
  onClose,
}: BlocklyDialogModalProps) {
  const [draft, setDraft] = useState(
    request.kind === 'prompt' ? request.defaultValue : '',
  );
  const [scope, setScope] = useState<VariableScopeKind>(
    request.kind === 'create-variable' ? request.initialScope : 'file',
  );
  const [fnHasReturn, setFnHasReturn] = useState<boolean>(false);
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(request.kind === 'prompt' ? request.defaultValue : '');
    if (request.kind === 'create-variable') {
      setScope(request.initialScope);
    }
    if (request.kind === 'create-function') {
      setFnHasReturn(false);
    }
    setTouched(false);
    if (
      request.kind === 'create-variable' ||
      request.kind === 'create-function' ||
      request.kind === 'prompt'
    ) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [request]);

  const isCreateVar = request.kind === 'create-variable';
  const isCreateFn = request.kind === 'create-function';
  const isPrompt = request.kind === 'prompt';
  const isVariablePrompt =
    isCreateVar ||
    (isPrompt &&
      (request.message.includes('变量') ||
        request.message.toLowerCase().includes('variable')));
  const isRenamePrompt =
    isPrompt &&
    isVariablePrompt &&
    (request.message.includes('重命名') ||
      request.message.toLowerCase().includes('rename'));

  const renamingIsShared =
    isRenamePrompt && handleSharedVars.includes(request.defaultValue.trim());

  const effectiveScope: VariableScopeKind = isCreateVar
    ? scope
    : renamingIsShared
      ? 'shared'
      : 'file';

  const validation = useMemo(() => {
    if (!isCreateVar && !isCreateFn && !isPrompt) {
      return { valid: true, trimmed: '' } as const;
    }
    if (isCreateFn) {
      return validateSharedVariableName(
        draft,
        allHandleFunctions,
        undefined,
        '跨文件公共函数',
      );
    }
    if (!isVariablePrompt) {
      return draft.trim()
        ? ({ valid: true, trimmed: draft.trim() } as const)
        : ({ valid: false, error: '内容不能为空' } as const);
    }
    const existingList =
      effectiveScope === 'shared'
        ? allHandleVars
        : Array.from(new Set([...handleSharedVars, ...currentScriptVars]));
    const scopeLabel =
      effectiveScope === 'shared' ? '跨文件共享变量' : '当前脚本变量';
    return validateSharedVariableName(
      draft,
      existingList,
      isRenamePrompt && isPrompt ? request.defaultValue.trim() : undefined,
      scopeLabel,
    );
  }, [
    allHandleFunctions,
    allHandleVars,
    currentScriptVars,
    draft,
    effectiveScope,
    handleSharedVars,
    isCreateFn,
    isCreateVar,
    isPrompt,
    isRenamePrompt,
    isVariablePrompt,
    request,
  ]);

  const cancel = () => {
    if (request.kind === 'prompt') request.callback(null);
    else if (request.kind === 'confirm') request.callback(false);
    else if (request.kind === 'alert') request.callback?.();
    onClose();
  };

  const confirm = () => {
    if (request.kind === 'create-variable') {
      setTouched(true);
      if (!validation.valid) {
        inputRef.current?.focus();
        return;
      }
      request.onConfirm(validation.trimmed, scope);
      onClose();
      return;
    }
    if (request.kind === 'create-function') {
      setTouched(true);
      if (!validation.valid) {
        inputRef.current?.focus();
        return;
      }
      request.onConfirm(validation.trimmed, fnHasReturn);
      onClose();
      return;
    }
    if (request.kind === 'prompt') {
      setTouched(true);
      if (!validation.valid) {
        inputRef.current?.focus();
        return;
      }
      request.callback(validation.trimmed);
      onClose();
      return;
    }
    if (request.kind === 'confirm') {
      request.callback(true);
      onClose();
      return;
    }
    request.callback?.();
    onClose();
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (
        e.key === 'Enter' &&
        request.kind !== 'prompt' &&
        request.kind !== 'create-variable' &&
        request.kind !== 'create-function'
      ) {
        e.preventDefault();
        confirm();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const modalTitle = isCreateFn
    ? '新建跨文件公共函数'
    : isCreateVar
      ? scope === 'shared'
        ? '新建跨文件全局变量'
        : '新建单文件全局变量'
      : isPrompt
        ? isRenamePrompt
          ? renamingIsShared
            ? '重命名跨文件全局变量'
            : '重命名单文件全局变量'
          : isVariablePrompt
            ? '新建变量'
            : request.message
        : request.kind === 'confirm'
          ? '请确认操作'
          : '提示';

  const isDeleteConfirm =
    request.kind === 'confirm' &&
    (request.message.includes('删除') ||
      request.message.toLowerCase().includes('delete'));

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={modalTitle}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div className="modal-shell alias-modal" style={{ maxWidth: 440 }}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            {isCreateFn ? (
              <Code2 size={15} style={{ color: '#4f46e5' }} />
            ) : isCreateVar || isPrompt ? (
              <Variable size={15} style={{ color: '#db2777' }} />
            ) : request.kind === 'confirm' ? (
              <AlertTriangle size={15} style={{ color: 'var(--warn)' }} />
            ) : (
              <Info size={15} style={{ color: 'var(--accent)' }} />
            )}
            <span className="modal-title">{modalTitle}</span>
          </div>
          <button
            type="button"
            className="btn-ghost"
            onClick={cancel}
            aria-label="关闭"
            style={{ padding: '3px 5px' }}
          >
            <X size={14} />
          </button>
        </div>

        <div
          style={{
            padding: '14px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 11,
          }}
        >
          {isCreateVar || isCreateFn || isPrompt ? (
            <>
              {isCreateVar && (
                <div className="var-scope-switcher" role="radiogroup" aria-label="选择变量作用域">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={scope === 'shared'}
                    className={`var-scope-option ${scope === 'shared' ? 'active' : ''}`}
                    onClick={() => setScope('shared')}
                  >
                    <Globe size={13} />
                    <span>跨文件全局</span>
                    <small>同句柄共享</small>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={scope === 'file'}
                    className={`var-scope-option ${scope === 'file' ? 'active' : ''}`}
                    onClick={() => setScope('file')}
                  >
                    <FileCode2 size={13} />
                    <span>单文件全局</span>
                    <small>仅当前脚本</small>
                  </button>
                </div>
              )}

              {isCreateFn && (
                <div className="var-scope-switcher" role="radiogroup" aria-label="选择函数返回类型">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!fnHasReturn}
                    className={`var-scope-option ${!fnHasReturn ? 'active' : ''}`}
                    onClick={() => setFnHasReturn(false)}
                  >
                    <Code2 size={13} />
                    <span>无返回值</span>
                    <small>语句调用</small>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={fnHasReturn}
                    className={`var-scope-option ${fnHasReturn ? 'active' : ''}`}
                    onClick={() => setFnHasReturn(true)}
                  >
                    <Globe size={13} />
                    <span>带返回值</span>
                    <small>表达式返回</small>
                  </button>
                </div>
              )}

              {(isVariablePrompt || isCreateFn) && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    flexWrap: 'wrap',
                  }}
                >
                  <span>作用范围：</span>
                  <span className="var-chip">
                    <span
                      className="lang-dot"
                      style={{ background: handleColor }}
                    />
                    <strong>
                      {isCreateFn || effectiveScope === 'shared'
                        ? handleName
                        : `${handleName}/${activeScriptLabel}`}
                    </strong>
                  </span>
                  <span className="count-badge">
                    {isCreateFn
                      ? '跨文件公共函数 · 同句柄共享'
                      : effectiveScope === 'shared'
                        ? '跨文件全局 · 同句柄共享'
                        : '单文件全局 · 仅本脚本'}
                  </span>
                </div>
              )}

              <label
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  fontSize: 12.5,
                  color: 'var(--text-secondary)',
                }}
              >
                <span>
                  {isCreateFn
                    ? '新函数的名称：'
                    : isPrompt
                      ? request.message
                      : '新变量的名称：'}
                </span>
                <input
                  ref={inputRef}
                  type="text"
                  aria-label={modalTitle}
                  className="dropdown-rename-input"
                  style={{
                    width: '100%',
                    height: 36,
                    fontSize: 13.5,
                    padding: '0 10px',
                    borderColor:
                      touched && !validation.valid ? 'var(--danger)' : undefined,
                  }}
                  placeholder={
                    isCreateFn
                      ? '输入跨文件函数名（如 clamp、format_msg、calc_crc）'
                      : isVariablePrompt
                        ? effectiveScope === 'shared'
                          ? '输入跨文件变量名（如 led_on、ticks、状态）'
                          : '输入单文件变量名（如 total、step、计数）'
                        : '请输入内容'
                  }
                  maxLength={32}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    if (!touched) setTouched(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      confirm();
                    }
                  }}
                />
              </label>

              {touched && !validation.valid ? (
                <div
                  role="alert"
                  style={{
                    fontSize: 12,
                    color: 'var(--danger)',
                    lineHeight: 1.45,
                  }}
                >
                  {validation.error}
                </div>
              ) : isCreateFn ? (
                <p className="settings-hint" style={{ margin: 0 }}>
                  将在当前脚本「{activeScriptLabel}」中创建并向句柄「{handleName}」内所有脚本共享：Lua 导出全局 <code>function</code>，Python 导出模块函数并自动以 <code>模块名.函数名()</code> 跨文件调用。右键函数定义块可随时在私有/公共间切换。
                </p>
              ) : isVariablePrompt ? (
                <p className="settings-hint" style={{ margin: 0 }}>
                  {effectiveScope === 'shared' ? (
                    <>
                      将在句柄「{handleName}」内所有脚本间共享：Lua 写入 <code>_G</code>，Python 自动归入只读 <code>shared.py</code> 并以 <code>shared.变量名</code> 访问。
                    </>
                  ) : (
                    <>
                      仅在当前脚本「{activeScriptLabel}」内所有回调共享、与其他脚本严格隔离：Lua 生成文件顶层 <code>local</code>，Python 生成模块级 <code>global</code>。
                    </>
                  )}
                </p>
              ) : null}

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 8,
                  marginTop: 4,
                }}
              >
                <button type="button" className="btn-outline" onClick={cancel}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!validation.valid}
                  onClick={confirm}
                >
                  {isRenamePrompt ? '确认重命名' : '确认创建'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div
                style={{
                  fontSize: 13,
                  lineHeight: 1.55,
                  color: 'var(--text-primary)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {request.message}
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 8,
                  marginTop: 6,
                }}
              >
                {request.kind === 'confirm' && (
                  <button
                    type="button"
                    className="btn-outline"
                    onClick={cancel}
                  >
                    取消
                  </button>
                )}
                <button
                  type="button"
                  className="btn-primary"
                  style={
                    isDeleteConfirm
                      ? { background: 'var(--danger)', borderColor: 'var(--danger)' }
                      : undefined
                  }
                  onClick={confirm}
                >
                  {request.kind === 'confirm'
                    ? isDeleteConfirm
                      ? '确认删除'
                      : '确定'
                    : '知道了'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
