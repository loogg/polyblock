# PolyBlock 架构演进与待优化清单

> 本文档记录当前架构纯度审查后识别出的**非阻塞、可按需推进的结构性优化项**，主要面向“引入第 3 种及更多目标语言后端（如 C / JavaScript / 自定义 DSL）”与长期代码可维护性。核心架构不变量仍以根目录 [AGENTS.md](../../AGENTS.md) 为准。

---

## 1. 多语言后端注册“单一入口”化（已完成 ✅）

### 实现结果
- **单一真相源**：每个具体后端适配器（如 [luaBackend.ts](../../src/core/backends/luaBackend.ts)、[pythonBackend.ts](../../src/core/backends/pythonBackend.ts)）自身完整声明并导出其 `LanguageDialect`（含语法字面量、关键字、`builtinFuncs`、`libBinding` 脚本库导入/调用/扫描/提取器、`extractErrorLine` 运行期错误行解析与可选 `exportToolchain` 工具链元信息）。
- **单一注册入口**：[src/core/backends/registry.ts](../../src/core/backends/registry.ts) 的 `BUILTIN_BACKEND_ENTRIES` 是全工程唯一内置语言清单；`RegisteredLanguageId`（[src/types/project.ts](../../src/types/project.ts) 中的 `ScriptLanguageId`）、方言查询、扩展名识别、语法高亮、保留关键字校验、脚本库扫描、导入模块解析与 UI 语言选项全部自动由 `backendRegistry` 动态派生。
- **零旧表残留**：彻底移除 `types.ts` 中硬编码的 `LANGUAGE_DIALECTS` / `SUPPORTED_LANGUAGE_IDS` 以及 `scriptLibScanner.ts` / `moduleResolver.ts` / `logParser.ts` / `highlight.ts` 中的二元语言分支表（由单元测试持续守门）。
- **新增第 3 种目标语言的标准 2 步配方**：
  1. 新建 `src/core/backends/<lang>Backend.ts`（导出 `<LANG>_DIALECT` + 继承 [BaseScriptBackend](../../src/core/backends/baseBackend.ts) 的适配器类；编译型/仅导出型语言可声明 `exportToolchain` 并无需注册 WASM Runner）。
  2. 在 [src/core/backends/registry.ts](../../src/core/backends/registry.ts) 的 `BUILTIN_BACKEND_ENTRIES` 追加 1 行条目（如需浏览器沙箱仿真，再按需在 `runnerManager` 注册对应 Runner）。

---

## 2. 三个偏大前端模块的垂直拆瘦

当前逻辑已按职责分层，但有 3 个文件篇幅超过 1,000 行，后续功能扩展时可按子域自然拆分：

| 模块 | 当前规模 | 建议拆瘦边界 |
| --- | ---: | --- |
| [src/hooks/useProjectStore.ts](../../src/hooks/useProjectStore.ts) | ~1,291 行 | 拆为「持久化与工程/模板切换」「句柄与脚本 CRUD」「变量/函数作用域变更与导出动作」3 个子 Hook |
| [src/core/extensions/registry.ts](../../src/core/extensions/registry.ts) | ~1,211 行 | 拆为「扩展包注册与存储（含 `isBuiltin`）」「Blockly 积木/帽块动态注册器」「工具箱与能力查询视图」 |
| [src/components/BlocklyWorkbench.tsx](../../src/components/BlocklyWorkbench.tsx) | ~1,090 行 | 拆出「右键菜单与自定义动作注册」「Flyout 工具箱同步与搜索」「只读/运行锁定控制器」 |

---

## 3. 编译型 / 静态类型语言（如 C / TypeScript）的协议前瞻

- **执行模型天然兼容**：当前单句柄单轨协程循环（`on_start` 主协程 + 顶层零闭包 `singleton`/`dispatch` 事件回调）与嵌入式 C 宿主模型高度一致，无需修改三层工程拓扑与 `.polyext.json` 单轨协议。
- **变量显式初值驱动类型推导**：3 级变量模型已支持显式初值 `VariableInitialValue`（`null | number | boolean | string | list | dict`）；面向静态类型语言时可直接由初值推导声明类型（如 `double`/`int`/`bool`/`const char*`），或按需在变量元信息中补充可选静态类型标注。
- **容器原语适配**：列表、字典 5 块原语统一遵循纯值槽原则（`input_value`）且无 Blockly 隐藏辅助函数，C 后端可直接映射至目标固件提供的轻量容器头文件/宏库（如 `poly_list_*` / `poly_dict_*`）。
