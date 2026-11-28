# PolyBlock 架构演进与产品路线

> 本文档记录**已确认的产品推进优先级与面向未来的非阻塞结构演进**（不含日常开发红线；日常红线见 [`AGENTS.md`](../../AGENTS.md) 与 [`docs/guidelines/`](../guidelines/)）。
>
> **定位锚点**：PolyBlock 是面向私有硬件与嵌入式脚本引擎的**业务层安全编排、秒级离线模拟与纯净脚本下发底座**——底层驱动与滤波归属设备固件，复杂算法沉淀在原生脚本库，工程以 `.polyblock.zip` 严格锁定整包交付、永不丢环境。

---

## 1. 近期核心方向（直接服务业务闭环）

### 1.1 快速新建与编辑积木包工作流
- **目标**：大幅降低为新设备 API 或业务算法库制作 `.polyext.json` 扩展包的门槛，兼顾人工可视化配置与 AI 辅助生成。
- **规划内容**：
  - 提供**快速新建/编辑扩展包向导**（可视化配置包元信息、组件、积木参数、多语言模板、通道池与模拟控件，免手写转义 JSON）；
  - 配套目录级脚本/配置一键打包工具，与现有 `schemas/polyext.schema.json` 及示例模板形成闭环，方便人工与 AI 高准确率产出扩展包；
  - 增强项目私有脚本库（`libs[]`）的源码更新与一键重新扫描体验，把复杂算法稳定沉淀在库层、保持积木层简洁。

### 1.2 设备日志专用扩展包模式（同真机 API）
- **目标**：将业务日志升级为与真实设备日志模块 1:1 对齐的标准扩展包（如 `logger.polyext.json`，提供 `logger.info` / `logger.warn` / `logger.error` 等真实设备接口），Layer 0 保持纯语言无依赖的 `print`。
- **双端协同**：
  - **浏览器模拟**：通过日志包的 `sandboxMock` 输出标准分级日志到工作台 `LogConsole`，零改动复用分级着色与过滤；
  - **真实设备**：部署导出自动剥离 `sandboxMock`，脚本直接调用固件原生日志接口；不同硬件平台可各自提供贴合自身 API 的日志扩展包。

### 1.3 真实设备脚本下载通道 + 只读日志回显
- **边界明确**：**只做脚本下发与可选只读日志回显，不做联机真机单步断点调试**（逻辑调试与断点在浏览器仿真阶段完成，底层驱动与抗干扰由板子固件保障）。
- **规划内容**：
  - 基于现有 `ScriptRunner` / `RunnerManager` 抽象，按需接入真实下载通道（Web Serial / 本机桥接 Agent / HTTP·WS 接口），一键将纯净导出脚本与 `libs` 下发至设备；
  - 支持将设备吐出的日志流只读回显至底部 `LogConsole`，并复用 `SourceMap` 与 `extractErrorLine` 实现设备运行报错行号反向定位积木。

---

## 2. AI 协同编排前瞻

- **受控白名单积木生成**：结合当前项目启用的 `.polyext.json` 积木定义与 Schema，支持由自然语言让 AI 生成严格受限于当前板型能力白名单的积木工作区 JSON，再经 PolyBlock 静态诊断与本地沙箱仿真跑通、人工可视化微调后下发设备（兼具 AI 提效与积木护栏防呆）。

---

## 3. 按需推进的架构提纯与扩展前瞻（非阻塞）

以下事项仅在引入新目标语言或模块继续增长时按需推进，不阻塞核心业务闭环：

- **收敛多语言后端公共样板至 `BaseScriptBackend`**：将 Lua / Python / JS 后端在扩展帽块注册（`registerExtensionHat`）、`poly_local_*`、`variables_get/set` 与 `poly_call_shared_*` 上的重复骨架进一步上移至基类。
- **消除 `workspaceContextBridge` 渲染期同步**：将代码生成依赖的句柄变量、通道池与伴随脚本元信息全面收口为纯输入参数 `CompileContext`。
- **未知动态语言 ID 保留与板型上限提示**：打开未安装动态语言插件创建的工程时保留原 `project.language` 并展示缺失插件横幅；在新建句柄流程按需接入 `TargetProfile.maxHandles` 提示；完善 `RunnerManager` 单实例外部 Runner 与多句柄工厂的能力区分。
- **前端 3 大 Hook 解耦与超千行模块拆瘦**：
  - `useProjectStore` / `useExecutionController` / `useExtensionActions` 的双向回调可升级为轻量 Context 或事件总线；
  - 按需垂直拆分 [`useProjectStore.ts`](../../src/hooks/useProjectStore.ts)（~1,420 行）、[`extensions/registry.ts`](../../src/core/extensions/registry.ts)（~1,430 行）与 [`BlocklyWorkbench.tsx`](../../src/components/BlocklyWorkbench.tsx)（~1,100 行）。
- **编译型 / 静态类型语言（如 C / Rust / TypeScript）前瞻**：Layer 0.5 单句柄单轨协程模型与显式变量初值天然兼容静态类型与嵌入式 C 宿主；后续可在 `LanguageDialect.exportToolchain` 扩展多产物输出（如 `.h` + `.c`），列表/字典纯值槽原语可直接映射目标固件轻量容器库。
