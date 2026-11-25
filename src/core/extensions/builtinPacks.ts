import type { PolyExtensionPack } from './types';

export const VIRTUAL_BOARD_PACK: PolyExtensionPack = {
  format: 'polyblock-extension',
  version: 1,
  id: 'virtual-board',
  name: '虚拟硬件外设包',
  packVersion: '1.0.0',
  categoryLabel: '硬件',
  color: '#0ea5e9',
  description:
    '提供板载 LED、RGB 彩灯、OLED 文本屏、温度传感器与按键 A/B 积木；导出标准 board 模块代码供真机运行，浏览器沙箱内置实时交互模拟。',
  builtin: true,
  hasVirtualBoardUi: true,
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
      lua: {
        imports: ['local board = require("board")'],
        template: 'board.led({{STATE:bool_lua}})',
      },
      python: {
        imports: ['import board'],
        template: 'board.led({{STATE:bool_py}})',
      },
    },
    {
      type: 'ext_board_rgb',
      kind: 'statement',
      message0: '设置 RGB 彩灯 %1',
      args0: [
        {
          type: 'field_dropdown',
          name: 'COLOR',
          options: [
            ['翠绿 (#10b981)', '#10b981'],
            ['天蓝 (#3b82f6)', '#3b82f6'],
            ['警示红 (#ef4444)', '#ef4444'],
            ['琥珀黄 (#f59e0b)', '#f59e0b'],
            ['炫紫 (#8b5cf6)', '#8b5cf6'],
            ['关闭 (#1e293b)', '#1e293b'],
          ],
        },
      ],
      inputsInline: true,
      tooltip: '设置板载 RGB 彩灯的发光颜色。',
      keywords: 'rgb 彩灯 颜色 led 硬件 board',
      lua: {
        imports: ['local board = require("board")'],
        template: 'board.rgb({{COLOR:json}})',
      },
      python: {
        imports: ['import board'],
        template: 'board.rgb({{COLOR:json}})',
      },
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
      lua: {
        imports: ['local board = require("board")'],
        template: 'board.oled_show({{TEXT}})',
      },
      python: {
        imports: ['import board'],
        template: 'board.oled_show({{TEXT}})',
      },
    },
    {
      type: 'ext_board_oled_clear',
      kind: 'statement',
      message0: '清空 OLED 屏幕',
      inputsInline: true,
      tooltip: '清空板载 OLED 屏幕显示内容。',
      keywords: 'oled 清空 clear 屏幕 硬件',
      lua: {
        imports: ['local board = require("board")'],
        template: 'board.oled_clear()',
      },
      python: {
        imports: ['import board'],
        template: 'board.oled_clear()',
      },
    },
    {
      type: 'ext_board_temp',
      kind: 'value',
      outputType: 'Number',
      message0: '读取板载温度 (°C)',
      tooltip: '读取板载温度传感器数值（在沙箱右侧「模拟」面板可实时拖动滑块测试）。',
      keywords: '温度 传感器 sensor temp temperature 硬件 board',
      lua: {
        imports: ['local board = require("board")'],
        template: 'board.read_temp()',
      },
      python: {
        imports: ['import board'],
        template: 'board.read_temp()',
      },
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
      lua: {
        imports: ['local board = require("board")'],
        template: 'board.is_pressed({{BTN:json}})',
      },
      python: {
        imports: ['import board'],
        template: 'board.is_pressed({{BTN:json}})',
      },
    },
  ],
  sandboxMock: {
    moduleName: 'board',
    luaSource: `
local M = {}
function M.led(on)
  __poly_sim_set("led", on and true or false)
end
function M.rgb(hex)
  __poly_sim_set("rgb", tostring(hex))
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
def rgb(hex_color):
    _poly.sim_set("rgb", str(hex_color))
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
      kind: 'rgb',
      key: 'rgb',
      label: 'RGB',
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
    },
    {
      kind: 'button',
      key: 'btnB',
      label: '按键 B',
      default: false,
      activeLabel: '按下中',
      idleLabel: '释放',
    },
  ],
};

export const DICT_JSON_PACK: PolyExtensionPack = {
  format: 'polyblock-extension',
  version: 1,
  id: 'dict-json',
  name: '字典与文本进阶包',
  packVersion: '1.0.0',
  categoryLabel: '字典',
  color: '#f97316',
  description:
    '提供跨 Lua table 与 Python dict 的键值对操作积木及字符串替换工具，生成原生标准语法，零额外依赖。',
  builtin: true,
  blocks: [
    {
      type: 'ext_dict_new',
      kind: 'value',
      outputType: null,
      message0: '空字典 { }',
      tooltip: '创建一个空的键值字典（Lua table / Python dict）。',
      keywords: '字典 dict map table 空对象 json',
      lua: { template: '{}' },
      python: { template: '{}' },
    },
    {
      type: 'ext_dict_set',
      kind: 'statement',
      message0: '字典 %1 设置键 %2 = %3',
      args0: [
        { type: 'field_variable', name: 'DICT', variable: 'cfg' },
        { type: 'input_value', name: 'KEY', check: 'String' },
        { type: 'input_value', name: 'VAL' },
      ],
      inputsInline: true,
      tooltip: '向字典写入指定键名与值。',
      keywords: '字典 设置 键 key value set dict',
      shadows: {
        KEY: { type: 'text', value: 'mode' },
        VAL: { type: 'text', value: 'auto' },
      },
      lua: { template: '{{DICT}}[{{KEY}}] = {{VAL}}' },
      python: { template: '{{DICT}}[{{KEY}}] = {{VAL}}' },
    },
    {
      type: 'ext_dict_get',
      kind: 'value',
      outputType: null,
      message0: '字典 %1 取键 %2',
      args0: [
        { type: 'field_variable', name: 'DICT', variable: 'cfg' },
        { type: 'input_value', name: 'KEY', check: 'String' },
      ],
      inputsInline: true,
      tooltip: '从字典读取指定键对应的值（不存在返回 nil / None）。',
      keywords: '字典 读取 获取 get key dict',
      shadows: { KEY: { type: 'text', value: 'mode' } },
      lua: { template: '{{DICT}}[{{KEY}}]' },
      python: { template: '{{DICT}}.get({{KEY}})' },
    },
    {
      type: 'ext_dict_has',
      kind: 'value',
      outputType: 'Boolean',
      message0: '字典 %1 包含键 %2 ?',
      args0: [
        { type: 'field_variable', name: 'DICT', variable: 'cfg' },
        { type: 'input_value', name: 'KEY', check: 'String' },
      ],
      inputsInline: true,
      tooltip: '判断字典中是否存在指定键名。',
      keywords: '字典 包含 存在 has contains key',
      shadows: { KEY: { type: 'text', value: 'mode' } },
      lua: { template: '({{DICT}}[{{KEY}}] ~= nil)' },
      python: { template: '({{KEY}} in {{DICT}})' },
    },
    {
      type: 'ext_str_replace',
      kind: 'value',
      outputType: 'String',
      message0: '文本 %1 替换 %2 为 %3',
      args0: [
        { type: 'input_value', name: 'SRC', check: 'String' },
        { type: 'input_value', name: 'OLD', check: 'String' },
        { type: 'input_value', name: 'NEW', check: 'String' },
      ],
      inputsInline: true,
      tooltip: '将源文本中的指定子串替换为新内容。',
      keywords: '文本 替换 replace string sub',
      shadows: {
        SRC: { type: 'text', value: 'hello world' },
        OLD: { type: 'text', value: 'world' },
        NEW: { type: 'text', value: 'PolyBlock' },
      },
      lua: { template: '(string.gsub(tostring({{SRC}}), tostring({{OLD}}), tostring({{NEW}})))' },
      python: { template: 'str({{SRC}}).replace(str({{OLD}}), str({{NEW}}))' },
    },
  ],
};

export const CLOCK_TIMER_PACK: PolyExtensionPack = {
  format: 'polyblock-extension',
  version: 1,
  id: 'clock-timer',
  name: '秒表与计时器包',
  packVersion: '1.0.0',
  categoryLabel: '计时',
  color: '#a855f7',
  description:
    '提供高精度毫秒秒表积木，便于测量循环耗时、定时轮询与节拍控制。',
  builtin: true,
  blocks: [
    {
      type: 'ext_clock_millis',
      kind: 'value',
      outputType: 'Number',
      message0: '已运行毫秒数 (ms)',
      tooltip: '返回从脚本启动或上次重置秒表以来经过的毫秒数。',
      keywords: '时间 计时器 毫秒 millis timer clock elapsed',
      lua: {
        imports: ['local poly_clock = require("poly_clock")'],
        template: 'poly_clock.millis()',
      },
      python: {
        imports: ['import poly_clock'],
        template: 'poly_clock.millis()',
      },
    },
    {
      type: 'ext_clock_reset',
      kind: 'statement',
      message0: '重置秒表计时器',
      tooltip: '将当前秒表起点重置为 0ms。',
      keywords: '重置 计时器 秒表 reset timer clock',
      lua: {
        imports: ['local poly_clock = require("poly_clock")'],
        template: 'poly_clock.reset()',
      },
      python: {
        imports: ['import poly_clock'],
        template: 'poly_clock.reset()',
      },
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
  VIRTUAL_BOARD_PACK,
  DICT_JSON_PACK,
  CLOCK_TIMER_PACK,
];

/** Clean downloadable JSON template showing users how to author custom .polyext.json packs. */
export const SAMPLE_CUSTOM_EXTENSION_TEMPLATE: PolyExtensionPack = {
  format: 'polyblock-extension',
  version: 1,
  id: 'my-robot-api',
  name: '自定义机器人控制包（示例模板）',
  packVersion: '1.0.0',
  categoryLabel: '机器人',
  color: '#ec4899',
  description: '演示如何通过纯 JSON 声明一份自己的设备/业务 API 积木扩展包并同时生成 Lua 与 Python 代码。',
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
      lua: {
        imports: ['local robot = require("robot")'],
        template: 'robot.move({{DIR:json}}, {{SPEED}})',
      },
      python: {
        imports: ['import robot'],
        template: 'robot.move({{DIR:json}}, {{SPEED}})',
      },
    },
    {
      type: 'ext_robot_battery',
      kind: 'value',
      outputType: 'Number',
      message0: '读取机器人电量 (%)',
      tooltip: '获取机器人当前剩余电量百分比。',
      keywords: '机器人 电量 电池 battery',
      lua: {
        imports: ['local robot = require("robot")'],
        template: 'robot.battery()',
      },
      python: {
        imports: ['import robot'],
        template: 'robot.battery()',
      },
    },
  ],
  sandboxMock: {
    moduleName: 'robot',
    luaSource: `
local M = {}
function M.move(dir, speed)
  if __poly_sim_get("robot_estop") == true then
    __poly_sim_set("robot_moving", false)
    __poly_sim_set("robot_speed", 0)
    __poly_sim_set("robot_log:append", "[ESTOP] 急停已触发，忽略移动指令")
    print("[WARN] [Mock Robot] E-Stop active, move ignored")
    return
  end
  local spd = tonumber(speed) or 0
  __poly_sim_set("robot_moving", spd > 0)
  __poly_sim_set("robot_speed", spd)
  __poly_sim_set("robot_log:append", "move(" .. tostring(dir) .. ", " .. tostring(spd) .. "%)")
  print("[INFO] [Mock Robot] move(" .. tostring(dir) .. ", speed=" .. tostring(spd) .. ")")
end
function M.battery()
  local v = tonumber(__poly_sim_get("robot_battery"))
  return v or 88
end
return M
`,
    pythonSource: `
import _poly
def move(dir_name, speed):
    if _poly.sim_get("robot_estop") is True:
        _poly.sim_set("robot_moving", False)
        _poly.sim_set("robot_speed", 0)
        _poly.sim_set("robot_log:append", "[ESTOP] 急停已触发，忽略移动指令")
        print("[WARN] [Mock Robot] E-Stop active, move ignored")
        return
    spd = float(speed)
    _poly.sim_set("robot_moving", spd > 0)
    _poly.sim_set("robot_speed", spd)
    _poly.sim_set("robot_log:append", f"move({dir_name}, {int(spd)}%)")
    print("[INFO] [Mock Robot] move(" + str(dir_name) + ", speed=" + str(speed) + ")")
def battery():
    v = _poly.sim_get("robot_battery")
    return int(v) if v is not None else 88
`,
  },
  simWidgets: [
    {
      kind: 'led',
      key: 'robot_moving',
      label: '运动状态',
      color: '#10b981',
      default: false,
    },
    {
      kind: 'bar',
      key: 'robot_speed',
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
      key: 'robot_log',
      label: '机器人指令终端',
      maxLines: 3,
      default: ['[Robot Ready] 等待指令...'],
    },
    {
      kind: 'slider',
      key: 'robot_battery',
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
      key: 'robot_estop',
      label: '急停开关 (E-Stop)',
      color: '#ef4444',
      default: false,
    },
  ],
};
