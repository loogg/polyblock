# UI 架构纯净度与工程交付规范

> 归属：`docs/guidelines/` · 配合 [`docs/qa/gui-regression-checklist.md`](../qa/gui-regression-checklist.md) 执行

---

## 1. UI 与状态边界规范

- **响应式消费插件与运行器**：UI 层必须通过 [`useLanguagePlugins`](../../src/hooks/useLanguagePlugins.ts)（订阅 `backendRegistry.onPluginChange` 与 `runnerManager.onChange`）响应语言插件与多运行器的动态变更；未提供浏览器运行器的仅导出型语言须自动优雅降级，不阻断编辑与导出。
- **拒绝渲染期可变桥接扩散**：新增数据流禁止依赖 React render 阶段的全局可变单例桥接副作用，优先通过显式上下文或纯参数传递。
- **统一交互控件与排版品质**：
  - 下拉选择器统一使用受控 `PolySelect`，禁止混用样式割裂的原生 `<select>`；
  - 全局 `--font-mono` 必须包含无衬线中文回退（`"PingFang SC", "Microsoft YaHei", "Segoe UI"`），非代码卡片芯片与标签统一使用 `--font-sans`，禁止误用调试器 `.var-chip` 等宽样式或生硬 Unicode 占位符。
- **运行/暂停全链路只读锁**：运行或暂停期间，画布编辑、配置弹窗、扩展开关、句柄/变量变更及导入操作必须全链路只读锁定。
- **危险确认弹窗防误触**：重置默认、删除项目/句柄等危险确认弹窗不得因默认焦点落在确认或取消按钮上而被 `Enter` 误触发破坏性动作。

---

## 2. 零遗留与自动化门禁

- **零死代码与零过时文档**：严禁保留死导出、废弃协议别名、过时注释或阶段性历史日记；架构变动须同步刷新对应规范与文档。
- **源码静态架构门禁**：架构红线（`src/core/` 与 `src/workers/` 零具体语言文件及零 `src/plugins/` 反向依赖、零 `builtin` 字段与 `bundledExtensions` 内嵌、零硬编码包/板型 ID、全注册语言演示编译 0 诊断、三层解析与导出剥离 `sandboxMock` 等）固化在 [`extensions.test.ts`](../../src/core/__tests__/extensions.test.ts) 与 [`backends.test.ts`](../../src/core/__tests__/backends.test.ts) 中，随 `npm test` 每次运行拦断回流。

---

## 3. 交付验收与发布门禁

每次架构或 UI 改动交付前，必须完整通过以下四关：

1. `npx tsc -b` — 0 类型错误；
2. `npm test` — 全量单元测试与真实沙箱集成测试（Wasmoon Lua 5.4 + MicroPython WASM + 原生 JS Worker）全绿；
3. `npx vite build` — 生产构建成功；
4. **真实浏览器 E2E 与目视排版核查** — 按 [`gui-regression-checklist.md`](../qa/gui-regression-checklist.md) 启动本地预览检查功能、0 控制台/页面报错，并目视核查改动页面的真实渲染排版。

> **发布红线**：未经用户明确指令，严禁执行 `git push` 或线上部署；`.agents/` 与 `skills-lock.json` 保持本地忽略。
