# PolyBlock

**PolyBlock** 是一款基于 **Blockly v13** 与 **MicroBlocks 紧凑视觉美学** 打造的多语言嵌入式积木编程工作台。通过纯前端 WebAssembly 运行时与声明式扩展协议，无需后端服务器即可在浏览器中以多句柄隔离拓扑编排积木、实时生成干净的目标脚本（内置 **Lua 5.4** 与 **Python 3**，易于扩展更多语言后端）、支持断点单步与虚拟外设实时仿真，并一键打包导出真机部署 `.zip`。

## 核心特性

- **MicroBlocks 紧凑高颜值工作台**：基于 Blockly v13 `zelos` 定制紧凑圆角渲染器、浅色/深色双主题、10 个 Layer 0 核心积木分类（含列表与字典 5 块原语）、关键词搜索与 `+ / -` 行内变参。
- **三层多句柄工程模型与严格作用域**：
  - `Project → RuntimeHandle → ProjectScript` 1:1 映射真实嵌入式多隔离 VM 句柄（如多 `lua_State*`）。
  - 单句柄采用单轨协程调度模型：`on_start` 支持阻塞 `sleep_ms` / `await sleep_ms`，其余顶层零闭包事件回调（`on_run` / `on_timer` / `on_button` 等）由主入口统一路由派发。
  - **3 级变量作用域**（跨文件共享 / 单文件全局 / 块顶部提升局部）+ 显式初值，**2 级函数作用域** + 自动生成的只读 `shared.<ext>` 模块。
- **多语言后端插件契约（`ScriptBackendAdapter`）**：
  - 内置 **Lua 5.4** 与 **Python 3**（含传递性 `async/await` 协程传染），实现积木 ↔ 代码行双向高亮、作用域树监视、静态诊断与双产线代码生成（纯净导出 + 沙箱调试插桩）。
- **单轨声明式扩展包与目标板型协议**：
  - `.polyext.json` 统一声明组件、积木模板、事件帽块、每句柄通道池（`handleConfigs`）、运行时监控（`runtimeMonitor`）、交互式模拟控件（`simWidgets`）、沙箱假桩（`sandboxMock`）与真机共用脚本库（`libs[]`）。
  - 支持直接导入原生 `.lua` / `.py` 脚本库自动扫描生成积木包，并按 `句柄脚本 > 项目内嵌包 > 全局扩展包` 3 层优先级解析。
  - `.polyboard.json` 声明目标板型预设与默认能力裁剪清单。
- **纯前端 WASM 多句柄并发沙箱 & 真机导出**：
  - 内置 **Wasmoon（Lua 5.4 WASM）** 与 **MicroPython WASM** 独立 Web Worker 执行器，支持单句柄断点/单步、全项目多句柄并发联动、超时保护与真机 `.zip` 一键打包（自动剥离 `sandboxMock`）。
  - 零外部 CDN 依赖、零 `SharedArrayBuffer` 要求，相对路径构建 + Hash 路由，原生适配 GitHub Pages 静态托管。

## 本地开发

```bash
npm install
npm run dev
```

## 测试与构建

```bash
npx tsc -b
npm test
npm run build
npm run preview
```

## 目录说明

- `AGENTS.md`：PolyBlock 核心架构不变量与开发红线
- `schemas/`：扩展包（`polyext.schema.json`）与目标板型（`polyboard.schema.json`）JSON Schema
- `src/core/blocks/`：MicroBlocks 风格渲染器、双主题、Layer 0 积木定义与分类目录
- `src/core/backends/`：多脚本语言后端适配层（`ScriptBackendAdapter`、Lua 5.4 / Python 3、SourceMap、作用域分析与 `shared` 模块）
- `src/core/extensions/`：声明式扩展包注册表、校验器、模板引擎、3 层模块解析器与原生脚本库扫描器
- `src/core/capabilities/`：目标板型（`TargetProfile`）注册表与能力开关
- `src/core/projects/`：v3 三层工程状态模型、内置演示套件与句柄变量管理
- `src/core/export/`：单脚本 / 单句柄 / 整工程真机 `.zip` 打包导出器
- `src/core/runners/` & `src/workers/`：可插拔运行器管理层、多句柄并发调度与 WASM Web Worker 沙箱
- `docs/`：扩展包协议规范（[extension-pack-spec.md](docs/extension-pack-spec.md)）、系统架构（[system-architecture.md](docs/architecture/system-architecture.md)）、GUI 回归清单与各阶段历史验收记录
