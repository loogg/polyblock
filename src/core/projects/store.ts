import { PROJECT_TEMPLATES } from '../blocks/templates';
import {
  DEFAULT_TIMER_COUNT,
  MAX_TIMER_COUNT,
  MIN_TIMER_COUNT,
  normalizeTimerConfig,
} from '../blocks/timerConfigBridge';
import {
  CAP_RT_LIFECYCLE,
  CAP_RT_TIMERS,
  CAP_VIRTUAL_BOARD,
  targetProfileRegistry,
} from '../capabilities/registry';
import {
  extensionRegistry,
  validateExtensionPack,
} from '../extensions/registry';
import type {
  HandleChannelPoolSpec,
  PolyExtensionPack,
} from '../extensions/types';
import {
  FLAGSHIP_DRIVE_CTRL_WS,
  FLAGSHIP_PATROL_TEST_WS,
  FLAGSHIP_PWM_SERVO_PACK,
  FLAGSHIP_ROBOT_DRIVE_PACK,
  FLAGSHIP_SENSOR_GUARD_WS,
  FLAGSHIP_TELEMETRY_HUB_WS,
  MEDIUM_DICT_CONFIG_WS,
} from './flagshipDemo';
import type {
  LegacyProjectFileV1,
  LegacyProjectModelV2,
  ProjectModel,
  ProjectScript,
  ProjectTimerConfig,
  RuntimeHandle,
  ScriptLanguageId,
  TargetProfile,
  WorkspaceStoreState,
} from '../../types/project';

export const STORAGE_STORE_V3_KEY = 'polyblock.store.v3';
export const STORAGE_STORE_V2_KEY = 'polyblock.store.v2';
export const STORAGE_LEGACY_V1_KEY = 'polyblock.workspace.v1';

export const HANDLE_COLOR_PALETTE = [
  '#4f46e5',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#8b5cf6',
];

export interface HandleTemplateSpec {
  name: string;
  description?: string;
  color?: string;
  autoStart?: boolean;
  timerConfig?: Partial<ProjectTimerConfig>;
  /** Additional per-handle channel pool configs (e.g. `pwm-servo` isolated from `rt-timers`). */
  capabilityConfigs?: Record<string, Partial<ProjectTimerConfig>>;
  scripts: Array<{
    name: string;
    isEntry?: boolean;
    workspace: Record<string, unknown>;
  }>;
}

export interface ProjectDifficultyMeta {
  level: 'L1' | 'L2' | 'L3' | 'L4';
  label: string;
  highlights: string[];
}

export interface MultiHandleProjectTemplate {
  id: string;
  name: string;
  description: string;
  language: ScriptLanguageId;
  targetProfileId: string;
  defaultTimerCount?: number;
  enabledCapabilities: string[];
  /** Optional project-embedded custom .polyext.json packs shipped with this template. */
  localExtensions?: PolyExtensionPack[];
  /** Progressive difficulty tier badge & feature highlights displayed in ProjectsPage. */
  difficulty?: ProjectDifficultyMeta;
  /** Internal templates (like blank_project) that have dedicated UI buttons instead of demo cards. */
  hiddenFromDemoList?: boolean;
  handles: HandleTemplateSpec[];
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

export function sanitizeHandleName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'handle';
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

export function makeUniqueHandleName(
  desired: string,
  existingNames: string[],
  excludeCurrent?: string,
): string {
  const base = sanitizeHandleName(desired);
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

export function getHandleChannelPoolConfig(
  handle: RuntimeHandle,
  configKey: string,
  fallbackCount = DEFAULT_TIMER_COUNT,
  minCount = MIN_TIMER_COUNT,
  maxCount = MAX_TIMER_COUNT,
): ProjectTimerConfig {
  const fromCap = handle.capabilityConfigs?.[configKey] as
    | Partial<ProjectTimerConfig>
    | undefined;
  const legacy =
    configKey === CAP_RT_TIMERS
      ? (handle as unknown as { timerConfig?: Partial<ProjectTimerConfig> }).timerConfig
      : undefined;
  return normalizeTimerConfig(fromCap ?? legacy, fallbackCount, minCount, maxCount);
}

export function setHandleChannelPoolConfig(
  handle: RuntimeHandle,
  configKey: string,
  nextCfg: ProjectTimerConfig,
  minCount = MIN_TIMER_COUNT,
  maxCount = MAX_TIMER_COUNT,
): RuntimeHandle {
  return {
    ...handle,
    capabilityConfigs: {
      ...(handle.capabilityConfigs ?? {}),
      [configKey]: normalizeTimerConfig(nextCfg, nextCfg.count, minCount, maxCount),
    },
    updatedAt: new Date().toISOString(),
  };
}

export function getAllHandleChannelPoolConfigs(
  handle: RuntimeHandle,
  channelPoolPacks: PolyExtensionPack[],
  defaultTimerCount = DEFAULT_TIMER_COUNT,
): Record<string, ProjectTimerConfig> {
  const out: Record<string, ProjectTimerConfig> = {
    [CAP_RT_TIMERS]: getHandleTimerConfig(handle, defaultTimerCount),
  };
  for (const pack of channelPoolPacks) {
    const pool: HandleChannelPoolSpec | undefined = pack.handleChannelPool;
    if (!pool) continue;
    const fallback =
      pool.configKey === CAP_RT_TIMERS ? defaultTimerCount : pool.defaultCount;
    out[pool.configKey] = getHandleChannelPoolConfig(
      handle,
      pool.configKey,
      fallback,
      pool.min,
      pool.max,
    );
  }
  return out;
}

export function getHandleTimerConfig(
  handle: RuntimeHandle,
  fallbackCount = DEFAULT_TIMER_COUNT,
): ProjectTimerConfig {
  return getHandleChannelPoolConfig(handle, CAP_RT_TIMERS, fallbackCount);
}

export function setHandleTimerConfig(
  handle: RuntimeHandle,
  nextCfg: ProjectTimerConfig,
): RuntimeHandle {
  return setHandleChannelPoolConfig(handle, CAP_RT_TIMERS, nextCfg);
}

function normalizeLocalExtensions(raw: unknown): PolyExtensionPack[] {
  if (!Array.isArray(raw)) return [];
  const map = new Map<string, PolyExtensionPack>();
  for (const item of raw) {
    try {
      const valid = validateExtensionPack(item);
      map.set(valid.id, { ...valid, builtin: false });
    } catch {
      // ignore malformed extension entry
    }
  }
  return Array.from(map.values());
}

/**
 * Prepares a portable .polyblock.json export payload:
 * - Preserves project-embedded `localExtensions`.
 * - Auto-snapshots any non-builtin GLOBAL packs referenced in `enabledCapabilities`
 *   into `bundledExtensions` so recipients open the project out-of-the-box.
 */
export function buildExportableProjectJson(
  project: ProjectModel,
  globalPacks: PolyExtensionPack[] = extensionRegistry.listAll(),
): ProjectModel {
  const localPacks = project.localExtensions ?? [];
  const localIds = new Set(localPacks.map((p) => p.id));
  const bundled: PolyExtensionPack[] = [];

  for (const capId of project.enabledCapabilities) {
    if (localIds.has(capId)) continue;
    const globalPack = globalPacks.find((p) => p.id === capId);
    if (globalPack && !globalPack.builtin) {
      bundled.push(cloneJson({ ...globalPack, builtin: false }));
    }
  }

  const base: ProjectModel = cloneJson(project);
  delete base.bundledExtensions;
  if (localPacks.length > 0) {
    base.localExtensions = cloneJson(localPacks);
  } else {
    delete base.localExtensions;
  }
  if (bundled.length > 0) {
    base.bundledExtensions = bundled;
  }
  return base;
}

/**
 * Computes which bundled global snapshots in an imported JSON should be absorbed
 * unconditionally as project-local embedded packs:
 * - Always absorb every bundled pack not already present in `localExtensions`
 *   (regardless of whether the recipient's global library has the same ID/version,
 *   because two files with the same ID+version can still have different block definitions).
 * - Guarantees 100% deterministic reproduction with zero global-library pollution;
 *   the user can remove the local override at any time to fall back to their global pack.
 */
export function getAbsorbedBundledExtensions(
  raw: unknown,
): PolyExtensionPack[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const localIds = new Set(normalizeLocalExtensions(obj.localExtensions).map((p) => p.id));
  return normalizeLocalExtensions(obj.bundledExtensions).filter(
    (p) => !localIds.has(p.id),
  );
}

export function applyTargetProfileToProject(
  project: ProjectModel,
  profile: TargetProfile,
): ProjectModel {
  const now = new Date().toISOString();
  return {
    ...project,
    targetProfileId: profile.id,
    enabledCapabilities: [...profile.capabilities],
    defaultTimerCount: profile.defaultTimerCount || DEFAULT_TIMER_COUNT,
    updatedAt: now,
  };
}

function inferCapabilitiesFromWorkspaces(
  workspaces: Array<Record<string, unknown>>,
): string[] {
  const raw = JSON.stringify(workspaces);
  const inferred = new Set<string>();
  if (
    raw.includes('"poly_on_run"') ||
    raw.includes('"poly_on_stop"') ||
    raw.includes('"poly_set_run_period"') ||
    raw.includes('"poly_run_control"')
  ) {
    inferred.add(CAP_RT_LIFECYCLE);
  }
  if (
    raw.includes('"poly_on_timer"') ||
    raw.includes('"poly_start_timer"') ||
    raw.includes('"poly_stop_timer"') ||
    raw.includes('"poly_get_timer_value"') ||
    raw.includes('"poly_is_timer_running"')
  ) {
    inferred.add(CAP_RT_TIMERS);
  }
  if (raw.includes('"poly_on_button"') || raw.includes('"ext_board_')) {
    inferred.add(CAP_VIRTUAL_BOARD);
  }
  return Array.from(inferred);
}

function inferProfileId(caps: string[]): string {
  const hasRt = caps.includes(CAP_RT_LIFECYCLE) || caps.includes(CAP_RT_TIMERS);
  const hasVb = caps.includes(CAP_VIRTUAL_BOARD);
  if (hasRt && hasVb) return 'virtual-board-rt';
  if (hasRt) return 'embedded-rt';
  if (hasVb) return 'virtual-board-basic';
  return 'generic-script';
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
                                            fields: { TEXT: 'TriColor => Blue' },
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
                                                fields: { TEXT: '板载 LED / 三色灯 / OLED 自检通过！' },
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
                          id: 'vt_if_high',
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
                                id: 'vt_led_hi',
                                fields: { STATE: 'true' },
                                next: {
                                  block: {
                                    type: 'ext_board_rgb',
                                    id: 'vt_rgb_hi',
                                    fields: { COLOR: '#ef4444' },
                                    next: {
                                      block: {
                                        type: 'ext_board_oled',
                                        id: 'vt_oled_hi',
                                        inputs: {
                                          TEXT: {
                                            block: {
                                              type: 'text',
                                              id: 'vt_hi_txt',
                                              fields: { TEXT: 'ALARM: TEMP > 35C!' },
                                            },
                                          },
                                        },
                                        next: {
                                          block: {
                                            type: 'poly_log',
                                            id: 'vt_log_hi',
                                            fields: { LEVEL: 'WARN' },
                                            inputs: {
                                              MESSAGE: {
                                                block: {
                                                  type: 'text',
                                                  id: 'vt_warn_txt',
                                                  fields: {
                                                    TEXT: '高温告警！已点亮板载三色灯（红）',
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
                                              id: 'vt_ok_oled',
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

const EVENT_LOOP_MAIN_WS: Record<string, unknown> = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'poly_on_start',
        id: 'ev_start',
        x: 36,
        y: 28,
        inputs: {
          BODY: {
            block: {
              type: 'variables_set',
              id: 'ev_init_led',
              fields: { VAR: { id: 'var_ev_led' } },
              inputs: {
                VALUE: {
                  block: {
                    type: 'logic_boolean',
                    id: 'ev_false',
                    fields: { BOOL: 'FALSE' },
                  },
                },
              },
              next: {
                block: {
                  type: 'variables_set',
                  id: 'ev_init_ticks',
                  fields: { VAR: { id: 'var_ev_ticks' } },
                  inputs: {
                    VALUE: {
                      block: {
                        type: 'math_number',
                        id: 'ev_zero',
                        fields: { NUM: 0 },
                      },
                    },
                  },
                  next: {
                    block: {
                      type: 'ext_board_oled_clear',
                      id: 'ev_oled_clr',
                      next: {
                        block: {
                          type: 'ext_board_oled',
                          id: 'ev_oled_ready',
                          inputs: {
                            TEXT: {
                              block: {
                                type: 'text',
                                id: 'ev_ready_txt',
                                fields: { TEXT: 'Event Loop Ready' },
                              },
                            },
                          },
                          next: {
                            block: {
                              type: 'poly_start_timer',
                              id: 'ev_start_t0',
                              fields: { TIMER_ID: '0' },
                              inputs: {
                                PERIOD_MS: {
                                  shadow: {
                                    type: 'math_number',
                                    id: 'ev_t0_ms',
                                    fields: { NUM: 500 },
                                  },
                                },
                                REPEAT: {
                                  shadow: {
                                    type: 'math_number',
                                    id: 'ev_t0_rep',
                                    fields: { NUM: 0 },
                                  },
                                },
                              },
                              next: {
                                block: {
                                  type: 'poly_log',
                                  id: 'ev_start_log',
                                  fields: { LEVEL: 'INFO' },
                                  inputs: {
                                    MESSAGE: {
                                      block: {
                                        type: 'text',
                                        id: 'ev_start_msg',
                                        fields: {
                                          TEXT: '事件循环启动：T0心跳 / on_run监控',
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
      {
        type: 'poly_on_run',
        id: 'ev_on_run',
        x: 36,
        y: 520,
        fields: { PERIOD_MS: 100 },
        inputs: {
          BODY: {
            block: {
              type: 'poly_local_set',
              id: 'ev_set_temp',
              fields: { NAME: 'cur_temp' },
              inputs: {
                VALUE: {
                  block: { type: 'ext_board_temp', id: 'ev_read_temp' },
                },
              },
              next: {
                block: {
                  type: 'controls_if',
                  id: 'ev_if_temp',
                  extraState: { hasElse: true },
                  inputs: {
                    IF0: {
                      block: {
                        type: 'logic_compare',
                        id: 'ev_cmp_temp',
                        fields: { OP: 'GT' },
                        inputs: {
                          A: {
                            block: {
                              type: 'poly_local_get',
                              id: 'ev_get_temp',
                              fields: { NAME: 'cur_temp' },
                            },
                          },
                          B: {
                            block: {
                              type: 'math_number',
                              id: 'ev_th_35',
                              fields: { NUM: 35 },
                            },
                          },
                        },
                      },
                    },
                    DO0: {
                      block: {
                        type: 'ext_board_rgb',
                        id: 'ev_rgb_red',
                        fields: { COLOR: '#ef4444' },
                      },
                    },
                    ELSE: {
                      block: {
                        type: 'ext_board_rgb',
                        id: 'ev_rgb_green',
                        fields: { COLOR: '#10b981' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        type: 'poly_on_timer',
        id: 'ev_on_t0',
        x: 700,
        y: 28,
        fields: { TIMER_ID: '0' },
        inputs: {
          BODY: {
            block: {
              type: 'variables_set',
              id: 'ev_flip_led',
              fields: { VAR: { id: 'var_ev_led' } },
              inputs: {
                VALUE: {
                  block: {
                    type: 'logic_negate',
                    id: 'ev_not_led',
                    inputs: {
                      BOOL: {
                        block: {
                          type: 'variables_get',
                          id: 'ev_get_led',
                          fields: { VAR: { id: 'var_ev_led' } },
                        },
                      },
                    },
                  },
                },
              },
              next: {
                block: {
                  type: 'controls_if',
                  id: 'ev_if_led',
                  extraState: { hasElse: true },
                  inputs: {
                    IF0: {
                      block: {
                        type: 'variables_get',
                        id: 'ev_get_led2',
                        fields: { VAR: { id: 'var_ev_led' } },
                      },
                    },
                    DO0: {
                      block: {
                        type: 'ext_board_led',
                        id: 'ev_led_on',
                        fields: { STATE: 'true' },
                      },
                    },
                    ELSE: {
                      block: {
                        type: 'ext_board_led',
                        id: 'ev_led_off',
                        fields: { STATE: 'false' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        type: 'poly_on_button',
        id: 'ev_on_btn_a',
        x: 700,
        y: 460,
        fields: { KEY: 'A', EDGE: 'press' },
        inputs: {
          BODY: {
            block: {
              type: 'poly_log',
              id: 'ev_btn_log',
              fields: { LEVEL: 'WARN' },
              inputs: {
                MESSAGE: {
                  block: {
                    type: 'text',
                    id: 'ev_btn_txt',
                    fields: { TEXT: '按键 A 按下：启动 T1 三次告警提示定时器 (400ms)' },
                  },
                },
              },
              next: {
                block: {
                  type: 'poly_start_timer',
                  id: 'ev_start_t1',
                  fields: { TIMER_ID: '1' },
                  inputs: {
                    PERIOD_MS: {
                      shadow: {
                        type: 'math_number',
                        id: 'ev_t1_ms',
                        fields: { NUM: 400 },
                      },
                    },
                    REPEAT: {
                      shadow: {
                        type: 'math_number',
                        id: 'ev_t1_rep',
                        fields: { NUM: 3 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        type: 'poly_on_timer',
        id: 'ev_on_t1',
        x: 700,
        y: 780,
        fields: { TIMER_ID: '1' },
        inputs: {
          BODY: {
            block: {
              type: 'math_change',
              id: 'ev_inc_ticks',
              fields: { VAR: { id: 'var_ev_ticks' } },
              inputs: {
                DELTA: {
                  shadow: {
                    type: 'math_number',
                    id: 'ev_delta_1',
                    fields: { NUM: 1 },
                  },
                },
              },
              next: {
                block: {
                  type: 'poly_print_kv',
                  id: 'ev_print_t1',
                  fields: { LABEL: 'T1 告警触发次数' },
                  inputs: {
                    VALUE: {
                      block: {
                        type: 'variables_get',
                        id: 'ev_get_ticks',
                        fields: { VAR: { id: 'var_ev_ticks' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        type: 'poly_on_stop',
        id: 'ev_on_stop',
        x: 36,
        y: 940,
        inputs: {
          BODY: {
            block: {
              type: 'ext_board_led',
              id: 'ev_stop_led',
              fields: { STATE: 'false' },
              next: {
                block: {
                  type: 'ext_board_rgb',
                  id: 'ev_stop_rgb',
                  fields: { COLOR: '#1e293b' },
                  next: {
                    block: {
                      type: 'poly_log',
                      id: 'ev_stop_log',
                      fields: { LEVEL: 'OK' },
                      inputs: {
                        MESSAGE: {
                          block: {
                            type: 'text',
                            id: 'ev_stop_txt',
                            fields: { TEXT: 'on_stop 已安全关闭 LED 与三色灯' },
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
  variables: [
    { name: 'led_on', id: 'var_ev_led' },
    { name: 'ticks', id: 'var_ev_ticks' },
  ],
};

const TIMER_ONESHOT_WS: Record<string, unknown> = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'poly_on_start',
        id: 'ts_start',
        x: 36,
        y: 28,
        inputs: {
          BODY: {
            block: {
              type: 'variables_set',
              id: 'ts_init_n',
              fields: { VAR: { id: 'var_ts_n' } },
              inputs: {
                VALUE: {
                  block: {
                    type: 'math_number',
                    id: 'ts_zero',
                    fields: { NUM: 0 },
                  },
                },
              },
              next: {
                block: {
                  type: 'poly_start_timer',
                  id: 'ts_start_t0',
                  fields: { TIMER_ID: '0' },
                  inputs: {
                    PERIOD_MS: {
                      shadow: {
                        type: 'math_number',
                        id: 'ts_ms',
                        fields: { NUM: 120 },
                      },
                    },
                    REPEAT: {
                      shadow: {
                        type: 'math_number',
                        id: 'ts_rep',
                        fields: { NUM: 3 },
                      },
                    },
                  },
                  next: {
                    block: {
                      type: 'poly_print_kv',
                      id: 'ts_running_chk',
                      fields: { LABEL: 'T0 运行中' },
                      inputs: {
                        VALUE: {
                          block: {
                            type: 'poly_is_timer_running',
                            id: 'ts_is_run',
                            fields: { TIMER_ID: '0' },
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
      {
        type: 'poly_on_timer',
        id: 'ts_on_t0',
        x: 36,
        y: 360,
        fields: { TIMER_ID: '0' },
        inputs: {
          BODY: {
            block: {
              type: 'math_change',
              id: 'ts_inc',
              fields: { VAR: { id: 'var_ts_n' } },
              inputs: {
                DELTA: {
                  shadow: {
                    type: 'math_number',
                    id: 'ts_one',
                    fields: { NUM: 1 },
                  },
                },
              },
              next: {
                block: {
                  type: 'poly_print_kv',
                  id: 'ts_print_n',
                  fields: { LABEL: 'T0 触发次数' },
                  inputs: {
                    VALUE: {
                      block: {
                        type: 'variables_get',
                        id: 'ts_get_n',
                        fields: { VAR: { id: 'var_ts_n' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      {
        type: 'poly_on_stop',
        id: 'ts_on_stop',
        x: 36,
        y: 640,
        inputs: {
          BODY: {
            block: {
              type: 'poly_log',
              id: 'ts_done_log',
              fields: { LEVEL: 'OK' },
              inputs: {
                MESSAGE: {
                  block: {
                    type: 'text',
                    id: 'ts_done_txt',
                    fields: { TEXT: '3 次定时任务全部完成，事件循环自动退出！' },
                  },
                },
              },
            },
          },
        },
      },
    ],
  },
  variables: [{ name: 'count', id: 'var_ts_n' }],
};

export const MULTI_SCRIPT_PROJECT_TEMPLATES: MultiHandleProjectTemplate[] = [
  {
    id: 'starter_suite',
    name: '入门演示项目',
    description:
      '纯脚本环境（零外设、零定时器）：含顺序累加日志（main）、延时与断点单步（step_debug）、随机采样阈值告警（threshold_alarm），适合快速熟悉积木与双语代码导出。',
    language: 'lua',
    targetProfileId: 'generic-script',
    defaultTimerCount: 8,
    enabledCapabilities: [],
    difficulty: {
      level: 'L1',
      label: 'L1 入门 · 纯脚本',
      highlights: ['零外设纯净内核', '循环与条件', '断点单步调试'],
    },
    handles: [
      {
        name: 'main_vm',
        description: '默认主运行句柄',
        color: '#4f46e5',
        autoStart: true,
        scripts: [
          { name: 'main', isEntry: true, workspace: tplById('demo_logger').workspace },
          { name: 'step_debug', workspace: tplById('step_debug_demo').workspace },
          { name: 'threshold_alarm', workspace: tplById('threshold_alarm').workspace },
        ],
      },
    ],
  },
  {
    id: 'virtual_board_demo',
    name: '智能温控与虚拟板联动',
    description:
      '中等难度（Python 3 + 外设与工具库）：启用虚拟硬件外设包、字典与秒表包；含 LED/三色灯/OLED 开机自检、交互式温度滑块告警（temp_guard）与字典配置耗时统计（dict_config）。',
    language: 'python',
    targetProfileId: 'virtual-board-basic',
    defaultTimerCount: 8,
    enabledCapabilities: [CAP_VIRTUAL_BOARD, 'dict-json', 'clock-timer'],
    difficulty: {
      level: 'L2',
      label: 'L2 中等 · 外设联动',
      highlights: ['LED / 三色灯 / OLED', '温度滑块交互', '字典与毫秒秒表'],
    },
    handles: [
      {
        name: 'board_vm',
        description: 'Python 虚拟硬件联动句柄',
        color: '#0ea5e9',
        autoStart: true,
        scripts: [
          { name: 'led_blink', isEntry: true, workspace: VIRTUAL_BOARD_LED_WS },
          { name: 'temp_guard', workspace: VIRTUAL_BOARD_TEMP_WS },
          { name: 'dict_config', workspace: MEDIUM_DICT_CONFIG_WS },
        ],
      },
    ],
  },
  {
    id: 'event_timer_demo',
    name: '事件回调与多路定时器示例',
    description:
      '进阶事件驱动（Lua 5.4 顶层零闭包 ABI）：启用周期循环、多路编号定时与虚拟硬件按键中断；支持 T0 常驻心跳灯、on_run 实时温检、按键 A 触发 T1 三次告警与 on_stop 安全停机。',
    language: 'lua',
    targetProfileId: 'virtual-board-rt',
    defaultTimerCount: 8,
    enabledCapabilities: [CAP_RT_LIFECYCLE, CAP_RT_TIMERS, CAP_VIRTUAL_BOARD],
    difficulty: {
      level: 'L3',
      label: 'L3 进阶 · 事件定时',
      highlights: ['on_run / on_stop', '多路编号定时器', '按键边沿回调', '局部变量作用域'],
    },
    handles: [
      {
        name: 'board_vm',
        description: '板载事件循环控制句柄',
        color: '#4f46e5',
        autoStart: true,
        timerConfig: {
          count: 8,
          aliases: {
            '0': '心跳灯',
            '1': '告警倒计时',
          },
        },
        scripts: [
          { name: 'event_loop', isEntry: true, workspace: EVENT_LOOP_MAIN_WS },
          { name: 'timer_oneshot', workspace: TIMER_ONESHOT_WS },
        ],
      },
    ],
  },
  {
    id: 'multi_handle_robot',
    name: '智能双轮机器人全栈仿真',
    description:
      '旗舰全栈综合（3 隔离句柄并发 + 2 个项目内嵌自定义外设包 + 全部内置包）：展示多卡片模拟面板、自定义声明式急停中断（on_drive_estop）、双独立通道池（T0~T7 与 PWM0~PWM3）、自定义工具箱序号（#35）及秒表字典遥测。',
    language: 'lua',
    targetProfileId: 'virtual-board-rt',
    defaultTimerCount: 8,
    enabledCapabilities: [
      CAP_RT_LIFECYCLE,
      CAP_RT_TIMERS,
      CAP_VIRTUAL_BOARD,
      'dict-json',
      'clock-timer',
      FLAGSHIP_ROBOT_DRIVE_PACK.id,
      FLAGSHIP_PWM_SERVO_PACK.id,
    ],
    localExtensions: [FLAGSHIP_ROBOT_DRIVE_PACK, FLAGSHIP_PWM_SERVO_PACK],
    difficulty: {
      level: 'L4',
      label: 'L4 旗舰 · 全栈综合',
      highlights: [
        '3 句柄并发模拟',
        '2 内嵌自定义外设',
        '自定义急停中断',
        '双通道池 (T + PWM)',
        '字典 + 秒表遥测',
      ],
    },
    handles: [
      {
        name: 'drive_ctrl',
        description: '运动、云台与急停控制句柄（独立 lua_State #1）',
        color: '#4f46e5',
        autoStart: true,
        timerConfig: {
          count: 8,
          aliases: {
            '0': '云台扫描',
            '1': '疾速倒计时',
          },
        },
        capabilityConfigs: {
          'pwm-servo': {
            count: 4,
            aliases: {
              '0': '云台偏航',
              '1': '云台俯仰',
            },
          },
        },
        scripts: [
          { name: 'motion_ctrl', isEntry: true, workspace: FLAGSHIP_DRIVE_CTRL_WS },
          { name: 'patrol_test', workspace: FLAGSHIP_PATROL_TEST_WS },
        ],
      },
      {
        name: 'sensor_guard',
        description: '安防温控告警句柄（独立 lua_State #2，独享 T0）',
        color: '#0ea5e9',
        autoStart: true,
        timerConfig: {
          count: 8,
          aliases: {
            '0': '温度巡检',
          },
        },
        scripts: [
          { name: 'thermal_watch', isEntry: true, workspace: FLAGSHIP_SENSOR_GUARD_WS },
        ],
      },
      {
        name: 'telemetry_hub',
        description: '字典与秒表遥测统计句柄（独立 lua_State #3，独享 T0）',
        color: '#10b981',
        autoStart: true,
        timerConfig: {
          count: 8,
          aliases: {
            '0': '遥测上报',
          },
        },
        scripts: [
          { name: 'metrics_report', isEntry: true, workspace: FLAGSHIP_TELEMETRY_HUB_WS },
        ],
      },
    ],
  },
  {
    id: 'blank_project',
    name: '空白项目',
    description: '纯脚本环境空白工程（无定时器/无预设外设），后续可在项目配置中按需勾选目标板型与能力包。',
    language: 'lua',
    targetProfileId: 'generic-script',
    defaultTimerCount: 8,
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
  },
];

/** Curated 4-tier progressive showcase templates (L1 Simple -> L4 Full-Stack Flagship). */
export const DEMO_PROJECT_TEMPLATES: MultiHandleProjectTemplate[] =
  MULTI_SCRIPT_PROJECT_TEMPLATES.filter((t) => !t.hiddenFromDemoList);

function instantiateHandleSpec(
  spec: HandleTemplateSpec,
  idx: number,
  defaultTimerCount: number,
  hasTimersCap: boolean,
  now: string,
): RuntimeHandle {
  const scripts: ProjectScript[] = spec.scripts.map((s) => ({
    id: createId('scr'),
    name: sanitizeScriptName(s.name),
    workspace: cloneJson(s.workspace),
    breakpoints: [],
    updatedAt: now,
  }));
  const entryIdx = Math.max(
    0,
    spec.scripts.findIndex((s) => s.isEntry),
  );
  const entryId = scripts[entryIdx]?.id ?? scripts[0].id;
  const capabilityConfigs: Record<string, unknown> = {};
  if (hasTimersCap || spec.timerConfig) {
    capabilityConfigs[CAP_RT_TIMERS] = normalizeTimerConfig(
      spec.timerConfig,
      defaultTimerCount,
    );
  }
  if (spec.capabilityConfigs) {
    for (const [cfgKey, rawCfg] of Object.entries(spec.capabilityConfigs)) {
      capabilityConfigs[cfgKey] = normalizeTimerConfig(rawCfg);
    }
  }

  return {
    id: createId('hdl'),
    name: sanitizeHandleName(spec.name),
    description: spec.description,
    color: spec.color ?? HANDLE_COLOR_PALETTE[idx % HANDLE_COLOR_PALETTE.length],
    autoStart: spec.autoStart ?? true,
    capabilityConfigs,
    entryScriptId: entryId,
    activeScriptId: entryId,
    scripts,
    updatedAt: now,
  };
}

export function instantiateProjectFromTemplate(
  templateId: string,
  existingProjectNames: string[] = [],
  customName?: string,
): ProjectModel {
  const tpl =
    MULTI_SCRIPT_PROJECT_TEMPLATES.find((t) => t.id === templateId) ??
    MULTI_SCRIPT_PROJECT_TEMPLATES[0];
  const now = new Date().toISOString();
  const defaultTimerCount = tpl.defaultTimerCount ?? DEFAULT_TIMER_COUNT;
  const hasTimersCap = tpl.enabledCapabilities.includes(CAP_RT_TIMERS);

  const handles = tpl.handles.map((hs, idx) =>
    instantiateHandleSpec(hs, idx, defaultTimerCount, hasTimersCap, now),
  );

  return {
    format: 'polyblock-project',
    version: 3,
    id: createId('proj'),
    name: makeUniqueProjectName(customName ?? tpl.name, existingProjectNames),
    description: tpl.description,
    language: tpl.language,
    targetProfileId: tpl.targetProfileId,
    enabledCapabilities: [...tpl.enabledCapabilities],
    localExtensions: tpl.localExtensions ? cloneJson(tpl.localExtensions) : [],
    defaultTimerCount,
    sharedModules: [],
    activeHandleId: handles[0].id,
    handles,
    createdAt: now,
    updatedAt: now,
  };
}

/** Creates the clean initial workspace store preloaded with the 4 progressive demo projects (L1 active). */
export function createDefaultWorkspaceStore(): WorkspaceStoreState {
  const projects: ProjectModel[] = [];
  for (const tpl of DEMO_PROJECT_TEMPLATES) {
    projects.push(
      instantiateProjectFromTemplate(
        tpl.id,
        projects.map((p) => p.name),
      ),
    );
  }
  return {
    version: 3,
    activeProjectId: projects[0].id,
    projects,
  };
}

export function instantiateProjectFromProfile(
  profile: TargetProfile,
  existingProjectNames: string[] = [],
  customName?: string,
): ProjectModel {
  const now = new Date().toISOString();
  const hasTimersCap = profile.capabilities.includes(CAP_RT_TIMERS);
  const handle = instantiateHandleSpec(
    {
      name: 'main_vm',
      color: HANDLE_COLOR_PALETTE[0],
      autoStart: true,
      scripts: [{ name: 'main', isEntry: true, workspace: createBlankWorkspace() }],
    },
    0,
    profile.defaultTimerCount || DEFAULT_TIMER_COUNT,
    hasTimersCap,
    now,
  );
  return {
    format: 'polyblock-project',
    version: 3,
    id: createId('proj'),
    name: makeUniqueProjectName(
      customName ?? `${profile.name.split('（')[0]}工程`,
      existingProjectNames,
    ),
    description: profile.description,
    language: profile.defaultLanguage,
    targetProfileId: profile.id,
    enabledCapabilities: [...profile.capabilities],
    localExtensions: [],
    defaultTimerCount: profile.defaultTimerCount || DEFAULT_TIMER_COUNT,
    sharedModules: [],
    activeHandleId: handle.id,
    handles: [handle],
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeScriptsArray(
  rawScripts: Array<Record<string, unknown>>,
  now: string,
): { scripts: ProjectScript[]; idMap: Map<string, string> } {
  const usedNames: string[] = [];
  const idMap = new Map<string, string>();
  const scripts: ProjectScript[] = rawScripts.map((rs, idx) => {
    const uniqueName = makeUniqueScriptName(
      typeof rs.name === 'string'
        ? rs.name
        : idx === 0
          ? 'main'
          : `script_${idx + 1}`,
      usedNames,
    );
    usedNames.push(uniqueName);
    const newId = createId('scr');
    if (typeof rs.id === 'string') {
      idMap.set(rs.id, newId);
    }
    return {
      id: newId,
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
  return { scripts, idMap };
}

/** Losslessly migrates a v2 two-tier ProjectModel into v3 three-tier ProjectModel. */
export function migrateProjectV2ToV3(
  v2: LegacyProjectModelV2,
  existingProjectNames: string[] = [],
  fallbackName = '导入项目',
): ProjectModel {
  const now = new Date().toISOString();
  const rawScripts = Array.isArray(v2.scripts) && v2.scripts.length > 0
    ? (v2.scripts as unknown as Array<Record<string, unknown>>)
    : [{ name: 'main', workspace: createBlankWorkspace() }];
  const { scripts, idMap } = normalizeScriptsArray(rawScripts, now);
  const entryId =
    (v2.entryScriptId && idMap.get(v2.entryScriptId)) || scripts[0].id;
  const activeScriptId =
    (v2.activeScriptId && idMap.get(v2.activeScriptId)) || entryId;
  const timerCfg = normalizeTimerConfig(v2.timerConfig);
  const inferred = inferCapabilitiesFromWorkspaces(scripts.map((s) => s.workspace));
  const mergedCaps = Array.from(
    new Set([
      ...(Array.isArray(v2.enabledExtensions)
        ? v2.enabledExtensions.filter((e): e is string => typeof e === 'string')
        : []),
      ...inferred,
      ...(v2.timerConfig ? [CAP_RT_TIMERS] : []),
    ]),
  );

  const handle: RuntimeHandle = {
    id: createId('hdl'),
    name: 'main_vm',
    description: '由 v2 工程自动迁移的主句柄',
    color: HANDLE_COLOR_PALETTE[0],
    autoStart: true,
    capabilityConfigs:
      v2.timerConfig || mergedCaps.includes(CAP_RT_TIMERS)
        ? { [CAP_RT_TIMERS]: timerCfg }
        : {},
    entryScriptId: entryId,
    activeScriptId,
    scripts,
    updatedAt: v2.updatedAt || now,
  };

  return {
    format: 'polyblock-project',
    version: 3,
    id: v2.id || createId('proj'),
    name:
      existingProjectNames.length > 0
        ? makeUniqueProjectName(
            typeof v2.name === 'string' && v2.name.trim() ? v2.name : fallbackName,
            existingProjectNames,
          )
        : (typeof v2.name === 'string' && v2.name.trim()) || fallbackName,
    description: typeof v2.description === 'string' ? v2.description : undefined,
    language: v2.language === 'python' ? 'python' : 'lua',
    targetProfileId: inferProfileId(mergedCaps),
    enabledCapabilities: mergedCaps,
    localExtensions: [],
    defaultTimerCount: timerCfg.count,
    sharedModules: [],
    activeHandleId: handle.id,
    handles: [handle],
    createdAt: typeof v2.createdAt === 'string' ? v2.createdAt : now,
    updatedAt: typeof v2.updatedAt === 'string' ? v2.updatedAt : now,
  };
}

function normalizeLoadedV3Project(raw: Record<string, unknown>): ProjectModel {
  const now = new Date().toISOString();
  const defaultCount = Number.isFinite(Number(raw.defaultTimerCount))
    ? Math.max(
        MIN_TIMER_COUNT,
        Math.min(MAX_TIMER_COUNT, Math.trunc(Number(raw.defaultTimerCount))),
      )
    : DEFAULT_TIMER_COUNT;

  const rawHandles = Array.isArray(raw.handles)
    ? (raw.handles as Array<Record<string, unknown>>)
    : [];

  const allWs: Array<Record<string, unknown>> = [];
  const handles: RuntimeHandle[] = rawHandles.map((rh, idx) => {
    const scripts = Array.isArray(rh.scripts)
      ? (rh.scripts as ProjectScript[])
      : [
          {
            id: createId('scr'),
            name: 'main',
            workspace: createBlankWorkspace(),
            breakpoints: [],
            updatedAt: now,
          },
        ];
    for (const s of scripts) {
      if (s.workspace) allWs.push(s.workspace);
    }

    const existingCapConfigs =
      rh.capabilityConfigs && typeof rh.capabilityConfigs === 'object'
        ? cloneJson(rh.capabilityConfigs as Record<string, unknown>)
        : {};
    if (!existingCapConfigs[CAP_RT_TIMERS] && rh.timerConfig) {
      existingCapConfigs[CAP_RT_TIMERS] = normalizeTimerConfig(
        rh.timerConfig as Partial<ProjectTimerConfig>,
        defaultCount,
      );
    }

    const entryId =
      typeof rh.entryScriptId === 'string' &&
      scripts.some((s) => s.id === rh.entryScriptId)
        ? rh.entryScriptId
        : scripts[0].id;
    const activeId =
      typeof rh.activeScriptId === 'string' &&
      scripts.some((s) => s.id === rh.activeScriptId)
        ? rh.activeScriptId
        : entryId;

    return {
      id: typeof rh.id === 'string' ? rh.id : createId('hdl'),
      name: typeof rh.name === 'string' ? rh.name : `handle_${idx + 1}`,
      description: typeof rh.description === 'string' ? rh.description : undefined,
      color:
        typeof rh.color === 'string' && rh.color.startsWith('#')
          ? rh.color
          : HANDLE_COLOR_PALETTE[idx % HANDLE_COLOR_PALETTE.length],
      autoStart: rh.autoStart !== false,
      capabilityConfigs: existingCapConfigs,
      entryScriptId: entryId,
      activeScriptId: activeId,
      scripts,
      updatedAt: typeof rh.updatedAt === 'string' ? rh.updatedAt : now,
    };
  });

  // Migrate early-v3 `enabledExtensions` -> unified `enabledCapabilities`
  let enabledCapabilities: string[];
  if (Array.isArray(raw.enabledCapabilities)) {
    enabledCapabilities = raw.enabledCapabilities.filter(
      (c): c is string => typeof c === 'string',
    );
  } else {
    const legacyExts = Array.isArray(raw.enabledExtensions)
      ? raw.enabledExtensions.filter((e): e is string => typeof e === 'string')
      : [];
    const inferred = inferCapabilitiesFromWorkspaces(allWs);
    enabledCapabilities = Array.from(new Set([...legacyExts, ...inferred]));
  }

  const profileId =
    typeof raw.targetProfileId === 'string' && raw.targetProfileId.trim()
      ? raw.targetProfileId
      : inferProfileId(enabledCapabilities);

  const activeHandleId =
    typeof raw.activeHandleId === 'string' &&
    handles.some((h) => h.id === raw.activeHandleId)
      ? raw.activeHandleId
      : handles[0].id;

  return {
    format: 'polyblock-project',
    version: 3,
    id: typeof raw.id === 'string' ? raw.id : createId('proj'),
    name: typeof raw.name === 'string' ? raw.name : '未命名项目',
    description: typeof raw.description === 'string' ? raw.description : undefined,
    language: raw.language === 'python' ? 'python' : 'lua',
    targetProfileId: profileId,
    enabledCapabilities,
    localExtensions: normalizeLocalExtensions(raw.localExtensions),
    defaultTimerCount: defaultCount,
    sharedModules: Array.isArray(raw.sharedModules)
      ? (raw.sharedModules as ProjectScript[])
      : [],
    activeHandleId,
    handles,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
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

  // v3 Three-tier Project -> Handles -> Scripts
  if (obj.version === 3 && Array.isArray(obj.handles) && obj.handles.length > 0) {
    const rawHandles = obj.handles as Array<Record<string, unknown>>;
    const defaultCount = Number.isFinite(Number(obj.defaultTimerCount))
      ? Math.max(
          MIN_TIMER_COUNT,
          Math.min(MAX_TIMER_COUNT, Math.trunc(Number(obj.defaultTimerCount))),
        )
      : DEFAULT_TIMER_COUNT;

    const usedHandleNames: string[] = [];
    const handleIdMap = new Map<string, string>();
    const handles: RuntimeHandle[] = rawHandles.map((rh, hIdx) => {
      const hName = makeUniqueHandleName(
        typeof rh.name === 'string' ? rh.name : `handle_${hIdx + 1}`,
        usedHandleNames,
      );
      usedHandleNames.push(hName);
      const rawScripts =
        Array.isArray(rh.scripts) && rh.scripts.length > 0
          ? (rh.scripts as Array<Record<string, unknown>>)
          : [{ name: 'main', workspace: createBlankWorkspace() }];
      const { scripts, idMap } = normalizeScriptsArray(rawScripts, now);
      const entryId =
        (typeof rh.entryScriptId === 'string' && idMap.get(rh.entryScriptId)) ||
        scripts[0].id;
      const newHandleId = createId('hdl');
      if (typeof rh.id === 'string') {
        handleIdMap.set(rh.id, newHandleId);
      }
      const capCfgs =
        rh.capabilityConfigs && typeof rh.capabilityConfigs === 'object'
          ? cloneJson(rh.capabilityConfigs as Record<string, unknown>)
          : {};
      if (!capCfgs[CAP_RT_TIMERS] && rh.timerConfig) {
        capCfgs[CAP_RT_TIMERS] = normalizeTimerConfig(
          rh.timerConfig as Partial<ProjectTimerConfig>,
          defaultCount,
        );
      }
      return {
        id: newHandleId,
        name: hName,
        description: typeof rh.description === 'string' ? rh.description : undefined,
        color:
          typeof rh.color === 'string' && rh.color.startsWith('#')
            ? rh.color
            : HANDLE_COLOR_PALETTE[hIdx % HANDLE_COLOR_PALETTE.length],
        autoStart: rh.autoStart !== false,
        capabilityConfigs: capCfgs,
        entryScriptId: entryId,
        activeScriptId: entryId,
        scripts,
        updatedAt: typeof rh.updatedAt === 'string' ? rh.updatedAt : now,
      };
    });

    const activeHandleId =
      (typeof obj.activeHandleId === 'string' &&
        handleIdMap.get(obj.activeHandleId)) ||
      handles[0].id;

    const allWs = handles.flatMap((h) => h.scripts.map((s) => s.workspace));
    const enabledCapabilities = Array.isArray(obj.enabledCapabilities)
      ? obj.enabledCapabilities.filter((c): c is string => typeof c === 'string')
      : Array.from(
          new Set([
            ...(Array.isArray(obj.enabledExtensions)
              ? obj.enabledExtensions.filter((e): e is string => typeof e === 'string')
              : []),
            ...inferCapabilitiesFromWorkspaces(allWs),
          ]),
        );

    const targetProfileId =
      typeof obj.targetProfileId === 'string' && obj.targetProfileId.trim()
        ? obj.targetProfileId
        : inferProfileId(enabledCapabilities);

    const localPacks = normalizeLocalExtensions(obj.localExtensions);
    const absorbedBundled = getAbsorbedBundledExtensions(obj);
    const mergedLocalExtensions = [...localPacks, ...absorbedBundled];

    return {
      format: 'polyblock-project',
      version: 3,
      id: createId('proj'),
      name: makeUniqueProjectName(
        typeof obj.name === 'string' && obj.name.trim() ? obj.name : fallbackName,
        existingProjectNames,
      ),
      description: typeof obj.description === 'string' ? obj.description : undefined,
      language: obj.language === 'python' ? 'python' : 'lua',
      targetProfileId,
      enabledCapabilities,
      localExtensions: mergedLocalExtensions,
      defaultTimerCount: defaultCount,
      sharedModules: Array.isArray(obj.sharedModules)
        ? normalizeScriptsArray(
            obj.sharedModules as Array<Record<string, unknown>>,
            now,
          ).scripts
        : [],
      activeHandleId,
      handles,
      createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : now,
      updatedAt: now,
    };
  }

  // Legacy v2 Two-tier Project -> upgrade losslessly to v3
  if (obj.version === 2 && Array.isArray(obj.scripts) && obj.scripts.length > 0) {
    const migrated = migrateProjectV2ToV3(
      obj as unknown as LegacyProjectModelV2,
      existingProjectNames,
      fallbackName,
    );
    return {
      ...migrated,
      id: createId('proj'),
      updatedAt: now,
    };
  }

  // Legacy v1 single-canvas project -> upgrade seamlessly to v3
  const v1 = obj as unknown as LegacyProjectFileV1;
  if (!v1.workspace || typeof v1.workspace !== 'object') {
    throw new Error('缺少 handles / scripts 或 workspace 数据');
  }

  const cleanProjName = (v1.name || fallbackName)
    .replace(/\.polyblock\.json$|\.json$/i, '')
    .trim();
  const scriptId = createId('scr');
  const handleId = createId('hdl');

  return {
    format: 'polyblock-project',
    version: 3,
    id: createId('proj'),
    name: makeUniqueProjectName(cleanProjName || '导入项目', existingProjectNames),
    description: '由 v1 单脚本工程自动升级导入',
    language: v1.language === 'python' ? 'python' : 'lua',
    targetProfileId: 'generic-script',
    enabledCapabilities: inferCapabilitiesFromWorkspaces([v1.workspace]),
    localExtensions: [],
    defaultTimerCount: DEFAULT_TIMER_COUNT,
    sharedModules: [],
    activeHandleId: handleId,
    handles: [
      {
        id: handleId,
        name: 'main_vm',
        color: HANDLE_COLOR_PALETTE[0],
        autoStart: true,
        capabilityConfigs: {},
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

export function getActiveHandle(project: ProjectModel): RuntimeHandle {
  return (
    project.handles.find((h) => h.id === project.activeHandleId) ??
    project.handles[0]
  );
}

export function getActiveScript(handle: RuntimeHandle): ProjectScript {
  return (
    handle.scripts.find((s) => s.id === handle.activeScriptId) ??
    handle.scripts[0]
  );
}

export function countProjectScripts(project: ProjectModel): number {
  return project.handles.reduce((acc, h) => acc + h.scripts.length, 0);
}

export function loadWorkspaceStore(): WorkspaceStoreState {
  // 1. Try v3 store
  try {
    const rawV3 = localStorage.getItem(STORAGE_STORE_V3_KEY);
    if (rawV3) {
      const parsed = JSON.parse(rawV3) as WorkspaceStoreState;
      if (
        parsed &&
        parsed.version === 3 &&
        Array.isArray(parsed.projects) &&
        parsed.projects.length > 0 &&
        parsed.projects.every(
          (p) =>
            Array.isArray(p.handles) &&
            p.handles.length > 0 &&
            p.handles.every((h) => Array.isArray(h.scripts) && h.scripts.length > 0),
        )
      ) {
        targetProfileRegistry.ensureInitialized();
        return {
          ...parsed,
          projects: parsed.projects.map((p) =>
            normalizeLoadedV3Project(p as unknown as Record<string, unknown>),
          ),
        };
      }
    }
  } catch {
    // fall through
  }

  // 2. Losslessly migrate existing v2 store
  try {
    const rawV2 = localStorage.getItem(STORAGE_STORE_V2_KEY);
    if (rawV2) {
      const parsedV2 = JSON.parse(rawV2) as {
        version: number;
        activeProjectId?: string;
        projects?: LegacyProjectModelV2[];
      };
      if (
        parsedV2 &&
        parsedV2.version === 2 &&
        Array.isArray(parsedV2.projects) &&
        parsedV2.projects.length > 0
      ) {
        const migratedProjects = parsedV2.projects.map((p) =>
          migrateProjectV2ToV3(p),
        );
        const activeId =
          migratedProjects.find((p) => p.id === parsedV2.activeProjectId)?.id ??
          migratedProjects[0].id;
        return {
          version: 3,
          activeProjectId: activeId,
          projects: migratedProjects,
        };
      }
    }
  } catch {
    // fall through
  }

  // 3. Migrate legacy v1 single workspace if present, otherwise preload 4 progressive demos
  const defaultStore = createDefaultWorkspaceStore();
  try {
    const rawV1 = localStorage.getItem(STORAGE_LEGACY_V1_KEY);
    if (rawV1) {
      const parsedV1 = JSON.parse(rawV1) as LegacyProjectFileV1;
      if (parsedV1 && parsedV1.workspace && typeof parsedV1.workspace === 'object') {
        const migrated = parseImportedProject(
          parsedV1,
          '历史项目',
          defaultStore.projects.map((p) => p.name),
        );
        return {
          version: 3,
          activeProjectId: defaultStore.activeProjectId,
          projects: [...defaultStore.projects, migrated],
        };
      }
    }
  } catch {
    // ignore invalid v1 cache
  }

  return defaultStore;
}

export function saveWorkspaceStore(store: WorkspaceStoreState): void {
  try {
    localStorage.setItem(STORAGE_STORE_V3_KEY, JSON.stringify(store));
  } catch {
    // ignore storage quota errors
  }
}

/* ============================================================================
   Pure Immutable Store Reducers (Unit-Tested · Project / Handle / Script)
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

export function updateHandleById(
  project: ProjectModel,
  handleId: string,
  updater: (handle: RuntimeHandle) => RuntimeHandle,
): ProjectModel {
  return {
    ...project,
    handles: project.handles.map((h) =>
      h.id === handleId ? updater(h) : h,
    ),
    updatedAt: new Date().toISOString(),
  };
}

export function addHandleToProject(
  project: ProjectModel,
  desiredName?: string,
  initialWorkspace?: Record<string, unknown>,
): ProjectModel {
  const now = new Date().toISOString();
  const baseName = desiredName ?? `handle_${project.handles.length + 1}`;
  const uniqueName = makeUniqueHandleName(
    baseName,
    project.handles.map((h) => h.name),
  );
  const scriptId = createId('scr');
  const hasTimers = project.enabledCapabilities.includes(CAP_RT_TIMERS);
  const newHandle: RuntimeHandle = {
    id: createId('hdl'),
    name: uniqueName,
    color: HANDLE_COLOR_PALETTE[project.handles.length % HANDLE_COLOR_PALETTE.length],
    autoStart: true,
    capabilityConfigs: hasTimers
      ? { [CAP_RT_TIMERS]: normalizeTimerConfig(undefined, project.defaultTimerCount) }
      : {},
    entryScriptId: scriptId,
    activeScriptId: scriptId,
    scripts: [
      {
        id: scriptId,
        name: 'main',
        workspace: initialWorkspace
          ? cloneJson(initialWorkspace)
          : createBlankWorkspace(),
        breakpoints: [],
        updatedAt: now,
      },
    ],
    updatedAt: now,
  };

  return {
    ...project,
    activeHandleId: newHandle.id,
    handles: [...project.handles, newHandle],
    updatedAt: now,
  };
}

export function renameHandleInProject(
  project: ProjectModel,
  handleId: string,
  nextName: string,
): ProjectModel {
  const target = project.handles.find((h) => h.id === handleId);
  if (!target) return project;
  const unique = makeUniqueHandleName(
    nextName,
    project.handles.map((h) => h.name),
    target.name,
  );
  const now = new Date().toISOString();
  return updateHandleById(project, handleId, (h) => ({
    ...h,
    name: unique,
    updatedAt: now,
  }));
}

export function duplicateHandleInProject(
  project: ProjectModel,
  handleId: string,
): ProjectModel {
  const target = project.handles.find((h) => h.id === handleId);
  if (!target) return project;
  const now = new Date().toISOString();
  const scriptIdMap = new Map<string, string>();
  const clonedScripts: ProjectScript[] = target.scripts.map((s) => {
    const sid = createId('scr');
    scriptIdMap.set(s.id, sid);
    return {
      ...cloneJson(s),
      id: sid,
      updatedAt: now,
    };
  });
  const copy: RuntimeHandle = {
    ...target,
    id: createId('hdl'),
    name: makeUniqueHandleName(
      `${target.name}_copy`,
      project.handles.map((h) => h.name),
    ),
    color: HANDLE_COLOR_PALETTE[project.handles.length % HANDLE_COLOR_PALETTE.length],
    capabilityConfigs: cloneJson(target.capabilityConfigs ?? {}),
    entryScriptId: scriptIdMap.get(target.entryScriptId) ?? clonedScripts[0].id,
    activeScriptId: scriptIdMap.get(target.activeScriptId) ?? clonedScripts[0].id,
    scripts: clonedScripts,
    updatedAt: now,
  };
  const idx = project.handles.findIndex((h) => h.id === handleId);
  const nextHandles = [...project.handles];
  nextHandles.splice(idx + 1, 0, copy);
  return {
    ...project,
    activeHandleId: copy.id,
    handles: nextHandles,
    updatedAt: now,
  };
}

export function deleteHandleFromProject(
  project: ProjectModel,
  handleId: string,
): ProjectModel {
  if (project.handles.length <= 1) return project;
  const idx = project.handles.findIndex((h) => h.id === handleId);
  if (idx === -1) return project;
  const nextHandles = project.handles.filter((h) => h.id !== handleId);
  const fallback = nextHandles[Math.max(0, idx - 1)] ?? nextHandles[0];
  return {
    ...project,
    activeHandleId:
      project.activeHandleId === handleId ? fallback.id : project.activeHandleId,
    handles: nextHandles,
    updatedAt: new Date().toISOString(),
  };
}

export function addScriptToHandle(
  handle: RuntimeHandle,
  desiredName?: string,
  workspace?: Record<string, unknown>,
): RuntimeHandle {
  const now = new Date().toISOString();
  const baseName = desiredName ?? `script_${handle.scripts.length + 1}`;
  const uniqueName = makeUniqueScriptName(
    baseName,
    handle.scripts.map((s) => s.name),
  );
  const newScript: ProjectScript = {
    id: createId('scr'),
    name: uniqueName,
    workspace: workspace ? cloneJson(workspace) : createBlankWorkspace(),
    breakpoints: [],
    updatedAt: now,
  };
  return {
    ...handle,
    activeScriptId: newScript.id,
    scripts: [...handle.scripts, newScript],
    updatedAt: now,
  };
}

export function renameScriptInHandle(
  handle: RuntimeHandle,
  scriptId: string,
  nextName: string,
): RuntimeHandle {
  const target = handle.scripts.find((s) => s.id === scriptId);
  if (!target) return handle;
  const unique = makeUniqueScriptName(
    nextName,
    handle.scripts.map((s) => s.name),
    target.name,
  );
  const now = new Date().toISOString();
  return {
    ...handle,
    scripts: handle.scripts.map((s) =>
      s.id === scriptId ? { ...s, name: unique, updatedAt: now } : s,
    ),
    updatedAt: now,
  };
}

export function duplicateScriptInHandle(
  handle: RuntimeHandle,
  scriptId: string,
): RuntimeHandle {
  const target = handle.scripts.find((s) => s.id === scriptId);
  if (!target) return handle;
  const now = new Date().toISOString();
  const unique = makeUniqueScriptName(
    `${target.name}_copy`,
    handle.scripts.map((s) => s.name),
  );
  const copy: ProjectScript = {
    id: createId('scr'),
    name: unique,
    workspace: cloneJson(target.workspace),
    breakpoints: [...target.breakpoints],
    updatedAt: now,
  };
  const idx = handle.scripts.findIndex((s) => s.id === scriptId);
  const nextScripts = [...handle.scripts];
  nextScripts.splice(idx + 1, 0, copy);
  return {
    ...handle,
    activeScriptId: copy.id,
    scripts: nextScripts,
    updatedAt: now,
  };
}

export function deleteScriptFromHandle(
  handle: RuntimeHandle,
  scriptId: string,
): RuntimeHandle {
  if (handle.scripts.length <= 1) return handle;
  const idx = handle.scripts.findIndex((s) => s.id === scriptId);
  if (idx === -1) return handle;

  const nextScripts = handle.scripts.filter((s) => s.id !== scriptId);
  const fallback = nextScripts[Math.max(0, idx - 1)] ?? nextScripts[0];
  const now = new Date().toISOString();

  return {
    ...handle,
    activeScriptId:
      handle.activeScriptId === scriptId ? fallback.id : handle.activeScriptId,
    entryScriptId:
      handle.entryScriptId === scriptId ? fallback.id : handle.entryScriptId,
    scripts: nextScripts,
    updatedAt: now,
  };
}

// Convenience wrappers operating on the active handle of a project
export function addScriptToProject(
  project: ProjectModel,
  desiredName?: string,
  workspace?: Record<string, unknown>,
): ProjectModel {
  return updateHandleById(project, getActiveHandle(project).id, (h) =>
    addScriptToHandle(h, desiredName, workspace),
  );
}

export function renameScriptInProject(
  project: ProjectModel,
  scriptId: string,
  nextName: string,
): ProjectModel {
  return updateHandleById(project, getActiveHandle(project).id, (h) =>
    renameScriptInHandle(h, scriptId, nextName),
  );
}

export function duplicateScriptInProject(
  project: ProjectModel,
  scriptId: string,
): ProjectModel {
  return updateHandleById(project, getActiveHandle(project).id, (h) =>
    duplicateScriptInHandle(h, scriptId),
  );
}

export function deleteScriptFromProject(
  project: ProjectModel,
  scriptId: string,
): ProjectModel {
  return updateHandleById(project, getActiveHandle(project).id, (h) =>
    deleteScriptFromHandle(h, scriptId),
  );
}

export function duplicateProjectInStore(
  store: WorkspaceStoreState,
  projectId: string,
): WorkspaceStoreState {
  const target = store.projects.find((p) => p.id === projectId);
  if (!target) return store;
  const now = new Date().toISOString();
  const handleIdMap = new Map<string, string>();
  const clonedHandles: RuntimeHandle[] = target.handles.map((h) => {
    const newHId = createId('hdl');
    handleIdMap.set(h.id, newHId);
    const scriptIdMap = new Map<string, string>();
    const clonedScripts = h.scripts.map((s) => {
      const sid = createId('scr');
      scriptIdMap.set(s.id, sid);
      return { ...cloneJson(s), id: sid, updatedAt: now };
    });
    return {
      ...h,
      id: newHId,
      capabilityConfigs: cloneJson(h.capabilityConfigs ?? {}),
      entryScriptId: scriptIdMap.get(h.entryScriptId) ?? clonedScripts[0].id,
      activeScriptId: scriptIdMap.get(h.activeScriptId) ?? clonedScripts[0].id,
      scripts: clonedScripts,
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
    enabledCapabilities: [...target.enabledCapabilities],
    localExtensions: cloneJson(target.localExtensions ?? []),
    sharedModules: cloneJson(target.sharedModules ?? []),
    activeHandleId: handleIdMap.get(target.activeHandleId) ?? clonedHandles[0].id,
    handles: clonedHandles,
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
