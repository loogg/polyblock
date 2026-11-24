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
