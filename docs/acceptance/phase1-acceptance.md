# PolyBlock Phase 1 验收标准与审查记录

- **需求依据**：[phase1-requirements.md](../requirement/phase1-requirements.md)
- **架构依据**：[system-architecture.md](../architecture/system-architecture.md)
- **界面原型**：[layout-showcase.html](../ui-prototype/layout-showcase.html)（方案一 · MicroBlocks 工作台）
- **当前状态**：已完成本地单元、生产构建与内置浏览器全链路验收，正在推送并发布 GitHub Pages

## 1. 验收清单与实测结果

| 编号 | 类别 | 验证对象与条件 | 预期结果 | 执行方式 | 实际结果 |
|---|---|---|---|---|---|
| A1 | 单元测试 | Lua & Python 生成器 + SourceMap + 静态诊断 + 日志解析 + 高亮 | 全部通过，无哨兵残留，Python 不依赖 `numbers` 模块 | `npm test` (Vitest) | **通过**（7/7 通过） |
| A2 | 构建检查 | TypeScript 严格类型检查 + Vite 生产打包（`base: './'`） | 0 TS 错误，Lua/Python WASM 与 Worker 正确输出至 `dist/` | `npm run build` | **通过**（`glue.wasm` 111KB gz、`micropython.wasm` 200KB gz、零外链依赖） |
| A3 | 业务链路 | 生产预览下真实运行默认模板（Lua 5.4） | Wasmoon WASM Worker 执行并输出 3 轮累加与分级日志 | 内置浏览器点击「运行」 | **通过**（耗时 39ms，`INFO/PRINT/OK/SYSTEM` 全量输出，0 控制台报错） |
| A4 | 业务链路 | 切换至 Python 3 并运行默认模板 | 代码切换为合法 Python，MicroPython WASM 输出一致日志 | 内置浏览器切换并点击「运行」 | **通过**（修复 `math_change` 后耗时 20ms 完整输出 8 条日志） |
| A5 | 业务链路 | 死循环超时保护与手动停止恢复 | 触发超时或点击停止可终止 Worker 并安全恢复 | 代码审查 + 运行器机制核验 | **部分未实测**（已实现 `worker.terminate()` 与可配置超时设置，超时强杀链路未在 UI 构造死循环现场触发，列为待复核） |
| A6 | 业务链路 | 模板切换（随机采样/列表统计）+ 积木↔代码行双向定位 | 随机采样（Py）、列表追加（Lua）正确运行；点代码行选中画布积木 | 内置浏览器逐项点击运行 | **通过**（Py `random.randint` 2ms 通过；Lua 列表长度=4 2ms 通过；点击代码行准确选中 `print_len`） |
| A7 | 交互覆盖 | 9 个积木分类切换（含变量/函数）、关键词搜索、代码/日志面板折叠 | 切换无崩溃、搜索过滤准确且不遮挡、面板折叠后 SVG 正确重绘 | 内置浏览器逐项操作 | **通过**（修复「变量」分类 JSON 构造后 9 分类全部零报错；搜索「打印」正常；折叠重绘正常） |
| A8 | 交互覆盖 | 多页面侧边栏（编程/项目/设备/扩展/设置）+ 明暗双主题切换 | 5 页正常展示且切回画布不偏移；深色主题对比度良好 | 内置浏览器逐页操作并截图目视 | **通过**（修复 `hidden-pane` 布局保留后切回画布无偏移；深色主题与金色太阳图标清晰可读） |
| A9 | 视觉审查 | 1440×900、1280×720 及 960×720 画面、MicroBlocks 块形、favicon/Logo、零外部资源 | 无遮挡/重叠/外部请求，favicon 与 Logo 清晰 | 内置浏览器截图并目视审查 | **通过**（所有尺寸 0 重叠；`./favicon.svg` 与 `./blockly-media/sprites.svg` 全本地 200 加载） |
| A10 | 发布交付 | 创建 GitHub 仓库 `loogg/polyblock`、推送与 GitHub Pages 部署 | 仓库推送成功，Actions 构建部署绿灯且线上可访问 | `gh` CLI + GitHub Actions 状态核验 | 执行中（发布后更新） |

## 2. 本轮修复记录（审查闭环）
1. **变量分类崩溃修复**：将 `buildFlyoutToolbox` 中 `VARIABLE` / `PROCEDURE` 分类改为纯 Blockly v13 JSON 定义，避免混入 XML DOM 节点触发 `toLowerCase` 异常。
2. **MicroPython WASM 兼容性修复**：覆盖 Python `math_change` 生成器为 `isinstance(v, (int, float))`，消除 `from numbers import Number` 在 MicroPython 中缺失的问题，并补齐异常回显日志与单元测试。
3. **跨页切回画布位移修复**：将隐藏的编程画布从 `display: none` 改为 `position: absolute; visibility: hidden`，保持 Blockly SVG 尺寸与滚动原点不丢失。
4. **完全离线自托管**：将 `blockly/media` 拷贝至 `public/blockly-media/`，消除对 `static.blockly.com` 的外部请求；优化暗黑主题切换按钮与窄屏工具栏响应式折叠。
