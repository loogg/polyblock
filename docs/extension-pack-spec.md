# PolyBlock 扩展包协议规范（`.polyext.json`）

> 适用架构：统一单轨声明式协议（`version: 1`）  
> 配套 JSON Schema：[schemas/polyext.schema.json](../schemas/polyext.schema.json)  
> 配套 VS Code 代码片段：[`.vscode/polyext.code-snippets`](../.vscode/polyext.code-snippets)

---

## 1. 核心设计原则

1. **一模块一扩展包**：一个 `.polyext.json` 对应一个逻辑模块或 SDK（如 `rt`、`board`、`crc16`），不在包层级碎片拆分。
2. **单轨 `sections[]`**：无论单组件还是多组件包，所有侧边栏落位、排序、显隐、句柄资源配置和积木定义全部统一写在 `sections[]` 内，**零双轨覆盖、零孤儿积木**。
3. **整包开关 + 按组件细粒度裁剪**：当 `sections.length > 1` 时，自动支持整包 ID（如 `"rt"`）与组件 ID（如 `"rt.timers"`）切换。
4. **严格分离「沙箱假桩」与「真实脚本库」**：
   - `sandboxMock`：模拟真机 C 固件接口，**只在浏览器沙箱运行，导出真机时剥离**；
   - `bundleModule`：真实纯脚本算法库（如 `crc16.lua`），**沙箱运行与真机打包导出共用**。
5. **按积木驱动模拟面板**：`pack.simWidgets` 作为控件资产表，由积木上的 `simWidgetKeys[]` 自动聚合按需展示。

---

## 2. 顶层字段一览

| 字段名 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `$schema` | 否 | - | 推荐填 `"./schemas/polyext.schema.json"` 以启用 VS Code 悬浮说明与补全 |
| `format` | **是** | - | 固定 `"polyblock-extension"` |
| `version` | **是** | - | 固定 `1` |
| `id` | **是** | - | 全局唯一包 ID（2~48 位字母/数字/`-`/`_`，不能与内置包冲突） |
| `name` | **是** | - | 扩展包展示名 |
| `packVersion` | 否 | `"1.0.0"` | 扩展包自身版本号 |
| `iconLabel` | 否 | 首个 section 的 `label` | 扩展卡片图标缩写（1~4 字） |
| `color` | 否 | `"#6366f1"` | 扩展包主色（6 位 HEX） |
| `description` | 否 | 默认文案 | 功能描述 |
| `tags` | 否 | `[]` | 最多 6 个自定义标签 |
| `imports` | 否 | - | 包级默认顶部导入 `{ lua?: string[], python?: string[] }`，全包普通/表达式积木自动继承并按内容全局去重 |
| `sections` | **是** | - | 至少 1 个组件（见第 3 节） |
| `simWidgets` | 否 | - | 包内共享模拟控件资产表（见第 5 节，需配合 `sandboxMock` 或 `bundleModule`） |
| `sandboxMock` | 否 | - | `{ moduleName, luaSource?, pythonSource? }`，仅浏览器沙箱模拟用 |
| `bundleModule` | 否 | - | `{ moduleName, luaSource?, pythonSource? }`，纯脚本库真实现（沙箱 + 真机共用） |

---

## 3. 组件 `sections[]` 与句柄配置 `handleConfigs[]`

| 字段名 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `id` | **是** | - | 包内唯一组件 ID；多组件包的能力 ID 为 `<pack.id>.<section.id>` |
| `label` | **是** | - | 侧边栏分类名 & 多组件勾选芯片名 |
| `description` | 否 | - | 悬浮说明 |
| `visible` | 否 | `true` | 是否显示在左侧工具箱 |
| `categoryTarget` | 否 | `"own"` | `"own"` 新建独立分类；或填核心分类 ID 并入对应分类：`"event"`（事件 #10）、`"print"`（打印 #20）、`"control"`（控制 #30）、`"variables"`（变量 #40）、`"math"`（运算 #50）、`"logic"`（逻辑 #60）、`"text"`（文本 #70）、`"lists"`（列表 #80）、`"functions"`（函数 #90） |
| `toolboxOrder` | 否 | `100` | `categoryTarget === "own"` 时的侧边栏排序序号 |
| `color` | 否 | 继承 `pack.color` | 组件独立主题色 |
| `handleConfigs` | 否 | `[]` | 可扩展的每句柄资源配置数组 |
| `blocks` | **是** | - | 直接内嵌属于本组件的积木定义数组（至少 1 个） |

### `handleConfigs[]` 当前支持类型

- **`kind: "channel-pool"`**（每句柄隔离的 `0 ~ N-1` 整数通道池）：
  - `label`（必填）：资源名称（如 `"定时器通道"`、`"PWM 舵机通道"`）
  - `prefix`（可选，默认 `"CH"`）：界面与注释前缀（如 `"T"` → `T0`，`"PWM"` → `PWM0`）
  - `min` / `max` / `defaultCount`（必填）、`presets?`、`hint?`、`configKey?`（默认自动派生为 `<pack.id>.<section.id>`）
  - **自动联动 4 处能力**：① 独立分类抽屉顶部自动生成 `⚙ 配置本句柄<label>` 快捷按钮；② 项目配置「运行句柄」自动出现数量与别名面板；③ 积木中 `type: "field_channel_id"` 下拉自动展示别名；④ 静态校验自动扫描所有 `field_channel_id` 字段做越界报错。

---

## 4. 积木 `blocks[]` 与 `kind` 三选一

| `kind` | 形态 | 说明与典型例子 |
|---|---|---|
| `"statement"` | 上下拼接语句块 | 执行动作、不向外部槽位返回值（含给变量赋值、点亮 LED、启动定时器） |
| `"value"` | 左侧输出表达式块 | 算出返回值并嵌入其他积木参数槽（如 `crc16(data)`、`board.read_temp()`、`rt.tick()`） |
| `"hat"` | 顶层事件回调帽块 | 生成顶层零闭包回调 `function on_xxx(...)`；句柄内只要任意脚本含 `hat` 即自动进入事件循环 |

### 常用积木字段

- `type`、`message0`、`args0`（支持 `input_value`、`field_dropdown`、`field_number`、`field_input`、`field_variable`、`field_channel_id`）
- `lua` / `python`：`{ template, imports? }`；不写 `imports` 自动继承包级 `imports`，写 `imports: []` 显式取消导入。
- `simWidgetKeys?: string[]`：声明本积木关联的 `pack.simWidgets` key 列表；启用本组件时自动聚合展示。
- `sandboxRunnable?: boolean`：默认 `true`；仅真机可用、浏览器无沙箱实现的积木标 `false`。

---

## 5. 模拟控件 `simWidgets[]`

支持 8 种通用控件（所有控件关闭态均自动跟随明暗主题，**无需配置熄灭色**）：

- `led`（单色灯，`color` 仅控制亮灯色）、`tricolor`（红/绿/蓝离散三色灯）、`rgb`（全彩灯）
- `bar`（进度条）、`screen`（多行文本屏，支持 `key:append` / `key:clear`）
- `slider`（传感器滑块）、`toggle`（开关，可配 `emitEvent`）、`button`（按键，可配 `emitEvent`）

---

## 6. 极简示例（纯脚本算法库 `crc16`）

```json
{
  "$schema": "./schemas/polyext.schema.json",
  "format": "polyblock-extension",
  "version": 1,
  "id": "crc16-modbus",
  "name": "CRC16 校验库",
  "iconLabel": "CRC",
  "color": "#10b981",
  "description": "纯 Lua/Python CRC16-Modbus 校验库（沙箱与真机共用真实源码）",
  "imports": {
    "lua": ["local crc16 = require(\"crc16\")"],
    "python": ["import crc16"]
  },
  "sections": [
    {
      "id": "main",
      "label": "校验",
      "toolboxOrder": 130,
      "blocks": [
        {
          "type": "ext_crc16_calc",
          "kind": "value",
          "outputType": "Number",
          "message0": "计算 %1 的 CRC16",
          "args0": [{ "type": "input_value", "name": "DATA", "check": "String" }],
          "shadows": { "DATA": { "type": "text", "value": "HELLO" } },
          "lua": { "template": "crc16.calc({{DATA}})" },
          "python": { "template": "crc16.calc({{DATA}})" }
        }
      ]
    }
  ],
  "bundleModule": {
    "moduleName": "crc16",
    "luaSource": "local M = {}\nfunction M.calc(s)\n  local crc = 0xFFFF\n  for i = 1, #s do\n    crc = crc ~ string.byte(s, i)\n    for _ = 1, 8 do\n      if (crc & 1) ~= 0 then crc = (crc >> 1) ~ 0xA001 else crc = crc >> 1 end\n    end\n  end\n  return crc\nend\nreturn M\n"
  }
}
```

## 7. VS Code 快捷开发提示

在 VS Code 中打开任意 `.polyext.json`（或 `.json`）文件，直接键入以下前缀按回车即可一键插入对应结构并按 `Tab` 跳填：
- `poly-pack`：完整扩展包骨架
- `poly-section`：新增一个组件
- `poly-block-stmt` / `poly-block-val` / `poly-block-hat`：新增语句 / 表达式 / 事件帽块
- `poly-pool`：新增每句柄通道池配置
- `poly-widget`：新增模拟控件
