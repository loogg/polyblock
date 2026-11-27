import { PROJECT_TEMPLATES } from '../../blocks/templates';
import type { MultiHandleProjectTemplate } from './types';

const tplById = (id: string) =>
  PROJECT_TEMPLATES.find((t) => t.id === id) ?? PROJECT_TEMPLATES[0];

/** L1 Starter Demo: pure-language zero-extension suite with 3 independent handles. */
export const STARTER_SUITE_DEMO: MultiHandleProjectTemplate = {
  id: 'starter_suite',
  name: '入门演示项目',
  description:
    '纯脚本环境（零外设、零定时器）：3 个独立入门句柄（每句柄唯一 on_start），分别演示顺序累加日志（main_vm）、延时与断点单步（step_debug_vm）、随机采样阈值告警（alarm_vm）。',
  language: 'lua',
  targetProfileId: 'generic-script',
  enabledCapabilities: [],
  difficulty: {
    level: 'L1',
    label: 'L1 入门 · 纯脚本',
    highlights: ['零外设纯净内核', '循环与条件', '断点单步调试'],
  },
  handles: [
    {
      name: 'main_vm',
      description: '顺序累加与日志输出句柄',
      color: '#4f46e5',
      autoStart: true,
      scripts: [
        { name: 'main', isEntry: true, workspace: tplById('demo_logger').workspace },
      ],
    },
    {
      name: 'step_debug_vm',
      description: '延时与断点单步调试句柄',
      color: '#0ea5e9',
      autoStart: false,
      scripts: [
        { name: 'main', isEntry: true, workspace: tplById('step_debug_demo').workspace },
      ],
    },
    {
      name: 'alarm_vm',
      description: '随机采样阈值告警句柄',
      color: '#10b981',
      autoStart: false,
      scripts: [
        { name: 'main', isEntry: true, workspace: tplById('threshold_alarm').workspace },
      ],
    },
  ],
};
