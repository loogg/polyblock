# Phase 9 统一声明式扩展协议（Option B）验收报告

## 1. 交付范围
1. **包级 `simWidgets` 命名空间隔离（零 Key 冲突）**
   - `qualifySimKey(packId, rawKey)` 自动按 `${packId}::${key}` 隔离各外设包的模拟控件与 Worker `sandboxMock` 读写；支持 `global:` 前缀用于显式跨包共享。
   - Lua Worker 通过 `setmetatable` 模块沙箱环境自动注入作用域限定 `__poly_sim_set`/`__poly_sim_get`；Python Worker 通过包专属 `_PolyScopedProxy` 自动代理 `_poly.sim_set`/`_poly.sim_get`。
2. **声明式事件帽块（`kind: "hat"`）与通用 `emitEvent` 派发引擎**
   - `.polyext.json` 正式支持 `kind: "hat"`（`singleton` 单例与 `dispatch` 条件聚合分发），自动生成干净顶层零闭包 Lua/Python 回调、驱动作用域树归类与重复分支静态诊断。
   - `simWidgets` 支持 `emitEvent` 占位参数解析（`$value` / `$state:<key>`），交互控件与 `sandboxMock`（`__poly_emit_event` / `_poly.emit_event`）统一走 `WorkerRuntimeScheduler.customEventQueue` 派发并支持多句柄转发。
   - 原核心硬编码的 `poly_on_button` 已完全迁入 `VIRTUAL_BOARD_PACK` JSON 描述；`SAMPLE_CUSTOM_EXTENSION_TEMPLATE` 新增 `ext_robot_on_estop` 示例帽块与急停开关 `emitEvent`。
3. **运行时能力统一至 `.polyext.json` 协议（`packKind: "runtime"`）**
   - `RT_LIFECYCLE_PACK`（`rt-lifecycle`）与 `RT_TIMERS_PACK`（`rt-timers`，含通用 `handleChannelPool` 与 `field_channel_id` 动态下拉）统一注册在 `BUILTIN_EXTENSION_PACKS`。
   - 核心文件 `definitions.ts`、`catalog.ts`、`luaBackend.ts`、`pythonBackend.ts`、`scopeAnalysis.ts`、`sourceMap.ts` 彻底去除运行时与硬件回调硬编码，100% 保持历史积木 ID 与已有工程兼容。
4. **目视审查回归修复**
   - 修复 `.sim-pack-card` / `.sim-pack-header` / `.vboard-control-card` 在右侧「模拟」面板多包展开时因缺少 `flex-shrink: 0` 导致的纵向挤压裁剪。
   - `validateExtensionPack` 兼容 `categoryColor` 作为 `color` 别名。

## 2. 自动化构建与测试结果
- `npm run build`（`tsc -b && vite build`）：**通过（0 错误）**。
- `npm test`（Vitest）：**5 个测试文件 / 28 项测试 100% 通过**，包含：
  - `extensions.test.ts`（9/9）：统一 5 个内置包校验、`motor-a` 与 `motor-b` 同名 `key: "speed"` 命名空间隔离 + `global:vbus` 跨包共享、自定义 `ext_robot_on_estop` 声明式帽块双语代码生成/作用域树/重名分支诊断、`emitEvent` 参数解析与禁用/移除外设包诊断。
  - `wasmRuntime.test.ts`（3/3）：真实 **Wasmoon Lua 5.4 WASM** 与 **MicroPython WASM** 实测 `temp_guard`、3 次定时回调事件循环、以及自定义声明式 `kind: "hat"`（`on_robot_estop`）通过 `enqueueEvent` 触发并打印输出。
  - `eventsAndTimers.test.ts`（3/3）、`backends.test.ts`（9/9）、`projectStore.test.ts`（4/4）全部通过。

## 3. 真机浏览器 E2E 与截图目视审查（1280×720）
- **测试地址**：`http://127.0.0.1:4177/`（生产构建产物 `vite preview`），全流程 **0 console errors / 0 page errors**。
- **验收项 1（`#/extensions` 统一展示）**：确认「内置运行时扩展包」展示 `周期事件循环`（4 积木）与 `多路编号定时器`（5 积木 · 句柄通道池），「虚拟硬件外设包」展示 `7 个积木 · 含事件回调 · 含沙箱模拟 · 6 模拟控件`。
- **验收项 2（迁移后的 `on_button` 真实 Lua WASM 执行）**：在「事件回调与多路定时器示例」点击运行并按下虚拟板「按键 A」，控制台实测输出 `按键 A 按下：启动 T1 三次告警提示定时器 (400ms)` → `T1 告警触发次数 = 1 / 2 / 3`，点击停止后触发 `on_stop 已安全关闭 LED 与 RGB 彩灯`。
- **验收项 3（同名 `key: "speed"` 多包隔离 + 自定义 `hat` 积木 + 深色主题）**：导入 `motor-a.polyext.json`（左轮电机包，默认 30%）与 `motor-b-hat.polyext.json`（右轮电机包，默认 80% + `ext_motor_b_on_estop` 橙色帽块），右侧「模拟」面板两张卡片完整无裁剪且数值完全隔离（30% vs 80%），左侧「右轮」飞出栏清晰展示橙色 `#f97316` 声明式帽块 `当右轮急停 触发 时`。
