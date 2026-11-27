# PolyBlock Architecture Guardrails

> **演进优先（防僵化总则）**：本文件只记录当前已验证的核心架构不变量，用于在新增语言后端（如 C / JS 等）或扩展功能时避免重踩旧坑。项目处于开发期，**默认零旧版/旧文件兼容**；若未来有更简洁正确的架构路线，直接彻底重构并同步更新本文件，严禁为兼容旧实现保留死代码或冗余兜底。

## 1. Layer 0 核心 vs 扩展包边界
- **Layer 0 核心**：所有零外部模块依赖的纯语言原语（`on_start`、`require`/`import`、控制/运算/逻辑/文本含 `str_replace`、列表、字典 5 块、变量、函数）必须留在核心，不放进扩展包。
- **扩展包（`.polyext.json`）**：仅承载带真实外部模块接口（`imports` + `libs` 或 `sandboxMock`）的运行时/外设/库能力（如 `rt`、`virtual-board`、`clock-timer`）。
- **纯值槽原则**：列表、字典等容器操作积木统一用 `input_value` 接收容器表达式，作用域自然随拖入的变量走；**禁止**用 `field_variable` 扫描推断作用域，**禁止**通过 Blockly `provideFunction_` 向导出代码注入隐藏辅助函数。

## 2. 句柄、并发与作用域模型（新增语言后端必守）
- **1 句柄 = 1 线程 / 单轨协程循环**：
  - 同一句柄内所有脚本共享状态，但**不开多线程**（沙箱与未来 C 后端保持同一执行模型）。
  - `on_start` 是唯一允许阻塞延时（`sleep_ms` / `await sleep_ms`）的主协程；所有事件回调（`on_run` / `on_timer` / `on_button` 等）均为非阻塞短回调，由单轨调度器在 `sleep_ms` 让出点或周期循环中派发。
  - 若目标语言采用显式协程语法（如 Python `async/await`），须对含 `sleep_ms` 的自定义函数做传递性 `async`/`await` 传染，且纯净导出与沙箱保持同一 ABI。
- **3 级变量作用域 + 显式初值**：
  - `跨文件共享`（归集于 `shared`） / `单文件全局`（仅本文件顶层声明，且只声明实际用到的变量） / `局部`（`poly_local_*`，需在所属函数/回调顶部提升声明以避免分支作用域泄漏，如 Lua 顶部 `local x`、Python 顶部 `x = None`）。
  - 新建变量支持显式初值（`null/number/boolean/string/list/dict`）；**禁止**在运算积木中插入隐式类型兜底（如 `math_change` 直接导出原生 `x = x + d` / `x += d`，绝不注入 `or 0` / `isinstance` 魔术代码，未初始化由业务层暴露报错）。
- **2 级函数作用域 + Style A1 只读 `shared` 模块**：
  - `跨文件公共函数` 与 `跨文件共享变量` 统一归集到自动生成的只读 `shared.<ext>` 模块，调用方顶部自动引入；`单文件私有函数` 严格限制在文件内（如 Lua `local function`）。
  - 生成条件极简且无特判：只要句柄存在任一跨文件变量或函数（即使当前只有 `main`），即生成 `shared.<ext>`；全部删除后自动移除。
- **同句柄伴随脚本显式加载**：非 `shared` 的同句柄普通脚本不自动导入，必须由用户显式拖入 `加载脚本`（`require`/`import`），未加载报静态错误；调试产物 `moduleDebugCode` 保留行号/断点桩但必须剥离顶层入口心跳。

## 3. 主入口与顶层事件回调（Hat）
- 所有顶层帽块（含核心 `on_start`）统一由 `hat.mode`（`'singleton'` | `'dispatch'`）元数据驱动，禁止按块名写特例。
- 句柄唯一主入口（`entry`）自动限制 `singleton` 帽块仅主入口可用，并自动聚合本句柄全文件的 `dispatch` 分发路由；当某类分发回调全被删除时，主入口对应分发路由必须自动删除。

## 4. 新增语言后端的 Blockly 防坑清单
- **必须覆写 Blockly 默认生成器**：`variables_get/set`、`math_change`、`text_append`、循环变量及 `procedures_*` 必须接管，以严格对齐 3 级变量与 2 级函数作用域（避免默认 `global` 散弹声明或未用变量污染顶层）。
- **禁止跨文件幽灵函数**：跨文件函数调用使用独立块（`poly_call_shared_*`），防止 Blockly 内置 `procedures_call*` 在调用方画布自动生成幽灵 `procedures_def*`。
- **检查链式索引优先级**：容器取键/取值与字面量须设准 `Order`（例如 Lua 索引返回 `Order.ATOMIC`、`{}` 返回 `Order.HIGH`），避免生成前导括号 `(a['b'])['val'] = 0` 触发语法歧义。

## 5. 验证与发布红线
- 每次架构/UI 改动须过 `npx tsc -b` + `npm test`（含真 WASM 运行）+ 真实浏览器 E2E 视觉核查。
- **未经用户明确指令，严禁 `git push` 或线上发布**；`.agents/` 与 `skills-lock.json` 保持本地忽略。
