# PolyBlock

**PolyBlock** 是一款基于 **Blockly** 与 **MicroBlocks 视觉美学** 打造的多语言积木编程工作台。通过纯前端 WebAssembly 运行时，无需后端服务器即可在浏览器中实时搭积木、生成 **Lua 5.4** 与 **Python 3** 脚本、在沙箱中试跑查看分级打印日志，并一键导出标准脚本文件。

## 核心特性

- **MicroBlocks 紧凑高颜值风格**：基于 Blockly v13 `zelos` 定制紧凑圆角渲染器、柔和对比色板与浅色/深色双主题，并支持 `+ / -` 行内变参交互。
- **多脚本后端架构（`ScriptBackendAdapter`）**：先行内置 **Lua 5.4** 与 **Python 3** 单向实时代码生成，支持积木 ↔ 代码行双向高亮定位与静态诊断，易于扩展更多目标脚本语言。
- **可插拔运行器架构（`ScriptRunner`）**：
  - Phase 1 内置 **Wasmoon（Lua 5.4 WASM）** 与 **MicroPython WASM** 浏览器 Web Worker 沙箱，支持实时日志流与死循环超时/手动强杀。
  - 预留网络设备（WebSocket/HTTP）、本地桥接与串口硬件 Runner 扩展位及多页面侧边栏。
- **开箱即用 & GitHub Pages 友好**：零外部 CDN 依赖，相对路径打包 + Hash 路由，推至 GitHub 即可自动发布在线访问。

## 本地开发

```bash
npm install
npm run dev
```

## 测试与构建

```bash
npm test
npm run build
npm run preview
```

## 目录说明

- `src/core/blocks/`：MicroBlocks 风格渲染器、主题、基础积木与独立打印日志模块
- `src/core/backends/`：多脚本语言后端适配层（Lua 5.4 / Python 3 + Source Map 提取）
- `src/core/runners/`：可插拔运行器管理层与浏览器 WASM Worker 执行器
- `src/workers/`：Lua & Python 独立 Web Worker 沙箱
- `docs/`：需求、系统架构、UI 选型原型与验收文档
