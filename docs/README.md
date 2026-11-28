# PolyBlock 文档中心

> 按「架构全貌 → 领域规范 → 语言手册 → 协议标准 → 验收清单」五层组织；最高层架构红线与文档路由见根目录 [`AGENTS.md`](../AGENTS.md)。

---

## 1. 架构与路线（`docs/architecture/`）

| 文档 | 内容说明 |
| --- | --- |
| [`system-architecture.md`](./architecture/system-architecture.md) | 当前生效的四层 + Layer 0.5 协作运行时架构全貌、工程拓扑与静态部署约束 |
| [`roadmap.md`](./architecture/roadmap.md) | 面向未来的结构演进路线、语言插件物理抽离与大模块拆瘦计划（独立于日常红线） |

## 2. 领域开发规范（`docs/guidelines/`）

| 文档 | 适用改动场景 |
| --- | --- |
| [`project-and-packaging.md`](./guidelines/project-and-packaging.md) | 工程目录协议、`project.polyblock.json` / `.polyblock.zip` 锁定导入、真机导出、全包平权与 3 层模块解析 |
| [`runtime-and-scope.md`](./guidelines/runtime-and-scope.md) | 句柄并发、Layer 0.5 单轨协程、3 级变量作用域、纯循环局部隔离、2 级函数、只读 `shared.<ext>` 与帽块路由 |
| [`blockly-and-codegen.md`](./guidelines/blockly-and-codegen.md) | 新增原生 Blockly 积木准入硬门禁、纯值槽原则、零魔术代码、双产线与调试断点桩 |
| [`ui-and-delivery.md`](./guidelines/ui-and-delivery.md) | UI/状态边界、响应式插件消费、统一控件、运行只读锁、弹窗安全与自动化门禁 |

## 3. 多语言插件与作用域手册（`docs/languages/`）

| 文档 | 内容说明 |
| --- | --- |
| [`languages/README.md`](./languages/README.md) | 跨语言统一语义契约、三语言实现机制对比矩阵、新增第 4 种目标语言插件接入指南 |
| [`languages/lua.md`](./languages/lua.md) | Lua 5.4 上值、互递归前向声明、栈式协程、`debug.sethook` 看门狗与防坑清单 |
| [`languages/python.md`](./languages/python.md) | Python 3 最小 `global`、纯循环局部隔离、`shared.py`、`async/await` 传染与 MicroPython VFS |
| [`languages/javascript.md`](./languages/javascript.md) | JavaScript ES2023/CommonJS 词法闭包、`for (let)` 隔离、TDZ 防护与原生零 WASM Web Worker |

## 4. 协议规范与质量验收（`docs/specs/` · `docs/qa/`）

| 文档 | 内容说明 |
| --- | --- |
| [`specs/extension-pack-spec.md`](./specs/extension-pack-spec.md) | `.polyext.json` 扩展包与 `.polyboard.json` 板型声明式协议、模拟控件、脚本库导入与 VS Code 片段 |
| [`qa/gui-regression-checklist.md`](./qa/gui-regression-checklist.md) | 真实浏览器 GUI 回归清单（含层级、缩放、零重叠、全语言诊断与排版目视审查） |
