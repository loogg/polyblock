# PolyBlock Architecture Guardrails

> **演进优先（防僵化总则）**：项目处于开发期，**默认零旧版/旧文件兼容**；若出现更简洁正确的架构路线，直接彻底重构并同步更新文档，严禁保留死代码、废弃协议别名或过时历史文档。  
> **职责边界**：本文件仅保留**最高层架构方向红线、文档路由与交付门禁**；详细开发规范归档于 [`docs/guidelines/`](./docs/guidelines/)，各语言实现手册归档于 [`docs/languages/`](./docs/languages/README.md)，未来演进路线统一记录在 [`docs/architecture/roadmap.md`](./docs/architecture/roadmap.md)。

---

## 1. 最高层架构方向红线

1. **核心极简与单向无环（Layer 0 + Layer 0.5）**：`src/core/` 仅承载零外部依赖的纯语言原语（Layer 0）与语言无关、包无关的引擎抽象，`src/workers/` 仅承载跨语言共用的单句柄单轨协程宿主契约（Layer 0.5）；核心与宿主调度器严禁硬编码具体语言、扩展包 ID、板型 ID 或专有外设通道，注册表保持单向无环依赖。
2. **包彻底外置且平权**：所有扩展包（`.polyext.json`）、板型（`.polyboard.json`）、演示工程（`src/demos/`）与模板均为同构成品 JSON 资产，严禁 `builtin` 特权字段与硬编码常量；工程文件 `project.polyblock.json` 严禁 JSON 套 JSON 内嵌包或板型正文。
3. **目标语言彻底插件化且物理外置（`LanguagePlugin`）**：每种目标语言高内聚于独立的 `src/plugins/languages/<lang>/`（方言 + 后端 + 可选运行器与 Worker），由应用入口由外向内注册至 `backendRegistry`；`src/core/` 与 `src/workers/` 严禁出现具体语言文件或反向 `import src/plugins/`；全语言插件平权，UI 响应式消费，仅导出型语言自动优雅降级。
4. **纯代码与无魔法生成**：严禁通过 Blockly `provideFunction_` 注入隐藏辅助函数或隐式类型兜底；原生积木引入必须通过全注册语言准入审查；上述架构红线同步固化在自动化门禁测试中随 `npm test` 拦断回流。

---

## 2. 按领域查阅详细规范（执行前必读对应文档）

| 涉及改动领域 | 必读规范文档 |
| --- | --- |
| 工程目录、`.polyblock.zip` 锁定导入导出、全包/板型平权、3 层模块解析 | [`docs/guidelines/project-and-packaging.md`](./docs/guidelines/project-and-packaging.md) · [`docs/specs/extension-pack-spec.md`](./docs/specs/extension-pack-spec.md) |
| 句柄并发、协程 `sleep_ms`、变量/循环/函数作用域、只读 `shared` 模块、帽块路由 | [`docs/guidelines/runtime-and-scope.md`](./docs/guidelines/runtime-and-scope.md) |
| 原生 Blockly 积木准入、代码生成、语言插件物理边界与调试插桩 | [`docs/guidelines/blockly-and-codegen.md`](./docs/guidelines/blockly-and-codegen.md) |
| 单语言具体作用域、协程 ABI 与防坑细节（Lua / Python / JS / 新增语言） | [`docs/languages/README.md`](./docs/languages/README.md) · [`lua.md`](./docs/languages/lua.md) · [`python.md`](./docs/languages/python.md) · [`javascript.md`](./docs/languages/javascript.md) |
| UI 控件规范、只读锁、弹窗安全、排版验收与发版检查 | [`docs/guidelines/ui-and-delivery.md`](./docs/guidelines/ui-and-delivery.md) · [`docs/qa/gui-regression-checklist.md`](./docs/qa/gui-regression-checklist.md) |
| 系统架构全貌与未来演进规划（**不含于本文件**） | [`docs/architecture/system-architecture.md`](./docs/architecture/system-architecture.md) · [`docs/architecture/roadmap.md`](./docs/architecture/roadmap.md) |

---

## 3. 交付与发布硬门禁

- **每次架构或 UI 改动交付前必须全绿通过**：`npx tsc -b` → `npm test`（含真实 Lua WASM / MicroPython WASM / 原生 JS Worker 集成测试与架构门禁）→ `npx vite build` → 真实浏览器 E2E 与目视排版核查。
- **严禁擅自发布**：未经用户明确指令，**严禁**执行 `git push` 或线上部署；`.agents/`、`skills-lock.json` 与 `.tmp-test/` 保持本地忽略。
