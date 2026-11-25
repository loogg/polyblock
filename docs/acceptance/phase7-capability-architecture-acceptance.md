# Phase 7 验收记录：能力驱动解耦架构、目标板型规格与层级遮挡修复

- **日期**：2026-11-25
- **分支 / 提交基线**：`main`（在 `9b0da21` 基础上完成 Phase 7）
- **验证环境**：Node.js + Vite 6.4.6 + Vitest 3.2.7 + 本地生产预览 (`http://127.0.0.1:4177/`) · Chromium `1280×720`

---

## 1. 核心交付内容

### 1.1 修复 `ScriptTabBar` 句柄下拉框被 Blockly 抽屉遮挡（Bug #1）
- **根因**：[global.css](file:///d:/Learning/AI/jimuCoding/src/styles/global.css) 中 `.script-tabbar` 层级为 `z-index: 22`，低于 Blockly 抽屉 `.blocklyFlyout`（`30`）与搜索框 `.flyout-search-dock`（`35`），导致在打开抽屉时点击句柄切换胶囊（如 `led_ctrl 2 ▼`），下拉菜单被右侧抽屉遮挡。
- **修复**：提升 `.script-tabbar` 至 `z-index: 45`、`.dropdown-menu` 至 `z-index: 95`（仍严格低于 TopBar `60` / Modal `160` 层级秩序）。

### 1.2 4 层能力驱动架构解耦（零硬编码硬件概念）
1. **核心层（Layer 0）瘦身**：
   - [catalog.ts](file:///d:/Learning/AI/jimuCoding/src/core/blocks/catalog.ts)：从默认核心分类中剥离 `timers`（`定时`）与 `poly_on_run`/`poly_on_stop`/`poly_on_button`，新增 `getCoreCategoriesForCapabilities(enabledCapabilities)` 按项目启用能力动态裁剪左侧积木分类与搜索池。
   - [registry.ts](file:///d:/Learning/AI/jimuCoding/src/core/extensions/registry.ts)：将 `poly_on_button`（`当按键 A/B 按下/释放时`）归属至示例 `virtual-board`（`硬件`）外设包，避免污染非虚拟板项目。
2. **统一能力注册表与目标板型规格（`.polyboard.json`）**：
   - [registry.ts](file:///d:/Learning/AI/jimuCoding/src/core/capabilities/registry.ts)：新增内置运行时能力 `rt-lifecycle`、`rt-timers` 与 4 套内置 `TargetProfile` 预设（`generic-script` / `embedded-rt` / `virtual-board-rt` / `virtual-board-basic`），支持自定义 `.polyboard.json` 校验、导入与持久化管理。
   - [project.ts](file:///d:/Learning/AI/jimuCoding/src/types/project.ts) 与 [store.ts](file:///d:/Learning/AI/jimuCoding/src/core/projects/store.ts)：`ProjectModel` 引入 `targetProfileId` + `enabledCapabilities[]`；`RuntimeHandle` 将原先写死的 `timerConfig` 泛化为 `capabilityConfigs: Record<string, unknown>`；保留 v1 / v2 / 早期 v3 工程的无损自动迁移。
3. **能力门控 UI 与静态诊断**：
   - [sourceMap.ts](file:///d:/Learning/AI/jimuCoding/src/core/backends/sourceMap.ts)：新增缺失能力静态诊断（`cap-missing-lifecycle` / `cap-missing-timers` / `cap-missing-vboard`）。
   - [CodeInspector.tsx](file:///d:/Learning/AI/jimuCoding/src/components/CodeInspector.tsx)：纯脚本项目仅展示 `代码 | 变量 | 校验` 三栏（无「模拟」页签）；基础虚拟板项目仅展示虚拟板 PCB 控件而不展示 `rt` 定时器监控卡。
   - [ProjectSettingsModal.tsx](file:///d:/Learning/AI/jimuCoding/src/components/ProjectSettingsModal.tsx)：重构为 `常规与板型` / `能力与外设` / `运行句柄` 三分栏；未启用 `rt-timers` 时句柄页不再强行展示定时器通道表单，改为引导至能力清单。
   - [ExtensionsPage.tsx](file:///d:/Learning/AI/jimuCoding/src/components/pages/ExtensionsPage.tsx) 与 [ProjectsPage.tsx](file:///d:/Learning/AI/jimuCoding/src/components/pages/ProjectsPage.tsx)：完整呈现目标板型规格、运行时能力与外设扩展包，支持 `.polyboard.json` 与 `.polyext.json` 导入及模板下载。

---

## 2. 自动化构建与单测结果

- `npm run build`（`tsc -b && vite build`）：**PASS**（0 TypeScript 错误，4.92s 完成打包）
- `npm test`（`vitest run`）：**PASS**（5 个测试文件 / 23 项测试全部通过，含 Wasmoon Lua 5.4 与 MicroPython WASM 真机事件定时器集成测试）：
  - `projectStore.test.ts` (4/4)：验证各模板差异化板型能力、独立句柄 `capabilityConfigs`、板型切换及 v1/v2/v3 无损迁移
  - `extensions.test.ts` (5/5)：验证 `getCoreCategoriesForCapabilities` 门控裁剪、`poly_on_button` 归属 `virtual-board`、`.polyboard.json` 与 `.polyext.json` 校验及导入删除
  - `backends.test.ts` (9/9)
  - `eventsAndTimers.test.ts` (3/3)：新增缺失能力静态诊断 `cap-missing-timers` 校验
  - `wasmRuntime.test.ts` (2/2)

---

## 3. 真机浏览器 E2E 与人工视觉审查（`1280×720`）

- **控制台错误**：0；**页面未捕获异常**：0
- **场景 1（纯脚本项目 `入门演示项目` / `generic-script`）**：左侧仅 9 类基础积木 + `+扩展`（无 `定时`/`硬件`），`事件` 抽屉仅含 `当程序启动` 与 `注释`，右侧仅 `main.lua | 变量 | 校验` 三栏，配置弹窗「运行句柄」隐藏定时器通道表单并展示能力开启引导 —— **PASS**。
- **场景 2（基础虚拟板 `虚拟硬件联动演示项目` / `virtual-board-basic`）**：左侧含 `硬件`/`字典` 且无 `定时`，`硬件` 抽屉包含 `当按键` 积木，右侧「模拟」页签仅渲染虚拟板 PCB/温度/按键，无任何 `.rt-monitor-card` —— **PASS**。
- **场景 3（Bug #1 回归 · 深色主题 `多句柄协同仿真项目`）**：打开 `定时` 抽屉后点击 `led_ctrl 2 ▼`，下拉菜单 100% 完整浮于抽屉与搜索框之上，全部 6 个菜单项在中心及右侧重叠区域均通过顶层命中检测且人工审图清晰无遮挡 —— **PASS**。
- **场景 4（动态能力热切换与深色配置弹窗）**：`ProjectSettingsModal`「能力与外设」在深色 `1280×720` 下无溢出/重叠；关闭 `rt-timers` 后左侧 `定时` 立即消失且右侧「校验」实时检出 4 条 `cap-missing-timers` 错误，重新启用后立即恢复 `校验 ✓` —— **PASS**。
