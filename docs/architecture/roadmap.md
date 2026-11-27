# PolyBlock 架构演进与待优化清单

> 本文档记录当前架构纯度审查后识别出的**非阻塞、可按需推进的结构性优化项**，主要面向“引入第 3 种及更多目标语言后端（如 C / JavaScript / 自定义 DSL）”与长期代码可维护性。核心架构不变量仍以根目录 [AGENTS.md](../../AGENTS.md) 为准。

---

## 1. 多语言后端注册“单一入口”化（新增语言前优先项）

### 当前现状
新增一门目标语言时，需要同步修改 4 处：
1. `ScriptLanguageId` 联合类型（[src/types/project.ts](../../src/types/project.ts)）
2. `LANGUAGE_DIALECTS` 方言元数据表（[src/core/backends/types.ts](../../src/core/backends/types.ts)）
3. 新建后端适配器类（继承 [BaseScriptBackend](../../src/core/backends/baseBackend.ts)）
4. 注册表装配（[src/core/backends/registry.ts](../../src/core/backends/registry.ts)）

### 优化方向
- 让每个 `ScriptBackendAdapter` 自身携带完整 `dialect` 元数据作为唯一真相源，`LANGUAGE_DIALECTS`、`SUPPORTED_LANGUAGE_IDS` 及工具函数统一由 `backendRegistry` 自动派生。
- 针对编译型/仅导出型语言（如嵌入式 C，浏览器无 WASM 沙箱运行器），保持当前 `runnerManager.hasRunnerForLanguage()` 优雅降级机制，并允许板型/语言声明导出工具链元信息（如头文件、CMake/Makefile 片段或固件接口约定）。

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
