import type { PolyExtensionPack } from '../extensions/types';

/**
 * Embedded custom extension pack #1 for the L4 Flagship Robot project:
 * Differential-drive chassis controller with declarative `simWidgets`,
 * dual Lua/Python `sandboxMock`, and custom declarative `kind: 'hat'` E-Stop callback.
 */
export const FLAGSHIP_ROBOT_DRIVE_PACK: PolyExtensionPack = {
  format: 'polyblock-extension',
  version: 1,
  id: 'robot-drive',
  name: '差速底盘驱动包',
  packVersion: '1.0.0',
  iconLabel: '底盘',
  color: '#ec4899',
  tags: ['机器人', '差速驱动'],
  description:
    '项目内嵌自定义外设包：提供双轮差速控制、电池监测与声明式急停中断回调（on_drive_estop），随工程文件自动携带且不污染全局库。',
  builtin: false,
  imports: {
    lua: ['local drive = require("drive")'],
    python: ['import drive'],
  },
  sections: [
    {
      id: 'main',
      label: '底盘',
      toolboxOrder: 105,
      blocks: [
        {
          type: 'ext_drive_set_wheels',
          kind: 'statement',
          message0: '差速驱动 左轮 %1 %% 右轮 %2 %%',
          args0: [
            { type: 'input_value', name: 'LEFT', check: 'Number' },
            { type: 'input_value', name: 'RIGHT', check: 'Number' },
          ],
          inputsInline: true,
          shadows: {
            LEFT: { type: 'math_number', value: 60 },
            RIGHT: { type: 'math_number', value: 60 },
          },
          tooltip: '设置左右轮目标转速百分比（0~100%）；若急停开关处于锁定态会自动归零保护。',
          keywords: '底盘 差速 驱动 左轮 右轮 速度 drive set_wheels',
          simWidgetKeys: ['moving', 'left_speed', 'right_speed', 'drive_log'],
          lua: { template: 'drive.set_wheels({{LEFT}}, {{RIGHT}})' },
          python: { template: 'drive.set_wheels({{LEFT}}, {{RIGHT}})' },
        },
        {
          type: 'ext_drive_stop',
          kind: 'statement',
          message0: '底盘立即刹车停机',
          inputsInline: true,
          tooltip: '立刻切断左右轮动力并刷新底盘状态灯与指令终端。',
          keywords: '底盘 刹车 停机 stop drive',
          simWidgetKeys: ['moving', 'left_speed', 'right_speed', 'drive_log'],
          lua: { template: 'drive.stop()' },
          python: { template: 'drive.stop()' },
        },
        {
          type: 'ext_drive_battery',
          kind: 'value',
          outputType: 'Number',
          message0: '读取底盘电量 (%)',
          tooltip: '读取机器人动力电池当前剩余百分比（可在右侧「模拟」面板拖动电量滑块实时测试）。',
          keywords: '底盘 电池 电量 battery drive',
          simWidgetKeys: ['battery'],
          lua: { template: 'drive.battery()' },
          python: { template: 'drive.battery()' },
        },
        {
          type: 'ext_drive_is_estop',
          kind: 'value',
          outputType: 'Boolean',
          message0: '底盘处于急停锁定?',
          tooltip: '检查急停开关（E-Stop）当前是否被拨至锁定状态。',
          keywords: '底盘 急停 锁定 estop drive',
          simWidgetKeys: ['estop'],
          lua: { template: 'drive.is_estop()' },
          python: { template: 'drive.is_estop()' },
        },
        {
          type: 'ext_drive_on_estop',
          kind: 'hat',
          message0: '当底盘急停 %1 时',
          args0: [
            {
              type: 'field_dropdown',
              name: 'STATE',
              options: [
                ['触发', 'press'],
                ['解除', 'release'],
              ],
            },
          ],
          inputsInline: true,
          fields: { STATE: 'press' },
          tooltip:
            '自定义声明式硬件中断回调：聚合成顶层零闭包 on_drive_estop(active)，点击右侧急停开关即刻触发。',
          keywords: '当底盘 急停 触发 解除 回调 on_drive_estop hat',
          simWidgetKeys: ['estop'],
          hat: {
            eventName: 'on_drive_estop',
            params: ['active'],
            mode: 'dispatch',
            conditionLua: '{{STATE:edge_lua:active}}',
            conditionPython: '{{STATE:edge_py:active}}',
            duplicateKeyTemplate: '{{STATE}}',
            scopeLabelTemplate: 'on_drive_estop · {{STATE:edge_zh}}',
            scopeShortTemplate: '急停',
            scopeCategory: 'event',
            keepsAlive: true,
          },
        },
      ],
    },
  ],
  sandboxMock: {
    moduleName: 'drive',
    luaSource: `
local M = {}
function M.set_wheels(l, r)
  if __poly_sim_get("estop") == true then
    __poly_sim_set("moving", false)
    __poly_sim_set("left_speed", 0)
    __poly_sim_set("right_speed", 0)
    __poly_sim_set("drive_log:append", "[ESTOP] 急停锁定中，拒绝动力输出")
    return
  end
  local lv = math.max(0, math.min(100, math.floor(tonumber(l) or 0)))
  local rv = math.max(0, math.min(100, math.floor(tonumber(r) or 0)))
  __poly_sim_set("left_speed", lv)
  __poly_sim_set("right_speed", rv)
  __poly_sim_set("moving", (lv > 0 or rv > 0))
  __poly_sim_set("drive_log:append", "wheels(L=" .. tostring(lv) .. "%, R=" .. tostring(rv) .. "%)")
end
function M.stop()
  __poly_sim_set("left_speed", 0)
  __poly_sim_set("right_speed", 0)
  __poly_sim_set("moving", false)
  __poly_sim_set("drive_log:append", "[STOP] 双轮动力已归零")
end
function M.battery()
  local v = tonumber(__poly_sim_get("battery"))
  return v or 86
end
function M.is_estop()
  return __poly_sim_get("estop") == true
end
return M
`,
    pythonSource: `
import _poly
def set_wheels(l, r):
    if _poly.sim_get("estop") is True:
        _poly.sim_set("moving", False)
        _poly.sim_set("left_speed", 0)
        _poly.sim_set("right_speed", 0)
        _poly.sim_set("drive_log:append", "[ESTOP] 急停锁定中，拒绝动力输出")
        return
    lv = max(0, min(100, int(float(l))))
    rv = max(0, min(100, int(float(r))))
    _poly.sim_set("left_speed", lv)
    _poly.sim_set("right_speed", rv)
    _poly.sim_set("moving", lv > 0 or rv > 0)
    _poly.sim_set("drive_log:append", f"wheels(L={lv}%, R={rv}%)")
def stop():
    _poly.sim_set("left_speed", 0)
    _poly.sim_set("right_speed", 0)
    _poly.sim_set("moving", False)
    _poly.sim_set("drive_log:append", "[STOP] 双轮动力已归零")
def battery():
    v = _poly.sim_get("battery")
    return int(v) if v is not None else 86
def is_estop():
    return _poly.sim_get("estop") is True
`,
  },
  simWidgets: [
    {
      kind: 'led',
      key: 'moving',
      label: '底盘动力',
      color: '#10b981',
      default: false,
    },
    {
      kind: 'bar',
      key: 'left_speed',
      label: '左轮转速',
      hint: 'drive.set_wheels',
      min: 0,
      max: 100,
      unit: '%',
      color: '#0ea5e9',
      default: 0,
    },
    {
      kind: 'bar',
      key: 'right_speed',
      label: '右轮转速',
      hint: 'drive.set_wheels',
      min: 0,
      max: 100,
      unit: '%',
      color: '#ec4899',
      default: 0,
    },
    {
      kind: 'screen',
      key: 'drive_log',
      label: '底盘指令日志',
      maxLines: 3,
      default: ['[Drive Ready] 等待运动控制指令...'],
    },
    {
      kind: 'slider',
      key: 'battery',
      label: '模拟电池电量',
      hint: 'drive.battery',
      min: 0,
      max: 100,
      step: 1,
      unit: '%',
      default: 86,
      marks: ['0% 亏电', '25% 低电降速', '100% 满电'],
    },
    {
      kind: 'toggle',
      key: 'estop',
      label: '急停开关 (E-Stop)',
      hint: '触发 on_drive_estop',
      color: '#ef4444',
      default: false,
      emitEvent: {
        eventName: 'on_drive_estop',
        args: ['$value'],
        trigger: 'change',
      },
    },
  ],
};

/**
 * Embedded custom extension pack #2 for the L4 Flagship Robot project:
 * Pan/Tilt PWM servo pack demonstrating:
 * - Custom `toolboxOrder: 35` (slots cleanly between 控制 #30 and 变量 #40)
 * - Isolated per-handle `handleConfigs` (`channel-pool` -> `pwm-servo`, completely independent of `rt.timers`)
 * - Pack-scoped `simWidgets` angle bars
 */
export const FLAGSHIP_PWM_SERVO_PACK: PolyExtensionPack = {
  format: 'polyblock-extension',
  version: 1,
  id: 'pwm-servo',
  name: '云台 PWM 舵机通道包',
  packVersion: '1.0.0',
  iconLabel: '云台',
  color: '#14b8a6',
  tags: ['云台', 'PWM通道'],
  description:
    '项目内嵌自定义通道池外设包：演示独立每句柄 PWM 舵机通道（PWM0~PWM7，与定时器 T0~T7 彻底隔离）以及自定义工具箱序号（#35）。',
  builtin: false,
  imports: {
    lua: ['local servo = require("servo")'],
    python: ['import servo'],
  },
  sections: [
    {
      id: 'main',
      label: '云台',
      toolboxOrder: 35,
      handleConfigs: [
        {
          kind: 'channel-pool',
          label: 'PWM 舵机通道',
          prefix: 'PWM',
          min: 1,
          max: 8,
          defaultCount: 4,
          presets: [2, 4, 8],
          hint: '独立存储在 capabilityConfigs["pwm-servo"]，与多路编号定时器 T0~T7 完全隔离；右键积木可就地标注轴名称。',
        },
      ],
      blocks: [
        {
          type: 'ext_servo_set_angle',
          kind: 'statement',
          message0: '设置舵机 %1 角度 %2 °',
          args0: [
            { type: 'field_channel_id', name: 'PWM_ID' },
            { type: 'input_value', name: 'ANGLE', check: 'Number' },
          ],
          inputsInline: true,
          fields: { PWM_ID: '0' },
          shadows: { ANGLE: { type: 'math_number', value: 90 } },
          tooltip: '设置指定 PWM 舵机通道的目标角度（0~180°）。',
          keywords: '舵机 云台 pwm 角度 servo set_angle',
          simWidgetKeys: ['pan_deg', 'tilt_deg'],
          lua: {
            template:
              'servo.set_angle({{PWM_ID:int}}, {{ANGLE}}){{PWM_ID:channel_comment_lua}}',
          },
          python: {
            template:
              'servo.set_angle({{PWM_ID:int}}, {{ANGLE}}){{PWM_ID:channel_comment_py}}',
          },
        },
        {
          type: 'ext_servo_center_all',
          kind: 'statement',
          message0: '云台全部舵机归中 (90°)',
          inputsInline: true,
          tooltip: '将偏航（PWM0）与俯仰（PWM1）舵机同步归中至 90°。',
          keywords: '云台 舵机 归中 center servo',
          simWidgetKeys: ['pan_deg', 'tilt_deg'],
          lua: { template: 'servo.center_all()' },
          python: { template: 'servo.center_all()' },
        },
      ],
    },
  ],
  sandboxMock: {
    moduleName: 'servo',
    luaSource: `
local M = {}
function M.set_angle(ch, deg)
  local cid = math.floor(tonumber(ch) or 0)
  local d = math.max(0, math.min(180, math.floor(tonumber(deg) or 90)))
  if cid == 1 then
    __poly_sim_set("tilt_deg", d)
  else
    __poly_sim_set("pan_deg", d)
  end
end
function M.center_all()
  __poly_sim_set("pan_deg", 90)
  __poly_sim_set("tilt_deg", 90)
end
return M
`,
    pythonSource: `
import _poly
def set_angle(ch, deg):
    cid = int(float(ch))
    d = max(0, min(180, int(float(deg))))
    if cid == 1:
        _poly.sim_set("tilt_deg", d)
    else:
        _poly.sim_set("pan_deg", d)
def center_all():
    _poly.sim_set("pan_deg", 90)
    _poly.sim_set("tilt_deg", 90)
`,
  },
  simWidgets: [
    {
      kind: 'bar',
      key: 'pan_deg',
      label: '云台偏航角 (PWM0)',
      hint: 'servo.set_angle(0)',
      min: 0,
      max: 180,
      unit: '°',
      color: '#14b8a6',
      default: 90,
    },
    {
      kind: 'bar',
      key: 'tilt_deg',
      label: '云台俯仰角 (PWM1)',
      hint: 'servo.set_angle(1)',
      min: 0,
      max: 180,
      unit: '°',
      color: '#8b5cf6',
      default: 90,
    },
  ],
};

/**
 * L2 Medium Extra Script (`dict_config`): demonstrates dict-json + clock-timer + board button polling.
 */
export const MEDIUM_DICT_CONFIG_WS: Record<string, unknown> = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'poly_on_start',
        id: 'md_start',
        x: 36,
        y: 28,
        inputs: {
          BODY: {
            block: {
              type: 'ext_clock_reset',
              id: 'md_clk_rst',
              next: {
                block: {
                  type: 'variables_set',
                  id: 'md_cfg_new',
                  fields: { VAR: { id: 'var_md_cfg' } },
                  inputs: {
                    VALUE: { block: { type: 'ext_dict_new', id: 'md_dict_lit' } },
                  },
                  next: {
                    block: {
                      type: 'ext_dict_set',
                      id: 'md_set_mode',
                      fields: { DICT: { id: 'var_md_cfg' } },
                      inputs: {
                        KEY: { block: { type: 'text', id: 'md_k1', fields: { TEXT: 'mode' } } },
                        VAL: { block: { type: 'text', id: 'md_v1', fields: { TEXT: 'SMART_ECO' } } },
                      },
                      next: {
                        block: {
                          type: 'ext_dict_set',
                          id: 'md_set_limit',
                          fields: { DICT: { id: 'var_md_cfg' } },
                          inputs: {
                            KEY: { block: { type: 'text', id: 'md_k2', fields: { TEXT: 'limit' } } },
                            VAL: { block: { type: 'math_number', id: 'md_v2', fields: { NUM: 35 } } },
                          },
                          next: {
                            block: {
                              type: 'ext_board_oled_clear',
                              id: 'md_oled_clr',
                              next: {
                                block: {
                                  type: 'ext_board_oled',
                                  id: 'md_oled_mode',
                                  inputs: {
                                    TEXT: {
                                      block: {
                                        type: 'ext_str_replace',
                                        id: 'md_rep',
                                        inputs: {
                                          SRC: { block: { type: 'text', id: 'md_src', fields: { TEXT: 'MODE: {M}' } } },
                                          OLD: { block: { type: 'text', id: 'md_old', fields: { TEXT: '{M}' } } },
                                          NEW: {
                                            block: {
                                              type: 'ext_dict_get',
                                              id: 'md_get_m',
                                              fields: { DICT: { id: 'var_md_cfg' } },
                                              inputs: {
                                                KEY: { block: { type: 'text', id: 'md_gk', fields: { TEXT: 'mode' } } },
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
                                      id: 'md_print_lim',
                                      fields: { LABEL: '字典阈值 °C' },
                                      inputs: {
                                        VALUE: {
                                          block: {
                                            type: 'ext_dict_get',
                                            id: 'md_get_lim',
                                            fields: { DICT: { id: 'var_md_cfg' } },
                                            inputs: {
                                              KEY: { block: { type: 'text', id: 'md_gk2', fields: { TEXT: 'limit' } } },
                                            },
                                          },
                                        },
                                      },
                                      next: {
                                        block: {
                                          type: 'poly_print_kv',
                                          id: 'md_print_ms',
                                          fields: { LABEL: '配置加载耗时 ms' },
                                          inputs: {
                                            VALUE: { block: { type: 'ext_clock_millis', id: 'md_ms' } },
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
  variables: [{ name: 'cfg', id: 'var_md_cfg' }],
};

/**
 * L4 Flagship Handle #1 (`drive_ctrl`) Entry Script: `motion_ctrl`
 * Combines: on_start, on_run (battery-adaptive speed with local var), on_timer(T0 pan scan + T1 turbo reset),
 * on_button(A turbo sprint), custom declarative hat on_drive_estop(press/release), and on_stop safe shutdown!
 */
export const FLAGSHIP_DRIVE_CTRL_WS: Record<string, unknown> = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'poly_on_start',
        id: 'fg_d_start',
        x: 36,
        y: 28,
        inputs: {
          BODY: {
            block: {
              type: 'variables_set',
              id: 'fg_d_init_spd',
              fields: { VAR: { id: 'var_fg_spd' } },
              inputs: {
                VALUE: { block: { type: 'math_number', id: 'fg_d_60', fields: { NUM: 60 } } },
              },
              next: {
                block: {
                  type: 'variables_set',
                  id: 'fg_d_init_pan',
                  fields: { VAR: { id: 'var_fg_pan' } },
                  inputs: {
                    VALUE: { block: { type: 'math_number', id: 'fg_d_45', fields: { NUM: 45 } } },
                  },
                  next: {
                    block: {
                      type: 'ext_servo_center_all',
                      id: 'fg_d_center',
                      next: {
                        block: {
                          type: 'ext_drive_set_wheels',
                          id: 'fg_d_go',
                          inputs: {
                            LEFT: { block: { type: 'variables_get', id: 'fg_d_gl1', fields: { VAR: { id: 'var_fg_spd' } } } },
                            RIGHT: { block: { type: 'variables_get', id: 'fg_d_gr1', fields: { VAR: { id: 'var_fg_spd' } } } },
                          },
                          next: {
                            block: {
                              type: 'poly_set_run_period',
                              id: 'fg_d_set_period',
                              inputs: {
                                MS: {
                                  shadow: {
                                    type: 'math_number',
                                    id: 'fg_d_250',
                                    fields: { NUM: 250 },
                                  },
                                },
                              },
                              next: {
                                block: {
                                  type: 'poly_start_timer',
                                  id: 'fg_d_start_t0',
                                  fields: { TIMER_ID: '0' },
                                  inputs: {
                                    PERIOD_MS: { block: { type: 'math_number', id: 'fg_d_700', fields: { NUM: 700 } } },
                                    REPEAT: { block: { type: 'math_number', id: 'fg_d_inf', fields: { NUM: 0 } } },
                                  },
                                  next: {
                                    block: {
                                      type: 'poly_log',
                                      id: 'fg_d_boot_log',
                                      fields: { LEVEL: 'INFO' },
                                      inputs: {
                                        MESSAGE: {
                                          block: {
                                            type: 'text',
                                            id: 'fg_d_boot_txt',
                                            fields: { TEXT: '底盘与云台控制启动：60% 巡航 + T0 扫描' },
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
        id: 'fg_d_on_run',
        x: 36,
        y: 620,
        inputs: {
          BODY: {
            block: {
              type: 'poly_local_set',
              id: 'fg_d_loc_bat',
              fields: { NAME: 'bat' },
              inputs: {
                VALUE: { block: { type: 'ext_drive_battery', id: 'fg_d_rd_bat' } },
              },
              next: {
                block: {
                  type: 'controls_if',
                  id: 'fg_d_if_not_estop',
                  inputs: {
                    IF0: {
                      block: {
                        type: 'logic_negate',
                        id: 'fg_d_not_es',
                        inputs: {
                          BOOL: { block: { type: 'ext_drive_is_estop', id: 'fg_d_es_chk' } },
                        },
                      },
                    },
                    DO0: {
                      block: {
                        type: 'controls_if',
                        id: 'fg_d_if_lowbat',
                        extraState: { hasElse: true },
                        inputs: {
                          IF0: {
                            block: {
                              type: 'logic_compare',
                              id: 'fg_d_cmp_bat',
                              fields: { OP: 'LT' },
                              inputs: {
                                A: { block: { type: 'poly_local_get', id: 'fg_d_gbat', fields: { NAME: 'bat' } } },
                                B: { block: { type: 'math_number', id: 'fg_d_25', fields: { NUM: 25 } } },
                              },
                            },
                          },
                          DO0: {
                            block: {
                              type: 'ext_drive_set_wheels',
                              id: 'fg_d_slow',
                              inputs: {
                                LEFT: { block: { type: 'math_number', id: 'fg_d_25l', fields: { NUM: 25 } } },
                                RIGHT: { block: { type: 'math_number', id: 'fg_d_25r', fields: { NUM: 25 } } },
                              },
                            },
                          },
                          ELSE: {
                            block: {
                              type: 'ext_drive_set_wheels',
                              id: 'fg_d_norm',
                              inputs: {
                                LEFT: { block: { type: 'variables_get', id: 'fg_d_gl2', fields: { VAR: { id: 'var_fg_spd' } } } },
                                RIGHT: { block: { type: 'variables_get', id: 'fg_d_gr2', fields: { VAR: { id: 'var_fg_spd' } } } },
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
        type: 'poly_on_timer',
        id: 'fg_d_on_t0',
        x: 720,
        y: 28,
        fields: { TIMER_ID: '0' },
        inputs: {
          BODY: {
            block: {
              type: 'controls_if',
              id: 'fg_d_if_pan',
              extraState: { hasElse: true },
              inputs: {
                IF0: {
                  block: {
                    type: 'logic_compare',
                    id: 'fg_d_cmp_pan',
                    fields: { OP: 'LT' },
                    inputs: {
                      A: { block: { type: 'variables_get', id: 'fg_d_gp1', fields: { VAR: { id: 'var_fg_pan' } } } },
                      B: { block: { type: 'math_number', id: 'fg_d_90', fields: { NUM: 90 } } },
                    },
                  },
                },
                DO0: {
                  block: {
                    type: 'variables_set',
                    id: 'fg_d_pan_hi',
                    fields: { VAR: { id: 'var_fg_pan' } },
                    inputs: { VALUE: { block: { type: 'math_number', id: 'fg_d_135', fields: { NUM: 135 } } } },
                  },
                },
                ELSE: {
                  block: {
                    type: 'variables_set',
                    id: 'fg_d_pan_lo',
                    fields: { VAR: { id: 'var_fg_pan' } },
                    inputs: { VALUE: { block: { type: 'math_number', id: 'fg_d_45b', fields: { NUM: 45 } } } },
                  },
                },
              },
              next: {
                block: {
                  type: 'ext_servo_set_angle',
                  id: 'fg_d_pwm0',
                  fields: { PWM_ID: '0' },
                  inputs: {
                    ANGLE: { block: { type: 'variables_get', id: 'fg_d_gp2', fields: { VAR: { id: 'var_fg_pan' } } } },
                  },
                  next: {
                    block: {
                      type: 'ext_servo_set_angle',
                      id: 'fg_d_pwm1',
                      fields: { PWM_ID: '1' },
                      inputs: {
                        ANGLE: { block: { type: 'math_number', id: 'fg_d_tilt90', fields: { NUM: 95 } } },
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
        id: 'fg_d_on_t1',
        x: 720,
        y: 500,
        fields: { TIMER_ID: '1' },
        inputs: {
          BODY: {
            block: {
              type: 'variables_set',
              id: 'fg_d_rst_spd',
              fields: { VAR: { id: 'var_fg_spd' } },
              inputs: { VALUE: { block: { type: 'math_number', id: 'fg_d_60b', fields: { NUM: 60 } } } },
              next: {
                block: {
                  type: 'poly_log',
                  id: 'fg_d_t1_log',
                  fields: { LEVEL: 'INFO' },
                  inputs: {
                    MESSAGE: { block: { type: 'text', id: 'fg_d_t1_txt', fields: { TEXT: 'T1 疾速倒计时结束，恢复 60% 巡航' } } },
                  },
                },
              },
            },
          },
        },
      },
      {
        type: 'poly_on_button',
        id: 'fg_d_btn_a',
        x: 720,
        y: 780,
        fields: { KEY: 'A', EDGE: 'press' },
        inputs: {
          BODY: {
            block: {
              type: 'variables_set',
              id: 'fg_d_turbo_spd',
              fields: { VAR: { id: 'var_fg_spd' } },
              inputs: { VALUE: { block: { type: 'math_number', id: 'fg_d_92', fields: { NUM: 92 } } } },
              next: {
                block: {
                  type: 'poly_start_timer',
                  id: 'fg_d_start_t1',
                  fields: { TIMER_ID: '1' },
                  inputs: {
                    PERIOD_MS: { block: { type: 'math_number', id: 'fg_d_2000', fields: { NUM: 2000 } } },
                    REPEAT: { block: { type: 'math_number', id: 'fg_d_1x', fields: { NUM: 1 } } },
                  },
                  next: {
                    block: {
                      type: 'poly_log',
                      id: 'fg_d_btn_log',
                      fields: { LEVEL: 'WARN' },
                      inputs: {
                        MESSAGE: { block: { type: 'text', id: 'fg_d_btn_txt', fields: { TEXT: '按键 A：开启 2 秒 92% 疾速模式' } } },
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
        type: 'ext_drive_on_estop',
        id: 'fg_d_estop_on',
        x: 1380,
        y: 28,
        fields: { STATE: 'press' },
        inputs: {
          BODY: {
            block: {
              type: 'ext_drive_stop',
              id: 'fg_d_es_stop',
              next: {
                block: {
                  type: 'ext_board_rgb',
                  id: 'fg_d_es_red',
                  fields: { COLOR: '#ef4444' },
                  next: {
                    block: {
                      type: 'ext_board_oled',
                      id: 'fg_d_es_oled',
                      inputs: {
                        TEXT: { block: { type: 'text', id: 'fg_d_es_otxt', fields: { TEXT: 'ESTOP LOCKED!' } } },
                      },
                      next: {
                        block: {
                          type: 'poly_log',
                          id: 'fg_d_es_log',
                          fields: { LEVEL: 'WARN' },
                          inputs: {
                            MESSAGE: { block: { type: 'text', id: 'fg_d_es_ltxt', fields: { TEXT: '自定义中断 on_drive_estop：急停触发已刹停' } } },
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
        type: 'ext_drive_on_estop',
        id: 'fg_d_estop_off',
        x: 1380,
        y: 420,
        fields: { STATE: 'release' },
        inputs: {
          BODY: {
            block: {
              type: 'ext_board_rgb',
              id: 'fg_d_es_grn',
              fields: { COLOR: '#10b981' },
              next: {
                block: {
                  type: 'ext_board_oled',
                  id: 'fg_d_es_clr',
                  inputs: {
                    TEXT: { block: { type: 'text', id: 'fg_d_es_ctxt', fields: { TEXT: 'ESTOP CLEARED' } } },
                  },
                  next: {
                    block: {
                      type: 'poly_log',
                      id: 'fg_d_es_rlog',
                      fields: { LEVEL: 'OK' },
                      inputs: {
                        MESSAGE: { block: { type: 'text', id: 'fg_d_es_rltxt', fields: { TEXT: '急停已解除，恢复自动巡航' } } },
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
        id: 'fg_d_on_stop',
        x: 1380,
        y: 760,
        inputs: {
          BODY: {
            block: {
              type: 'ext_drive_stop',
              id: 'fg_d_stop_drv',
              next: {
                block: {
                  type: 'ext_servo_center_all',
                  id: 'fg_d_stop_srv',
                  next: {
                    block: {
                      type: 'poly_log',
                      id: 'fg_d_stop_log',
                      fields: { LEVEL: 'OK' },
                      inputs: {
                        MESSAGE: { block: { type: 'text', id: 'fg_d_stop_txt', fields: { TEXT: 'drive_ctrl 已安全刹停并归中云台' } } },
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
    { name: 'target_speed', id: 'var_fg_spd' },
    { name: 'pan_angle', id: 'var_fg_pan' },
  ],
};

/**
 * L4 Flagship Handle #1 Aux Module (`patrol_test`): defines reusable helper function `run_patrol_check()`
 * (NO duplicate `on_start` — each handle owns exactly one `on_start` in `main.lua`).
 */
export const FLAGSHIP_PATROL_TEST_WS: Record<string, unknown> = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'procedures_defnoreturn',
        id: 'fg_p_fn',
        x: 36,
        y: 28,
        fields: { NAME: 'run_patrol_check' },
        inputs: {
          STACK: {
            block: {
              type: 'ext_servo_set_angle',
              id: 'fg_p_s1',
              fields: { PWM_ID: '0' },
              inputs: { ANGLE: { block: { type: 'math_number', id: 'fg_p_30', fields: { NUM: 30 } } } },
              next: {
                block: {
                  type: 'ext_drive_set_wheels',
                  id: 'fg_p_go',
                  inputs: {
                    LEFT: { block: { type: 'math_number', id: 'fg_p_70l', fields: { NUM: 70 } } },
                    RIGHT: { block: { type: 'math_number', id: 'fg_p_50r', fields: { NUM: 50 } } },
                  },
                  next: {
                    block: {
                      type: 'poly_wait_ms',
                      id: 'fg_p_wait',
                      inputs: { MS: { shadow: { type: 'math_number', id: 'fg_p_300', fields: { NUM: 300 } } } },
                      next: {
                        block: {
                          type: 'ext_drive_stop',
                          id: 'fg_p_stop',
                          next: {
                            block: {
                              type: 'ext_servo_center_all',
                              id: 'fg_p_ctr',
                              next: {
                                block: {
                                  type: 'poly_log',
                                  id: 'fg_p_done',
                                  fields: { LEVEL: 'OK' },
                                  inputs: {
                                    MESSAGE: { block: { type: 'text', id: 'fg_p_ok', fields: { TEXT: '底盘差速与云台自检函数执行完成！' } } },
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

/**
 * L4 Flagship Handle #2 (`sensor_guard`) Entry Script: `thermal_watch`
 * Runs concurrently on its own isolated lua_State* & own T0 (`温度巡检`)!
 */
export const FLAGSHIP_SENSOR_GUARD_WS: Record<string, unknown> = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'poly_on_start',
        id: 'fg_s_start',
        x: 32,
        y: 28,
        inputs: {
          BODY: {
            block: {
              type: 'variables_set',
              id: 'fg_s_init_cnt',
              fields: { VAR: { id: 'var_fg_alarms' } },
              inputs: { VALUE: { block: { type: 'math_number', id: 'fg_s_0', fields: { NUM: 0 } } } },
              next: {
                block: {
                  type: 'variables_set',
                  id: 'fg_s_init_led',
                  fields: { VAR: { id: 'var_fg_led' } },
                  inputs: { VALUE: { block: { type: 'logic_boolean', id: 'fg_s_f', fields: { BOOL: 'FALSE' } } } },
                  next: {
                    block: {
                      type: 'ext_board_oled_clear',
                      id: 'fg_s_clr',
                      next: {
                        block: {
                          type: 'ext_board_oled',
                          id: 'fg_s_oled0',
                          inputs: {
                            TEXT: { block: { type: 'text', id: 'fg_s_otxt', fields: { TEXT: 'Robot Guard Online' } } },
                          },
                          next: {
                            block: {
                              type: 'poly_start_timer',
                              id: 'fg_s_t0',
                              fields: { TIMER_ID: '0' },
                              inputs: {
                                PERIOD_MS: { block: { type: 'math_number', id: 'fg_s_600', fields: { NUM: 600 } } },
                                REPEAT: { block: { type: 'math_number', id: 'fg_s_inf', fields: { NUM: 0 } } },
                              },
                              next: {
                                block: {
                                  type: 'poly_log',
                                  id: 'fg_s_log',
                                  fields: { LEVEL: 'INFO' },
                                  inputs: {
                                    MESSAGE: { block: { type: 'text', id: 'fg_s_ltxt', fields: { TEXT: '安防温控句柄就绪（独立 T0 巡检 600ms）' } } },
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
        type: 'poly_on_timer',
        id: 'fg_s_on_t0',
        x: 720,
        y: 28,
        fields: { TIMER_ID: '0' },
        inputs: {
          BODY: {
            block: {
              type: 'poly_local_set',
              id: 'fg_s_ltemp',
              fields: { NAME: 'cur_temp' },
              inputs: { VALUE: { block: { type: 'ext_board_temp', id: 'fg_s_rtemp' } } },
              next: {
                block: {
                  type: 'variables_set',
                  id: 'fg_s_tog',
                  fields: { VAR: { id: 'var_fg_led' } },
                  inputs: {
                    VALUE: {
                      block: {
                        type: 'logic_negate',
                        id: 'fg_s_not_led',
                        inputs: {
                          BOOL: { block: { type: 'variables_get', id: 'fg_s_gled', fields: { VAR: { id: 'var_fg_led' } } } },
                        },
                      },
                    },
                  },
                  next: {
                    block: {
                      type: 'controls_if',
                      id: 'fg_s_if_led',
                      extraState: { hasElse: true },
                      inputs: {
                        IF0: { block: { type: 'variables_get', id: 'fg_s_gled2', fields: { VAR: { id: 'var_fg_led' } } } },
                        DO0: { block: { type: 'ext_board_led', id: 'fg_s_lon', fields: { STATE: 'true' } } },
                        ELSE: { block: { type: 'ext_board_led', id: 'fg_s_loff', fields: { STATE: 'false' } } },
                      },
                      next: {
                        block: {
                          type: 'controls_if',
                          id: 'fg_s_if_hot',
                          extraState: { hasElse: true },
                          inputs: {
                            IF0: {
                              block: {
                                type: 'logic_compare',
                                id: 'fg_s_cmp',
                                fields: { OP: 'GT' },
                                inputs: {
                                  A: { block: { type: 'poly_local_get', id: 'fg_s_gt', fields: { NAME: 'cur_temp' } } },
                                  B: { block: { type: 'math_number', id: 'fg_s_35', fields: { NUM: 35 } } },
                                },
                              },
                            },
                            DO0: {
                              block: {
                                type: 'math_change',
                                id: 'fg_s_inc',
                                fields: { VAR: { id: 'var_fg_alarms' } },
                                inputs: { DELTA: { block: { type: 'math_number', id: 'fg_s_1', fields: { NUM: 1 } } } },
                                next: {
                                  block: {
                                    type: 'ext_board_rgb',
                                    id: 'fg_s_red',
                                    fields: { COLOR: '#ef4444' },
                                    next: {
                                      block: {
                                        type: 'ext_board_oled',
                                        id: 'fg_s_ohot',
                                        inputs: {
                                          TEXT: { block: { type: 'text', id: 'fg_s_htxt', fields: { TEXT: 'THERMAL ALARM >35C' } } },
                                        },
                                        next: {
                                          block: {
                                            type: 'poly_print_kv',
                                            id: 'fg_s_palarm',
                                            fields: { LABEL: '高温告警累计' },
                                            inputs: {
                                              VALUE: { block: { type: 'variables_get', id: 'fg_s_gal', fields: { VAR: { id: 'var_fg_alarms' } } } },
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
                                type: 'ext_board_rgb',
                                id: 'fg_s_grn',
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
            },
          },
        },
      },
      {
        type: 'poly_on_stop',
        id: 'fg_s_stop',
        x: 36,
        y: 540,
        inputs: {
          BODY: {
            block: {
              type: 'ext_board_led',
              id: 'fg_s_st_led',
              fields: { STATE: 'false' },
              next: {
                block: {
                  type: 'ext_board_rgb',
                  id: 'fg_s_st_rgb',
                  fields: { COLOR: '#1e293b' },
                  next: {
                    block: {
                      type: 'poly_log',
                      id: 'fg_s_st_log',
                      fields: { LEVEL: 'OK' },
                      inputs: {
                        MESSAGE: { block: { type: 'text', id: 'fg_s_st_txt', fields: { TEXT: 'sensor_guard 已安全熄灯停机' } } },
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
    { name: 'alarm_count', id: 'var_fg_alarms' },
    { name: 'led_blink', id: 'var_fg_led' },
  ],
};

/**
 * L4 Flagship Handle #3 (`telemetry_hub`) Entry Script: `metrics_report`
 * Uses `clock-timer` + `dict-json` + its own 3rd isolated T0 (`遥测上报`)!
 */
export const FLAGSHIP_TELEMETRY_HUB_WS: Record<string, unknown> = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'poly_on_start',
        id: 'fg_t_start',
        x: 32,
        y: 28,
        inputs: {
          BODY: {
            block: {
              type: 'variables_set',
              id: 'fg_t_seq0',
              fields: { VAR: { id: 'var_fg_seq' } },
              inputs: { VALUE: { block: { type: 'math_number', id: 'fg_t_0', fields: { NUM: 0 } } } },
              next: {
                block: {
                  type: 'variables_set',
                  id: 'fg_t_rep0',
                  fields: { VAR: { id: 'var_fg_report' } },
                  inputs: { VALUE: { block: { type: 'ext_dict_new', id: 'fg_t_dnew' } } },
                  next: {
                    block: {
                      type: 'ext_clock_reset',
                      id: 'fg_t_crst',
                      next: {
                        block: {
                          type: 'poly_start_timer',
                          id: 'fg_t_t0',
                          fields: { TIMER_ID: '0' },
                          inputs: {
                            PERIOD_MS: { block: { type: 'math_number', id: 'fg_t_1200', fields: { NUM: 1200 } } },
                            REPEAT: { block: { type: 'math_number', id: 'fg_t_inf', fields: { NUM: 0 } } },
                          },
                          next: {
                            block: {
                              type: 'poly_log',
                              id: 'fg_t_log',
                              fields: { LEVEL: 'INFO' },
                              inputs: {
                                MESSAGE: { block: { type: 'text', id: 'fg_t_ltxt', fields: { TEXT: '遥测统计句柄就绪（秒表 + 字典打包上报）' } } },
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
        type: 'poly_on_timer',
        id: 'fg_t_on_t0',
        x: 720,
        y: 28,
        fields: { TIMER_ID: '0' },
        inputs: {
          BODY: {
            block: {
              type: 'math_change',
              id: 'fg_t_inc',
              fields: { VAR: { id: 'var_fg_seq' } },
              inputs: { DELTA: { block: { type: 'math_number', id: 'fg_t_1', fields: { NUM: 1 } } } },
              next: {
                block: {
                  type: 'poly_local_set',
                  id: 'fg_t_up',
                  fields: { NAME: 'uptime_ms' },
                  inputs: { VALUE: { block: { type: 'ext_clock_millis', id: 'fg_t_ms' } } },
                  next: {
                    block: {
                      type: 'ext_dict_set',
                      id: 'fg_t_d1',
                      fields: { DICT: { id: 'var_fg_report' } },
                      inputs: {
                        KEY: { block: { type: 'text', id: 'fg_t_k1', fields: { TEXT: 'uptime_ms' } } },
                        VAL: { block: { type: 'poly_local_get', id: 'fg_t_gup', fields: { NAME: 'uptime_ms' } } },
                      },
                      next: {
                        block: {
                          type: 'ext_dict_set',
                          id: 'fg_t_d2',
                          fields: { DICT: { id: 'var_fg_report' } },
                          inputs: {
                            KEY: { block: { type: 'text', id: 'fg_t_k2', fields: { TEXT: 'temp' } } },
                            VAL: { block: { type: 'ext_board_temp', id: 'fg_t_rt' } },
                          },
                          next: {
                            block: {
                              type: 'ext_dict_set',
                              id: 'fg_t_d3',
                              fields: { DICT: { id: 'var_fg_report' } },
                              inputs: {
                                KEY: { block: { type: 'text', id: 'fg_t_k3', fields: { TEXT: 'battery' } } },
                                VAL: { block: { type: 'ext_drive_battery', id: 'fg_t_rb' } },
                              },
                              next: {
                                block: {
                                  type: 'poly_print_kv',
                                  id: 'fg_t_pseq',
                                  fields: { LABEL: '遥测帧 #' },
                                  inputs: {
                                    VALUE: { block: { type: 'variables_get', id: 'fg_t_gseq', fields: { VAR: { id: 'var_fg_seq' } } } },
                                  },
                                  next: {
                                    block: {
                                      type: 'poly_print_kv',
                                      id: 'fg_t_pms',
                                      fields: { LABEL: '累计运行 ms' },
                                      inputs: {
                                        VALUE: {
                                          block: {
                                            type: 'ext_dict_get',
                                            id: 'fg_t_gms',
                                            fields: { DICT: { id: 'var_fg_report' } },
                                            inputs: {
                                              KEY: { block: { type: 'text', id: 'fg_t_gk1', fields: { TEXT: 'uptime_ms' } } },
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
        type: 'poly_on_stop',
        id: 'fg_t_stop',
        x: 36,
        y: 500,
        inputs: {
          BODY: {
            block: {
              type: 'poly_log',
              id: 'fg_t_st_log',
              fields: { LEVEL: 'OK' },
              inputs: {
                MESSAGE: { block: { type: 'text', id: 'fg_t_st_txt', fields: { TEXT: 'telemetry_hub 遥测上报已停止' } } },
              },
            },
          },
        },
      },
    ],
  },
  variables: [
    { name: 'seq', id: 'var_fg_seq' },
    { name: 'report', id: 'var_fg_report' },
  ],
};
