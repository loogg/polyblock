import {
  CAP_RT,
  CAP_RT_TIMERS,
  CAP_VIRTUAL_BOARD,
} from '../../capabilities/registry';
import type { MultiHandleProjectTemplate } from './types';

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

/** L3 Event-Driven Demo: Lua 5.4 multi-file handle (main + timers + shared) + oneshot handle. */
export const EVENT_TIMER_DEMO: MultiHandleProjectTemplate = {
  id: 'event_timer_demo',
  name: '事件回调与多路定时器示例',
  description:
    '进阶事件驱动（Lua 5.4 单句柄多文件协同 + 顶层零闭包 ABI）：board_vm 句柄内由唯一入口 main.lua 的 on_start 显式 require("timers") 加载同句柄定时器回调模块；另附独立单次定时退出句柄 oneshot_vm。',
  language: 'lua',
  targetProfileId: 'virtual-board-rt',
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
      capabilityConfigs: {
        [CAP_RT_TIMERS]: {
          count: 8,
          aliases: { '0': '心跳灯', '1': '告警倒计时' },
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
      capabilityConfigs: {
        [CAP_RT_TIMERS]: { count: 8, aliases: { '0': '三次采样' } },
      },
      scripts: [{ name: 'main', isEntry: true, workspace: TIMER_ONESHOT_WS }],
    },
  ],
};
