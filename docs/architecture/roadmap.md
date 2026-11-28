# PolyBlock 架构演进与待优化路线

> 本文档仅记录**面向未来的结构演进与待规划项**（不含日常红线与历史已完成记录；日常开发红线见 [`AGENTS.md`](../../AGENTS.md) 与 [`docs/guidelines/`](../guidelines/)）。

---

## 1. 后端与运行时结构演进

- **收敛多语言后端公共样板至 `BaseScriptBackend`**：将 Lua / Python / JS 后端在扩展帽块注册（`registerExtensionHat`）、`poly_local_*`、`variables_get/set` 与 `poly_call_shared_*` 上的公共遍历与作用域绑定骨架进一步上移至 `BaseScriptBackend`，降低新增目标语言的接入成本。
- **消除 `workspaceContextBridge` 渲染期同步**：将代码生成依赖的句柄变量、通道池与伴随脚本元信息全面收口为纯输入参数 `CompileContext`，彻底消除渲染期全局可变桥接。
- **未知动态语言 ID 保留与缺失插件提示**：打开外部动态语言插件创建的 `.polyblock.json` / `.polyblock.zip` 且当前会话尚未注册该插件时，保留原始 `project.language` 并在顶部展示「缺失语言插件」诊断横幅（而非回退至默认语言）。
- **板型 `maxHandles` 软/硬约束与外部硬件 Runner**：在新建句柄流程接入 `TargetProfile.maxHandles` 上限校验/提示；面向外部真机通道（WebSocket / Local Bridge / Web Serial）完善 `RunnerManager` 单实例与多句柄工厂能力区分。
- **前端 3 大 Hook 解耦**：`useProjectStore` / `useExecutionController` / `useExtensionActions` 的 `executionBridgeRef` 双向回调可升级为轻量 React Context 或类型化事件总线。

---

## 2. 三个偏大模块的垂直拆瘦

| 模块 | 当前规模 | 建议拆瘦边界 |
| --- | ---: | --- |
| [`src/hooks/useProjectStore.ts`](../../src/hooks/useProjectStore.ts) | ~1,420 行 | 拆为「持久化与工程/模板切换」「句柄与脚本 CRUD」「变量/函数作用域变更与导出动作」3 个子 Hook |
| [`src/core/extensions/registry.ts`](../../src/core/extensions/registry.ts) | ~1,430 行 | 拆为「扩展包注册与差分持久化」「Blockly 积木/帽块动态注册器」「工具箱与可读预览格式化器」 |
| [`src/components/BlocklyWorkbench.tsx`](../../src/components/BlocklyWorkbench.tsx) | ~1,100 行 | 拆出「右键菜单与自定义动作注册」「Flyout 工具箱同步与搜索」「只读/运行锁定控制器」 |

---

## 3. 编译型 / 静态类型语言（如 C / Rust / TypeScript）的协议前瞻

- **执行模型兼容**：Layer 0.5 单句柄单轨协程循环（`on_start` 主协程 + 顶层零闭包 `singleton`/`dispatch` 事件回调）与嵌入式 C 宿主模型一致，无需修改三层工程拓扑与 `.polyext.json` 单轨协议。
- **多产物文件输出（`.h` + `.c`）**：当前每个 `ProjectScript` 与 `shared` 模块默认映射单文件 `<name>.<ext>`；面向 C/C++ 等需要头文件配对的语言时，可在 `LanguageDialect.exportToolchain` 扩展多输出单元能力（如 `shared.h` + `shared.c`）。
- **变量显式初值驱动类型推导**：3 级变量模型已支持显式初值 `VariableInitialValue`（`null | number | boolean | string | list | dict`）；面向静态类型语言时可直接由初值推导声明类型，或按需补充可选静态类型标注。
- **容器原语适配**：列表、字典 5 块原语统一遵循纯值槽原则（`input_value`）且零隐藏辅助函数，C 后端可直接映射至目标固件提供的轻量容器头文件/宏库（如 `poly_list_*` / `poly_dict_*`）。
