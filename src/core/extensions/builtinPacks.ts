import type { PolyExtensionPack } from './types';

/**
 * Unified built-in embedded runtime pack (`rt`).
 * Single C-module pack (`require("rt")` / `import rt`) organized into 3 declarative sections:
 *  - `rt.lifecycle` -> injected into core `事件` category (`on_run`, `on_stop`, run period/control)
 *  - `rt.timers`    -> standalone `定时` (#15) category with per-handle `0..31` channel-pool config
 *  - `rt.tick`      -> standalone `时钟` (#18) category (`rt.tick`, `rt.ms_to_tick`, `rt.is_expired`)
 * Projects & board profiles may enable the whole pack (`"rt"`) or finely prune individual sections (`"rt.tick"`).
 */
export const RT_PACK: PolyExtensionPack = {
  format: 'polyblock-extension',
  version: 1,
  id: 'rt',
  name: '嵌入式运行时核心包 (rt)',
  packVersion: '1.0.0',
  iconLabel: '运行',
  color: '#6366f1',
  description:
    '统一对应嵌入式 C 端 rt 模块：内含「周期事件」「多路定时 (0~31 通道池)」「系统时钟 (rt.tick)」3 个可裁剪组件，各自按声明配置独立决定侧边栏归属与排序。',
  builtin: true,
  tags: ['RTOS 核心'],
  imports: {
    lua: ['local rt = require("rt")'],
    python: ['import rt'],
  },
  sections: [
    {
      id: 'lifecycle',
      label: '周期事件',
      description: '常驻周期回调 on_run（默认使能，可动态调频/启停）与安全停机 on_stop',
      visible: true,
      categoryTarget: 'event',
      color: '#e0911f',
      blocks: [
        {
          type: 'poly_on_run',
          kind: 'hat',
          message0: '当周期运行触发时',
          inputsInline: true,
          blockStyle: 'event_blocks',
          tooltip:
            '周期主回调（on_run，默认使能、每 100ms 触发一次；可在「当程序启动」或运行中用「设置周期运行间隔」调整频率）。',
          keywords: '当周期运行 触发 on_run 周期 主循环 loop 回调 100ms',
          hat: {
            eventName: 'on_run',
            params: [],
            mode: 'singleton',
            scopeLabelTemplate: 'on_run (周期运行)',
            scopeShortTemplate: 'on_run',
            scopeCategory: 'lifecycle',
            // Managed by periodic `hasRun && runActive` scheduler, not as an always-on external IRQ listener
            keepsAlive: false,
          },
        },
        {
          type: 'poly_set_run_period',
          kind: 'statement',
          message0: '设置周期运行间隔为 %1 ms',
          args0: [{ type: 'input_value', name: 'MS', check: 'Number' }],
          inputsInline: true,
          blockStyle: 'event_stmt_blocks',
          shadows: { MS: { type: 'math_number', value: 100 } },
          tooltip:
            '设置或动态修改周期运行（on_run）的触发间隔（毫秒），调用后立即按新周期重新计时生效（对应 rt.set_run_period）。',
          keywords: '设置 on_run 周期运行 间隔 period ms 频率',
          lua: { template: 'rt.set_run_period({{MS}})' },
          python: { template: 'rt.set_run_period({{MS}})' },
        },
        {
          type: 'poly_run_control',
          kind: 'statement',
          message0: '%1 周期运行',
          args0: [
            {
              type: 'field_dropdown',
              name: 'ACTION',
              options: [
                ['启动', 'start_run'],
                ['停止', 'stop_run'],
              ],
            },
          ],
          inputsInline: true,
          blockStyle: 'event_stmt_blocks',
          fields: { ACTION: 'stop_run' },
          tooltip:
            '在运行时启动或暂停周期运行调度（默认使能为 1，对应 rt.start_run / rt.stop_run）。',
          keywords: '启动 停止 暂停 on_run 周期运行 start_run stop_run',
          lua: { template: 'rt.{{ACTION}}()' },
          python: { template: 'rt.{{ACTION}}()' },
        },
        {
          type: 'poly_on_stop',
          kind: 'hat',
          message0: '当程序停止',
          inputsInline: true,
          blockStyle: 'event_blocks',
          tooltip:
            '手动停止常驻事件循环时自动执行一次收尾清理（生成顶层 on_stop 回调，如熄灭 LED / 复位输出）。',
          keywords: '当程序停止 on_stop 退出 收尾 清理 事件',
          hat: {
            eventName: 'on_stop',
            params: [],
            mode: 'singleton',
            scopeLabelTemplate: 'on_stop (安全停机)',
            scopeShortTemplate: 'on_stop',
            scopeCategory: 'lifecycle',
            keepsAlive: false,
          },
        },
      ],
    },
    {
      id: 'timers',
      label: '定时',
      description: '每句柄独立整数通道定时器池（0~31 路）、画布就地别名与独立全局 on_timer_N 分发',
      visible: true,
      categoryTarget: 'own',
      toolboxOrder: 15,
      color: '#6366f1',
      handleConfigs: [
        {
          kind: 'channel-pool',
          label: '定时器通道',
          prefix: 'T',
          min: 1,
          max: 32,
          defaultCount: 8,
          presets: [4, 8, 16, 32],
          hint: '每个隔离句柄（独立 lua_State*）独享自己的定时器池与别名，彼此绝不窜扰；在画布上右键任意定时器积木也可就地修改别名。',
        },
      ],
      blocks: [
        {
          type: 'poly_on_timer',
          kind: 'hat',
          message0: '当定时器 %1 触发时',
          args0: [{ type: 'field_channel_id', name: 'TIMER_ID' }],
          inputsInline: true,
          blockStyle: 'timer_hat_blocks',
          fields: { TIMER_ID: '0' },
          tooltip:
            '绑定指定通道 ID 的定时器到期回调：拆分为独立全局函数 on_timer_<id>()，并自动生成轻量 on_timer(id) 路由分发（零闭包）。',
          keywords: '当定时器 触发 回调 on_timer timer id 通道',
          hat: {
            eventName: 'on_timer',
            params: ['id'],
            mode: 'dispatch',
            extractBranchFnPrefix: 'on_timer_',
            conditionLua: 'id == {{TIMER_ID:int}}',
            conditionPython: 'id == {{TIMER_ID:int}}',
            branchCommentLua: '{{TIMER_ID:channel_comment_lua}}',
            branchCommentPython: '{{TIMER_ID:channel_comment_py}}',
            duplicateKeyTemplate: '{{TIMER_ID:int}}',
            scopeLabelTemplate: 'on_timer · {{TIMER_ID:channel_label}}',
            scopeShortTemplate: 'T{{TIMER_ID:int}}',
            scopeCategory: 'event',
            keepsAlive: false,
          },
        },
        {
          type: 'poly_start_timer',
          kind: 'statement',
          message0: '启动定时器 %1 周期 %2 ms 重复 %3 次',
          args0: [
            { type: 'field_channel_id', name: 'TIMER_ID' },
            { type: 'input_value', name: 'PERIOD_MS', check: 'Number' },
            { type: 'input_value', name: 'REPEAT', check: 'Number' },
          ],
          inputsInline: true,
          blockStyle: 'timer_blocks',
          fields: { TIMER_ID: '0' },
          shadows: {
            PERIOD_MS: { type: 'math_number', value: 500 },
            REPEAT: { type: 'math_number', value: 0 },
          },
          tooltip:
            '启动或重置指定通道定时器（rt.start_timer(id, period_ms, repeat)）：repeat=0 持续循环，1 单次，N 触发 N 次后停止。',
          keywords: '启动定时器 start_timer 周期 重复 循环 单次 timer',
          lua: {
            template:
              'rt.start_timer({{TIMER_ID:int}}, {{PERIOD_MS}}, {{REPEAT}}){{TIMER_ID:channel_comment_lua}}',
          },
          python: {
            template:
              'rt.start_timer({{TIMER_ID:int}}, {{PERIOD_MS}}, {{REPEAT}}){{TIMER_ID:channel_comment_py}}',
          },
        },
        {
          type: 'poly_stop_timer',
          kind: 'statement',
          message0: '停止定时器 %1',
          args0: [{ type: 'field_channel_id', name: 'TIMER_ID' }],
          inputsInline: true,
          blockStyle: 'timer_blocks',
          fields: { TIMER_ID: '0' },
          tooltip: '停止指定通道定时器（rt.stop_timer(id)）。',
          keywords: '停止定时器 stop_timer 关闭 取消 timer',
          lua: {
            template: 'rt.stop_timer({{TIMER_ID:int}}){{TIMER_ID:channel_comment_lua}}',
          },
          python: {
            template: 'rt.stop_timer({{TIMER_ID:int}}){{TIMER_ID:channel_comment_py}}',
          },
        },
        {
          type: 'poly_get_timer_value',
          kind: 'value',
          outputType: 'Number',
          message0: '定时器 %1 已过毫秒数',
          args0: [{ type: 'field_channel_id', name: 'TIMER_ID' }],
          inputsInline: true,
          blockStyle: 'timer_blocks',
          fields: { TIMER_ID: '0' },
          tooltip:
            '读取指定定时器本周期已流逝的毫秒数（rt.get_timer_value(id)，0 → period_ms，未运行返回 0）。',
          keywords: '读取 定时器 已过 毫秒 get_timer_value elapsed timer',
          lua: { template: 'rt.get_timer_value({{TIMER_ID:int}})' },
          python: { template: 'rt.get_timer_value({{TIMER_ID:int}})' },
        },
        {
          type: 'poly_is_timer_running',
          kind: 'value',
          outputType: 'Boolean',
          message0: '定时器 %1 正在运行?',
          args0: [{ type: 'field_channel_id', name: 'TIMER_ID' }],
          inputsInline: true,
          blockStyle: 'timer_blocks',
          fields: { TIMER_ID: '0' },
          tooltip: '检查指定通道定时器当前是否处于运行状态（rt.is_timer_running(id)）。',
          keywords: '定时器 正在运行 状态 is_timer_running running timer',
          lua: { template: 'rt.is_timer_running({{TIMER_ID:int}})' },
          python: { template: 'rt.is_timer_running({{TIMER_ID:int}})' },
        },
      ],
    },
    {
      id: 'tick',
      label: '时钟',
      description: '嵌入式系统滴答 rt.tick、毫秒转 tick 与 32 位无符号回绕安全到期判断',
      visible: true,
      categoryTarget: 'own',
      toolboxOrder: 18,
      color: '#0891b2',
      blocks: [
        {
          type: 'poly_rt_tick',
          kind: 'value',
          outputType: 'Number',
          message0: '获取系统 tick',
          tooltip:
            '读取当前 32 位无符号系统滴答计数（对应 rt.tick()，沙箱默认 1000Hz 即 1ms/tick）。',
          keywords: '系统 tick 时钟 滴答 毫秒 rt.tick get_tick uptime',
          lua: { template: 'rt.tick()' },
          python: { template: 'rt.tick()' },
        },
        {
          type: 'poly_rt_ms_to_tick',
          kind: 'value',
          outputType: 'Number',
          message0: '%1 ms 转为 tick',
          args0: [{ type: 'input_value', name: 'MS', check: 'Number' }],
          inputsInline: true,
          shadows: { MS: { type: 'math_number', value: 500 } },
          tooltip:
            '将毫秒时长按目标板 tick 频率向上取整转换为 tick 数（对应 rt.ms_to_tick(ms)）。',
          keywords: '毫秒 转换 tick ms_to_tick 时钟 滴答',
          lua: { template: 'rt.ms_to_tick({{MS}})' },
          python: { template: 'rt.ms_to_tick({{MS}})' },
        },
        {
          type: 'poly_rt_is_expired',
          kind: 'value',
          outputType: 'Boolean',
          message0: '从 %1 起经过 %2 tick 已到期?',
          args0: [
            { type: 'input_value', name: 'START', check: 'Number' },
            { type: 'input_value', name: 'TIMEOUT', check: 'Number' },
          ],
          inputsInline: true,
          shadows: {
            START: { type: 'math_number', value: 0 },
            TIMEOUT: { type: 'math_number', value: 500 },
          },
          tooltip:
            '32 位无符号回绕安全的到期判断（(uint32_t)(now - start) >= timeout），对应 rt.is_expired(start_tick, timeout_ticks)。',
          keywords: '到期 超时 回绕 判断 is_expired tick timeout 时钟',
          lua: { template: 'rt.is_expired({{START}}, {{TIMEOUT}})' },
          python: { template: 'rt.is_expired({{START}}, {{TIMEOUT}})' },
        },
      ],
    },
  ],
  sandboxMock: {
    moduleName: 'rt',
    luaSource: `
local M = {
  set_run_period = __poly_rt_set_run_period,
  start_run = __poly_rt_start_run,
  stop_run = __poly_rt_stop_run,
  start_timer = __poly_rt_start_timer,
  stop_timer = __poly_rt_stop_timer,
  get_timer_value = __poly_rt_get_timer_value,
  is_timer_running = __poly_rt_is_timer_running,
  tick = __poly_rt_tick,
  ms_to_tick = __poly_rt_ms_to_tick,
  is_expired = __poly_rt_is_expired,
}
return M
`.trim(),
    pythonSource: `
import _poly

def set_run_period(ms):
    return _poly.rt_set_run_period(ms)

def start_run():
    return _poly.rt_start_run()

def stop_run():
    return _poly.rt_stop_run()

def start_timer(tid, period_ms, repeat=0):
    return _poly.rt_start_timer(tid, period_ms, repeat)

def stop_timer(tid):
    return _poly.rt_stop_timer(tid)

def get_timer_value(tid):
    return _poly.rt_get_timer_value(tid)

def is_timer_running(tid):
    return _poly.rt_is_timer_running(tid)

def tick():
    return _poly.rt_tick()

def ms_to_tick(ms):
    return _poly.rt_ms_to_tick(ms)

def is_expired(start_tick, timeout_ticks):
    return _poly.rt_is_expired(start_tick, timeout_ticks)
`.trim(),
  },
};

export const VIRTUAL_BOARD_PACK: PolyExtensionPack = {
  format: 'polyblock-extension',
  version: 1,
  id: 'virtual-board',
  name: '虚拟硬件外设包',
  packVersion: '1.0.0',
  iconLabel: '硬件',
  color: '#0ea5e9',
  description:
    '提供板载 LED、三色灯（红/绿/蓝）、OLED 文本屏、温度传感器与按键 A/B 回调积木；导出标准 board 模块代码供真机运行，浏览器沙箱内置实时交互模拟。',
  builtin: true,
  tags: ['示例板卡'],
  imports: {
    lua: ['local board = require("board")'],
    python: ['import board'],
  },
  sections: [
    {
      id: 'main',
      label: '硬件',
      toolboxOrder: 100,
      blocks: [
        {
          type: 'ext_board_led',
          kind: 'statement',
          message0: '设置板载 LED %1',
          args0: [
            {
              type: 'field_dropdown',
              name: 'STATE',
              options: [
                ['点亮 (ON)', 'true'],
                ['熄灭 (OFF)', 'false'],
              ],
            },
          ],
          inputsInline: true,
          tooltip: '控制板载 LED 指示灯亮灭。',
          keywords: 'led 灯 点亮 熄灭 硬件 board gpio',
          simWidgetKeys: ['led'],
          lua: { template: 'board.led({{STATE:bool_lua}})' },
          python: { template: 'board.led({{STATE:bool_py}})' },
        },
        {
          type: 'ext_board_rgb',
          kind: 'statement',
          message0: '设置板载三色灯 %1',
          args0: [
            {
              type: 'field_dropdown',
              name: 'COLOR',
              options: [
                ['红灯 (Red)', '#ef4444'],
                ['绿灯 (Green)', '#10b981'],
                ['蓝灯 (Blue)', '#3b82f6'],
                ['关闭 (OFF)', '#1e293b'],
              ],
            },
          ],
          inputsInline: true,
          tooltip:
            '设置板载三色指示灯（仅红 / 绿 / 蓝三色 + 关闭；需要 256 级全彩调色时请使用全彩 RGB 控件）。',
          keywords: '三色灯 指示灯 红 绿 蓝 tricolor rgb led 硬件 board',
          simWidgetKeys: ['rgb'],
          lua: { template: 'board.rgb({{COLOR:json}})' },
          python: { template: 'board.rgb({{COLOR:json}})' },
        },
        {
          type: 'ext_board_oled',
          kind: 'statement',
          message0: 'OLED 屏幕显示 %1',
          args0: [{ type: 'input_value', name: 'TEXT' }],
          inputsInline: true,
          tooltip: '向板载微型 OLED 屏幕输出一行文本。',
          keywords: 'oled 屏幕 显示 screen display 硬件 board',
          shadows: { TEXT: { type: 'text', value: 'Hello Board!' } },
          simWidgetKeys: ['oled'],
          lua: { template: 'board.oled_show({{TEXT}})' },
          python: { template: 'board.oled_show({{TEXT}})' },
        },
        {
          type: 'ext_board_oled_clear',
          kind: 'statement',
          message0: '清空 OLED 屏幕',
          inputsInline: true,
          tooltip: '清空板载 OLED 屏幕显示内容。',
          keywords: 'oled 清空 clear 屏幕 硬件',
          simWidgetKeys: ['oled'],
          lua: { template: 'board.oled_clear()' },
          python: { template: 'board.oled_clear()' },
        },
        {
          type: 'ext_board_temp',
          kind: 'value',
          outputType: 'Number',
          message0: '读取板载温度 (°C)',
          tooltip: '读取板载温度传感器数值（在沙箱右侧「模拟」面板可实时拖动滑块测试）。',
          keywords: '温度 传感器 sensor temp temperature 硬件 board',
          simWidgetKeys: ['temp'],
          lua: { template: 'board.read_temp()' },
          python: { template: 'board.read_temp()' },
        },
        {
          type: 'ext_board_button',
          kind: 'value',
          outputType: 'Boolean',
          message0: '按键 %1 已按下?',
          args0: [
            {
              type: 'field_dropdown',
              name: 'BTN',
              options: [
                ['按键 A', 'A'],
                ['按键 B', 'B'],
              ],
            },
          ],
          tooltip: '读取板载按键 A / B 是否处于按下状态。',
          keywords: '按键 按钮 button pressed 硬件 board',
          simWidgetKeys: ['btnA', 'btnB'],
          lua: { template: 'board.is_pressed({{BTN:json}})' },
          python: { template: 'board.is_pressed({{BTN:json}})' },
        },
        {
          type: 'poly_on_button',
          kind: 'hat',
          message0: '当按键 %1 %2 时',
          args0: [
            {
              type: 'field_dropdown',
              name: 'KEY',
              options: [
                ['按键 A', 'A'],
                ['按键 B', 'B'],
              ],
            },
            {
              type: 'field_dropdown',
              name: 'EDGE',
              options: [
                ['按下', 'press'],
                ['释放', 'release'],
              ],
            },
          ],
          inputsInline: true,
          blockStyle: 'event_blocks',
          fields: { KEY: 'A', EDGE: 'press' },
          tooltip:
            '硬件按键边沿事件回调，自动聚合成顶层 on_button(key, pressed) 分发函数（零闭包）。',
          keywords: '当按键 按下 释放 回调 硬件 事件 on_button key A B board',
          simWidgetKeys: ['btnA', 'btnB'],
          hat: {
            eventName: 'on_button',
            params: ['key', 'pressed'],
            mode: 'dispatch',
            conditionLua: 'key == {{KEY:json}} and {{EDGE:edge_lua:pressed}}',
            conditionPython: 'key == {{KEY:json}} and {{EDGE:edge_py:pressed}}',
            duplicateKeyTemplate: '{{KEY}}:{{EDGE}}',
            scopeLabelTemplate: 'on_button · 按键 {{KEY}} {{EDGE:edge_zh}}',
            scopeShortTemplate: '按键{{KEY}}',
            scopeCategory: 'event',
            keepsAlive: true,
          },
        },
      ],
    },
  ],
  sandboxMock: {
    moduleName: 'board',
    luaSource: `
local M = {}
function M.led(on)
  __poly_sim_set("led", on and true or false)
end
function M.rgb(color)
  local c = string.lower(tostring(color or ""))
  if c == "red" or c == "#ef4444" or c == "#ff0000" then
    __poly_sim_set("rgb", "#ef4444")
  elseif c == "green" or c == "#10b981" or c == "#00ff00" then
    __poly_sim_set("rgb", "#10b981")
  elseif c == "blue" or c == "#3b82f6" or c == "#0000ff" then
    __poly_sim_set("rgb", "#3b82f6")
  else
    __poly_sim_set("rgb", "#1e293b")
  end
end
function M.oled_show(text)
  __poly_sim_set("oled:append", tostring(text))
end
function M.oled_clear()
  __poly_sim_set("oled:clear", true)
end
function M.read_temp()
  local v = tonumber(__poly_sim_get("temp"))
  return v or 28
end
function M.is_pressed(btn)
  local key = (tostring(btn) == "B") and "btnB" or "btnA"
  return __poly_sim_get(key) == true
end
return M
`,
    pythonSource: `
import _poly
def led(on):
    _poly.sim_set("led", bool(on))
def rgb(color):
    c = str(color or "").lower()
    if c in ("red", "#ef4444", "#ff0000"):
        _poly.sim_set("rgb", "#ef4444")
    elif c in ("green", "#10b981", "#00ff00"):
        _poly.sim_set("rgb", "#10b981")
    elif c in ("blue", "#3b82f6", "#0000ff"):
        _poly.sim_set("rgb", "#3b82f6")
    else:
        _poly.sim_set("rgb", "#1e293b")
def oled_show(text):
    _poly.sim_set("oled:append", str(text))
def oled_clear():
    _poly.sim_set("oled:clear", True)
def read_temp():
    v = _poly.sim_get("temp")
    return float(v) if v is not None else 28.0
def is_pressed(btn):
    key = "btnB" if str(btn) == "B" else "btnA"
    return bool(_poly.sim_get(key))
`,
  },
  simWidgets: [
    {
      kind: 'led',
      key: 'led',
      label: '板载 LED',
      color: '#22c55e',
      default: false,
    },
    {
      kind: 'tricolor',
      key: 'rgb',
      label: '三色灯',
      default: '#1e293b',
    },
    {
      kind: 'screen',
      key: 'oled',
      label: '虚拟 OLED 显示屏',
      maxLines: 4,
      default: ['PolyBlock OLED', '等待脚本输出...'],
    },
    {
      kind: 'slider',
      key: 'temp',
      label: '模拟温度传感器',
      hint: 'board.read_temp',
      min: 15,
      max: 95,
      step: 1,
      unit: '°C',
      default: 28,
      marks: ['15°C (低温)', '35°C (演示阈值)', '95°C (高温)'],
    },
    {
      kind: 'button',
      key: 'btnA',
      label: '按键 A',
      default: false,
      activeLabel: '按下中',
      idleLabel: '释放',
      emitEvent: {
        eventName: 'on_button',
        args: ['A', '$value'],
        trigger: 'change',
      },
    },
    {
      kind: 'button',
      key: 'btnB',
      label: '按键 B',
      default: false,
      activeLabel: '按下中',
      idleLabel: '释放',
      emitEvent: {
        eventName: 'on_button',
        args: ['B', '$value'],
        trigger: 'change',
      },
    },
  ],
};

export const CLOCK_TIMER_PACK: PolyExtensionPack = {
  format: 'polyblock-extension',
  version: 1,
  id: 'clock-timer',
  name: '秒表与计时器包',
  packVersion: '1.0.0',
  iconLabel: '计时',
  color: '#a855f7',
  description:
    '提供高精度毫秒秒表积木，便于测量循环耗时、定时轮询与节拍控制。',
  builtin: true,
  tags: ['计时工具'],
  imports: {
    lua: ['local poly_clock = require("poly_clock")'],
    python: ['import poly_clock'],
  },
  sections: [
    {
      id: 'main',
      label: '计时',
      toolboxOrder: 120,
      blocks: [
        {
          type: 'ext_clock_millis',
          kind: 'value',
          outputType: 'Number',
          message0: '已运行毫秒数 (ms)',
          tooltip: '返回从脚本启动或上次重置秒表以来经过的毫秒数。',
          keywords: '时间 计时器 毫秒 millis timer clock elapsed',
          lua: { template: 'poly_clock.millis()' },
          python: { template: 'poly_clock.millis()' },
        },
        {
          type: 'ext_clock_reset',
          kind: 'statement',
          message0: '重置秒表计时器',
          tooltip: '将当前秒表起点重置为 0ms。',
          keywords: '重置 计时器 秒表 reset timer clock',
          lua: { template: 'poly_clock.reset()' },
          python: { template: 'poly_clock.reset()' },
        },
      ],
    },
  ],
  sandboxMock: {
    moduleName: 'poly_clock',
    luaSource: `
local M = {}
local base_ms = __poly_now_ms()
function M.millis()
  return math.floor(__poly_now_ms() - base_ms)
end
function M.reset()
  base_ms = __poly_now_ms()
end
return M
`,
    pythonSource: `
import _poly
_base_ms = _poly.now_ms()
def millis():
    return int(_poly.now_ms() - _base_ms)
def reset():
    global _base_ms
    _base_ms = _poly.now_ms()
`,
  },
};

export const BUILTIN_EXTENSION_PACKS: PolyExtensionPack[] = [
  RT_PACK,
  VIRTUAL_BOARD_PACK,
  CLOCK_TIMER_PACK,
];

/** Clean downloadable JSON template showing users how to author custom .polyext.json packs in the unified single-track schema. */
export const SAMPLE_CUSTOM_EXTENSION_TEMPLATE: PolyExtensionPack = {
  $schema: './schemas/polyext.schema.json',
  format: 'polyblock-extension',
  version: 1,
  id: 'my-robot-api',
  name: '自定义机器人控制包（示例模板）',
  packVersion: '1.0.0',
  iconLabel: '机器人',
  color: '#ec4899',
  tags: ['机器人', '运动控制'],
  description:
    '演示单轨声明式 .polyext.json 规范：包级默认 imports + sections[] 内嵌积木 + 事件回调帽块 (hat) + 积木级 simWidgetKeys 关联 + 双语沙箱模拟桩。',
  imports: {
    lua: ['local robot = require("robot")'],
    python: ['import robot'],
  },
  sections: [
    {
      id: 'main',
      label: '机器人',
      toolboxOrder: 100,
      blocks: [
        {
          type: 'ext_robot_move',
          kind: 'statement',
          message0: '机器人 %1 速度 %2',
          args0: [
            {
              type: 'field_dropdown',
              name: 'DIR',
              options: [
                ['前进', 'forward'],
                ['后退', 'backward'],
                ['左转', 'left'],
                ['右转', 'right'],
              ],
            },
            { type: 'input_value', name: 'SPEED', check: 'Number' },
          ],
          inputsInline: true,
          tooltip: '控制机器人沿指定方向以给定速度移动。',
          keywords: '机器人 移动 速度 robot move',
          shadows: { SPEED: { type: 'math_number', value: 60 } },
          simWidgetKeys: ['moving', 'speed', 'log'],
          lua: { template: 'robot.move({{DIR:json}}, {{SPEED}})' },
          python: { template: 'robot.move({{DIR:json}}, {{SPEED}})' },
        },
        {
          type: 'ext_robot_battery',
          kind: 'value',
          outputType: 'Number',
          message0: '读取机器人电量 (%)',
          tooltip: '获取机器人当前剩余电量百分比。',
          keywords: '机器人 电量 电池 battery',
          simWidgetKeys: ['battery'],
          lua: { template: 'robot.battery()' },
          python: { template: 'robot.battery()' },
        },
        {
          type: 'ext_robot_on_estop',
          kind: 'hat',
          message0: '当机器人急停 %1 时',
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
          tooltip: '自定义硬件中断回调示例：聚合成顶层 on_robot_estop(active) 函数。',
          keywords: '机器人 急停 回调 estop hat 事件',
          simWidgetKeys: ['estop'],
          hat: {
            eventName: 'on_robot_estop',
            params: ['active'],
            mode: 'dispatch',
            conditionLua: '{{STATE:edge_lua:active}}',
            conditionPython: '{{STATE:edge_py:active}}',
            duplicateKeyTemplate: '{{STATE}}',
            scopeLabelTemplate: 'on_robot_estop · {{STATE:edge_zh}}',
            scopeShortTemplate: '急停',
            scopeCategory: 'event',
            keepsAlive: true,
          },
        },
      ],
    },
  ],
  sandboxMock: {
    moduleName: 'robot',
    luaSource: `
local M = {}
function M.move(dir, speed)
  if __poly_sim_get("estop") == true then
    __poly_sim_set("moving", false)
    __poly_sim_set("speed", 0)
    __poly_sim_set("log:append", "[ESTOP] 急停已触发，忽略移动指令")
    print("[WARN] [Mock Robot] E-Stop active, move ignored")
    return
  end
  local spd = tonumber(speed) or 0
  __poly_sim_set("moving", spd > 0)
  __poly_sim_set("speed", spd)
  __poly_sim_set("log:append", "move(" .. tostring(dir) .. ", " .. tostring(spd) .. "%)")
  print("[INFO] [Mock Robot] move(" .. tostring(dir) .. ", speed=" .. tostring(spd) .. ")")
end
function M.battery()
  local v = tonumber(__poly_sim_get("battery"))
  return v or 88
end
return M
`,
    pythonSource: `
import _poly
def move(dir_name, speed):
    if _poly.sim_get("estop") is True:
        _poly.sim_set("moving", False)
        _poly.sim_set("speed", 0)
        _poly.sim_set("log:append", "[ESTOP] 急停已触发，忽略移动指令")
        print("[WARN] [Mock Robot] E-Stop active, move ignored")
        return
    spd = float(speed)
    _poly.sim_set("moving", spd > 0)
    _poly.sim_set("speed", spd)
    _poly.sim_set("log:append", f"move({dir_name}, {int(spd)}%)")
    print("[INFO] [Mock Robot] move(" + str(dir_name) + ", speed=" + str(speed) + ")")
def battery():
    v = _poly.sim_get("battery")
    return int(v) if v is not None else 88
`,
  },
  simWidgets: [
    {
      kind: 'led',
      key: 'moving',
      label: '运动状态',
      color: '#10b981',
      default: false,
    },
    {
      kind: 'bar',
      key: 'speed',
      label: '当前车速',
      hint: 'robot.move',
      min: 0,
      max: 100,
      unit: '%',
      color: '#ec4899',
      default: 0,
    },
    {
      kind: 'screen',
      key: 'log',
      label: '机器人指令终端',
      maxLines: 3,
      default: ['[Robot Ready] 等待指令...'],
    },
    {
      kind: 'slider',
      key: 'battery',
      label: '模拟电池电量',
      hint: 'robot.battery',
      min: 0,
      max: 100,
      step: 1,
      unit: '%',
      default: 88,
      marks: ['0% 亏电', '20% 预警', '100% 满电'],
    },
    {
      kind: 'toggle',
      key: 'estop',
      label: '急停开关 (E-Stop)',
      color: '#ef4444',
      default: false,
      emitEvent: {
        eventName: 'on_robot_estop',
        args: ['$value'],
        trigger: 'change',
      },
    },
  ],
};
