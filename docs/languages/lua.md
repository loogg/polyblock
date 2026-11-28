# Lua 5.4 语言插件与作用域实现规范

> 返回总览：[`docs/languages/README.md`](./README.md) · 后端源码：[`src/plugins/languages/lua/luaBackend.ts`](../../src/plugins/languages/lua/luaBackend.ts) · 沙箱 Worker：[`src/plugins/languages/lua/lua.worker.ts`](../../src/plugins/languages/lua/lua.worker.ts)

---

## 1. 插件与方言配置（`LUA_DIALECT`）

| 属性 | 值 / 说明 |
| --- | --- |
| 语言 ID / 后缀 | `id: 'lua'` · 扩展名 `.lua` · 注释 `--` |
| 共享模块引用风格 | `sharedModuleStyle: 'table'` · `bareAttrInSharedModule: false`（模块内同样使用 `shared.x`） |
| 协程模型 | **栈式协程（Stackful Coroutine）**：`on_start` 运行于 Lua 原生 `coroutine.create`，`sleep_ms(ms)` 直接让出，无需对自定义函数做 `async/await` 语法传染 |
| 列表索引 | **1-based**（对齐 Lua 原生表索引习惯） |
| 浏览器运行器 | `Wasmoon`（Lua 5.4 WebAssembly）运行于独立 Web Worker（[`workerWasmRunner.ts`](../../src/core/runners/workerWasmRunner.ts)） |

---

## 2. 变量作用域实现细节

### 2.1 跨文件共享变量（`shared.lua`）
- **生成位置**：统一归集至只读模块 `shared.lua`，以表字段初始化：
  ```lua
  local shared = {}
  shared.counter = 0
  return shared
  ```
- **读写方式**：无论在 `main.lua`、伴随脚本还是 `shared.lua` 内部函数，均通过 `shared.<attr>` 读写；使用方顶部自动注入 `local shared = require("shared")`。
- **导出名称规则**：经 [`buildSharedVarsMeta`](../../src/core/backends/eventMode.ts) 映射为合法属性名，保持跨画布一致。

### 2.2 单文件全局变量（File-Global）
- **声明方式**：仅扫描本文件实际被引用的非共享、非纯循环变量，在文件顶部以**文件级词法上值（Upvalue）**形式声明：
  ```lua
  local total = 0
  local label = nil
  ```
- **函数内可见性**：Lua 文件本身即一个顶层闭包，顶层 `local` 变量天然被本文件内所有函数与事件回调捕获为上值，函数内直接读写，不会泄漏到全局 `_G` 表。
- **零隐式类型兜底**：`math_change` 直接生成 `total = total + 10`（严禁注入 `(total or 0) + 10`）。

### 2.3 函数/回调局部变量（`poly_local_set` / `poly_local_get`）
- **块级泄漏防护（顶部提升）**：Lua 中 `if`/`while`/`for` 块内声明的 `local x = 1` 在块外不可见。为保证与视觉积木“函数/回调内局部可见”一致，后端在所属函数或回调体**顶部统一提升声明**：
  ```lua
  function on_start()
    local tmp, err
    if cond then
      tmp = 42
    end
    print(tmp)
  end
  ```
- **与形参冲突保护**：静态诊断 `local-param-collision-*` 在编辑期即阻断局部变量与所属函数形参重名。

### 2.4 纯循环变量（`loopOnly`）
- Lua 原生 `for i = 1, 3, 1 do ... end` 与 `for _, item in ipairs(list) do ... end` 本身即为**严格循环体局部变量**。
- `analyzeWorkspaceVariables` 识别 `loopOnly` 变量后，不将其放进文件顶层 `local` 列表，避免生成多余且易误解的顶层 `local i = nil`；同时循环体内对 `i` 的读写（经 `isShadowedByEnclosingForLoop` 判断，严格仅限 `DO` 槽）绝不会错误加 `shared.` 前缀。

---

## 3. 函数作用域与递归支持

### 3.1 单文件私有函数（前向调用 & 互递归）
Lua 中 `local function a()` 在定义点之前无法被同文件先前的函数看见。为彻底消除“调整积木上下位置导致 `attempt to call a nil value`”的隐患，[`hoistLuaPrivateFunctionDecls`](../../src/plugins/languages/lua/luaBackend.ts) 采用分段策略：
- **仅 1 个私有函数**：保留最地道的 `local function foo(...)` 写法，代码最干净；
- **2 个及以上私有函数**：自动在函数区顶部集中前向声明，函数体改为赋值式定义，**天然支持任意顺序的前向调用与互递归**：
  ```lua
  local fn_a, fn_b

  function fn_a()
    fn_b()
  end

  function fn_b()
    print("ok")
  end
  ```

### 3.2 跨文件公共函数（`shared.<fn>`）
- 在 `shared.lua` 中导出为 `function shared.<ident>(...)`，调用方通过 `poly_call_shared_*` 积木生成 `shared.<ident>(...)`。
- 函数标识符统一由 [`resolveSharedFnIdent`](../../src/core/backends/scopeAnalysis.ts) 生成（绝不依赖画布内 `getProcedureName`），避免调用方存在同名变量时出现 `shared.step2()` 错位。

---

## 4. 伴随脚本与顶层事件分发（Hat）

- **伴随脚本**：`poly_require_script` 生成 `require("<rawName>")`（使用校验后的原始脚本名，不经 `sanitizeLocalIdent` 改写）。
- **主入口（`entry`）事件路由**：
  - `singleton` 帽块（`on_start`、`on_run`、`on_stop` 等）仅主入口允许，直接导出为顶层全局函数供宿主 C / 沙箱调度器按名查找。
  - `dispatch` 帽块（`on_timer` 及扩展包自定义中断）跨伴随脚本收集后，在主入口自动聚合为单一零闭包路由函数（如 `function on_timer(id)`），伴随分支先拆出独立顶层函数（`on_timer_0()`），路由仅在伴随模块已被显式加载时触发。

---

## 5. 单轨协程、调试插桩与沙箱 ABI

### 5.1 纯净导出（`cleanCode`）vs 沙箱代码（`debugCode` / `moduleDebugCode`）
- **纯净导出**：零调试桩，直接调用宿主全局 `sleep_ms(ms)`，可直接刷入嵌入式 Lua C 宿主（`lua_State*`）运行。
- **沙箱主入口（`debugCode`）**：
  - 将 `on_start` 包装为 `coroutine.create(on_start)`；
  - `sleep_ms(ms)` 在 `on_start` 协程内调用 `_poly.co_sleep(ms)` 后执行 `coroutine.yield("sleep")`，若在事件回调或顶层调用则立即抛出明确运行期错误；
  - 通过 `_poly_tick(blockId, snapshot)` 实现断点挂起、单步步进与变量快照采集。
- **沙箱伴随脚本（`moduleDebugCode`）**：保留行号与 `_poly_tick` 断点桩，剥离主入口调度循环，加载时不会重复启动事件循环。

### 5.2 死循环与超时看门狗
- [`lua.worker.ts`](../../src/plugins/languages/lua/lua.worker.ts) 在进入事件回调前通过 `debug.sethook` 注册指令计数钩子：
  - 若单次事件回调超过用户配置的超时阈值（设置页可调），立即中断并报告疑似死循环；
  - 在断点暂停与 `sleep_ms` 显式挂起期间自动暂停看门狗计时，防止单步调试误杀。

---

## 6. Lua 原生 Blockly 积木防坑清单

以下原生 Blockly Lua 生成器缺陷已在 [`luaBackend.ts`](../../src/plugins/languages/lua/luaBackend.ts) 覆写修正：
1. **`text_join` 字符串拼接**：原生 Lua `..` 遇到 `boolean` 或 `nil` 会直接抛错；已覆写为对非字符串/非数字操作数自动包裹 `tostring(...)`。
2. **`poly_str_replace` 模式字符转义**：Lua `string.gsub` 默认将 `.`、`%`、`-`、`+`、`*`、`[`、`]` 等视为模式通配符；已转义为纯字面量替换，与 Python/JS 语义对齐。
3. **`controls_flow_statements`（`continue`）**：Lua 5.4 无内置 `continue` 关键字，使用 `goto continue` 并在全部原生及自定义 `poly_*` 循环末尾配套 `::continue::` 标签；同时开启 `suppressPrefixSuffix = false` 确保断点行号准确。
4. **容器与字面量运算符优先级**：字典字面量 `{}` 返回 `Order.HIGH`，索引访问 `a[k]` 返回 `Order.ATOMIC`，防止生成 `(a['b'])['val'] = 0` 触发 Lua 赋值语法歧义。
5. **零 `provideFunction_` 注入**：所有列表/数学/随机原语均生成纯原生 Lua 代码，绝不向导出文件注入隐藏辅助函数。
