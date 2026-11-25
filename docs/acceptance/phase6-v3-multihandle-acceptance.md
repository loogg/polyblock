# PolyBlock Phase 6 验收标准与审查记录（v3 三层工程模型、多句柄并发仿真、统一配置弹窗、画布就地别名与作用域变量树）

- **架构依据**：[system-architecture.md](../architecture/system-architecture.md)（第 9 节：三层工程模型、多句柄隔离仿真与作用域变量架构）
- **核心设计决策**：`1A`（三层模型 `Project → RuntimeHandle → ProjectScript` + 作用域树形变量监视器与 `local` 局部变量积木）、`2A`（项目统一目标语言 + 每句柄独立 `timerConfig` 通道数与专属别名 + 多句柄并发独立 Worker 模拟）、统一分 Tab 项目/句柄配置弹窗 + 画布定时器积木右键/下拉就地改别名。
- **当前状态**：已全项验收通过（21/21 单元与真实 WASM 集成测试绿灯、0 TS 错误生产打包通过、内置浏览器 `1440×900` 浅色与 `1280×720` 深色全链路实测与截图目视 0 报错/0 重叠通过、已部署至 GitHub Pages）。

## 1. 验收清单与实测结果

| 编号 | 类别 | 验证对象与条件 | 预期结果 | 执行方式 | 实际结果 |
|---|---|---|---|---|---|
| M1 | 数据模型与迁移 | v3 三层存储模型、句柄/脚本 CRUD、v1/v2 → v3 无损迁移 | 句柄与脚本增删改查安全防误删，历史 v1/v2 工程导入自动无损升级至 v3 并保留定时器配置与断点 | `npm test` (`projectStore.test.ts`) | **通过** |
| M2 | 局部变量与作用域分析 | `poly_local_set`/`poly_local_get` 双语言代码生成与 `analyzeWorkspaceScopes` | Lua 生成 `local cur_temp = ...`，Python 不写 `global cur_temp`；作用域树准确分离「句柄共享变量 (Global)」与各回调 `local`/独占变量 | `npm test` (`eventsAndTimers.test.ts` + `wasmRuntime.test.ts`) | **通过**（21/21 全绿） |
| M3 | 项目/句柄统一配置弹窗 | 移除项目管理页底部孤立卡片，通过项目卡片 `⚙` 与顶部菜单打开分 Tab 弹窗 | `常规与语言` / `句柄与定时` / `扩展外设` 正常切换；将 `sensor_hub` 改为 `16 路` (`0~15`) 时 `led_ctrl` 保持 `0~7` 完全隔离 | 内置浏览器交互实测 | **通过**（0 控制台错误） |
| M4 | 画布就地定时器别名 | 在画布右键定时器积木或下拉快捷项修改当前句柄通道别名 | 弹出 `TimerAliasModal` 标注 `led_ctrl` 的 `T0` 为「主心跳灯」，画布/飞出栏/代码尾注同步刷新，且 `sensor_hub` 的 `T0` 保持「温度巡检」互不窜扰 | 内置浏览器交互实测 | **通过** |
| M5 | 多句柄并发沙箱模拟 | 新建「多句柄协同仿真项目」点击顶部「并发」同时运行 `led_ctrl` 与 `sensor_hub`，再点「停止」 | 双独立 Worker 同时进入 `事件循环中`，右侧并列展示双句柄实时监控卡片，控制台交替输出彩色 `led_ctrl`/`sensor_hub` 标签日志；点击停止双方均优雅执行 `on_stop()` | 内置浏览器交互实测 | **通过**（0 外部网络请求） |
| M6 | 作用域树形变量监视器 | 单句柄运行 `led_ctrl/event_loop.lua` 并观察右侧「变量」树 | 运行期间实时刷新 `共享 led_on = true`、`共享 ticks = 0` 与 `on_run` 下的 `local cur_temp = 28`，按回调可折叠展开 | 内置浏览器交互与截图目视 | **通过** |
| M7 | 多分辨率视觉与边界审查 | `1440×900` 浅色（展开工程树 + 双句柄并发）与 `1280×720` 深色（收起工程树 + 作用域变量树） | TopBar（含 `运行`/`并发`/`单步`）、`ScriptTabBar`（含树开关+句柄胶囊）与四页签检视器 0 重叠、0 裁切 | 内置浏览器边界测量 + 截图目视 | **通过**（三组区域测量均为 `0` 重叠） |
| M8 | 生产构建与上线 | `npm run build` + GitHub Actions Pages 部署 | 0 TS 错误，Actions 全绿部署至 https://loogg.github.io/polyblock/ | `npm run build` + `gh run watch` | **通过** |
