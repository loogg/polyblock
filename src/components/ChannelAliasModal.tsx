import { Tag, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useModalFocusTrap } from '../hooks/useModalFocusTrap';

interface ChannelAliasModalProps {
  handleName: string;
  handleColor: string;
  channelId: number;
  prefix?: string;
  poolLabel?: string;
  currentAlias: string;
  onSave: (alias: string) => void;
  onClose: () => void;
}

export function ChannelAliasModal({
  handleName,
  handleColor,
  channelId,
  prefix = 'CH',
  poolLabel = '通道',
  currentAlias,
  onSave,
  onClose,
}: ChannelAliasModalProps) {
  const [draft, setDraft] = useState(currentAlias);
  const modalRef = useRef<HTMLDivElement | null>(null);

  useModalFocusTrap(modalRef, true);

  useEffect(() => {
    setDraft(currentAlias);
  }, [channelId, currentAlias]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const commit = () => {
    onSave(draft.trim());
    onClose();
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`设置${poolLabel} ${prefix}${channelId} 别名`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-shell alias-modal" ref={modalRef} tabIndex={-1}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Tag size={15} style={{ color: 'var(--accent)' }} />
            <span className="modal-title">
              设置{poolLabel} {prefix}
              {channelId} 别名
            </span>
          </div>
          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            aria-label="关闭"
            style={{ padding: '3px 5px' }}
          >
            <X size={14} />
          </button>
        </div>

        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
            <span>所属句柄：</span>
            <span className="var-chip">
              <span className="lang-dot" style={{ background: handleColor }} />
              <strong>{handleName}</strong>
            </span>
            <span className="count-badge">通道 ID {channelId}</span>
          </div>

          <input
            type="text"
            aria-label="就地通道别名输入"
            className="dropdown-rename-input"
            style={{ width: '100%', height: 34, fontSize: 13 }}
            placeholder="输入可读别名（如：心跳灯），留空即清除"
            maxLength={16}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
            }}
          />

          <p className="settings-hint" style={{ margin: 0 }}>
            仅作用于当前句柄的「{poolLabel}」画布下拉显示与代码尾注，导出脚本始终使用纯整数 ID（<code>{channelId}</code>），与其他通道池及句柄完全隔离。
          </p>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            {currentAlias && (
              <button
                type="button"
                className="btn-ghost"
                style={{ color: 'var(--danger)', marginRight: 'auto' }}
                onClick={() => {
                  onSave('');
                  onClose();
                }}
              >
                清除别名
              </button>
            )}
            <button type="button" className="btn-outline" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn-primary" onClick={commit}>
              确定并同步画布
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
