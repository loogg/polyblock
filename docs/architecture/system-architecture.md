# PolyBlock 系统架构与工程方案

> 本文档描述 PolyBlock **当前生效**的系统架构；完整文档导航见 [`docs/README.md`](../README.md)，最高层红线见 [`AGENTS.md`](../../AGENTS.md)，详细开发规范见 [`docs/guidelines/`](../guidelines/)，各目标语言作用域细节见 [`docs/languages/README.md`](../languages/README.md)，未来演进规划见 [`roadmap.md`](./roadmap.md)。

## 0. 文档体系导航

| 文档路径 | 职责边界 | 何时查阅 |
| --- | --- | --- |
| [`AGENTS.md`](../../AGENTS.md) | 精简版最高层架构红线、文档路由与交付门禁（**不含路线图**） | 每次任务启动前快速定位规范入口 |
| [`docs/guidelines/`](../guidelines/) | 4 份领域开发规范（工程包化 / 并发作用域 / 积木代码生成 / UI 交付） | 修改对应领域前逐条对照 |
| [`docs/architecture/system-architecture.md`](./system-architecture.md) | 当前生效的分层架构、工程拓扑与部署约束 | 了解全局模块边界与数据流 |
| [`docs/languages/`](../languages/README.md) | 跨语言作用域契约、三语言对比矩阵及 Lua/Python/JS 单语言规范 | 排查或扩展具体语言作用域与插件 |
| [`docs/specs/extension-pack-spec.md`](../specs/extension-pack-spec.md) | `.polyext.json` / `.polyboard.json` 声明式协议规范 | 开发外设包、模拟控件、通道池或目标板型 |
| [`docs/architecture/roadmap.md`](./roadmap.md) | 非阻塞的未来架构演进与拆瘦计划（**独立于红线**） | 规划下一阶段架构迭代 |
| [`docs/qa/gui-regression-checklist.md`](../qa/gui-regression-checklist.md) | 发版前真实浏览器 GUI 与排版回归验收清单 | UI / 画布 / 弹窗 / 演示工程改动后的验收 |

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
|  - 三层工程树: Project -> RuntimeHandle -> ProjectScript (含只读 shared 模块)  |
|  - 3 级变量作用域 (共享/文件全局/提升局部) + 纯循环局部隔离 + 2 级函数作用域   |
+---------------------------------------+--------------------------------------+
                                        |
                                        v
+------------------------------------------------------------------------------+
|       Layer 0.5 · 协作运行时宿主 ABI (WorkerRuntimeScheduler / 真机 C 宿主)   |
|  - 单句柄单轨协程循环: on_start 主协程 + 周期/定时槽 + on_stop + 通用事件队列  |
|  - 跨沙箱与真机共用的最小宿主契约，不含任何具体扩展包 ID 或专有事件通道        |
+---------------------------------------+--------------------------------------+
                                        |
                                        v
+------------------------------------------------------------------------------+
|       Layer 1~3 · 声明式板型与单轨扩展体系 (src/{packs,boards,demos,templates})|
|  - 全成品 JSON 默认种子 + manifest.json 顺序清单（零 builtin 字段与特权判定）  |
|  - TargetProfile (.polyboard.json): 目标语言 / 最大句柄数 / 默认能力裁剪       |
|  - PolyExtensionPack (.polyext.json): 单轨 sections[] + 多语言 code/sources   |
|    · 全局包与板型 100% 平权（含 rt.polyext.json 可同权升级/移除/恢复默认）     |
|    · 3 层纯作用域解析: 句柄脚本 > 项目锁定包 > 全局扩展包 (libs vs sandboxMock)|
|    · 声明式能力: hat (singleton/dispatch) / handleConfigs / runtimeMonitor   |
|                 / simWidgets (packId::key 命名空间隔离 + emitEvent)           |
+---------------------------------------+--------------------------------------+
                                        |
                                        v
+------------------------------------------------------------------------------+
|                  多语言插件层 (src/plugins/languages，完全独立于 src/core)     |
|  LanguagePlugin 单一入口 (Dialect + BackendAdapter + 可选 createRunner + Worker) |
|  main.tsx 调用 registerDefaultLanguagePlugins() 由外向内注册至 backendRegistry |
|    ├── plugins/languages/lua/    (Lua 5.4 + SourceMap + Wasmoon Worker)       |
|    ├── plugins/languages/python/ (Python 3 + async/await + MicroPython WASM)  |
|    └── plugins/languages/js/     (ES2023/CJS + 原生 Web Worker 零体积 Runner)  |
+---------------------------------------+--------------------------------------+
                                        | cleanCode (导出) / debugCode (沙箱)
                                        v
+------------------------------------------------------------------------------+
|            可插拔执行器与导出层 (src/core/runners + workers + export)          |
|  - RunnerManager 订阅 backendRegistry 自动挂载语言 Runner + MultiHandleRunner |
|  - 单句柄单轨协程调度器 (WorkerRuntimeScheduler) + 断点/单步/遥测/外设总线     |
|  - BundleExporter: 单脚本 / 单句柄 .zip / 整工程 .zip (自动剥离 sandboxMock)  |
+------------------------------------------------------------------------------+
```

## 2. 工程模型、作用域与协程并发

### 2.1 三层工程拓扑与同构工程目录（`Project → RuntimeHandle → ProjectScript`）
- **Project（项目）与零嵌套协议**：`project.polyblock.json` 仅绑定目标语言（`language`）、目标板型引用（`targetProfileId`）、统一能力引用列表（`enabledCapabilities`）与句柄/脚本数据，**严禁内嵌扩展包或板型正文**。仓库 Demo（`src/demos/<demoId>/`）与便携工程归档（`.polyblock.zip`）100% 同构，均为 `project.polyblock.json` + 独立 `extensions/<id>.polyext.json` + 独立 `boards/<id>.polyboard.json`。
- **双类导出与严格版本锁定**：
  - **PolyBlock 工程归档**（源文件，可重新编辑）：支持「纯工程文件 `.polyblock.json`（仅引用 ID）」与「完整工程包 `.polyblock.zip`（打包全部实际用到的扩展包与匹配板型，零默认包特判）」。导入 `.polyblock.zip` 时将随包扩展与板型严格锁定于该项目本地作用域，不污染全局库。
  - **真机部署代码包**（编译产物，给设备运行）：仅导出当前项目选定目标语言的纯净脚本 + 真实 `libs/`（单脚本 / 当前句柄 / 全部句柄），严格剥离 `sandboxMock`。
- **RuntimeHandle（隔离运行句柄）**：1:1 映射真机独立 VM（如 `lua_State*`）。持有独立 `capabilityConfigs`（按 `configKey` 隔离通道池数量与别名）、唯一主入口标记（`entryScriptId`）、以及 `sharedVariables` / `sharedFunctions` 清单。
- **只读 `shared.<ext>` 模块**：只要句柄存在任一跨文件共享变量或公共函数，即自动生成只读 `shared.<ext>` 并在调用方顶部自动引入；伴随普通脚本不自动导入，须显式拖入「加载脚本」（`require` / `import`）。

### 2.2 单轨协程与零闭包事件分发 ABI
- **1 句柄 = 1 线程 / 单轨协程循环**：同一句柄内所有脚本共享状态但不开多线程，确保浏览器沙箱与真机 C 宿主模型完全一致。
- **`on_start` 主协程与 `sleep_ms`**：只有 `on_start`（及其传递调用的自定义函数）允许调用阻塞延时 `sleep_ms(ms)`（Lua）/`await sleep_ms(ms)`（Python / JavaScript）；事件回调与顶层浮动语句内禁止阻塞延时并在静态诊断中标错。
- **零闭包顶层事件帽块**：所有顶层帽块由 `hat.mode` 声明驱动：
  - `singleton`（如 `on_start`、`on_run`、`on_stop`）：全句柄唯一，仅主入口可用。
  - `dispatch`（如 `on_timer` 及外设扩展包声明的异步中断）：跨脚本自动在主入口聚合为单一顶层分发路由函数（可选 `extractBranchFnPrefix` 拆出独立全局分支函数），无闭包注册表开销。
- **各语言作用域与协程落地细节**：完整规则分别归档于 [`docs/languages/lua.md`](../languages/lua.md)、[`docs/languages/python.md`](../languages/python.md) 与 [`docs/languages/javascript.md`](../languages/javascript.md)。

### 2.3 双代码产线（纯净导出 vs 沙箱调试）
- **`cleanCode`**：零调试桩、零 `provideFunction_` 隐藏魔术代码、零隐式类型兜底，直接用于代码预览与真机部署导出。
- **`debugCode` / `moduleDebugCode`**：仅在浏览器沙箱（WASM / 原生 Web Worker）运行，注入行号/块步进桩与非阻塞协程让出点；伴随脚本使用 `moduleDebugCode`（保留断点与单步桩，剥离顶层入口调度心跳），在断点暂停与显式等待期间自动暂停看门狗计时防止误杀。

## 3. 声明式扩展包与 3 层模块解析

详见完整协议文档：[docs/specs/extension-pack-spec.md](../specs/extension-pack-spec.md) 与 [schemas/polyext.schema.json](../../schemas/polyext.schema.json)。

- **Layer 0 边界**：10 个核心分类（`event #10`、`print #20`、`control #30`、`variables #40`、`math #50`、`logic #60`、`text #70`、`lists #80`、`dicts #85`、`functions #90`）涵盖所有零外部依赖语言原语；容器操作统一遵循纯值槽原则（`input_value`）。
- **单轨 `sections[]` 与全包彻底平权**：`src/packs/` 下的默认种子包（`rt` 含 `rt.lifecycle` / `rt.timers` / `rt.tick`、`virtual-board`、`clock-timer`）与用户导入包完全遵循同一协议并享有同等管理权（无 `isBuiltin` 权限隔离，支持差分持久化与「恢复默认」）。
- **3 层作用域解析与交付解耦（`moduleResolver.ts`）**：
  1. 唯一优先级：`当前句柄脚本` > `项目私有/锁定包` > `全局扩展包`；同层级重复声明同一 `moduleName` 触发静态 Error 阻断运行与导出。
  2. 交付属性解耦：`libs[]`（真实纯脚本库，支持 `role: 'entry' | 'helper'`）在沙箱与真机 `.zip` 导出中共用；`sandboxMock` 仅在浏览器沙箱挂载，导出真机 `.zip` 时严格剥离。
- **8 种声明式模拟控件（`SimWidgetPanel`）**：`led`、`tricolor`、`rgb`、`bar`、`screen`、`slider`、`toggle`、`button`，按 `<packId>::<key>` 自动隔离（`global:` 前缀跨包共享），跨句柄实时广播同步并支持通过 `emitEvent` 派发异步回调。

## 4. 多语言插件边界与运行器

- **`LanguagePlugin` 物理外置与单向无环注册（`src/plugins/languages/` → `backendRegistry` → `extensionRegistry` / `RunnerManager`）**：每种语言的方言、代码生成后端与可选沙箱 Worker 独立高内聚于 `src/plugins/languages/<lang>/`（`src/core/` 与 `src/workers/` 零具体语言文件、零反向 import `src/plugins/`）。`backendRegistry` 保持单向无环叶节点，下游通过 `onAdapterLifecycle` / `onPluginChange` 响应式订阅；应用入口 [`src/main.tsx`](../../src/main.tsx) 通过 [`registerDefaultLanguagePlugins`](../../src/plugins/languages/index.ts) 主动注册出厂插件，全语言插件平权，第三方或未来新语言只需新增独立插件目录并调用 `backendRegistry.registerPlugin(plugin)` 即可接入全链路（无运行器的仅导出型语言自动优雅降级）。

## 5. 静态部署约束（GitHub Pages）

1. `vite.config.ts` 使用 `base: './'`，兼容子路径部署（`https://<user>.github.io/<repo>/`）。
2. `wasmoon` 与 MicroPython 的 `.wasm` 均本地打包为静态资产，Blockly 媒体资源置于 `public/blockly-media/`，零外部 CDN 依赖。
3. 使用 Hash 路由（`#/blocks`、`#/projects`、`#/devices`、`#/extensions`、`#/settings`），刷新无 404。
4. 不依赖 `SharedArrayBuffer` / COOP·COEP 响应头，通过 `.github/workflows/deploy.yml` 自动测试、构建并发布至 GitHub Pages。
