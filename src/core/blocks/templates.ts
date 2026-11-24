import type { ScriptLanguageId } from '../../types/project';

export interface ProjectTemplate {
  id: string;
  name: string;
  fileName: string;
  description: string;
  recommendedLang: ScriptLanguageId;
  workspace: Record<string, unknown>;
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'demo_logger',
    name: '日志打印与循环累加（默认）',
    fileName: 'demo_logger.polyblock.json',
    description: '演示事件入口、变量初始化、计次循环、文本拼接与分级打印日志。',
    recommendedLang: 'lua',
    workspace: {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'start_main',
            x: 36,
            y: 28,
            inputs: {
              BODY: {
                block: {
                  type: 'variables_set',
                  id: 'set_total',
                  fields: { VAR: { id: 'var_total' } },
                  inputs: {
                    VALUE: {
                      block: {
                        type: 'math_number',
                        id: 'num_zero',
                        fields: { NUM: 0 },
                      },
                    },
                  },
                  next: {
                    block: {
                      type: 'poly_log',
                      id: 'log_start',
                      fields: { LEVEL: 'INFO' },
                      inputs: {
                        MESSAGE: {
                          block: {
                            type: 'text',
                            id: 'txt_start',
                            fields: { TEXT: '任务启动，开始执行 3 轮累加...' },
                          },
                        },
                      },
                      next: {
                        block: {
                          type: 'poly_for_range',
                          id: 'loop_main',
                          fields: { VAR: { id: 'var_i' } },
                          inputs: {
                            FROM: {
                              shadow: {
                                type: 'math_number',
                                id: 'loop_from',
                                fields: { NUM: 1 },
                              },
                            },
                            TO: {
                              shadow: {
                                type: 'math_number',
                                id: 'loop_to',
                                fields: { NUM: 3 },
                              },
                            },
                            BY: {
                              shadow: {
                                type: 'math_number',
                                id: 'loop_by',
                                fields: { NUM: 1 },
                              },
                            },
                            DO: {
                              block: {
                                type: 'math_change',
                                id: 'add_total',
                                fields: { VAR: { id: 'var_total' } },
                                inputs: {
                                  DELTA: {
                                    shadow: {
                                      type: 'math_number',
                                      id: 'num_ten',
                                      fields: { NUM: 10 },
                                    },
                                  },
                                },
                                next: {
                                  block: {
                                    type: 'poly_print',
                                    id: 'print_round',
                                    inputs: {
                                      VALUE: {
                                        block: {
                                          type: 'text_join',
                                          id: 'join_round',
                                          extraState: { itemCount: 4 },
                                          inputs: {
                                            ADD0: {
                                              block: {
                                                type: 'text',
                                                id: 't0',
                                                fields: { TEXT: '第 ' },
                                              },
                                            },
                                            ADD1: {
                                              block: {
                                                type: 'variables_get',
                                                id: 'get_i',
                                                fields: { VAR: { id: 'var_i' } },
                                              },
                                            },
                                            ADD2: {
                                              block: {
                                                type: 'text',
                                                id: 't2',
                                                fields: { TEXT: ' 轮 => total = ' },
                                              },
                                            },
                                            ADD3: {
                                              block: {
                                                type: 'variables_get',
                                                id: 'get_total_loop',
                                                fields: { VAR: { id: 'var_total' } },
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
                          next: {
                            block: {
                              type: 'poly_print_kv',
                              id: 'print_kv_final',
                              fields: { LABEL: '最终 total' },
                              inputs: {
                                VALUE: {
                                  block: {
                                    type: 'variables_get',
                                    id: 'get_total_end',
                                    fields: { VAR: { id: 'var_total' } },
                                  },
                                },
                              },
                              next: {
                                block: {
                                  type: 'poly_log',
                                  id: 'log_done',
                                  fields: { LEVEL: 'OK' },
                                  inputs: {
                                    MESSAGE: {
                                      block: {
                                        type: 'text',
                                        id: 'txt_done',
                                        fields: { TEXT: '所有轮次执行完毕！' },
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
      variables: [
        { name: 'total', id: 'var_total' },
        { name: 'i', id: 'var_i' },
      ],
    },
  },
  {
    id: 'step_debug_demo',
    name: '延时执行与断点单步演示',
    fileName: 'step_debug_demo.polyblock.json',
    description: '带「等待 350 毫秒」延时积木，适合直观观察逐块高亮、打断点暂停与单步监视变量变化。',
    recommendedLang: 'lua',
    workspace: {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'dbg_start',
            x: 36,
            y: 28,
            inputs: {
              BODY: {
                block: {
                  type: 'variables_set',
                  id: 'dbg_set_sum',
                  fields: { VAR: { id: 'var_sum' } },
                  inputs: {
                    VALUE: {
                      block: {
                        type: 'math_number',
                        id: 'dbg_zero',
                        fields: { NUM: 0 },
                      },
                    },
                  },
                  next: {
                    block: {
                      type: 'poly_log',
                      id: 'dbg_log_begin',
                      fields: { LEVEL: 'INFO' },
                      inputs: {
                        MESSAGE: {
                          block: {
                            type: 'text',
                            id: 'dbg_txt_begin',
                            fields: { TEXT: '开始演示：每轮等待 350ms 并累加 sum' },
                          },
                        },
                      },
                      next: {
                        block: {
                          type: 'poly_for_range',
                          id: 'dbg_loop',
                          fields: { VAR: { id: 'var_step' } },
                          inputs: {
                            FROM: {
                              shadow: {
                                type: 'math_number',
                                id: 'dbg_from',
                                fields: { NUM: 1 },
                              },
                            },
                            TO: {
                              shadow: {
                                type: 'math_number',
                                id: 'dbg_to',
                                fields: { NUM: 4 },
                              },
                            },
                            BY: {
                              shadow: {
                                type: 'math_number',
                                id: 'dbg_by',
                                fields: { NUM: 1 },
                              },
                            },
                            DO: {
                              block: {
                                type: 'poly_wait_ms',
                                id: 'dbg_wait',
                                inputs: {
                                  MS: {
                                    shadow: {
                                      type: 'math_number',
                                      id: 'dbg_ms',
                                      fields: { NUM: 350 },
                                    },
                                  },
                                },
                                next: {
                                  block: {
                                    type: 'math_change',
                                    id: 'dbg_add_sum',
                                    fields: { VAR: { id: 'var_sum' } },
                                    inputs: {
                                      DELTA: {
                                        block: {
                                          type: 'variables_get',
                                          id: 'dbg_get_step',
                                          fields: { VAR: { id: 'var_step' } },
                                        },
                                      },
                                    },
                                    next: {
                                      block: {
                                        type: 'poly_print_kv',
                                        id: 'dbg_print_sum',
                                        fields: { LABEL: '当前累计 sum' },
                                        inputs: {
                                          VALUE: {
                                            block: {
                                              type: 'variables_get',
                                              id: 'dbg_get_sum',
                                              fields: { VAR: { id: 'var_sum' } },
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
                          next: {
                            block: {
                              type: 'poly_log',
                              id: 'dbg_log_end',
                              fields: { LEVEL: 'OK' },
                              inputs: {
                                MESSAGE: {
                                  block: {
                                    type: 'text',
                                    id: 'dbg_txt_end',
                                    fields: { TEXT: '延时累加演示完成！' },
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
      variables: [
        { name: 'sum', id: 'var_sum' },
        { name: 'step', id: 'var_step' },
      ],
    },
  },
  {
    id: 'threshold_alarm',
    name: '随机采样与阈值告警',
    fileName: 'threshold_alarm.polyblock.json',
    description: '模拟 5 次温度随机采样，超过阈值时输出 WARN 告警日志。',
    recommendedLang: 'python',
    workspace: {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'alarm_start',
            x: 36,
            y: 28,
            inputs: {
              BODY: {
                block: {
                  type: 'poly_log',
                  id: 'alarm_init',
                  fields: { LEVEL: 'INFO' },
                  inputs: {
                    MESSAGE: {
                      block: {
                        type: 'text',
                        id: 'alarm_init_txt',
                        fields: { TEXT: '开始模拟 5 次传感器采样 (告警阈值 > 70)' },
                      },
                    },
                  },
                  next: {
                    block: {
                      type: 'poly_repeat_times',
                      id: 'alarm_loop',
                      inputs: {
                        TIMES: {
                          shadow: {
                            type: 'math_number',
                            id: 'alarm_times',
                            fields: { NUM: 5 },
                          },
                        },
                        DO: {
                          block: {
                            type: 'variables_set',
                            id: 'set_temp',
                            fields: { VAR: { id: 'var_temp' } },
                            inputs: {
                              VALUE: {
                                block: {
                                  type: 'math_random_int',
                                  id: 'rand_temp',
                                  inputs: {
                                    FROM: {
                                      shadow: {
                                        type: 'math_number',
                                        id: 'r_from',
                                        fields: { NUM: 45 },
                                      },
                                    },
                                    TO: {
                                      shadow: {
                                        type: 'math_number',
                                        id: 'r_to',
                                        fields: { NUM: 95 },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                            next: {
                              block: {
                                type: 'controls_if',
                                id: 'if_over',
                                extraState: { hasElse: true },
                                inputs: {
                                  IF0: {
                                    block: {
                                      type: 'logic_compare',
                                      id: 'cmp_over',
                                      fields: { OP: 'GT' },
                                      inputs: {
                                        A: {
                                          block: {
                                            type: 'variables_get',
                                            id: 'get_temp_cmp',
                                            fields: { VAR: { id: 'var_temp' } },
                                          },
                                        },
                                        B: {
                                          block: {
                                            type: 'math_number',
                                            id: 'num_70',
                                            fields: { NUM: 70 },
                                          },
                                        },
                                      },
                                    },
                                  },
                                  DO0: {
                                    block: {
                                      type: 'poly_log',
                                      id: 'log_warn',
                                      fields: { LEVEL: 'WARN' },
                                      inputs: {
                                        MESSAGE: {
                                          block: {
                                            type: 'text_join',
                                            id: 'join_warn',
                                            extraState: { itemCount: 2 },
                                            inputs: {
                                              ADD0: {
                                                block: {
                                                  type: 'text',
                                                  id: 'tw0',
                                                  fields: { TEXT: '温度偏高: ' },
                                                },
                                              },
                                              ADD1: {
                                                block: {
                                                  type: 'variables_get',
                                                  id: 'get_temp_w',
                                                  fields: { VAR: { id: 'var_temp' } },
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
                                      type: 'poly_print_kv',
                                      id: 'print_ok_temp',
                                      fields: { LABEL: '采样正常 temp' },
                                      inputs: {
                                        VALUE: {
                                          block: {
                                            type: 'variables_get',
                                            id: 'get_temp_ok',
                                            fields: { VAR: { id: 'var_temp' } },
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
      variables: [{ name: 'temp', id: 'var_temp' }],
    },
  },
  {
    id: 'list_stats',
    name: '列表追加与长度统计',
    fileName: 'list_stats.polyblock.json',
    description: '演示跨 Lua/Python 列表创建、动态追加元素与长度统计输出。',
    recommendedLang: 'lua',
    workspace: {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'list_start',
            x: 36,
            y: 28,
            inputs: {
              BODY: {
                block: {
                  type: 'variables_set',
                  id: 'set_items',
                  fields: { VAR: { id: 'var_items' } },
                  inputs: {
                    VALUE: {
                      block: {
                        type: 'lists_create_with',
                        id: 'mk_list',
                        extraState: { itemCount: 3 },
                        inputs: {
                          ADD0: {
                            block: {
                              type: 'math_number',
                              id: 'li0',
                              fields: { NUM: 10 },
                            },
                          },
                          ADD1: {
                            block: {
                              type: 'math_number',
                              id: 'li1',
                              fields: { NUM: 20 },
                            },
                          },
                          ADD2: {
                            block: {
                              type: 'math_number',
                              id: 'li2',
                              fields: { NUM: 30 },
                            },
                          },
                        },
                      },
                    },
                  },
                  next: {
                    block: {
                      type: 'poly_list_append',
                      id: 'append_40',
                      fields: { LIST: { id: 'var_items' } },
                      inputs: {
                        ITEM: {
                          block: {
                            type: 'math_number',
                            id: 'li3',
                            fields: { NUM: 40 },
                          },
                        },
                      },
                      next: {
                        block: {
                          type: 'poly_print_kv',
                          id: 'print_len',
                          fields: { LABEL: '列表元素数量' },
                          inputs: {
                            VALUE: {
                              block: {
                                type: 'lists_length',
                                id: 'len_items',
                                inputs: {
                                  VALUE: {
                                    block: {
                                      type: 'variables_get',
                                      id: 'get_items',
                                      fields: { VAR: { id: 'var_items' } },
                                    },
                                  },
                                },
                              },
                            },
                          },
                          next: {
                            block: {
                              type: 'poly_log',
                              id: 'log_list_ok',
                              fields: { LEVEL: 'OK' },
                              inputs: {
                                MESSAGE: {
                                  block: {
                                    type: 'text',
                                    id: 'txt_list_ok',
                                    fields: { TEXT: '列表统计完成' },
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
      variables: [{ name: 'items', id: 'var_items' }],
    },
  },
];
