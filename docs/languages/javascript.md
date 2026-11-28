# JavaScript (ES2023 / CommonJS) 语言插件与作用域实现规范

> 返回总览：[`docs/languages/README.md`](./README.md) · 后端源码：[`src/plugins/languages/js/jsBackend.ts`](../../src/plugins/languages/js/jsBackend.ts) · 沙箱核心：[`src/plugins/languages/js/jsSandboxCore.ts`](../../src/plugins/languages/js/jsSandboxCore.ts) · Worker 入口：[`src/plugins/languages/js/js.worker.ts`](../../src/plugins/languages/js/js.worker.ts)

---

## 1. 插件与方言配置（`JS_DIALECT`）

| 属性 | 值 / 说明 |
| --- | --- |
| 语言 ID / 后缀 | `id: 'js'` · 扩展名 `.js` · 注释 `//` |
| 模块规范 | **CommonJS**（`require(...)` / `module.exports = ...`），兼顾 Node.js、QuickJS / Espruino / Moddable 与浏览器沙箱 |
| 共享模块引用风格 | `sharedModuleStyle: 'table'` · `bareAttrInSharedModule: false`（模块内同样使用 `shared.x`） |
| 协程模型 | **无栈协程（Stackless `async/await`）**：`on_start` 导出为 `async function on_start()`，对含 `sleep_ms` 的自定义函数做传递性 `async` / `await` 传染 |
| 列表索引 | **0-based** |
| 浏览器运行器 | **原生 Web Worker（零 WASM 体积）**（[`jsRunner.ts`](../../src/plugins/languages/js/jsRunner.ts)，`kind: 'browser-worker'`，`transportLabel: '原生 Web Worker · 零 WASM 体积'`） |

---

## 2. 变量作用域实现细节

### 2.1 跨文件共享变量（`shared.js`）
- **生成位置**：统一归集至只读模块 `shared.js`：
  ```js
  const shared = {};
  shared.counter = 0;
  module.exports = shared;
  ```
- **读写方式**：无论在 `main.js`、伴随脚本还是 `shared.js` 内部函数，均通过 `shared.<attr>` 读写；使用方顶部自动注入 `const shared = require("./shared");`。
- **防止 `controls_for` 双前缀**：若循环变量显式绑定到共享变量，循环生成不会重复拼接 `shared.shared.x`。

### 2.2 单文件全局变量（File-Global）
- **声明方式**：仅扫描本文件实际被引用的非共享、非纯循环、非形参变量，在文件顶部生成 `let` 声明：
  ```js
  let total = 0;
  ```
- **函数内可见性**：依托 JavaScript 词法闭包，文件内所有函数与事件回调直接读写顶层 `let` 变量，且模块运行在严格模式包装函数内，绝不污染全局 `globalThis`。

### 2.3 函数/回调局部变量（`poly_local_set` / `poly_local_get`）
JavaScript 的 `let` 具有严格块级作用域与暂时性死区（TDZ），且同作用域重复 `let` 会直接报 `SyntaxError`。[`jsBackend.ts`](../../src/plugins/languages/js/jsBackend.ts) 做了三重防护：
1. **函数/回调顶部统一提升**：在所属函数或事件回调顶部收集所有 `poly_local_set` 目标并生成单一 `let a, b;`（[`buildJsHoistedLocalsLine`](../../src/plugins/languages/js/jsBackend.ts)），函数内所有分支安全赋值，杜绝块泄漏与 TDZ。
2. **自动排除形式参数**：提升列表通过 `excludeIdents` 自动跳过外层函数的形参名（配合静态诊断 `local-param-collision-*` 拦截），绝不生成 `function f(x) { let x; }` 的非法语法。
3. **顶层浮动栈与 `poly_require_script` 兼容**：
   - 若用户将 `poly_local_set` 挂在 `poly_require_script` 下方（非事件帽块、非函数定义），顶层提升器不会将其误判为帽块而跳过，确保在赋值语句之前已声明 `let`；
   - 若顶层已存在同名文件全局变量（`defs.variables`），顶层局部提升自动跳过，杜绝重复 `let` 导致 `SyntaxError`。

### 2.4 纯循环变量（`loopOnly` 块级隔离）
- **并发安全动因**：若将 `for` 循环计数器声明在文件顶层（如 `let i` + `for (i = 1; ...)`），不仅会在严格模式的 `shared.js` 公共函数内触发 `ReferenceError`，还会在 `on_start` 协程经 `await sleep_ms` 让出期间，被并发派发的 `on_timer` 循环覆盖同一个计数器 `i`。
- **PolyBlock 块级隔离实现**：
  - `analyzeWorkspaceVariables` 将仅出现在 `controls_for` / `controls_forEach` / `poly_for_range` 头部与 `DO` 体的非共享变量标记为 `loopOnly: true`；
  - `jsBackend.ts` 将 `loopOnly` 变量从文件顶部 `let` 声明中剔除，并统一生成严格块级作用域循环头：
    ```js
    for (let i = 1; i <= 3; i++) {
      ...
    }
    ```
  - 无论在 `main.js` 还是只读 `shared.js` 公共函数内，均严格合规且与 Lua/Python 保持一致的并发隔离语义。

---

## 3. 函数作用域与异步传染

- **单文件私有函数**：以顶层 `function foo(...)`（或 `async function foo(...)`）声明，依托 JS 函数声明提升天然支持前向调用与互递归，且不挂到 `module.exports`。
- **跨文件公共函数**：在 `shared.js` 中导出为 `shared.<ident> = function(...) { ... };`（或 `async function`），标识符统一经 [`resolveSharedFnIdent`](../../src/core/backends/scopeAnalysis.ts) 确定性生成。
- **`async` / `await` 传递性传染**：与 Python 共享同一份 [`eventMode.ts`](../../src/core/backends/eventMode.ts) 句柄调用图分析器，严格仅沿本文件私有函数及 `handle.sharedFunctions` 传播 `usesSleep`。

---

## 4. 伴随脚本与真机 / Node.js 导出约定

- **伴随脚本加载**：`poly_require_script` 直接使用校验后的原始模块名生成 `require("./<rawName>")`（不被 `sanitizeLocalIdent` 改写）。
- **外部扩展库 vs 本地脚本**：
  - 同句柄伴随脚本及 `shared` 使用相对路径 `require("./<name>")`，导出 `.zip` 后在 Node.js 中直接执行 `node main.js` 即可开箱解析；
  - 扩展包脚本库（`libs`）按包内 `imports.js` 声明生成对应 `require(...)` 语句，运行时由三层模块解析器（`handle > project > global`）决定最终挂载版本；真机导出时严格剥离 `sandboxMock`。
- **伴随脚本分发路由**：主入口通过 `_poly_get_loaded_mod("<mod>")`（沙箱）或 `require.cache` 探测已加载的伴随模块并分发 `dispatch` 事件，绝不自动隐式执行未加载的伴随脚本。

---

## 5. 原生 Web Worker 沙箱 ABI（零 WASM）

[`jsSandboxCore.ts`](../../src/plugins/languages/js/jsSandboxCore.ts) 与 [`js.worker.ts`](../../src/plugins/languages/js/js.worker.ts) 直接复用浏览器原生 V8 / SpiderMonkey / JavaScriptCore 引擎，**零外部 WASM 下载体积**，但与 Lua/Python Worker 严格共用同一套 `WorkerRuntimeScheduler` 与 `WorkerProtocolHost`：
- **虚拟 CommonJS 加载器**：内置隔离的 `require()` 与模块缓存，按 `global -> project -> handle` 优先级加载扩展库、`sandboxMock` 与伴随脚本，模块在 `'use strict'` 沙箱闭包内执行，每次运行完全干净重置。
- **字符串/注释感知的 `stripTopLevelDebugTicks`**：剥离伴随脚本 `moduleDebugCode` 中的顶层入口调试桩时，采用词法级字符串（`'`/`"`/`` ` ``）与注释（`//`、`/* */`）感知的大括号深度扫描，绝不会被代码中的 `"}"` 或注释里的 `{` 破坏结构。
- **异步协程与死循环保护**：`sleep_ms(_ms)` 仅允许在 `on_start` 协程内调用；循环体在 `debugPass` 注入 `await _poly_yield_check()` 实现单次事件回调超时保护与实时停止响应。

---

## 6. JavaScript 原生 Blockly 积木防坑清单

1. **零 `provideFunction_` 魔术函数**：`math_random_int` 直接生成内联 `Math.floor(Math.random() * (b - a + 1) + a)`，`text_append` 直接生成 `x += String(...)`，零隐藏辅助函数。
2. **零 `var` 声明**：全部用户变量与提升局部变量均使用 `let` / `const`，彻底规避 `var` 函数级提升与全局属性泄漏。
3. **无隐式类型兜底**：`math_change` 直接生成 `x += delta;`（绝不注入 `typeof x === 'number' ? x : 0` 魔术代码）。
4. **`controls_flow_statements` 断点对齐**：与 Lua/Python 一致解除 `suppressPrefixSuffix = true`，保障 `break` / `continue` 在 `SourceMap` 与调试断点中可命中。
