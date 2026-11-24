import { ArrowLeft, RotateCcw } from 'lucide-react';
import type { AppSettings } from '../../types/project';

interface SettingsPageProps {
  settings: AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onResetWorkspace: () => void;
  onReturnToBlocks: () => void;
}

export function SettingsPage({
  settings,
  onUpdateSettings,
  onResetWorkspace,
  onReturnToBlocks,
}: SettingsPageProps) {
  return (
    <div className="subpage-wrap">
      <div className="subpage-inner" style={{ maxWidth: 740 }}>
        <div className="subpage-header">
          <div>
            <h1 className="subpage-title">环境与偏好设置</h1>
            <p className="subpage-sub">
              调整界面外观、WASM 沙箱死循环超时保护及工作区行为，配置自动保存在本地浏览器。
            </p>
          </div>
          <button type="button" className="btn-outline" onClick={onReturnToBlocks}>
            <ArrowLeft size={14} />
            <span>返回编程画布</span>
          </button>
        </div>

        <div className="setting-row">
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>界面主题风格</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              切换 MicroBlocks 浅色工作台或深色护眼主题（同步应用到 Blockly 画布）
            </div>
          </div>
          <div className="seg-control">
            <button
              type="button"
              className={`seg-btn ${settings.theme === 'light' ? 'active' : ''}`}
              onClick={() => onUpdateSettings({ theme: 'light' })}
            >
              浅色
            </button>
            <button
              type="button"
              className={`seg-btn ${settings.theme === 'dark' ? 'active' : ''}`}
              onClick={() => onUpdateSettings({ theme: 'dark' })}
            >
              深色
            </button>
          </div>
        </div>

        <div className="setting-row">
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>默认执行高亮速度</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              控制沙箱逐块联动高亮的节奏（选择「极速」时不额外停顿，但仍会在断点处暂停）
            </div>
          </div>
          <select
            className="template-select"
            value={settings.executionSpeed}
            onChange={(e) =>
              onUpdateSettings({
                executionSpeed: e.target.value as AppSettings['executionSpeed'],
              })
            }
          >
            <option value="normal">正常（每步 180ms）</option>
            <option value="slow">慢放（每步 450ms）</option>
            <option value="fast">极速（0ms 无停顿）</option>
          </select>
        </div>

        <div className="setting-row">
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>沙箱执行超时保护</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              遇到死循环时自动终止 Web Worker 并恢复沙箱，避免页面卡死
            </div>
          </div>
          <select
            className="template-select"
            value={settings.timeoutMs}
            onChange={(e) =>
              onUpdateSettings({ timeoutMs: Number(e.target.value) })
            }
          >
            <option value={2000}>2 秒（快速保护）</option>
            <option value={5000}>5 秒（推荐默认）</option>
            <option value={10000}>10 秒</option>
            <option value={30000}>30 秒</option>
          </select>
        </div>

        <div className="setting-row">
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>运行时自动展开打印日志台</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              点击顶部「运行」时若日志台处于收起状态，自动展开方便实时观察输出
            </div>
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings.autoOpenConsoleOnRun}
              onChange={(e) =>
                onUpdateSettings({ autoOpenConsoleOnRun: e.target.checked })
              }
            />
            <span>{settings.autoOpenConsoleOnRun ? '已开启' : '已关闭'}</span>
          </label>
        </div>

        <div className="setting-row">
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>重置默认示例画布</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              清除本地缓存并恢复“日志打印与循环累加”默认示例工作区
            </div>
          </div>
          <button
            type="button"
            className="btn-outline"
            onClick={onResetWorkspace}
          >
            <RotateCcw size={13} />
            <span>恢复默认示例</span>
          </button>
        </div>
      </div>
    </div>
  );
}
