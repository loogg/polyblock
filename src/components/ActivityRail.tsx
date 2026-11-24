import {
  Blocks,
  Cpu,
  FolderKanban,
  Puzzle,
  Settings,
} from 'lucide-react';
import type { PageId } from '../types/project';

interface ActivityRailProps {
  activePage: PageId;
  onSelectPage: (page: PageId) => void;
}

const TOP_ITEMS: Array<{
  id: PageId;
  label: string;
  title: string;
  Icon: typeof Blocks;
  badge?: boolean;
}> = [
  { id: 'blocks', label: '编程', title: '积木编程工作台', Icon: Blocks },
  { id: 'projects', label: '项目', title: '项目管理与模板', Icon: FolderKanban },
  { id: 'devices', label: '设备', title: '执行目标与设备下载', Icon: Cpu, badge: true },
  { id: 'extensions', label: '扩展', title: '扩展积木与脚本后端', Icon: Puzzle },
];

export function ActivityRail({ activePage, onSelectPage }: ActivityRailProps) {
  return (
    <aside className="activity-rail" aria-label="主导航栏">
      <div className="rail-group">
        {TOP_ITEMS.map(({ id, label, title, Icon, badge }) => (
          <button
            key={id}
            type="button"
            className={`rail-item ${activePage === id ? 'active' : ''}`}
            onClick={() => onSelectPage(id)}
            title={title}
            aria-label={title}
            aria-current={activePage === id ? 'page' : undefined}
          >
            <Icon size={17} strokeWidth={2} />
            <span className="rail-label">{label}</span>
            {badge && <span className="rail-badge-dot" aria-hidden="true" />}
          </button>
        ))}
      </div>

      <div className="rail-group">
        <button
          type="button"
          className={`rail-item ${activePage === 'settings' ? 'active' : ''}`}
          onClick={() => onSelectPage('settings')}
          title="环境与设置"
          aria-label="环境与设置"
          aria-current={activePage === 'settings' ? 'page' : undefined}
        >
          <Settings size={17} strokeWidth={2} />
          <span className="rail-label">设置</span>
        </button>
      </div>
    </aside>
  );
}
