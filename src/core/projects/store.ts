import { PROJECT_TEMPLATES } from '../blocks/templates';
import {
  DEFAULT_TIMER_COUNT,
  MAX_TIMER_COUNT,
  MIN_TIMER_COUNT,
  normalizeTimerConfig,
} from '../blocks/timerConfigBridge';
import {
  CAP_RT,
  CAP_RT_LIFECYCLE,
  CAP_RT_TICK,
  CAP_RT_TIMERS,
  CAP_VIRTUAL_BOARD,
  hasCapability,
  targetProfileRegistry,
} from '../capabilities/registry';
import {
  extensionRegistry,
  validateExtensionPack,
} from '../extensions/registry';
import type {
  PolyExtensionPack,
  ResolvedHandleChannelPoolSpec,
} from '../extensions/types';
import { normalizeVariableInitialValue } from './handleVariables';
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
  ProjectModel,
  ProjectScript,
  ProjectTimerConfig,
  RuntimeHandle,
  ScriptLanguageId,
  TargetProfile,
  VariableInitialValue,
  WorkspaceStoreState,
} from '../../types/project';

export const STORAGE_STORE_V6_KEY = 'polyblock.store.v6';

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
  /** Additional per-handle channel pool configs (e.g. `pwm-servo` isolated from `rt.timers`). */
  capabilityConfigs?: Record<string, Partial<ProjectTimerConfig>>;
  /** Explicit cross-file shared variables for this handle (Lua `shared.lua` / Python `shared.py`). */
  sharedVariables?: string[];
  /** Explicit cross-file shared functions exported into `shared.lua` / `shared.py`. */
  sharedFunctions?: string[];
  /** Optional explicit initial values for cross-file shared variables. */
  variableInitialValues?: Record<string, VariableInitialValue>;
  scripts: Array<{
    name: string;
    isEntry?: boolean;
    workspace: Record<string, unknown>;
    variableInitialValues?: Record<string, VariableInitialValue>;
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

/** Blank canvas for auxiliary module/callback scripts inside an existing handle (no duplicate `on_start`). */
export function createBlankModuleWorkspace(): Record<string, unknown> {
  return {
    blocks: {
      languageVersion: 0,
      blocks: [],
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
  return normalizeTimerConfig(fromCap, fallbackCount, minCount, maxCount);
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
  channelPools: ResolvedHandleChannelPoolSpec[],
  defaultTimerCount = DEFAULT_TIMER_COUNT,
): Record<string, ProjectTimerConfig> {
  const out: Record<string, ProjectTimerConfig> = {
    [CAP_RT_TIMERS]: getHandleTimerConfig(handle, defaultTimerCount),
  };
  for (const pool of channelPools) {
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
  const seenBundled = new Set<string>();
  const bundled: PolyExtensionPack[] = [];

  for (const capId of project.enabledCapabilities) {
    const dotIdx = capId.indexOf('.');
    const basePackId = dotIdx > 0 ? capId.slice(0, dotIdx) : capId;
    if (localIds.has(basePackId) || seenBundled.has(basePackId)) continue;
    const globalPack = globalPacks.find((p) => p.id === basePackId);
    if (globalPack && !globalPack.builtin) {
      seenBundled.add(basePackId);
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
  if (
    raw.includes('"poly_rt_tick"') ||
    raw.includes('"poly_rt_ms_to_tick"') ||
    raw.includes('"poly_rt_is_expired"')
  ) {
    inferred.add(CAP_RT_TICK);
  }
  if (raw.includes('"poly_on_button"') || raw.includes('"ext_board_')) {
    inferred.add(CAP_VIRTUAL_BOARD);
  }
  if (
    inferred.has(CAP_RT_LIFECYCLE) &&
    inferred.has(CAP_RT_TIMERS) &&
    inferred.has(CAP_RT_TICK)
  ) {
    inferred.delete(CAP_RT_LIFECYCLE);
    inferred.delete(CAP_RT_TIMERS);
    inferred.delete(CAP_RT_TICK);
    inferred.add(CAP_RT);
  }
  return Array.from(inferred);
}

function inferProfileId(caps: string[]): string {
  const hasRt = hasCapability(caps, CAP_RT);
  const hasVb = hasCapability(caps, CAP_VIRTUAL_BOARD);
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
                      type: 'poly_require_script',
                      id: 'ev_req_timers',
                      fields: { SCRIPT: 'timers' },
                      next: {
                        block: {
                          type: 'poly_set_run_period',
                          id: 'ev_set_period',
                          inputs: {
                            MS: {
                              shadow: {
                                type: 'math_number',
                                id: 'ev_run_ms',
                                fields: { NUM: 100 },
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
                                                  TEXT: '事件循环启动：已加载 timers.lua（T0心跳 / on_run监控）',
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
      {
        type: 'poly_on_run',
        id: 'ev_on_run',
        x: 36,
        y: 620,
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
        type: 'poly_on_button',
        id: 'ev_on_btn_a',
        x: 720,
        y: 28,
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
        type: 'poly_on_stop',
        id: 'ev_on_stop',
        x: 720,
        y: 360,
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

/** Companion script `timers.lua` in L3 Event-Driven Demo, loaded by `main.lua` via `require("timers")`. */
const EVENT_LOOP_TIMERS_WS: Record<string, unknown> = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'poly_on_timer',
        id: 'ev_on_t0',
        x: 36,
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
        type: 'poly_on_timer',
        id: 'ev_on_t1',
        x: 36,
        y: 380,
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
      '纯脚本环境（零外设、零定时器）：3 个独立入门句柄（每句柄唯一 on_start），分别演示顺序累加日志（main_vm）、延时与断点单步（step_debug_vm）、随机采样阈值告警（alarm_vm）。',
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
  },
  {
    id: 'virtual_board_demo',
    name: '智能温控与虚拟板联动',
    description:
      '中等难度（Python 3 + 外设与工具库）：启用虚拟硬件外设包、字典与秒表包；含 LED/三色灯/OLED 自检（board_vm）、交互式温度滑块告警（temp_guard_vm）与字典耗时统计（dict_config_vm）。',
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
        description: 'LED / 三色灯 / OLED 开机自检句柄',
        color: '#0ea5e9',
        autoStart: true,
        scripts: [
          { name: 'main', isEntry: true, workspace: VIRTUAL_BOARD_LED_WS },
        ],
      },
      {
        name: 'temp_guard_vm',
        description: '交互式温度传感器阈值告警句柄',
        color: '#f59e0b',
        autoStart: false,
        scripts: [
          { name: 'main', isEntry: true, workspace: VIRTUAL_BOARD_TEMP_WS },
        ],
      },
      {
        name: 'dict_config_vm',
        description: '字典配置与毫秒秒表耗时统计句柄',
        color: '#8b5cf6',
        autoStart: false,
        scripts: [
          { name: 'main', isEntry: true, workspace: MEDIUM_DICT_CONFIG_WS },
        ],
      },
    ],
  },
  {
    id: 'event_timer_demo',
    name: '事件回调与多路定时器示例',
    description:
      '进阶事件驱动（Lua 5.4 单句柄多文件协同 + 顶层零闭包 ABI）：board_vm 句柄内由唯一入口 main.lua 的 on_start 显式 require("timers") 加载同句柄定时器回调模块；另附独立单次定时退出句柄 oneshot_vm。',
    language: 'lua',
    targetProfileId: 'virtual-board-rt',
    defaultTimerCount: 8,
    enabledCapabilities: [CAP_RT, CAP_VIRTUAL_BOARD],
    difficulty: {
      level: 'L3',
      label: 'L3 进阶 · 事件定时',
      highlights: ['main + timers 同句柄协同', '唯一 on_start / on_stop', '独立 on_timer_N 函数', '按键边沿回调'],
    },
    handles: [
      {
        name: 'board_vm',
        description: '板载事件循环控制句柄（main.lua + timers.lua 协同运行）',
        color: '#4f46e5',
        autoStart: true,
        timerConfig: {
          count: 8,
          aliases: {
            '0': '心跳灯',
            '1': '告警倒计时',
          },
        },
        sharedVariables: ['led_on', 'ticks'],
        variableInitialValues: {
          led_on: { kind: 'boolean', value: false },
          ticks: { kind: 'number', value: 0 },
        },
        scripts: [
          { name: 'main', isEntry: true, workspace: EVENT_LOOP_MAIN_WS },
          { name: 'timers', workspace: EVENT_LOOP_TIMERS_WS },
        ],
      },
      {
        name: 'oneshot_vm',
        description: '3 次定时自动退出独立句柄',
        color: '#10b981',
        autoStart: false,
        timerConfig: {
          count: 8,
          aliases: {
            '0': '三次采样',
          },
        },
        scripts: [
          { name: 'main', isEntry: true, workspace: TIMER_ONESHOT_WS },
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
      CAP_RT,
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
          { name: 'main', isEntry: true, workspace: FLAGSHIP_DRIVE_CTRL_WS },
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
          { name: 'main', isEntry: true, workspace: FLAGSHIP_SENSOR_GUARD_WS },
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
          { name: 'main', isEntry: true, workspace: FLAGSHIP_TELEMETRY_HUB_WS },
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

function normalizeInitialValuesMap(
  raw: unknown,
): Record<string, VariableInitialValue> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, VariableInitialValue> = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim();
    if (!key) continue;
    out[key] = normalizeVariableInitialValue(v as VariableInitialValue);
    count += 1;
  }
  return count > 0 ? out : undefined;
}

function instantiateHandleSpec(
  spec: HandleTemplateSpec,
  idx: number,
  defaultTimerCount: number,
  hasTimersCap: boolean,
  now: string,
): RuntimeHandle {
  const scripts: ProjectScript[] = spec.scripts.map((s) => {
    const scriptInitials = normalizeInitialValuesMap(s.variableInitialValues);
    return {
      id: createId('scr'),
      name: sanitizeScriptName(s.name),
      workspace: cloneJson(s.workspace),
      breakpoints: [],
      ...(scriptInitials ? { variableInitialValues: scriptInitials } : {}),
      updatedAt: now,
    };
  });
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

  const sharedVariables = Array.isArray(spec.sharedVariables)
    ? [...spec.sharedVariables]
    : [];
  const sharedFunctions = Array.isArray(spec.sharedFunctions)
    ? [...spec.sharedFunctions]
    : [];
  const handleInitials = normalizeInitialValuesMap(spec.variableInitialValues);

  return {
    id: createId('hdl'),
    name: sanitizeHandleName(spec.name),
    description: spec.description,
    color: spec.color ?? HANDLE_COLOR_PALETTE[idx % HANDLE_COLOR_PALETTE.length],
    autoStart: spec.autoStart ?? true,
    capabilityConfigs,
    sharedVariables,
    sharedFunctions,
    ...(handleInitials ? { variableInitialValues: handleInitials } : {}),
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
  const hasTimersCap = hasCapability(tpl.enabledCapabilities, CAP_RT_TIMERS);

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
  const hasTimersCap = hasCapability(profile.capabilities, CAP_RT_TIMERS);
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
    const scriptInitials = normalizeInitialValuesMap(rs.variableInitialValues);
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
      ...(scriptInitials ? { variableInitialValues: scriptInitials } : {}),
      updatedAt: typeof rs.updatedAt === 'string' ? rs.updatedAt : now,
    };
  });
  return { scripts, idMap };
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
    const scripts: ProjectScript[] = Array.isArray(rh.scripts)
      ? (rh.scripts as Array<Record<string, unknown>>).map((rs, sIdx) => {
          const scriptInitials = normalizeInitialValuesMap(
            rs.variableInitialValues,
          );
          return {
            id: typeof rs.id === 'string' ? rs.id : createId('scr'),
            name:
              typeof rs.name === 'string'
                ? rs.name
                : sIdx === 0
                  ? 'main'
                  : `script_${sIdx + 1}`,
            workspace:
              rs.workspace && typeof rs.workspace === 'object'
                ? (rs.workspace as Record<string, unknown>)
                : createBlankWorkspace(),
            breakpoints: Array.isArray(rs.breakpoints)
              ? rs.breakpoints.filter((b): b is string => typeof b === 'string')
              : [],
            ...(scriptInitials ? { variableInitialValues: scriptInitials } : {}),
            updatedAt: typeof rs.updatedAt === 'string' ? rs.updatedAt : now,
          };
        })
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
    const handleInitials = normalizeInitialValuesMap(rh.variableInitialValues);

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
      sharedVariables: Array.isArray(rh.sharedVariables)
        ? rh.sharedVariables.filter(
            (v): v is string => typeof v === 'string' && v.trim().length > 0,
          )
        : [],
      sharedFunctions: Array.isArray(rh.sharedFunctions)
        ? rh.sharedFunctions.filter(
            (v): v is string => typeof v === 'string' && v.trim().length > 0,
          )
        : [],
      ...(handleInitials ? { variableInitialValues: handleInitials } : {}),
      entryScriptId: entryId,
      activeScriptId: activeId,
      scripts,
      updatedAt: typeof rh.updatedAt === 'string' ? rh.updatedAt : now,
    };
  });

  const enabledCapabilities = Array.isArray(raw.enabledCapabilities)
    ? raw.enabledCapabilities.filter((c): c is string => typeof c === 'string')
    : inferCapabilitiesFromWorkspaces(allWs);

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

  if (obj.version !== 3 || !Array.isArray(obj.handles) || obj.handles.length === 0) {
    throw new Error('仅支持 PolyBlock v3 工程格式（缺少 version: 3 或 handles 数据）');
  }

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
    const handleInitials = normalizeInitialValuesMap(rh.variableInitialValues);
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
      sharedVariables: Array.isArray(rh.sharedVariables)
        ? rh.sharedVariables.filter(
            (v): v is string => typeof v === 'string' && v.trim().length > 0,
          )
        : [],
      sharedFunctions: Array.isArray(rh.sharedFunctions)
        ? rh.sharedFunctions.filter(
            (v): v is string => typeof v === 'string' && v.trim().length > 0,
          )
        : [],
      ...(handleInitials ? { variableInitialValues: handleInitials } : {}),
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
    : inferCapabilitiesFromWorkspaces(allWs);

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
    activeHandleId,
    handles,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : now,
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
  try {
    const rawCurrent = localStorage.getItem(STORAGE_STORE_V6_KEY);
    if (rawCurrent) {
      const parsed = JSON.parse(rawCurrent) as WorkspaceStoreState;
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
    // fall through to clean defaults
  }

  return createDefaultWorkspaceStore();
}

export function saveWorkspaceStore(store: WorkspaceStoreState): void {
  try {
    localStorage.setItem(STORAGE_STORE_V6_KEY, JSON.stringify(store));
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
  const hasTimers = hasCapability(project.enabledCapabilities, CAP_RT_TIMERS);
  const newHandle: RuntimeHandle = {
    id: createId('hdl'),
    name: uniqueName,
    color: HANDLE_COLOR_PALETTE[project.handles.length % HANDLE_COLOR_PALETTE.length],
    autoStart: true,
    capabilityConfigs: hasTimers
      ? { [CAP_RT_TIMERS]: normalizeTimerConfig(undefined, project.defaultTimerCount) }
      : {},
    sharedVariables: [],
    sharedFunctions: [],
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
    sharedVariables: Array.isArray(target.sharedVariables)
      ? [...target.sharedVariables]
      : [],
    sharedFunctions: Array.isArray(target.sharedFunctions)
      ? [...target.sharedFunctions]
      : [],
    ...(target.variableInitialValues
      ? { variableInitialValues: cloneJson(target.variableInitialValues) }
      : {}),
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
    workspace: workspace
      ? cloneJson(workspace)
      : handle.scripts.length > 0
        ? createBlankModuleWorkspace()
        : createBlankWorkspace(),
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
    ...(target.variableInitialValues
      ? { variableInitialValues: cloneJson(target.variableInitialValues) }
      : {}),
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
      sharedVariables: [...(h.sharedVariables ?? [])],
      sharedFunctions: [...(h.sharedFunctions ?? [])],
      ...(h.variableInitialValues
        ? { variableInitialValues: cloneJson(h.variableInitialValues) }
        : {}),
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
