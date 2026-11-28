# PolyBlock 多语言作用域与插件体系总览

> 本目录系统记录 PolyBlock 每种目标语言的**变量作用域、函数作用域、循环隔离、模块化机制、单轨协程 ABI 与沙箱实现细节**，既作为排障与回忆查阅手册，也作为新增第 4 种及以上目标语言插件的落地蓝本。
>
> - 核心架构红线：[`AGENTS.md`](../../AGENTS.md)
> - 当前系统架构总览：[`docs/architecture/system-architecture.md`](../architecture/system-architecture.md)
> - 后续架构演进规划：[`docs/architecture/roadmap.md`](../architecture/roadmap.md)

---

## 1. 语言文档导航

| 目标语言 | 后端与插件入口 | 沙箱运行器 | 详细作用域与实现文档 |
| --- | --- | --- | --- |
| **Lua 5.4** | [`src/plugins/languages/lua/`](../../src/plugins/languages/lua/index.ts) | Wasmoon WASM Web Worker | [**`lua.md`**](./lua.md) |
| **Python 3** | [`src/plugins/languages/python/`](../../src/plugins/languages/python/index.ts) | MicroPython WASM Web Worker | [**`python.md`**](./python.md) |
| **JavaScript (ES2023 / CJS)** | [`src/plugins/languages/js/`](../../src/plugins/languages/js/index.ts) | 原生 Web Worker（零 WASM 体积） | [**`javascript.md`**](./javascript.md) |

---

## 2. 跨语言统一语义契约（Language-Agnostic Contract）

无论新增何种语言插件，PolyBlock 在 **单个 `RuntimeHandle`（单线程 / 单轨协程循环）** 内对全部语言施加以下统一语义：

### 2.1 三级变量作用域 + 循环变量隔离

| 作用域级别 | 积木/管理方式 | 可见范围 | 存储位置 | 显式初值 |
| --- | --- | --- | --- | --- |
| **跨文件共享（Shared）** | 句柄级变量清单（`handle.sharedVariables`） | 同句柄全部脚本（`main` 及伴随脚本） | 自动生成的只读模块 `shared.<ext>` | 仅在 `shared.<ext>` 声明一次（支持 `null` / 数值 / 布尔 / 字符串 / 列表 / 字典） |
| **单文件全局（File-Global）** | 画布普通变量（非共享、非纯循环） | 仅当前脚本顶层及本文件所有函数/回调 | 本文件顶层声明（**仅声明实际用到的变量**） | 顶层按初值声明；运算块禁止注入隐式类型兜底 |
| **函数/回调局部（Local）** | `poly_local_set` / `poly_local_get` | 仅当前所在函数或事件回调内 | 在所属函数/回调**顶部统一提升声明**，防止分支块泄漏与 TDZ | 默认初始化为空值（`nil` / `None` / `undefined`） |
| **纯循环变量（Loop-Only）** | `controls_for` / `controls_forEach` / `poly_for_range` 中仅在循环头与 `DO` 体使用的非共享变量 | 严格局限于该循环（不污染文件顶层） | 循环局部绑定，避免 `on_start` 与 `on_timer` 等回调踩踏同一计数器 | 由循环语句自身控制 |

> **关键不变量**：
> 1. **头部表达式归属外层**：`for` / `forEach` 的 `FROM` / `TO` / `BY` / `LIST` 输入槽属于**循环外层作用域**，只有 `DO` 槽内部才受循环变量遮蔽（见 [`codegenContext.ts`](../../src/core/backends/codegenContext.ts) `isShadowedByEnclosingForLoop` 与 [`sourceMap.ts`](../../src/core/backends/sourceMap.ts) `isEnclosingLoopVar`）。
> 2. **形参优先与冲突阻断**：函数形式参数屏蔽同名文件全局变量；若函数内 `poly_local_set` 与外层函数形参重名，静态诊断（`local-param-collision-*`）立即标错阻断。
> 3. **泛型字段扫描**：作用域分析通过 [`getBlockVariableFieldIds`](../../src/core/backends/scopeAnalysis.ts) 遍历积木全部 `Blockly.FieldVariable` 实例，不硬编码字段名 `'VAR'`。

### 2.2 两级函数作用域与只读 `shared.<ext>` 模块

| 作用域级别 | 可见范围 | 导出位置 | 跨文件调用机制 |
| --- | --- | --- | --- |
| **跨文件公共函数（Shared）** | 同句柄全部脚本 | 统一归集到只读 `shared.<ext>` | 使用独立积木 `poly_call_shared_noreturn` / `poly_call_shared_return` 调用（杜绝 Blockly 幽灵 `procedures_def*`） |
| **单文件私有函数（Private）** | 仅当前脚本内 | 本脚本顶层，不对外暴露 | 仅本文件内普通调用，且支持同文件前向调用与互递归 |

- **`shared.<ext>` 生成条件（无特判）**：只要当前句柄存在至少 1 个跨文件变量或 1 个跨文件函数（即使只有 `main`），即自动生成只读 `shared.<ext>` 并在使用方顶部自动引入；全部删除后自动移除。
- **确定性跨画布函数标识（`resolveSharedFnIdent`）**：所有跨文件函数的定义与调用统一经过 [`resolveSharedFnIdent`](../../src/core/backends/scopeAnalysis.ts) 生成规范化标识符，**禁止**使用依赖当前画布局部命名冲突表的 `generator.getProcedureName(...)`，保证在任意脚本画布中 `shared.<fn>()` 名称 100% 一致。

### 2.3 标识符规范化与保留字保护

统一由 [`scopeAnalysis.ts`](../../src/core/backends/scopeAnalysis.ts) 与 [`handleVariables.ts`](../../src/core/projects/handleVariables.ts) 执行：
- **跨语言保留字并集**：[`getAllDialectReservedKeywords()`](../../src/core/backends/scopeAnalysis.ts) 动态聚合所有已注册语言插件的 `dialect.keywords`，加上模块/宿主保留字（`shared`、`module`、`exports`、`require`、`on_start`、`sleep_ms` 等），确保项目在任意语言间切换不撞保留字。
- **中文与混合标识符防碰撞**：
  - 纯 ASCII 合法标识符直接保留；
  - 纯中文/Unicode 标识符转为稳定的 `v_<hex>`；
  - **混合非 ASCII + ASCII**（如 `温度1` vs `湿度1`）在去除非法字符后追加确定性 5 位 base-36 哈希后缀，杜绝不同中文前缀被清洗成同一标识符（`v_1`）引发静默变量覆盖。

### 2.4 伴随脚本与单轨协程 ABI（Layer 0.5）

- **伴随脚本显式加载**：非 `shared` 的同句柄伴随脚本不会自动导入，必须通过 `poly_require_script` 显式加载，静态诊断检测未加载或循环引用。调试构建产物为 `moduleDebugCode`（保留断点与单步桩，剥离顶层入口调度心跳）。
- **单轨协程模型**：`on_start` 是唯一允许阻塞延时（`sleep_ms`）的主协程；所有其他事件帽块（`on_run`、`on_timer`、`on_stop` 及扩展包自定义 `dispatch` 回调）均为非阻塞短回调，由 `WorkerRuntimeScheduler` 在 `sleep_ms` 让出点或周期循环中顺序派发。
- **传递性异步传染**：跨脚本传播 `usesSleep` 时严格按 `handle.sharedFunctions` 过滤，避免某脚本私有函数里的 `sleep_ms` 误传染给另一脚本的同名函数。

---

## 3. 三语言核心实现机制速查矩阵

| 维度 | Lua 5.4 ([`lua.md`](./lua.md)) | Python 3 ([`python.md`](./python.md)) | JavaScript ES2023 ([`javascript.md`](./javascript.md)) |
| --- | --- | --- | --- |
| **共享模块导出** | `local shared = {} ... return shared` | 顶层模块变量 + 顶层 `def`（模块即命名空间） | `const shared = {}; ... module.exports = shared;` |
| **共享模块内访问自身变量** | `shared.x`（`bareAttrInSharedModule: false`） | 直接 `x` + 函数内 `global x`（`bareAttrInSharedModule: true`） | `shared.x`（`bareAttrInSharedModule: false`） |
| **单文件全局变量** | 文件顶层 `local x = ...`（词法上值，函数内直接读写） | 文件顶层 `x = ...` + 仅对写入目标发射精确 `global x` | 文件顶层 `let x = ...;`（词法闭包，函数内直接读写） |
| **提升局部变量 (`poly_local_*`)** | 函数/回调顶部 `local a, b` | 函数/回调顶部 `a = None` | 函数/回调顶部 `let a, b;`（自动排除形参及顶层已声明同名变量） |
| **纯循环变量 (`loopOnly`)** | Lua `for i = ...` 天然块局部 | 不在模块顶层声明，不进 `global`，纯函数局部 `for i in ...` | 不在文件顶层声明，统一生成 `for (let i = ...)` 块局部 |
| **单文件私有函数前向/互递归** | 单个用 `local function f()`；`>=2` 个自动提升 `local f1, f2` + `function f1()` | 函数体执行期查全局命名空间，天然支持前向与互递归 | 顶层 `function` 声明自动提升，天然支持前向与互递归 |
| **伴随脚本加载** | `require("mod")` | `import mod`（运行时 VFS 延迟加载） | `require("./mod")`（导出/沙箱均兼容） |
| **阻塞延时 (`sleep_ms`)** | 栈式协程 `coroutine.yield()`（无 `async/await` 语法） | 无栈协程 `async def` + `await sleep_ms(...)`（传递传染） | 无栈协程 `async function` + `await sleep_ms(...)`（传递传染） |
| **死循环保护** | 沙箱 `debug.sethook` 指令计数钩子 + 回调看门狗 | 沙箱循环内 `_poly_yield_check()` + 回调超时检查 | 沙箱循环内 `_poly_yield_check()` + 回调超时检查 |
| **列表索引基数** | **1-based**（与原生 Lua 一致） | **0-based** | **0-based** |
| **沙箱执行引擎** | Wasmoon (Lua 5.4 WASM) Worker | MicroPython WASM Worker | 浏览器原生 Web Worker（零额外 WASM 体积） |

---

## 4. 新增第 4 种目标语言插件指南（`LanguagePlugin`）

PolyBlock 采用 `LanguagePlugin` 单一入口插件架构（见 [`src/core/backends/types.ts`](../../src/core/backends/types.ts)）：

1. **定义 `LanguageDialect`**：声明 `id`、`displayName`、`shortLabel`、`compactLabel`、`accentGradient`、`extension`、`commentToken`、`lineCommentPrefix`、`keywords`、`builtinFuncs`、基础字面量（`boolTrue`/`boolFalse`/`nullLiteral`/`listLiteral`/`dictLiteral`）、`libBinding`、`extractErrorLine` 及可选 `exportToolchain`。
2. **实现 `ScriptBackendAdapter`（继承 [`BaseScriptBackend`](../../src/core/backends/baseBackend.ts)）**：
   - 双产线生成 `cleanCode`（零调试桩、零 `provideFunction_` 魔术函数）与 `debugCode` / `moduleDebugCode`；
   - 完整实现上文 2.1 ~ 2.4 的 3 级变量、循环局部隔离、2 级函数、`shared.<ext>` 与 `SourceMap` / `breakpointableLines`；
   - 逐项通过 [`docs/guidelines/blockly-and-codegen.md`](../guidelines/blockly-and-codegen.md) 中的原生 Blockly 积木准入检查。
3. **可选实现浏览器沙箱 `createRunner`**：若目标语言无需浏览器内仿真（如纯导出型 C / Rust），省略 `createRunner` 即可，`RunnerManager` 与 UI 自动将其识别为「仅导出型语言」并优雅降级。
4. **注册插件**：在 `src/plugins/languages/<lang>/` 下独立组织该语言的 Backend / Runner / Worker，并在 [`src/plugins/languages/index.ts`](../../src/plugins/languages/index.ts) 的 `getDefaultLanguagePlugins()` 中追加（或在宿主运行时调用 `backendRegistry.registerPlugin(plugin)` 热注册）；所有 UI（顶栏、设备页、扩展页、项目配置）、高亮器、脚本库扫描器与静态门禁测试将自动感知并同步生效。
5. **落盘语言文档**：在 `docs/languages/<lang>.md` 按本目录模板记录该语言的作用域与运行细节，并在本页索引表中登记。
