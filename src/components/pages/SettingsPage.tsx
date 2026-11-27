import { ArrowLeft, RotateCcw } from 'lucide-react';
import type { AppSettings, ExecutionSpeedId } from '../../types/project';
import { PolySelect } from '../PolySelect';

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
          <PolySelect<ExecutionSpeedId>
            size="md"
            ariaLabel="默认执行高亮速度"
            value={settings.executionSpeed}
            minPopoverWidth={190}
            options={[
              { value: 'normal', label: '正常（每步 180ms）' },
              { value: 'slow', label: '慢放（每步 450ms）' },
              { value: 'fast', label: '极速（0ms 无停顿）' },
            ]}
            onChange={(val) => onUpdateSettings({ executionSpeed: val })}
          />
        </div>

        <div className="setting-row">
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              <code>on_start</code> 协程时间片（抢占让出）
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              当 <code>on_start</code> 内存在死循环或长计算且未调用 <code>sleep_ms</code> 时，每连续运行满该时间片即自动让出给事件调度器（防止阻塞事件响应）
            </div>
          </div>
          <PolySelect
            size="md"
            ariaLabel="on_start 协程时间片"
            value={String(settings.timeSliceMs)}
            minPopoverWidth={186}
            options={[
              { value: '10', label: '10 ms（高频响应）' },
              { value: '20', label: '20 ms（推荐默认）' },
              { value: '50', label: '50 ms' },
              { value: '100', label: '100 ms（长计算优先）' },
            ]}
            onChange={(val) => onUpdateSettings({ timeSliceMs: Number(val) })}
          />
        </div>

        <div className="setting-row">
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>单次事件回调 / 阻塞超时保护</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              仅限制单次事件回调（<code>on_run</code> / <code>on_timer</code> / <code>on_button</code>）或纯同步计算的连续耗时，不影响常驻事件循环与 <code>on_start</code> 协程的长期运行
            </div>
          </div>
          <PolySelect
            size="md"
            ariaLabel="单次事件回调超时保护"
            value={String(settings.timeoutMs)}
            minPopoverWidth={180}
            options={[
              { value: '2000', label: '2 秒（快速保护）' },
              { value: '5000', label: '5 秒（推荐默认）' },
              { value: '10000', label: '10 秒' },
              { value: '30000', label: '30 秒' },
            ]}
            onChange={(val) => onUpdateSettings({ timeoutMs: Number(val) })}
          />
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
              清除本地缓存并恢复全部内置成品演示项目
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
