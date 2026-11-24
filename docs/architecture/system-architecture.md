# PolyBlock 系统架构与工程方案（Phase 1）

## 1. 分层架构总览

```text
+------------------------------------------------------------------------------+
|                       UI 表现层 (React 19 + TypeScript)                       |
|  [TopBar] [ActivityRail (#/hash)] [BlocklyWorkspace] [CodePane] [LogConsole] |
+---------------------------------------+--------------------------------------+
                                        | Blockly JSON / 编辑与选中事件
                                        v
+------------------------------------------------------------------------------+
|                        核心编排层 (src/core/blocks)                           |
|  - MicroZelosRenderer (紧凑圆角/榫口) + Light/Dark Theme                       |
|  - 积木目录与搜索元数据 (9 分类含独立打印日志模块 + Plus/Minus 变参)              |
|  - 静态诊断器 (悬空积木、空入口提示)                                           |
+---------------------------------------+--------------------------------------+
                                        | workspace
                                        v
+------------------------------------------------------------------------------+
|                     多语言后端适配层 (src/core/backends)                       |
|  BackendRegistry (统一 ScriptBackendAdapter 契约)                             |
|    ├── LuaBackendAdapter    (Lua 5.4 代码生成 + Sentinel SourceMap 提取)      |
|    └── PythonBackendAdapter (Python 3 代码生成 + Sentinel SourceMap 提取)     |
+---------------------------------------+--------------------------------------+
                                        | { code, sourceMap, language }
                                        v
+------------------------------------------------------------------------------+
|                     可插拔执行器层 (src/core/runners)                         |
|  RunnerManager (统一 ScriptRunner 契约: run / stop / onLog / onStatusChange)  |
|    ├── WasmoonLuaRunner       -> Web Worker (wasmoon Lua 5.4 WASM)           |
|    ├── MicroPythonWasmRunner  -> Web Worker (MicroPython WASM)               |
|    └── [预留插件槽位]          -> RemoteWsRunner / LocalBridgeRunner / Serial  |
+------------------------------------------------------------------------------+
```

## 2. 关键数据流与交互闭环

```text
用户拖拽积木 ──> Blockly Change Event (防抖)
                    │
                    ├──> 持久化到 localStorage (防止刷新丢失)
                    └──> Active BackendAdapter.generate(workspace)
                            │
                            ├──> 剥离内部行号哨兵，生成干净的 main.lua / main.py
                            ├──> 构建 SourceMap: blockId <-> [startLine, endLine]
                            └──> 刷新右侧代码区 & 诊断数量

用户点击 [▶ 运行] ──> RunnerManager.run({ language, code, timeoutMs })
                        │
                        ├──> 启动/复用对应 Web Worker (隔离主线程)
                        ├──> 实时截获 print / stdout / stderr ──> 底部日志控制台
                        ├──> 若发生语法/运行错误，解析行号反查 SourceMap ──> 画布高亮出错积木
                        └──> 点击 [■ 停止] 或超时 ──> worker.terminate() 立即终止并安全重建
```

## 3. 核心契约设计

### 3.1 `ScriptBackendAdapter`（扩展新脚本语言只需实现此接口）
- `id: 'lua' | 'python' | string`
- `name: string`、`version: string`、`extension: string`、`fileName: string`
- `generate(workspace: Blockly.Workspace): GeneratedCodeResult`
  - 返回：`code`（纯洁可独立运行脚本）、`sourceMap`（`Record<string, LineRange>`）、`diagnostics`、`blockCount`

### 3.2 `ScriptRunner`（可插拔执行器契约）
- `id: string`、`name: string`、`kind: 'browser-wasm' | 'network' | 'serial' | 'bridge'`
- `supportedLanguages: ScriptLanguageId[]`
- `run(request: RunRequest, callbacks: RunCallbacks): Promise<RunResult>`
- `stop(): void`
- `dispose(): void`

## 4. GitHub Pages 静态部署约束
1. Vite 配置 `base: './'`，确保部署在 `https://<user>.github.io/<repo>/` 子路径时所有 JS/CSS/WASM/Worker 相对寻址正确。
2. `wasmoon` 的 `glue.wasm` 与 `@micropython/micropython-webassembly-pyscript` 的 `.wasm` 均由 Vite 本地打包为静态资产（`?url`），零外部 CDN 依赖。
3. 路由使用状态 + `window.location.hash`（`#/blocks`、`#/projects`、`#/devices`、`#/extensions`、`#/settings`），刷新不出现 404。
4. 不使用 `SharedArrayBuffer`，完全兼容 GitHub Pages 默认 HTTP 响应头。
5. 提供 `.github/workflows/deploy.yml` 自动化构建与发布 GitHub Pages。

## 5. Phase 2 扩展：双代码产线与异步沙箱调试架构

为同时兼顾“浏览器沙箱强调试”与“未来真机板子下发纯净脚本”，后端代码生成与沙箱执行升级为双产线设计：

```text
[Blockly Workspace]
   ├──> cleanCode (100% 纯净标准 Lua / Python)
   │       ├── 右侧代码区展示 & 一键导出 (.lua / .py)
   │       └── 未来直接下载至目标硬件板子（零调试插桩）
   │
   └──> debugCode (仅沙箱运行态，含异步追踪桩 + 非阻塞延时)
           ├── Lua 5.4: __poly_step(blockId, snap):await() / __poly_sleep(ms):await()
           └── Python 3: await _poly.step(blockId, snap) / await _poly.sleep(ms)
                               │
                               ▼ (Web Worker 双向消息，零 SharedArrayBuffer)
                    STEP / PAUSED / WAITING / RESUME / STEP_NEXT / SET_BREAKPOINTS
                               │
                               ▼
              [画布执行块发光] + [代码行同步高亮 & 断点槽] + [实时变量监视]
```

### 关键保障
- **延时积木（`poly_wait_ms`）**：干净导出时生成标准等待代码（Python `time.sleep(...)`、Lua 独立 `poly_wait_ms` 辅助函数）；沙箱运行时走非阻塞 `setTimeout` Promise。
- **超时保护不误杀**：Worker 处于断点暂停（`PAUSED`）或显式等待（`WAITING`）期间自动暂停看门狗计时，仅对真实计算死循环触发超时强杀；点击「停止」仍可随时立即终止 Worker。

## 6. Phase 3 升级：v2 以项目为根的多脚本工程模型

将底层数据模型从“单项目 = 单画布”重构为三层项目树结构（1A 项目级统一目标语言 + 2A 运行当前激活标签脚本）：

```text
WorkspaceStore (localStorage: polyblock.store.v2，自动兼容迁移 v1 数据)
 └── ProjectModel (项目根容器)
      ├── id, name, description, language ('lua' | 'python')
      ├── enabledExtensions: string[]   (项目级扩展挂载点)
      ├── entryScriptId: string         (标星 ★ 入口脚本)
      ├── activeScriptId: string        (当前激活画布标签)
      └── scripts: ProjectScript[]      (1..N 个独立积木编程脚本)
           ├── id, name                 (如 main / step_debug / threshold_alarm)
           ├── workspace                (独立 Blockly JSON 状态)
           └── breakpoints[]            (独立断点列表)
```

### 交互与隔离约束
1. **顶栏以项目为根**：左上角提供项目切换器下拉菜单（切项目、新建、重命名、保存整项目工程）。
2. **画布顶部 36px 脚本标签栏**：与右侧 `CodeInspector` 顶栏齐平，支持单击切换画布、`+` 新建脚本、双击行内重命名、复制、设为入口（★）、删除以及多脚本快速下拉跳转，不占用画布横向宽度。
3. **严格状态隔离**：切换脚本标签前先立即快照保存当前画布，切换时禁用 Blockly 临时事件并清空撤销栈（`clearUndo`），确保不同脚本的积木、撤销历史、断点与生成代码互不串台。

## 7. Phase 4 扩展：声明式积木扩展包与沙箱虚拟外设模拟架构

通过统一 `PolyExtensionPack` JSON 规范，在不修改核心代码的前提下动态扩展新积木分类、双语言代码模板与浏览器沙箱 Mock 模块：

```text
[PolyExtensionPack (.polyext.json)]
   ├── 元信息: id / name / version / categoryLabel / color
   ├── 积木定义: blocks[] (外观 JSON + 默认 shadow + 搜索词)
   ├── 多语言生成模板: lua { template, imports } / python { template, imports }
   └── 可选沙箱 Mock: sandboxMock { moduleName, luaSource, pythonSource }
                 │
                 ├──> ExtensionRegistry.register() ──> 动态注入 Blockly 积木 + Lua/Python 生成器
                 ├──> ProjectModel.enabledExtensions[] ──> 按项目动态呈现左侧积木分类与搜索
                 └──> Worker Runner (package.preload / sys.modules) ──> 实时 DEVICE_EVENT 回传虚拟外设面板
```

### 关键收益
- **一份扩展包通吃“沙箱模拟 + 真机导出”**：导出给目标板子的仍是标准 `local board = require("board")` / `import board` 纯净代码；浏览器沙箱自动挂载 `sandboxMock` 并驱动交互式虚拟外设面板（LED / RGB / OLED / 模拟温度滑块 / 按键 A·B）。
- **支持外部自定义扩展包导入**：用户在「扩展」页可一键下载 JSON 模板、导入自定义 `.polyext.json` 积木包（持久化于 `polyblock.extensions.custom.v1`）并按项目随时启停。



