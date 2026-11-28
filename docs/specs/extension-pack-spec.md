# PolyBlock 扩展包与目标板型协议规范（`.polyext.json` / `.polyboard.json`）

> 归属：`docs/specs/` · 适用架构：统一单轨声明式多语言协议（`version: 1`）  
> 配套 JSON Schema：[`schemas/polyext.schema.json`](../../schemas/polyext.schema.json) · [`schemas/polyboard.schema.json`](../../schemas/polyboard.schema.json)  
> 配套 VS Code 代码片段：[`.vscode/polyext.code-snippets`](../../.vscode/polyext.code-snippets)

---

## 1. 核心设计原则

1. **一模块一扩展包**：一个 `.polyext.json` 对应一个带真实外部模块接口（`imports` + `libs[]` 或 `sandboxMock`）的运行时/外设/库模块（如 `rt`、`virtual-board`、`clock-timer`、`crc16`），纯语言原语留在 Layer 0 核心。
2. **多语言映射（零二元锁死）**：所有语言相关字段（`imports`、`code`、`sources`、`hat.condition`、`hat.branchComment`）统一按目标语言 ID 映射（`Record<ScriptLanguageId, ...>`，如 `lua` / `python` / `js` / 未来扩展语言），占位符修饰器保持语言中立。
3. **单轨 `sections[]`**：无论单组件还是多组件包，所有侧边栏落位、排序、显隐、句柄资源配置、运行时监控声明与积木定义全部统一写在 `sections[]` 内，**零双轨覆盖、零孤儿积木**。
4. **整包开关 + 按组件细粒度裁剪**：当 `sections.length > 1` 时，自动支持整包 ID（如 `"rt"`）与组件 ID（如 `"rt.timers"`）切换。
5. **纯 3 层作用域优先级 + 交付属性解耦（全包彻底平权，零 `builtin` 特权）**：
   - **唯一查找优先级链路（只看作用域，从近到远）**：
     1. **当前句柄脚本**（`handle.scripts`，如 `timers.<ext>`）
     2. **项目私有/锁定包**（独立存于工程目录 `extensions/*.polyext.json`，可使用任意包 ID 含 `rt` / `virtual-board` 仅在本项目内覆盖全局包）
     3. **全局扩展包**（出厂种子包与用户导入全局包完全平权，一视同仁）
   - **同层级冲突阻断**：同一层级内若有 2 个已启用包声明同一 `moduleName`，触发静态 **Error**，直接阻断运行与 `.zip` 导出；单包内也禁止将同一 `moduleName` 同时写入 `libs[]` 和 `sandboxMock`。
   - **交付属性解耦**：
     - `libs[]`：真实纯脚本库源码列表（支持入口库 + 辅助依赖表，如 `crc16` + `crc16_table`），**沙箱运行与真机 `.zip` 导出共用**；
     - `sandboxMock`：模拟真机固件接口的假桩（如 `board` / `i2c`），**仅在浏览器沙箱运行，真机 `.zip` 打包导出时严格剥离**（若项目级 `sandboxMock` 覆盖了全局级 `libs[]`，导出真机时同样不会把旧全局库打入包中）。
6. **按积木驱动模拟面板**：`pack.simWidgets` 作为控件资产表，由积木上的 `simWidgetKeys[]` 自动聚合按需展示，并按 `<packId>::<key>` 自动命名空间隔离（加 `global:` 前缀可显式跨包共享）。

---

## 2. 顶层字段一览

| 字段名 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `$schema` | 否 | - | 推荐填 `"./schemas/polyext.schema.json"` 以启用 VS Code 悬浮说明与补全 |
| `format` | **是** | - | 固定 `"polyblock-extension"` |
| `version` | **是** | - | 固定 `1` |
| `id` | **是** | - | 唯一包 ID（2~48 位字母/数字/`-`/`_`）；项目私有/锁定包可用任意 ID 覆盖全局包 |
| `name` | **是** | - | 扩展包展示名 |
| `packVersion` | 否 | `"1.0.0"` | 扩展包自身语义版本号 |
| `iconLabel` | 否 | 首个 section 的 `label` | 扩展卡片图标缩写（建议 1~4 字，上限 6 字） |
| `color` | 否 | `"#6366f1"` | 扩展包主色（6 位 HEX） |
| `description` | 否 | 默认文案 | 功能描述 |
| `tags` | 否 | `[]` | 最多 6 个自定义标签（每个上限 12 字） |
| `imports` | 否 | - | 包级默认顶部导入 `Record<ScriptLanguageId, string[]>`，普通/表达式积木自动继承并按内容全局去重 |
| `sections` | **是** | - | 至少 1 个组件（见第 3 节） |
| `simWidgets` | 否 | - | 包内共享模拟控件资产表（见第 5 节，需配合 `sandboxMock` 或非空 `libs[]`） |
| `sandboxMock` | 否 | - | `{ moduleName, role?, sources: Record<ScriptLanguageId, string> }`，仅浏览器沙箱模拟用（真机导出剥离；不可与同包 `libs[]` 重名） |
| `libs` | 否 | - | `Array<{ moduleName, role?: "entry"\|"helper", sources: Record<ScriptLanguageId, string> }>`，纯脚本库真实现（沙箱与真机 `.zip` 共用；支持在 IDE「导入脚本库」或「附加库源码」自动生成） |

---

## 3. 组件 `sections[]`、句柄配置与运行时监控

| 字段名 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `id` | **是** | - | 包内唯一组件 ID（1~32 位字母/数字/`-`/`_`）；多组件包的能力 ID 为 `<pack.id>.<section.id>` |
| `label` | **是** | - | 侧边栏分类名 & 多组件勾选芯片名（上限 12 字） |
| `description` | 否 | - | 悬浮说明 |
| `visible` | 否 | `true` | 是否显示在左侧工具箱 |
| `categoryTarget` | 否 | `"own"` | `"own"` 新建独立分类；或填任意 10 个核心分类 ID 并入对应分类：`"event"`（#10）、`"print"`（#20）、`"control"`（#30）、`"variables"`（#40）、`"math"`（#50）、`"logic"`（#60）、`"text"`（#70）、`"lists"`（#80）、`"dicts"`（#85）、`"functions"`（#90） |
| `toolboxOrder` | 否 | `100` | `categoryTarget === "own"` 时的侧边栏排序序号（`0~9999`） |
| `color` | 否 | 继承 `pack.color` | 组件独立主题色（6 位 HEX） |
| `runtimeMonitor` | 否 | - | 可选声明式运行时监控卡片类型：`"scheduler"` 或 `"timers"` |
| `handleConfigs` | 否 | `[]` | 可扩展的每句柄资源配置数组 |
| `blocks` | **是** | - | 直接内嵌属于本组件的积木定义数组（至少 1 个） |

### `handleConfigs[]` 当前支持类型

- **`kind: "channel-pool"`**（每句柄隔离的 `0 ~ N-1` 整数通道池）：
  - `label`（必填）：资源名称（如 `"定时器通道"`、`"PWM 舵机通道"`）
  - `prefix`（可选，默认 `"CH"`）：界面与注释前缀（如 `"T"` → `T0`，`"PWM"` → `PWM0`）
  - `min` / `max` / `defaultCount`（必填，`1~32`）、`presets?`、`hint?`、`configKey?`（省略时自动派生为 `<pack.id>.<section.id>`，单组件包为 `<pack.id>`）
  - **自动联动 4 处能力**：① 独立分类抽屉顶部自动生成 `⚙ 配置本句柄<label>` 快捷按钮；② 项目配置「运行句柄」自动出现数量与别名面板；③ 积木中 `type: "field_channel_id"` 下拉自动展示别名；④ 静态校验自动扫描所有 `field_channel_id` 字段做越界报错。

---

## 4. 积木 `blocks[]`、`kind` 三选一与 `hat` 声明

| `kind` | 形态 | 说明与典型例子 |
| --- | --- | --- |
| `"statement"` | 上下拼接语句块 | 执行动作、不向外部槽位返回值（如点亮 LED、启动定时器）；必填 `code` |
| `"value"` | 左侧输出表达式块 | 算出返回值并嵌入其他积木参数槽（如 `crc16.calc(data)`、`board.read_temp()`、`rt.tick()`）；必填 `code` |
| `"hat"` | 顶层事件回调帽块 | 生成顶层零闭包回调（如 Lua `function on_xxx(...)` / Python `def on_xxx(...)` / JS `function on_xxx(...)`）；必填 `hat` |

### 常用积木字段

- `type`、`message0`（用 `%1`、`%2` 占位，字面百分号写 `%%`）、`args0`、`inputsInline`（默认 `true`）、`outputType`（仅 `value` 块使用）、`tooltip`、`keywords`、`blockStyle`、`fields`、`shadows`
- `code`（`statement` / `value` 必填）：`Record<ScriptLanguageId, { template: string, imports?: string[] }>`，**至少提供一种目标语言即可**（切到未提供模板的语言时校验面板自动报静态 Error）。不写 `imports` 自动继承包级 `imports`，写 `imports: []` 显式取消导入。
- `hat`（`hat` 块必填）：
  - `eventName`（必填）：生成的顶层回调函数名（如 `"on_run"` / `"on_timer"` / 自定义中断名）
  - `mode`（必填）：`"singleton"`（全句柄唯一，仅主入口可用）或 `"dispatch"`（自动聚合全句柄同类帽块至主入口路由函数）
  - `params?`、`imports?`（按语言 ID 映射，帽块默认不继承包级 `imports`）
  - `condition?` / `branchComment?`：`Record<ScriptLanguageId, string>`，`dispatch` 模式下的分支条件与尾注模板
  - `extractBranchFnPrefix?`：将各分支提取为独立全局函数（如 `on_timer_0`），主入口路由仅调用分支函数
  - `duplicateKeyTemplate?`、`scopeLabelTemplate?`、`scopeShortTemplate?`、`scopeCategory?`（`"lifecycle" | "event" | "function"`）、`keepsAlive?`（默认 `true`）
- `simWidgetKeys?: string[]`：声明本积木关联的 `pack.simWidgets` key 列表；启用本组件时自动聚合展示。
- `sandboxRunnable?: boolean`：默认 `true`；仅真机可用、浏览器无沙箱实现的积木标 `false`。

### `args0` 参数类型与语言中立模板修饰器（`name` 对应 `{{NAME}}`）

| `type` | 画布形态 | 常用属性与模板用法 |
| --- | --- | --- |
| `input_value` | 凹进去的值插槽（推荐用于容器/表达式参数，遵循纯值槽原则） | `name`、可选 `check`（`"Number"` / `"String"` / `"Boolean"`）；配合 `shadows` 设默认阴影值，模板写 `{{X}}` |
| `field_number` | 积木内联数字框 | `name`、`value`、`min`、`max`、`precision`；模板写 `{{MS}}` 或 `{{MS:int}}` |
| `field_input` | 积木内联文本框 | `name`、`text`；模板写 `{{TXT:json}}` 自动加双引号转义 |
| `field_dropdown` | 固定选项下拉框 | `name`、`options: [["展示名", "值"], ...]`；模板写 `{{DIR:json}}`、`{{ON:bool}}`、`{{EDGE:edge:<param>}}`、`{{EDGE:edge_zh}}` |
| `field_checkbox` | 积木勾选框（布尔开关） | `name`、`checked: true \| false`；模板写 `{{EN:bool}}`（按当前语言方言自动展开） |
| `field_variable` | 工作区变量选择器（容器操作禁用） | `name`、`variable`；模板写 `{{VAR}}` 输出合法变量标识符 |
| `field_channel_id` | 每句柄通道池下拉框（带别名/越界校验） | `name`；自动绑定所属 `section.handleConfigs` 的 `channel-pool`；支持 `{{CH:int}}`、`{{CH:channel_comment}}` 与 `{{CH:channel_label}}` |

---

## 5. 模拟控件 `simWidgets[]`

支持 8 种通用声明式控件（所有控件关闭态均自动跟随明暗主题，**无需配置熄灭色**）：
- `led`（单色灯，`color` 仅控制亮灯色）、`tricolor`（红/绿/蓝离散三色灯）、`rgb`（全彩灯）
- `bar`（进度条）、`screen`（多行文本屏，支持 `key:append` / `key:clear`）
- `slider`（传感器滑块）、`toggle`（开关，可配 `emitEvent`）、`button`（按键，可配 `emitEvent`）

---

## 6. 完整可导入示例（多语言纯脚本算法库 `crc16-modbus`）

```json
{
  "$schema": "./schemas/polyext.schema.json",
  "format": "polyblock-extension",
  "version": 1,
  "id": "crc16-modbus",
  "name": "CRC16 校验库",
  "packVersion": "1.0.0",
  "iconLabel": "CRC",
  "color": "#10b981",
  "description": "多语言 CRC16-Modbus 校验库（沙箱与真机共用真实源码）",
  "imports": {
    "lua": ["local crc16 = require(\"crc16\")"],
    "python": ["import crc16"],
    "js": ["const crc16 = require(\"crc16\");"]
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
          "code": {
            "lua": { "template": "crc16.calc({{DATA}})" },
            "python": { "template": "crc16.calc({{DATA}})" },
            "js": { "template": "crc16.calc({{DATA}})" }
          }
        }
      ]
    }
  ],
  "libs": [
    {
      "moduleName": "crc16",
      "role": "entry",
      "sources": {
        "lua": "local tbl = require(\"crc16_table\")\nlocal M = {}\nfunction M.calc(s)\n  local crc = 0xFFFF\n  for i = 1, #s do\n    crc = ((crc >> 8) ~ tbl[((crc ~ string.byte(s, i)) & 0xFF) + 1]) & 0xFFFF\n  end\n  return crc\nend\nreturn M\n",
        "python": "import crc16_table\n\ndef calc(s):\n    crc = 0xFFFF\n    for ch in str(s).encode('utf-8'):\n        crc = ((crc >> 8) ^ crc16_table.TABLE[(crc ^ ch) & 0xFF]) & 0xFFFF\n    return crc\n",
        "js": "const tbl = require(\"crc16_table\");\nexports.calc = function calc(s) {\n  let crc = 0xffff;\n  const str = String(s);\n  for (let i = 0; i < str.length; i++) {\n    crc = ((crc >>> 8) ^ tbl[(crc ^ str.charCodeAt(i)) & 0xff]) & 0xffff;\n  }\n  return crc;\n};\n"
      }
    },
    {
      "moduleName": "crc16_table",
      "role": "helper",
      "sources": {
        "lua": "return { 0x0000, 0xC0C1 }\n",
        "python": "TABLE = [0x0000, 0xC0C1]\n",
        "js": "module.exports = [0x0000, 0xc0c1];\n"
      }
    }
  ]
}
```

## 7. 原生脚本库导入与双类打包导出

1. **导入原生脚本库**：在「项目配置 → 能力与外设」或左侧「扩展」页点击**「导入脚本库」**，可多选入口库与辅助依赖文件（`.lua` / `.py` / `.js` 等全部已注册语言），自动扫描公开函数并一键生成标准 `.polyext.json`（含 `libs[]`）；已有扩展包亦可通过「附加库源码」直接挂载。
2. **双类打包导出**：详见 [`docs/guidelines/project-and-packaging.md`](../guidelines/project-and-packaging.md)。

## 8. VS Code 快捷代码片段

在 VS Code 中打开任意 `.polyext.json` 或 `.polyboard.json`，键入以下前缀回车即可生成骨架：
`poly-pack` · `poly-section` · `poly-block-stmt` · `poly-block-val` · `poly-block-hat` · `poly-pool` · `poly-widget` · `poly-lib` · `poly-board`
