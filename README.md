# PolyBlock

**PolyBlock** 是一套**纯前端离线、面向私有硬件与嵌入式脚本引擎的业务层可视化编排与仿真工作台**（基于 Blockly v13 与 MicroBlocks 紧凑美学）。  
无需后端服务器，只需一份声明式 JSON 即可接入任意非标硬件并自带交互模拟器；在浏览器内跑通多任务逻辑后，一键导出工程师敢直接上板的纯净多语言脚本（出厂提供 **Lua 5.4 / Python 3 / JavaScript** 插件），或以 `.polyblock.zip` 整包交付、永不丢环境。

## 产品定位与核心价值

- **私有硬件秒级可视化模拟（无真机也能先跑通）**：无需画原理图或写专用仿真器，通过 `.polyext.json` 声明业务 API、交互控件与 `sandboxMock`，任意非标设备都能即刻在浏览器内预演业务逻辑、演示验收，跑通后再下发真机。
- **受控安全的业务编排层（三层清晰分工）**：底层固件负责驱动、滤波与稳定接口，复杂算法沉淀在原生脚本库（`libs[]`）并封装成积木，PolyBlock 专注上层状态机、定时调度与外设联动；配合通道范围校验、禁回调阻塞检查与本地沙箱预演，既摆脱传统表单上位机的死板，又杜绝野代码把设备搞挂。
- **对齐真实嵌入式并发 + 工程师敢直接用的纯净代码**：支持多隔离句柄并发、单轨协程 `sleep_ms`、零闭包顶层事件路由与严格 3 级作用域 + 只读 `shared` 模块，零隐藏魔法函数——业务/实施用积木搭，研发可直接审阅上板。
- **零后端免开发上位机底座（一套工具通吃多代设备）**：目标语言插件与外设/板型包彻底外置且平权；硬件方案商只需交付自家 `.polyboard.json` + `.polyext.json`，零前端开发即可为不同代际、不同脚本引擎的设备提供统一离线编排台，并天然适配 AI 依据 Schema 快速生成积木包。
- **`.polyblock.zip` 严格版本锁定（交付多年依然 100% 复现）**：完整工程包自动锁定项目引用的全部扩展包与板型，导入仅作用于当前项目、绝不污染全局库，拖进浏览器即可视化查看逻辑与仿真，彻底解决升级破坏旧工程的现场痛点。

## 核心特性

- **MicroBlocks 紧凑工作台**：定制紧凑圆角渲染器、浅/深双主题、10 个 Layer 0 纯语言原语分类（含列表与字典 5 块原语）、关键词搜索与 `+ / -` 行内变参。
- **三层多句柄工程模型与严格作用域**：
  - `Project → RuntimeHandle → ProjectScript` 1:1 映射真机独立隔离 VM 句柄（如多 `lua_State*`）。
  - Layer 0.5 单句柄单轨协程调度：`on_start` 支持阻塞延时（`sleep_ms` / `await sleep_ms`），其余顶层零闭包事件回调由主入口统一路由派发。
  - **3 级变量作用域**（跨文件共享 / 单文件全局 / 顶部提升局部）+ **纯循环变量局部隔离** + 显式初值，**2 级函数作用域** + 自动生成的只读 `shared.<ext>` 模块。
- **多语言物理外置插件（`LanguagePlugin`）**：
  - 独立于内核的 **Lua 5.4**（Wasmoon WASM）、**Python 3**（MicroPython WASM，含传递性 `async/await` 传染）与 **JavaScript ES2023 / CommonJS**（原生 Web Worker 零 WASM 体积），支持无运行器的仅导出型语言自动优雅降级。
  - 积木 ↔ 代码行双向高亮、作用域监视、静态诊断与双产线代码生成（纯净导出 + 沙箱调试插桩）。
- **全资产 JSON 包化与彻底平权**：
  - `.polyext.json` 单轨 `sections[]` 声明多语言积木、事件帽块、每句柄通道池、运行时监控、8 种模拟控件、`sandboxMock` 与真机共用脚本库 `libs[]`。
  - 支持导入原生 `.lua` / `.py` / `.js` 脚本库自动扫描生成积木包，按 `句柄脚本 > 项目锁定包 > 全局扩展包` 3 层优先级解析。
  - 标准工程目录（`project.polyblock.json` + 独立 `extensions/` + `boards/`）与 `.polyblock.zip` 100% 同构，导入执行严格版本锁定，绝不污染全局库。
- **纯前端离线部署**：零外部 CDN、零 `SharedArrayBuffer`，相对路径 + Hash 路由，原生适配 GitHub Pages 与内网静态托管。

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
