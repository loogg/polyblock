# PolyBlock

**PolyBlock** 是一款基于 **Blockly v13** 与 **MicroBlocks 紧凑视觉美学** 打造的多语言嵌入式积木编程工作台。通过插件化多语言后端、声明式外设扩展包与纯前端沙箱（WASM + 原生 Web Worker），无需后端服务器即可在浏览器中以多句柄隔离拓扑编排积木、实时生成干净的目标脚本（出厂内置 **Lua 5.4**、**Python 3**、**JavaScript ES2023** 插件，支持动态扩展更多目标语言）、支持断点单步与虚拟外设实时仿真，并一键打包导出可复现工程归档（`.polyblock.zip`）或真机部署代码包。

## 核心特性

- **MicroBlocks 紧凑高颜值工作台**：基于 Blockly v13 `zelos` 定制紧凑圆角渲染器、浅色/深色双主题、10 个 Layer 0 纯语言原语分类（含列表与字典 5 块原语）、关键词搜索与 `+ / -` 行内变参。
- **三层多句柄工程模型与严格作用域**：
  - `Project → RuntimeHandle → ProjectScript` 1:1 映射真机独立隔离 VM 句柄（如多 `lua_State*`）。
  - 单句柄采用 Layer 0.5 单轨协程调度模型：`on_start` 支持阻塞延时（`sleep_ms` / `await sleep_ms`），其余顶层零闭包事件回调（`on_run` / `on_timer` / `on_stop` 及外设中断）由主入口统一路由派发。
  - **3 级变量作用域**（跨文件共享 / 单文件全局 / 顶部提升局部）+ **纯循环变量局部隔离** + 显式初值，**2 级函数作用域** + 自动生成的只读 `shared.<ext>` 模块。
- **多语言统一插件架构（`LanguagePlugin`）**：
  - 出厂内置 **Lua 5.4**（Wasmoon WASM）、**Python 3**（MicroPython WASM，含传递性 `async/await` 传染）与 **JavaScript ES2023 / CommonJS**（原生 Web Worker 零 WASM 体积），统一通过 `backendRegistry.registerPlugin(...)` 注册，支持无浏览器运行器的仅导出型语言自动优雅降级。
  - 实现积木 ↔ 代码行双向高亮、作用域监视、静态诊断与双产线代码生成（纯净导出 + 沙箱调试插桩）。
- **全资产 JSON 包化与彻底平权**：
  - `.polyext.json` 单轨 `sections[]` 声明多语言积木、事件帽块、每句柄通道池（`handleConfigs`）、运行时监控（`runtimeMonitor`）、8 种交互式模拟控件（`simWidgets`）、`sandboxMock` 与真机共用脚本库（`libs[]`）。
  - 支持导入原生 `.lua` / `.py` / `.js` 脚本库自动扫描生成积木包，按 `句柄脚本 > 项目锁定包 > 全局扩展包` 3 层优先级解析。
  - 标准工程目录（`project.polyblock.json` + 独立 `extensions/` + `boards/`）与 `.polyblock.zip` 100% 同构；导入 `.polyblock.zip` 执行严格版本锁定，绝不污染全局库。
- **纯前端部署**：零外部 CDN 依赖、零 `SharedArrayBuffer` 要求，相对路径构建 + Hash 路由，原生适配 GitHub Pages 静态托管。

## 本地开发与验证

```bash
npm install
npm run dev          # 本地开发服务器
npx tsc -b           # TypeScript 类型检查
npm test             # 全量单元测试 + 真实 Lua/Python/JS 沙箱集成测试
npm run build        # 生产构建
npm run preview      # 本地预览生产构建
```

## 目录与文档导航

- [`AGENTS.md`](./AGENTS.md)：核心架构方向红线、领域规范路由与交付门禁
- [`docs/README.md`](./docs/README.md)：**完整文档中心索引**（系统架构、4 份领域开发规范、3 门语言作用域手册、扩展包协议、演进路线与 GUI 回归清单）
- `schemas/`：扩展包（`polyext.schema.json`）与目标板型（`polyboard.schema.json`）JSON Schema
- `src/packs/`、`src/boards/`、`src/demos/`、`src/templates/`：平级声明式成品 JSON 资产与 `manifest.json` 顺序清单（零 `builtin` 特权）
- `src/plugins/languages/`：独立于内核的多语言插件目录（`lua/`、`python/`、`js/` 各自内聚后端、运行器与 Worker，由入口主动注册）
- `src/core/`：100% 语言无关、包无关的纯净内核（积木引擎、统一编译流水线、声明式扩展/板型引擎、工程模型、打包导出器、后端与运行器抽象层）
- `src/workers/`：跨语言共用的 Layer 0.5 单句柄单轨协程调度器、调试会话与 Worker 宿主协议
- `src/components/` & `src/hooks/` & `src/styles/`：React 19 界面组件、响应式插件/状态 Hook 与 6 个模块化样式表
