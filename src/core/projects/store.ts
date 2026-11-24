import { PROJECT_TEMPLATES } from '../blocks/templates';
import type {
  LegacyProjectFileV1,
  ProjectModel,
  ProjectScript,
  ScriptLanguageId,
  WorkspaceStoreState,
} from '../../types/project';

export const STORAGE_STORE_V2_KEY = 'polyblock.store.v2';
export const STORAGE_LEGACY_V1_KEY = 'polyblock.workspace.v1';

export interface MultiScriptProjectTemplate {
  id: string;
  name: string;
  description: string;
  language: ScriptLanguageId;
  enabledExtensions?: string[];
  scripts: Array<{
    name: string;
    isEntry?: boolean;
    workspace: Record<string, unknown>;
  }>;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

export function createBlankWorkspace(): Record<string, unknown> {
  return {
    blocks: {
      languageVersion: 0,
      blocks: [
        {
          type: 'poly_on_start',
          id: createId('start'),
          x: 36,
          y: 28,
        },
      ],
    },
  };
}

export function sanitizeScriptName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/\.(lua|py|polyblock\.json|json)$/i, '')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'script';
}

export function makeUniqueScriptName(
  desired: string,
  existingNames: string[],
  excludeCurrent?: string,
): string {
  const base = sanitizeScriptName(desired);
  const used = new Set(
    existingNames
      .filter((n) => n !== excludeCurrent)
      .map((n) => n.toLowerCase()),
  );
  if (!used.has(base.toLowerCase())) return base;
  let idx = 2;
  while (used.has(`${base}_${idx}`.toLowerCase())) {
    idx += 1;
  }
  return `${base}_${idx}`;
}

export function makeUniqueProjectName(
  desired: string,
  existingNames: string[],
  excludeCurrent?: string,
): string {
  const base = desired.trim() || '未命名项目';
  const used = new Set(
    existingNames
      .filter((n) => n !== excludeCurrent)
      .map((n) => n.toLowerCase()),
  );
  if (!used.has(base.toLowerCase())) return base;
  let idx = 2;
  while (used.has(`${base} (${idx})`.toLowerCase())) {
    idx += 1;
  }
  return `${base} (${idx})`;
}

const tplById = (id: string) =>
  PROJECT_TEMPLATES.find((t) => t.id === id) ?? PROJECT_TEMPLATES[0];

const VIRTUAL_BOARD_LED_WS: Record<string, unknown> = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'poly_on_start',
        id: 'vb_start_1',
        x: 36,
        y: 28,
        inputs: {
          BODY: {
            block: {
              type: 'ext_board_oled_clear',
              id: 'vb_oled_clr',
              next: {
                block: {
                  type: 'ext_board_oled',
                  id: 'vb_oled_1',
                  inputs: {
                    TEXT: {
                      block: {
                        type: 'text',
                        id: 'vb_oled_t1',
                        fields: { TEXT: 'PolyBlock Board Ready' },
                      },
                    },
                  },
                  next: {
                    block: {
                      type: 'ext_board_led',
                      id: 'vb_led_on',
                      fields: { STATE: 'true' },
                      next: {
                        block: {
                          type: 'ext_board_rgb',
                          id: 'vb_rgb_green',
                          fields: { COLOR: '#10b981' },
                          next: {
                            block: {
                              type: 'poly_wait_ms',
                              id: 'vb_wait_1',
                              inputs: {
                                MS: {
                                  shadow: {
                                    type: 'math_number',
                                    id: 'vb_ms_1',
                                    fields: { NUM: 350 },
                                  },
                                },
                              },
                              next: {
                                block: {
                                  type: 'ext_board_rgb',
                                  id: 'vb_rgb_blue',
                                  fields: { COLOR: '#3b82f6' },
                                  next: {
                                    block: {
                                      type: 'ext_board_oled',
                                      id: 'vb_oled_2',
                                      inputs: {
                                        TEXT: {
                                          block: {
                                            type: 'text',
                                            id: 'vb_oled_t2',
                                            fields: { TEXT: 'RGB => Sky Blue' },
                                          },
                                        },
                                      },
                                      next: {
                                        block: {
                                          type: 'poly_log',
                                          id: 'vb_log_done',
                                          fields: { LEVEL: 'OK' },
                                          inputs: {
                                            MESSAGE: {
                                              block: {
                                                type: 'text',
                                                id: 'vb_done_t',
                                                fields: { TEXT: '板载 LED / RGB / OLED 自检通过！' },
                                              },
                                            },
                                          },
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
  },
};

const VIRTUAL_BOARD_TEMP_WS: Record<string, unknown> = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'poly_on_start',
        id: 'vt_start',
        x: 36,
        y: 28,
        inputs: {
          BODY: {
            block: {
              type: 'ext_board_oled_clear',
              id: 'vt_clr',
              next: {
                block: {
                  type: 'variables_set',
                  id: 'vt_set_temp',
                  fields: { VAR: { id: 'var_board_temp' } },
                  inputs: {
                    VALUE: {
                      block: { type: 'ext_board_temp', id: 'vt_read_temp' },
                    },
                  },
                  next: {
                    block: {
                      type: 'poly_print_kv',
                      id: 'vt_print_temp',
                      fields: { LABEL: '当前板载温度 °C' },
                      inputs: {
                        VALUE: {
                          block: {
                            type: 'variables_get',
                            id: 'vt_get_t1',
                            fields: { VAR: { id: 'var_board_temp' } },
                          },
                        },
                      },
                      next: {
                        block: {
                          type: 'controls_if',
                          id: 'vt_if_hot',
                          extraState: { hasElse: true },
                          inputs: {
                            IF0: {
                              block: {
                                type: 'logic_compare',
                                id: 'vt_cmp',
                                fields: { OP: 'GT' },
                                inputs: {
                                  A: {
                                    block: {
                                      type: 'variables_get',
                                      id: 'vt_get_t2',
                                      fields: { VAR: { id: 'var_board_temp' } },
                                    },
                                  },
                                  B: {
                                    block: {
                                      type: 'math_number',
                                      id: 'vt_35',
                                      fields: { NUM: 35 },
                                    },
                                  },
                                },
                              },
                            },
                            DO0: {
                              block: {
                                type: 'ext_board_led',
                                id: 'vt_led_hot',
                                fields: { STATE: 'true' },
                                next: {
                                  block: {
                                    type: 'ext_board_rgb',
                                    id: 'vt_rgb_hot',
                                    fields: { COLOR: '#ef4444' },
                                    next: {
                                      block: {
                                        type: 'ext_board_oled',
                                        id: 'vt_oled_hot',
                                        inputs: {
                                          TEXT: {
                                            block: {
                                              type: 'text',
                                              id: 'vt_txt_hot',
                                              fields: { TEXT: 'ALARM: TEMP > 35C!' },
                                            },
                                          },
                                        },
                                        next: {
                                          block: {
                                            type: 'poly_log',
                                            id: 'vt_log_warn',
                                            fields: { LEVEL: 'WARN' },
                                            inputs: {
                                              MESSAGE: {
                                                block: {
                                                  type: 'text',
                                                  id: 'vt_w_txt',
                                                  fields: { TEXT: '高温告警！已点亮红色 RGB 灯' },
                                                },
                                              },
                                            },
                                          },
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                            ELSE: {
                              block: {
                                type: 'ext_board_led',
                                id: 'vt_led_ok',
                                fields: { STATE: 'false' },
                                next: {
                                  block: {
                                    type: 'ext_board_rgb',
                                    id: 'vt_rgb_ok',
                                    fields: { COLOR: '#10b981' },
                                    next: {
                                      block: {
                                        type: 'ext_board_oled',
                                        id: 'vt_oled_ok',
                                        inputs: {
                                          TEXT: {
                                            block: {
                                              type: 'text',
                                              id: 'vt_txt_ok',
                                              fields: { TEXT: 'TEMP NORMAL (OK)' },
                                            },
                                          },
                                        },
                                        next: {
                                          block: {
                                            type: 'poly_log',
                                            id: 'vt_log_ok',
                                            fields: { LEVEL: 'OK' },
                                            inputs: {
                                              MESSAGE: {
                                                block: {
                                                  type: 'text',
                                                  id: 'vt_ok_txt',
                                                  fields: { TEXT: '温度正常，绿灯待机中' },
                                                },
                                              },
                                            },
                                          },
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ],
  },
  variables: [{ name: 'temp', id: 'var_board_temp' }],
};

export const MULTI_SCRIPT_PROJECT_TEMPLATES: MultiScriptProjectTemplate[] = [
  {
    id: 'starter_suite',
    name: '入门演示项目',
    description:
      '包含 3 个可独立运行的积木脚本：主累加日志（main）、延时与断点单步演示（step_debug）、随机采样告警（threshold_alarm）。',
    language: 'lua',
    enabledExtensions: [],
    scripts: [
      { name: 'main', isEntry: true, workspace: tplById('demo_logger').workspace },
      { name: 'step_debug', workspace: tplById('step_debug_demo').workspace },
      { name: 'threshold_alarm', workspace: tplById('threshold_alarm').workspace },
    ],
  },
  {
    id: 'virtual_board_demo',
    name: '虚拟硬件联动演示项目',
    description:
      '预装「虚拟硬件外设包」，含 LED/RGB/OLED 自检（led_blink）与交互式温度告警（temp_guard），拖动右侧模拟温度滑块即可触发不同分支。',
    language: 'python',
    enabledExtensions: ['virtual-board', 'dict-json'],
    scripts: [
      { name: 'led_blink', isEntry: true, workspace: VIRTUAL_BOARD_LED_WS },
      { name: 'temp_guard', workspace: VIRTUAL_BOARD_TEMP_WS },
    ],
  },
  {
    id: 'data_lab',
    name: '列表与逻辑练习项目',
    description:
      '演示多脚本项目组织：列表动态追加统计（list_stats）与延时循环监控（monitor）。',
    language: 'python',
    enabledExtensions: ['dict-json'],
    scripts: [
      { name: 'list_stats', isEntry: true, workspace: tplById('list_stats').workspace },
      { name: 'monitor', workspace: tplById('step_debug_demo').workspace },
    ],
  },
  {
    id: 'blank_project',
    name: '空白项目',
    description: '仅包含一个干净的 main 入口脚本，适合从零搭建自己的多脚本工程。',
    language: 'lua',
    enabledExtensions: [],
    scripts: [{ name: 'main', isEntry: true, workspace: createBlankWorkspace() }],
  },
];

export function instantiateProjectFromTemplate(
  templateId: string,
  existingProjectNames: string[] = [],
  customName?: string,
): ProjectModel {
  const tpl =
    MULTI_SCRIPT_PROJECT_TEMPLATES.find((t) => t.id === templateId) ??
    MULTI_SCRIPT_PROJECT_TEMPLATES[0];
  const now = new Date().toISOString();

  const scripts: ProjectScript[] = tpl.scripts.map((s) => ({
    id: createId('scr'),
    name: sanitizeScriptName(s.name),
    workspace: cloneJson(s.workspace),
    breakpoints: [],
    updatedAt: now,
  }));

  const entryIdx = Math.max(
    0,
    tpl.scripts.findIndex((s) => s.isEntry),
  );
  const entryId = scripts[entryIdx]?.id ?? scripts[0].id;

  return {
    format: 'polyblock-project',
    version: 2,
    id: createId('proj'),
    name: makeUniqueProjectName(customName ?? tpl.name, existingProjectNames),
    description: tpl.description,
    language: tpl.language,
    enabledExtensions: [...(tpl.enabledExtensions ?? [])],
    entryScriptId: entryId,
    activeScriptId: entryId,
    scripts,
    createdAt: now,
    updatedAt: now,
  };
}

export function parseImportedProject(
  raw: unknown,
  fallbackName: string,
  existingProjectNames: string[] = [],
): ProjectModel {
  if (!raw || typeof raw !== 'object') {
    throw new Error('工程文件格式无效');
  }
  const obj = raw as Record<string, unknown>;
  const now = new Date().toISOString();

  // v2 Multi-Script project
  if (obj.version === 2 && Array.isArray(obj.scripts) && obj.scripts.length > 0) {
    const rawScripts = obj.scripts as Array<Record<string, unknown>>;
    const usedNames: string[] = [];
    const scripts: ProjectScript[] = rawScripts.map((rs, idx) => {
      const uniqueName = makeUniqueScriptName(
        typeof rs.name === 'string' ? rs.name : idx === 0 ? 'main' : `script_${idx + 1}`,
        usedNames,
      );
      usedNames.push(uniqueName);
      return {
        id: createId('scr'),
        name: uniqueName,
        workspace:
          rs.workspace && typeof rs.workspace === 'object'
            ? cloneJson(rs.workspace as Record<string, unknown>)
            : createBlankWorkspace(),
        breakpoints: Array.isArray(rs.breakpoints)
          ? rs.breakpoints.filter((b): b is string => typeof b === 'string')
          : [],
        updatedAt: typeof rs.updatedAt === 'string' ? rs.updatedAt : now,
      };
    });

    const origEntryIdx = rawScripts.findIndex((rs) => rs.id === obj.entryScriptId);
    const entryId = scripts[origEntryIdx >= 0 ? origEntryIdx : 0].id;

    return {
      format: 'polyblock-project',
      version: 2,
      id: createId('proj'),
      name: makeUniqueProjectName(
        typeof obj.name === 'string' && obj.name.trim() ? obj.name : fallbackName,
        existingProjectNames,
      ),
      description: typeof obj.description === 'string' ? obj.description : undefined,
      language: obj.language === 'python' ? 'python' : 'lua',
      enabledExtensions: Array.isArray(obj.enabledExtensions)
        ? obj.enabledExtensions.filter((e): e is string => typeof e === 'string')
        : [],
      entryScriptId: entryId,
      activeScriptId: entryId,
      scripts,
      createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : now,
      updatedAt: now,
    };
  }

  // Legacy v1 single-canvas project -> upgrade seamlessly to v2
  const v1 = obj as unknown as LegacyProjectFileV1;
  if (!v1.workspace || typeof v1.workspace !== 'object') {
    throw new Error('缺少 scripts 或 workspace 数据');
  }

  const cleanProjName = (v1.name || fallbackName)
    .replace(/\.polyblock\.json$|\.json$/i, '')
    .trim();
  const scriptId = createId('scr');

  return {
    format: 'polyblock-project',
    version: 2,
    id: createId('proj'),
    name: makeUniqueProjectName(cleanProjName || '导入项目', existingProjectNames),
    description: '由 v1 单脚本工程自动升级导入',
    language: v1.language === 'python' ? 'python' : 'lua',
    enabledExtensions: [],
    entryScriptId: scriptId,
    activeScriptId: scriptId,
    scripts: [
      {
        id: scriptId,
        name: 'main',
        workspace: cloneJson(v1.workspace),
        breakpoints: [],
        updatedAt: v1.updatedAt || now,
      },
    ],
    createdAt: v1.updatedAt || now,
    updatedAt: now,
  };
}

export function getActiveProject(store: WorkspaceStoreState): ProjectModel {
  return (
    store.projects.find((p) => p.id === store.activeProjectId) ?? store.projects[0]
  );
}

export function getActiveScript(project: ProjectModel): ProjectScript {
  return (
    project.scripts.find((s) => s.id === project.activeScriptId) ??
    project.scripts[0]
  );
}

export function loadWorkspaceStore(): WorkspaceStoreState {
  try {
    const rawV2 = localStorage.getItem(STORAGE_STORE_V2_KEY);
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as WorkspaceStoreState;
      if (
        parsed &&
        parsed.version === 2 &&
        Array.isArray(parsed.projects) &&
        parsed.projects.length > 0 &&
        parsed.projects.every(
          (p) => Array.isArray(p.scripts) && p.scripts.length > 0,
        )
      ) {
        return parsed;
      }
    }
  } catch {
    // fall through to migration / default
  }

  // Try migrating v1 workspace if user had edited blocks previously
  const starter = instantiateProjectFromTemplate('starter_suite');
  try {
    const rawV1 = localStorage.getItem(STORAGE_LEGACY_V1_KEY);
    if (rawV1) {
      const parsedV1 = JSON.parse(rawV1) as LegacyProjectFileV1;
      if (parsedV1 && parsedV1.workspace && typeof parsedV1.workspace === 'object') {
        const migrated = parseImportedProject(parsedV1, '历史项目', [starter.name]);
        return {
          version: 2,
          activeProjectId: starter.id,
          projects: [starter, migrated],
        };
      }
    }
  } catch {
    // ignore invalid v1 cache
  }

  return {
    version: 2,
    activeProjectId: starter.id,
    projects: [starter],
  };
}

export function saveWorkspaceStore(store: WorkspaceStoreState): void {
  try {
    localStorage.setItem(STORAGE_STORE_V2_KEY, JSON.stringify(store));
  } catch {
    // ignore storage quota errors
  }
}

/* ============================================================================
   Pure Immutable Store Reducers (Unit-Tested)
   ============================================================================ */
export function updateProjectById(
  store: WorkspaceStoreState,
  projectId: string,
  updater: (project: ProjectModel) => ProjectModel,
): WorkspaceStoreState {
  return {
    ...store,
    projects: store.projects.map((p) =>
      p.id === projectId ? updater(p) : p,
    ),
  };
}

export function addScriptToProject(
  project: ProjectModel,
  desiredName?: string,
  workspace?: Record<string, unknown>,
): ProjectModel {
  const now = new Date().toISOString();
  const baseName = desiredName ?? `script_${project.scripts.length + 1}`;
  const uniqueName = makeUniqueScriptName(
    baseName,
    project.scripts.map((s) => s.name),
  );
  const newScript: ProjectScript = {
    id: createId('scr'),
    name: uniqueName,
    workspace: workspace ? cloneJson(workspace) : createBlankWorkspace(),
    breakpoints: [],
    updatedAt: now,
  };
  return {
    ...project,
    activeScriptId: newScript.id,
    scripts: [...project.scripts, newScript],
    updatedAt: now,
  };
}

export function renameScriptInProject(
  project: ProjectModel,
  scriptId: string,
  nextName: string,
): ProjectModel {
  const target = project.scripts.find((s) => s.id === scriptId);
  if (!target) return project;
  const unique = makeUniqueScriptName(
    nextName,
    project.scripts.map((s) => s.name),
    target.name,
  );
  const now = new Date().toISOString();
  return {
    ...project,
    scripts: project.scripts.map((s) =>
      s.id === scriptId ? { ...s, name: unique, updatedAt: now } : s,
    ),
    updatedAt: now,
  };
}

export function duplicateScriptInProject(
  project: ProjectModel,
  scriptId: string,
): ProjectModel {
  const target = project.scripts.find((s) => s.id === scriptId);
  if (!target) return project;
  const now = new Date().toISOString();
  const unique = makeUniqueScriptName(
    `${target.name}_copy`,
    project.scripts.map((s) => s.name),
  );
  const copy: ProjectScript = {
    id: createId('scr'),
    name: unique,
    workspace: cloneJson(target.workspace),
    breakpoints: [...target.breakpoints],
    updatedAt: now,
  };
  const idx = project.scripts.findIndex((s) => s.id === scriptId);
  const nextScripts = [...project.scripts];
  nextScripts.splice(idx + 1, 0, copy);
  return {
    ...project,
    activeScriptId: copy.id,
    scripts: nextScripts,
    updatedAt: now,
  };
}

export function deleteScriptFromProject(
  project: ProjectModel,
  scriptId: string,
): ProjectModel {
  if (project.scripts.length <= 1) return project;
  const idx = project.scripts.findIndex((s) => s.id === scriptId);
  if (idx === -1) return project;

  const nextScripts = project.scripts.filter((s) => s.id !== scriptId);
  const fallback = nextScripts[Math.max(0, idx - 1)] ?? nextScripts[0];
  const now = new Date().toISOString();

  return {
    ...project,
    activeScriptId:
      project.activeScriptId === scriptId ? fallback.id : project.activeScriptId,
    entryScriptId:
      project.entryScriptId === scriptId ? fallback.id : project.entryScriptId,
    scripts: nextScripts,
    updatedAt: now,
  };
}

export function duplicateProjectInStore(
  store: WorkspaceStoreState,
  projectId: string,
): WorkspaceStoreState {
  const target = store.projects.find((p) => p.id === projectId);
  if (!target) return store;
  const now = new Date().toISOString();
  const scriptIdMap = new Map<string, string>();
  const clonedScripts: ProjectScript[] = target.scripts.map((s) => {
    const newId = createId('scr');
    scriptIdMap.set(s.id, newId);
    return {
      ...cloneJson(s),
      id: newId,
      updatedAt: now,
    };
  });

  const copy: ProjectModel = {
    ...target,
    id: createId('proj'),
    name: makeUniqueProjectName(
      `${target.name} 副本`,
      store.projects.map((p) => p.name),
    ),
    enabledExtensions: [...target.enabledExtensions],
    entryScriptId: scriptIdMap.get(target.entryScriptId) ?? clonedScripts[0].id,
    activeScriptId: scriptIdMap.get(target.activeScriptId) ?? clonedScripts[0].id,
    scripts: clonedScripts,
    createdAt: now,
    updatedAt: now,
  };

  return {
    ...store,
    activeProjectId: copy.id,
    projects: [copy, ...store.projects],
  };
}

export function deleteProjectFromStore(
  store: WorkspaceStoreState,
  projectId: string,
): WorkspaceStoreState {
  if (store.projects.length <= 1) return store;
  const nextProjects = store.projects.filter((p) => p.id !== projectId);
  const nextActive =
    store.activeProjectId === projectId
      ? nextProjects[0].id
      : store.activeProjectId;
  return {
    ...store,
    activeProjectId: nextActive,
    projects: nextProjects,
  };
}
