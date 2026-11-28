# 句柄并发、作用域与模块化核心规范

> 归属：`docs/guidelines/` · 各语言具体实现细节见 [`docs/languages/README.md`](../languages/README.md)

---

## 1. Layer 0 与 Layer 0.5 边界

- **Layer 0 核心（纯语言原语）**：所有零外部模块依赖的语言原语（`on_start`、`require`/`import`、控制/运算/逻辑/文本含 `str_replace`、列表、字典 5 块、变量、函数）必须留在核心，绝不放进扩展包。
- **Layer 0.5 协作运行时宿主 ABI（与扩展包解耦）**：单句柄单轨协程调度模型（`on_start` 主协程 + 周期/定时槽 + `on_stop` + 统一自定义事件队列）是浏览器沙箱与嵌入式真机共用的最小宿主契约。宿主调度器与 Worker 协议严禁硬编码具体扩展包 ID、积木名或专有外设事件通道；上层扩展包（含 `rt.polyext.json`）仅通过声明式字段对接该 ABI，可平权替换或移除。

---

## 2. 单句柄单轨协程模型（1 句柄 = 1 线程）

- 同一 `RuntimeHandle` 内所有脚本共享状态但**不开多线程**，确保浏览器沙箱与嵌入式真机（如 `lua_State*` / C 宿主）模型完全一致。
- **`on_start` 是唯一允许阻塞延时（`sleep_ms`）的主协程**；所有其他事件回调（`on_run` / `on_timer` / `on_stop` 及扩展包声明的异步回调）与顶层浮动语句栈均为非阻塞短回调，由单轨调度器在 `sleep_ms` 让出点或周期循环中派发，静态诊断与运行时双重拦断非法 `sleep_ms`。
- 无栈协程语言（如 Python / JavaScript）须沿句柄调用图做传递性 `async`/`await` 传染，且跨脚本传染严格限定在 `handle.sharedFunctions`，严禁某脚本私有函数的 `usesSleep` 误传染给另一脚本的同名函数。

---

## 3. 三级变量作用域 + 纯循环局部隔离 + 显式初值

1. **跨文件共享（Shared）**：归集于只读 `shared.<ext>`，同句柄全部脚本可见。
2. **单文件全局（File-Global）**：仅在本文件顶层声明**实际被引用的**非共享、非纯循环变量，禁止未用变量或函数形参污染顶层。
3. **函数/回调局部（`poly_local_*`）**：必须在所属函数或事件回调顶部统一提升声明，避免块级泄漏或 JS TDZ；若与所属函数形参同名，由静态诊断（`local-param-collision-*`）报错阻断，不得生成重复 `let` 或遮蔽形参。
4. **纯循环变量严格局部化（`loopOnly`）**：
   - 仅在 `controls_for` / `controls_forEach` / `poly_for_range` 头部与 `DO` 体使用的非共享变量不得污染文件顶层或 `global` 列表，防止协程让出期间被其他事件回调踩踏同一计数器；
   - `FROM` / `TO` / `BY` / `LIST` 头部表达式归属**外层作用域**而非循环体，只有 `DO` 槽内受循环变量遮蔽。
5. **泛型字段扫描**：编译期变量作用域分析必须遍历积木全部 `Blockly.FieldVariable` 实例（`getBlockVariableFieldIds`），严禁硬编码只读 `'VAR'` 字段。
6. **显式初值与零隐式兜底**：新建变量支持显式初值（`null/number/boolean/string/list/dict`）；**严禁**在运算积木中注入隐式类型兜底（如 `or 0` / `isinstance` / `typeof` 魔术代码），未初始化由业务层暴露。

---

## 4. 两级函数作用域与只读 `shared.<ext>` 模块

- **统一归集**：`跨文件公共函数` 与 `跨文件共享变量` 统一归集至只读 `shared.<ext>`（存在任一跨文件成员即生成，全删即移除，无特判），调用方顶部自动引入。
- **确定性跨画布命名**：跨文件函数定义与调用必须经确定性 `resolveSharedFnIdent`（含混合中文防碰撞哈希与跨语言保留字并集），**禁止**依赖画布局部 `getProcedureName` 在不同画布产生漂移后缀。
- **单文件私有函数**：严格限制在当前文件内，且必须支持同文件前向调用与互递归（例如 Lua 在 `>=2` 个私有函数时自动顶部前向声明 `local f1, f2`）。
- **同句柄伴随脚本显式加载**：普通伴随脚本绝不自动导入，须显式拖入 `poly_require_script`（使用校验后的原始脚本名，不经 `sanitizeLocalIdent` 改写）；调试产物 `moduleDebugCode` 保留行号/断点桩，剥离顶层入口调度心跳。

---

## 5. 顶层事件帽块元数据驱动

- 所有顶层帽块（含核心 `on_start`）统一由 `hat.mode`（`'singleton'` | `'dispatch'`）元数据驱动，严禁按块名写特例。
- 句柄唯一主入口（`entry`）自动限制 `singleton` 仅主入口可用，并聚合全句柄的 `dispatch` 分发路由；某类分发回调全被删除时，主入口对应路由自动消失。
