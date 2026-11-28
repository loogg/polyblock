# Python 3 语言插件与作用域实现规范

> 返回总览：[`docs/languages/README.md`](./README.md) · 后端源码：[`src/plugins/languages/python/pythonBackend.ts`](../../src/plugins/languages/python/pythonBackend.ts) · 沙箱 Worker：[`src/plugins/languages/python/python.worker.ts`](../../src/plugins/languages/python/python.worker.ts)

---

## 1. 插件与方言配置（`PYTHON_DIALECT`）

| 属性 | 值 / 说明 |
| --- | --- |
| 语言 ID / 后缀 | `id: 'python'` · 扩展名 `.py` · 注释 `#` |
| 共享模块引用风格 | `sharedModuleStyle: 'module'` · `bareAttrInSharedModule: true`（在 `shared.py` 内部直接访问顶层变量 + `global`） |
| 协程模型 | **无栈协程（Stackless `async/await`）**：`on_start` 导出为 `async def on_start():`，对直接或传递调用 `sleep_ms` 的自定义函数自动传染 `async def` / `await` |
| 列表索引 | **0-based** |
| 浏览器运行器 | `MicroPython` WebAssembly 运行于独立 Web Worker（[`workerWasmRunner.ts`](../../src/core/runners/workerWasmRunner.ts)） |

---

## 2. 变量作用域实现细节

### 2.1 跨文件共享变量（`shared.py`）
- **生成位置**：统一归集至只读模块 `shared.py` 顶层（Python 模块本身即命名空间对象）：
  ```python
  counter = 0
  ```
- **外部脚本读写**：其他脚本顶部自动注入 `import shared`，通过 `shared.counter` 读写。
- **`shared.py` 内部函数读写**：因为 `bareAttrInSharedModule: true`，定义在 `shared.py` 中的公共函数直接读写裸标识符 `counter`，且仅当该函数体内对 `counter` 执行赋值/增量写入时，才在函数顶部精确发射 `global counter`（避免无意义的 `import shared` 自循环引入）。

### 2.2 单文件全局变量（最小精确 `global` 注入）
- **声明方式**：仅声明本文件实际被引用的非共享、非纯循环变量：
  ```python
  total = 0
  ```
- **精确 `global` 规则（严禁默认散弹声明）**：
  - Python 中函数体内若只读模块变量无需 `global`，只有赋值（`=`、`+=` 等）需要 `global`；
  - `pythonBackend.ts` 覆写了 Blockly 默认 `variables_set` / `math_change` / `text_append` 与函数体分析逻辑：仅当某函数/回调体内真正**写入**了某个非共享、非纯循环、非形参、非局部的文件全局变量时，才在该函数顶部发射 `global <vars>`；
  - 绝不向无关函数注入整张画布所有变量的 `global` 列表。

### 2.3 函数/回调局部变量（`poly_local_set` / `poly_local_get`）
- Python 函数内所有未声明 `global` 的赋值变量天然属于函数局部作用域；但若变量仅在 `if` 分支内赋值、分支外读取会触发 `UnboundLocalError`。
- 后端在所属函数/回调顶部统一提升初始化（排除已作为函数形参的名称）：
  ```python
  def on_timer_0():
    tmp = None
    if cond:
      tmp = 42
    print(tmp)
  ```
- 若 `poly_local_set` 与外层函数形参同名，静态诊断 `local-param-collision-*` 直接报错阻断。

### 2.4 纯循环变量（`loopOnly` 防并发踩踏）
- **为什么必须特殊处理**：在原生 Blockly Python 生成器中，`for i in range(1, 4):` 若把 `i` 当作普通文件变量，会在顶层声明 `i = None` 并在 `on_start` 与 `on_timer` 中都发射 `global i`。在单轨协程让出点（`await sleep_ms(...)`）切换执行 `on_timer` 时，`on_timer` 的 `for i` 会直接覆盖 `on_start` 正在使用的循环计数器 `i`！
- **PolyBlock 作用域实现**：
  - `analyzeWorkspaceVariables` 标记仅在循环头部与 `DO` 体中使用的非共享变量为 `loopOnly: true`；
  - `pythonBackend.ts` 将 `loopOnly` 变量从模块顶层声明和函数 `global ...` 列表中剔除，使 `for i in range(...)` 成为纯粹的**函数局部变量**，与 Lua 保持 100% 一致的并发隔离语义。
  - 若用户在循环外部确实读写了 `i`，则 `loopOnly` 自动为 `false`，回退为普通单文件全局变量。

---

## 3. 函数作用域与异步传染

### 3.1 单文件私有函数 & 跨文件公共函数
- Python 函数体在调用期而非定义期查找模块全局命名空间，因此单文件私有函数天然支持任意顺序的前向调用与互递归。
- 跨文件公共函数统一归集到 `shared.py` 中，函数名经 [`resolveSharedFnIdent`](../../src/core/backends/scopeAnalysis.ts) 确定性生成，调用方通过 `poly_call_shared_*` 生成 `shared.<ident>(...)`。

### 3.2 `async` / `await` 传递性传染
- 静态分析阶段（[`eventMode.ts`](../../src/core/backends/eventMode.ts)）构建句柄级调用图：
  1. 扫描直接包含 `poly_wait_ms` 的函数；
  2. 沿本文件私有函数与跨文件 `handle.sharedFunctions` 做不动点传递闭包计算（严格按 `sharedFunctions` 过滤，**绝不**将另一脚本私有函数的 `usesSleep` 误传染到同名函数）；
  3. 凡被标记 `usesSleep` 的函数均导出为 `async def`，其全部调用点（含 `shared.<fn>()`）自动添加 `await`。
- **纯净导出与沙箱同构**：纯净导出代码同样保留标准 `async def` / `await sleep_ms(...)` ABI，可直接运行于标准 Python 3 `asyncio` 或 MicroPython `uasyncio` 宿主。

---

## 4. 伴随脚本与顶层事件分发

- **伴随脚本加载**：`poly_require_script` 使用校验后的原始模块名直接生成 `import <rawName>`（不被 `sanitizeLocalIdent` 改写）。
- **主入口分发路由**：当主入口需要路由至伴随脚本中的 `dispatch` 回调分支时，自动按需引入 `import sys` 并通过 `sys.modules.get('<mod>')` 安全调用已加载伴随模块，**绝不**在文件顶部隐式自动导入伴随脚本。

---

## 5. 沙箱调试与 MicroPython WASM Worker ABI

- **虚拟文件系统（VFS）挂载**：[`python.worker.ts`](../../src/plugins/languages/python/python.worker.ts) 在运行前将三层模块解析产物（`global -> project -> handle` 顺序）写入 MicroPython VFS，使 `import` 原生按优先级解析。
- **双代码产线**：
  - `cleanCode`：纯净 Python 3 / MicroPython 代码，零 `_poly` 调试桩；
  - `debugCode`：注入 `_poly_tick(bid, snap)`、`_poly_yield_check()` 与异步 `sleep_ms(_ms)` 桥接层；在 `on_start` 运行超时片时协作让出给调度器，在事件回调内调用 `sleep_ms` 抛出明确 `RuntimeError`；
  - `moduleDebugCode`：供伴随脚本挂载，保留行号/断点桩并剥离主入口心跳。
- **回调看门狗**：所有循环体内在 `debugPass` 注入 `await _poly_yield_check()`，实时检查停止信号与单次事件回调超时（`cb_expired()`），防止死循环卡死 Worker。

---

## 6. Python 原生 Blockly 积木防坑清单

1. **禁止默认 `global` 散弹声明**：覆写 `procedures_defnoreturn` / `procedures_defreturn` 与全部变量读写块，仅对函数内实际写入的文件全局变量发射最小 `global` 列表。
2. **零 `provideFunction_` 魔术代码**：列表、文本替换、随机整数等直接生成原生 Python 表达式（如 `random.randint(a, b)` + 顶部 `import random`），绝不注入隐藏辅助函数。
3. **无隐式类型兜底**：`math_change` 直接生成 `x += delta`（绝不生成 Blockly 默认的 `x = (x if isinstance(x, Number) else 0) + delta` 魔术代码）。
4. **`controls_flow_statements` 断点对齐**：解除原生 `suppressPrefixSuffix = true`，使 `break` / `continue` 行可正确命中 `SourceMap` 与断点。
