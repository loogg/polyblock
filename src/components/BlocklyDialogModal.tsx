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
  backendRegistry,
  getLanguageDialect,
} from '../core/backends/registry';
import {
  validateSharedVariableName,
  type VariableScopeKind,
} from '../core/projects/handleVariables';
import { useModalFocusTrap } from '../hooks/useModalFocusTrap';
import type {
  ScriptLanguageId,
  VariableInitialValue,
} from '../types/project';

export type BlocklyDialogRequest =
  | {
      kind: 'create-variable';
      initialScope: VariableScopeKind;
      onConfirm: (
        name: string,
        scope: VariableScopeKind,
        initialValue: VariableInitialValue,
      ) => void;
    }
  | {
      kind: 'create-function';
      initialScope: VariableScopeKind;
      onConfirm: (
        name: string,
        scope: VariableScopeKind,
        hasReturn: boolean,
      ) => void;
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
  language?: ScriptLanguageId;
  handleName: string;
  handleColor: string;
  activeScriptLabel: string;
  handleSharedVars: string[];
  currentScriptVars: string[];
  allHandleVars: string[];
  handleSharedFunctions?: string[];
  currentScriptFunctions?: string[];
  allHandleFunctions?: string[];
  onClose: () => void;
}

export function BlocklyDialogModal({
  request,
  language = backendRegistry.getDefaultId(),
  handleName,
  handleColor,
  activeScriptLabel,
  handleSharedVars,
  currentScriptVars,
  allHandleVars,
  handleSharedFunctions = [],
  currentScriptFunctions = [],
  allHandleFunctions = [],
  onClose,
}: BlocklyDialogModalProps) {
  const dialect = getLanguageDialect(language);
  const sharedFileName = `shared.${dialect.extension}`;
  const initKindButtons: Array<{
    kind: VariableInitialValue['kind'];
    label: string;
  }> = [
    { kind: 'null', label: `空值 (${dialect.nullLiteral})` },
    { kind: 'number', label: '数字' },
    { kind: 'boolean', label: '布尔' },
    { kind: 'string', label: '文本' },
    { kind: 'list', label: `列表 ${dialect.listLiteral}` },
    { kind: 'dict', label: `字典 ${dialect.dictLiteral}` },
  ];
  const [draft, setDraft] = useState(
    request.kind === 'prompt' ? request.defaultValue : '',
  );
  const [scope, setScope] = useState<VariableScopeKind>(
    request.kind === 'create-variable' || request.kind === 'create-function'
      ? request.initialScope
      : 'file',
  );
  const [fnHasReturn, setFnHasReturn] = useState<boolean>(false);
  const [initKind, setInitKind] = useState<VariableInitialValue['kind']>('null');
  const [initNumberStr, setInitNumberStr] = useState<string>('0');
  const [initBool, setInitBool] = useState<boolean>(false);
  const [initString, setInitString] = useState<string>('');
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);

  useModalFocusTrap(modalRef, true);

  useEffect(() => {
    setDraft(request.kind === 'prompt' ? request.defaultValue : '');
    if (request.kind === 'create-variable' || request.kind === 'create-function') {
      setScope(request.initialScope);
    }
    if (request.kind === 'create-variable') {
      setInitKind('null');
      setInitNumberStr('0');
      setInitBool(false);
      setInitString('');
    }
    if (request.kind === 'create-function') {
      setFnHasReturn(false);
    }
    setTouched(false);
    let rafId: number | null = null;
    if (
      request.kind === 'create-variable' ||
      request.kind === 'create-function' ||
      request.kind === 'prompt'
    ) {
      rafId = requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
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

  const effectiveScope: VariableScopeKind =
    isCreateVar || isCreateFn
      ? scope
      : renamingIsShared
        ? 'shared'
        : 'file';

  const resolvedInitialValue = useMemo<VariableInitialValue>(() => {
    switch (initKind) {
      case 'number': {
        const parsed = Number(initNumberStr);
        return { kind: 'number', value: Number.isFinite(parsed) ? parsed : 0 };
      }
      case 'boolean':
        return { kind: 'boolean', value: initBool };
      case 'string':
        return { kind: 'string', value: initString };
      case 'list':
        return { kind: 'list' };
      case 'dict':
        return { kind: 'dict' };
      default:
        return { kind: 'null' };
    }
  }, [initKind, initNumberStr, initBool, initString]);

  const validation = useMemo(() => {
    if (!isCreateVar && !isCreateFn && !isPrompt) {
      return { valid: true, trimmed: '' } as const;
    }
    if (isCreateFn) {
      const existingFns =
        effectiveScope === 'shared'
          ? allHandleFunctions
          : Array.from(
              new Set([...handleSharedFunctions, ...currentScriptFunctions]),
            );
      return validateSharedVariableName(
        draft,
        existingFns,
        undefined,
        effectiveScope === 'shared' ? '跨文件公共函数' : '本文件函数',
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
    currentScriptFunctions,
    currentScriptVars,
    draft,
    effectiveScope,
    handleSharedFunctions,
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
      request.onConfirm(validation.trimmed, scope, resolvedInitialValue);
      onClose();
      return;
    }
    if (request.kind === 'create-function') {
      setTouched(true);
      if (!validation.valid) {
        inputRef.current?.focus();
        return;
      }
      request.onConfirm(validation.trimmed, scope, fnHasReturn);
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

  const cancelRef = useRef(cancel);
  const confirmRef = useRef(confirm);
  cancelRef.current = cancel;
  confirmRef.current = confirm;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelRef.current();
      } else if (
        e.key === 'Enter' &&
        request.kind === 'alert' &&
        !(document.activeElement instanceof HTMLButtonElement)
      ) {
        e.preventDefault();
        confirmRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [request.kind]);

  const modalTitle = isCreateFn
    ? effectiveScope === 'shared'
      ? '新建跨文件公共函数'
      : '新建本文件私有函数'
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
      <div
        className="modal-shell alias-modal"
        style={{ maxWidth: 460 }}
        ref={modalRef}
        tabIndex={-1}
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            {isCreateFn ? (
              <Code2 size={15} style={{ color: '#4f46e5' }} />
            ) : isCreateVar || isPrompt ? (
              <Variable size={15} style={{ color: '#db2777' }} />
            ) : request.kind === 'confirm' ? (
              <AlertTriangle size={15} style={{ color: 'var(--warning)' }} />
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
              {(isCreateVar || isCreateFn) && (
                <div
                  className="var-scope-switcher"
                  role="radiogroup"
                  aria-label={isCreateFn ? '选择函数作用域' : '选择变量作用域'}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={scope === 'shared'}
                    className={`var-scope-option ${scope === 'shared' ? 'active' : ''}`}
                    onClick={() => setScope('shared')}
                  >
                    <Globe size={13} />
                    <span>{isCreateFn ? '跨文件公共' : '跨文件全局'}</span>
                    <small>归入 shared 模块</small>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={scope === 'file'}
                    className={`var-scope-option ${scope === 'file' ? 'active' : ''}`}
                    onClick={() => setScope('file')}
                  >
                    <FileCode2 size={13} />
                    <span>{isCreateFn ? '本文件私有' : '单文件全局'}</span>
                    <small>仅当前脚本</small>
                  </button>
                </div>
              )}

              {isCreateFn && (
                <div
                  className="var-scope-switcher"
                  role="radiogroup"
                  aria-label="选择函数返回类型"
                >
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
                      {effectiveScope === 'shared'
                        ? handleName
                        : `${handleName}/${activeScriptLabel}`}
                    </strong>
                  </span>
                  <span className="count-badge">
                    {isCreateFn
                      ? effectiveScope === 'shared'
                        ? '跨文件公共 · shared.fn()'
                        : '本文件私有 · 仅本脚本'
                      : effectiveScope === 'shared'
                        ? '跨文件全局 · shared.xxx'
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
                      ? effectiveScope === 'shared'
                        ? '输入跨文件函数名（如 clamp、double_val、calc_crc）'
                        : '输入私有函数名（如 helper、step_once）'
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

              {isCreateVar && (
                <div className="var-init-picker">
                  <span className="var-init-picker-label">
                    声明时初始值（避免未赋值直接运算报错）：
                  </span>
                  <div
                    className="var-init-kind-grid"
                    role="radiogroup"
                    aria-label="选择变量初始值类型"
                  >
                    {initKindButtons.map((btn) => (
                      <button
                        key={btn.kind}
                        type="button"
                        role="radio"
                        aria-checked={initKind === btn.kind}
                        className={`var-init-kind-btn ${
                          initKind === btn.kind ? 'active' : ''
                        }`}
                        onClick={() => setInitKind(btn.kind)}
                      >
                        {btn.label}
                      </button>
                    ))}
                  </div>

                  {initKind === 'number' && (
                    <input
                      type="number"
                      step="any"
                      aria-label="初始数值"
                      className="dropdown-rename-input"
                      style={{ width: '100%', height: 32, padding: '0 10px' }}
                      value={initNumberStr}
                      onChange={(e) => setInitNumberStr(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          confirm();
                        }
                      }}
                    />
                  )}

                  {initKind === 'boolean' && (
                    <div
                      className="var-init-bool-row"
                      role="radiogroup"
                      aria-label="初始布尔值"
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-checked={!initBool}
                        className={`var-init-kind-btn ${!initBool ? 'active' : ''}`}
                        onClick={() => setInitBool(false)}
                      >
                        {dialect.boolFalse}
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={initBool}
                        className={`var-init-kind-btn ${initBool ? 'active' : ''}`}
                        onClick={() => setInitBool(true)}
                      >
                        {dialect.boolTrue}
                      </button>
                    </div>
                  )}

                  {initKind === 'string' && (
                    <input
                      type="text"
                      aria-label="初始文本"
                      className="dropdown-rename-input"
                      style={{ width: '100%', height: 32, padding: '0 10px' }}
                      placeholder="输入初始文本（留空表示空字符串）"
                      value={initString}
                      onChange={(e) => setInitString(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          confirm();
                        }
                      }}
                    />
                  )}
                </div>
              )}

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
                  {effectiveScope === 'shared' ? (
                    <>
                      函数积木保存在当前脚本「{activeScriptLabel}」便于编辑，导出时自动归入同句柄只读{' '}
                      <code>{sharedFileName}</code> 模块，所有脚本统一通过{' '}
                      <code>shared.函数名()</code> 调用；跨文件函数不可引用单文件私有变量。
                    </>
                  ) : (
                    <>
                      仅在当前脚本「{activeScriptLabel}」内部定义和调用，按当前目标语言导出为本文件作用域的私有函数，不污染同句柄其他脚本。右键函数定义块可随时在私有/公共间切换。
                    </>
                  )}
                </p>
              ) : isVariablePrompt ? (
                <p className="settings-hint" style={{ margin: 0 }}>
                  {effectiveScope === 'shared' ? (
                    <>
                      将在句柄「{handleName}」内所有脚本间共享：自动归入当前句柄只读{' '}
                      <code>{sharedFileName}</code> 模块，各脚本统一以{' '}
                      <code>shared.变量名</code> 访问。
                    </>
                  ) : (
                    <>
                      仅在当前脚本「{activeScriptLabel}」内的顶层与各回调之间共享，与同句柄其他脚本严格隔离，导出为单文件作用域变量。
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
