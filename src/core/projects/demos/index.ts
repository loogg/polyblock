import { EVENT_TIMER_DEMO } from './eventTimerDemo';
import { FLAGSHIP_ROBOT_DEMO } from './flagshipRobotDemo';
import { STARTER_SUITE_DEMO } from './starterSuite';
import {
  createBlankWorkspace,
  type HandleTemplateSpec,
  type MultiHandleProjectTemplate,
  type ProjectDifficultyMeta,
} from './types';
import { VIRTUAL_BOARD_DEMO } from './virtualBoardDemo';

export type {
  HandleTemplateSpec,
  MultiHandleProjectTemplate,
  ProjectDifficultyMeta,
};
export { createBlankWorkspace };

export const BLANK_PROJECT_TEMPLATE: MultiHandleProjectTemplate = {
  id: 'blank_project',
  name: '空白项目',
  description:
    '纯脚本环境空白工程（无定时器/无预设外设），后续可在项目配置中按需勾选目标板型与能力包。',
  language: 'lua',
  targetProfileId: 'generic-script',
  enabledCapabilities: [],
  hiddenFromDemoList: true,
  handles: [
    {
      name: 'main_vm',
      color: '#4f46e5',
      autoStart: true,
      scripts: [{ name: 'main', isEntry: true, workspace: createBlankWorkspace() }],
    },
  ],
};

export const MULTI_SCRIPT_PROJECT_TEMPLATES: MultiHandleProjectTemplate[] = [
  STARTER_SUITE_DEMO,
  VIRTUAL_BOARD_DEMO,
  EVENT_TIMER_DEMO,
  FLAGSHIP_ROBOT_DEMO,
  BLANK_PROJECT_TEMPLATE,
];

/** Curated 4-tier progressive showcase templates (L1 Simple -> L4 Full-Stack Flagship). */
export const DEMO_PROJECT_TEMPLATES: MultiHandleProjectTemplate[] =
  MULTI_SCRIPT_PROJECT_TEMPLATES.filter((t) => !t.hiddenFromDemoList);
