# PolyBlock 系统架构与工程方案

> 本文档描述 PolyBlock **当前生效**的系统架构；核心架构不变量与开发红线以根目录 [AGENTS.md](../../AGENTS.md) 为准，后续架构优化与新增语言演进规划见 [roadmap.md](./roadmap.md)，各演进阶段的历史验收记录归档于 [docs/acceptance/](../acceptance/)。

## 1. 四层解耦架构总览

```text
+------------------------------------------------------------------------------+
|                       UI 表现层 (React 19 + TypeScript)                       |
|  [TopBar] [ActivityRail (#/hash)] [BlocklyWorkbench] [CodeInspector] [Logs]  |
+---------------------------------------+--------------------------------------+
                                        | Blockly JSON / CompileContext / 事件
                                        v
+------------------------------------------------------------------------------+
|            Layer 0 · 通用编程内核 (src/core/blocks + src/core/projects)       |
|  - MicroZelosRenderer + Light/Dark Theme + 10 个核心积木分类 (10..90，含字典) |
|  - v3 三层工程树: Project -> RuntimeHandle -> ProjectScript (含 shared 模块)  |
|  - 3 级变量作用域 (跨文件共享 / 单文件全局 / 提升局部) + 2 级函数作用域         |
+---------------------------------------+--------------------------------------+
                                        |
                                        v
+------------------------------------------------------------------------------+
|       Layer 1~3 · 声明式板型与单轨扩展体系 (src/{packs,boards,demos,templates})|
|  - 全成品 JSON 资产 + manifest.json 顺序清单（随构建内置，便携 JSON 无 builtin 字段）|
|  - TargetProfile (.polyboard.json): 目标语言 / 最大句柄数 / 默认能力裁剪       |
|  - PolyExtensionPack (.polyext.json): 单轨 sections[] + 多语言 code/sources   |
|    · 预装平级包: rt (lifecycle/timers/tick) / virtual-board / clock-timer     |
|    · 3 层纯作用域解析: 句柄脚本 > 项目内嵌包 > 全局扩展包 (libs vs sandboxMock)|
|    · 声明式能力: hat (singleton/dispatch) / handleConfigs / runtimeMonitor   |
|                 / simWidgets (packId::key 命名空间隔离 + emitEvent)           |
+---------------------------------------+--------------------------------------+
                                        |
                                        v
+------------------------------------------------------------------------------+
|                  多语言后端插件层 (src/core/backends)                         |
|  BackendRegistry 单一入口 (统一 ScriptBackendAdapter + 自带 LanguageDialect)    |
|    ├── LuaBackendAdapter    (Lua 5.4 双产线生成 + SourceMap + 静态诊断)       |
|    └── PythonBackendAdapter (Python 3 双产线生成 + async/await 传递传染)      |
+---------------------------------------+--------------------------------------+
                                        | cleanCode (导出) / debugCode (沙箱)
                                        v
+------------------------------------------------------------------------------+
|            可插拔执行器与导出层 (src/core/runners + workers + export)          |
|  - WorkerWasmRunner + MultiHandleRunner (Wasmoon Lua 5.4 / MicroPython WASM) |
|  - 单句柄单轨协程调度器 (WorkerRuntimeScheduler) + 断点/单步/遥测/外设总线     |
|  - BundleExporter: 单脚本 / 单句柄 .zip / 整工程 .zip (自动剥离 sandboxMock)  |
+------------------------------------------------------------------------------+
```

## 2. 工程模型、作用域与协程并发

### 2.1 三层工程拓扑（`Project → RuntimeHandle → ProjectScript`）
- **Project（项目）**：绑定目标语言（`language`）、目标板型（`targetProfileId`）、统一能力列表（`enabledCapabilities`）与项目内嵌扩展包（`localExtensions`）；导出 `.polyblock.json` 时自动生成便携快照 `bundledExtensions`，导入时直接吸收为项目内嵌包而不污染全局库。
- **RuntimeHandle（隔离运行句柄）**：1:1 映射真机独立 VM（如 `lua_State*`）。持有独立 `capabilityConfigs`（按 `configKey` 隔离通道池数量与别名）、唯一主入口标记（`entryScriptId`）、以及 `sharedVariables` / `sharedFunctions` 清单。
- **Style A1 只读 `shared.<ext>` 模块**：只要句柄存在任一跨文件共享变量或公共函数，即自动生成只读 `shared.<ext>` 并在调用方顶部自动引入；伴随普通脚本不自动导入，须显式拖入「加载脚本」（`require` / `import`）。

### 2.2 单轨协程与零闭包事件分发 ABI
- **1 句柄 = 1 线程 / 单轨协程循环**：同一句柄内所有脚本共享状态但不开多线程，确保浏览器沙箱与真机 C 宿主模型完全一致。
- **`on_start` 主协程与 `sleep_ms`**：只有 `on_start`（及其传递调用的自定义函数）允许调用阻塞延时 `sleep_ms(ms)`（Lua）/`await sleep_ms(ms)`（Python）；事件回调内禁止阻塞延时并在静态诊断中标错。
- **零闭包顶层事件帽块**：所有顶层帽块由 `hat.mode` 声明驱动：
  - `singleton`（如 `on_start`、`on_run`、`on_stop`）：全句柄唯一，仅主入口可用。
  - `dispatch`（如 `on_timer`、`on_button`、自定义外设中断）：跨脚本自动在主入口聚合为单一顶层分发路由函数（可选 `extractBranchFnPrefix` 拆出独立全局分支函数），无闭包注册表开销。

### 2.3 双代码产线（纯净导出 vs 沙箱调试）
- **`cleanCode`**：零调试桩、零 `provideFunction_` 隐藏魔术代码、零隐式类型兜底，直接用于代码预览与真机部署导出。
- **`debugCode` / `moduleDebugCode`**：仅在浏览器 WASM 沙箱运行，注入行号/块步进桩与非阻塞协程让出点；伴随脚本使用 `moduleDebugCode`（保留断点与单步桩，剥离顶层入口调度心跳），在断点暂停与显式等待期间自动暂停看门狗计时防止误杀。

## 3. 声明式扩展包与 3 层模块解析

详见完整协议文档：[docs/extension-pack-spec.md](../extension-pack-spec.md) 与 [schemas/polyext.schema.json](../../schemas/polyext.schema.json)。

- **Layer 0 边界**：10 个核心分类（`event #10`、`print #20`、`control #30`、`variables #40`、`math #50`、`logic #60`、`text #70`、`lists #80`、`dicts #85`、`functions #90`）涵盖所有零外部依赖语言原语；容器操作统一遵循纯值槽原则（`input_value`）。
- **单轨 `sections[]`**：预装 `rt`（含 `rt.lifecycle`、`rt.timers`、`rt.tick` 3 个可细粒度裁剪组件）、`virtual-board`、`clock-timer` 与用户导入包完全遵循同一协议，无核心特判。
- **3 层作用域解析与交付解耦（`moduleResolver.ts`）**：
  1. 唯一优先级：`当前句柄脚本` > `项目内嵌包` > `全局扩展包`；同层级重复声明同一 `moduleName` 触发静态 Error 阻断运行与导出。
  2. 交付属性解耦：`libs[]`（真实纯脚本库，支持 `role: 'entry' | 'helper'`）在沙箱与真机 `.zip` 导出中共用；`sandboxMock` 仅在浏览器沙箱挂载，导出真机 `.zip` 时严格剥离。
- **8 种声明式模拟控件（`SimWidgetPanel`）**：`led`、`tricolor`、`rgb`、`bar`、`screen`、`slider`、`toggle`、`button`，按 `<packId>::<key>` 自动隔离（`global:` 前缀跨包共享），跨句柄实时广播同步并支持通过 `emitEvent` 派发异步回调。

## 4. 多语言插件边界与运行器

- **`BackendRegistry` 单一入口 + 自带 `LanguageDialect`**：语言方言、后缀、关键字、内建函数、注释前缀、布尔/空值字面量、脚本库绑定/扫描器、错误行解析、可选导出工具链元信息、代码生成、扩展积木/帽块注册与 `shared` 模块格式化全部收拢于各后端适配器自身；`ScriptLanguageId` 与所有工具函数由 `src/core/backends/registry.ts` 自动派生，新增目标语言只需新增 1 个后端文件并在 `BUILTIN_BACKEND_ENTRIES` 追加 1 行。
- **`ScriptRunner` + `RunnerManager`**：内置 `WasmoonLuaRunner` 与 `MicroPythonWasmRunner`（复用统一 `WorkerWasmRunner` 通信基类），预留网络（WebSocket/HTTP）、本地桥接与串口硬件 Runner 扩展位；仅导出型语言可无沙箱运行器优雅降级。

## 5. 静态部署约束（GitHub Pages）

1. `vite.config.ts` 使用 `base: './'`，兼容子路径部署（`https://<user>.github.io/<repo>/`）。
2. `wasmoon` 与 MicroPython 的 `.wasm` 均本地打包为静态资产，Blockly 媒体资源置于 `public/blockly-media/`，零外部 CDN 依赖。
3. 使用 Hash 路由（`#/blocks`、`#/projects`、`#/devices`、`#/extensions`、`#/settings`），刷新无 404。
4. 不依赖 `SharedArrayBuffer` / COOP·COEP 响应头，通过 `.github/workflows/deploy.yml` 自动测试、构建并发布至 GitHub Pages。
