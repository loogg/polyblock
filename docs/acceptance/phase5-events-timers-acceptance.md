# PolyBlock Phase 5 验收标准与审查记录（事件驱动生命周期、多路编号定时器与硬件按键回调）

- **架构依据**：[system-architecture.md](../architecture/system-architecture.md)（第 8 节：事件驱动生命周期、多路编号定时器与硬件事件回调架构）
- **核心设计决策**：`1A`（`on_start` + 默认 `100ms` 的 `on_run` + `repeat=0` 持续循环 / `1` 单次 / `N` 限次）、`2A`（整数 ID `0..N-1` + `get_timer_value(id)` 返回本周期已过毫秒数 + 项目级 `1~32` 通道数与可选别名）、`3A`（Lua 顶层 `local rt = require("rt")` + 零闭包顶层 `on_timer(id)` / `on_button(key, pressed)` 分发 ABI + 虚拟按键回调与实时监控卡片）。
- **当前状态**：已全项验收通过（21/21 单元与真实 WASM 集成测试通过、TypeScript 严格编译与 Vite 生产打包通过、内置浏览器双语言全链路实测与多分辨率视觉审查通过、已部署至 GitHub Pages）。

## 1. 验收清单与实测结果

| 编号 | 类别 | 验证对象与条件 | 预期结果 | 执行方式 | 实际结果 |
|---|---|---|---|---|---|
| T1 | 代码生成与静态校验 | `event_timer_demo` 双语言生成与静态诊断 | 导出顶层零闭包 `on_start` / `on_run` / `on_timer(id)` / `on_button(key, pressed)` / `on_stop`（无 `rt.on_timer(`），Python 自动生成 `global` 变量声明；重复定时器帽子与越界通道 ID（如 `T9` 超出 `0~3`）触发告警/错误 | `npm test` (`eventsAndTimers.test.ts`) | **通过** |
| T2 | 调度器与多上下文隔离 | `WorkerRuntimeScheduler` 周期、限次、已过时间、按键边沿与双独立调度上下文隔离 | 3 次定时器触发后自动返回 `done`，越界 ID 抛出中文错误，两份独立 `Scheduler`（模拟多隔离 `lua_State*` 句柄）操作同一 `T0` 互不窜扰 | `npm test` (`eventsAndTimers.test.ts`) | **通过** |
| T3 | 真实 WASM 集成 | Wasmoon Lua 5.4 与 MicroPython WASM 实跑 `timer_oneshot` | `on_start` 启动 `T0 (120ms, 3次)` → `on_timer(0)` 精确触发 3 次 → 自动退出事件循环并执行 `on_stop()` | `npm test` (`wasmRuntime.test.ts`) | **通过**（21/21 全部绿灯） |
| T4 | 常驻事件循环交互（Lua 5.4） | 浏览器运行 `event_loop.lua` 并实时拖动温度滑块、点击按键 A、再点停止 | `事件循环中` 状态持续运行不误触发超时看门狗；`on_run` 按 100ms 持续计数；`T0 · 心跳灯` 进度条实时推进；运行中调温至 `48°C` 实时切换红灯 `#ef4444`；点击按键 A 实时启动 `T1` 并触发 3 次告警日志；点「停止」优雅执行 `on_stop()` 关闭 LED/RGB | 内置浏览器交互实测 | **通过**（0 外部网络请求，优雅停机实测通过） |
| T5 | 常驻事件循环交互（Python 3） | 浏览器切换 Python 3 运行 `timer_oneshot.py` 与 `event_loop.py` | `timer_oneshot.py` 397ms 自动完成 3 次定时并退出；`event_loop.py` 持续进入 `事件循环中` 并实时更新 `on_run` 与 `T0` 监控条 | 内置浏览器交互实测 | **通过** |
| T6 | 项目级定时器能力配置 | 「项目管理」页切换通道数 `8 路 -> 16 路` 并新增 `T2 · 电机巡检` 别名 | 画布下拉框与右侧调度卡片实时同步为 `rt 0~15`，导出代码仍保持纯整数 ID | 内置浏览器交互实测 | **通过** |
| T7 | 视觉与布局审查 | `1440×900` 浅色与 `1280×720` 深色截图目视及边界测量 | 四页签无裁切、监控卡片单行紧凑、示例画布 6 个回调帽子块无纵横向重叠 | 内置浏览器截图目视与边界测量 | **通过**（初审修复模板帽子纵横向间距、精简启动定时器尾注与单行卡片标题后复验通过） |
| T8 | 生产构建与发布 | `npm run build` + GitHub Actions Pages 部署 | 0 TS 错误，Actions 全绿部署至 https://loogg.github.io/polyblock/ | `npm run build` + `gh run watch` | **通过** |

## 2. 本轮实测发现与修复闭环
1. **越界通道 ID 下拉框加载时被 Blockly 静默重置**（已修复）：实现 `TimerIdFieldDropdown` 子类在 `doClassValidation_` 中保留合法整数通道（`0~31`），使越界通道显示为 `T9 (越界)` 并触发静态错误诊断，不静默破坏用户积木。
2. **窄面板与示例画布布局打磨**（已修复并复验）：
   - 精简 `启动定时器` 积木尾注（将 `(0=循环)` 移至 tooltip），收窄「定时」分类飞出栏宽度；
   - 收敛右侧监控与按键卡片标题，保证在 `1280×720` 与窄面板下均保持单行无换行；
   - 调整 `EVENT_LOOP_MAIN_WS` 中 6 个回调帽子块的纵横向坐标间距，消除初审发现的纵横向重叠。
