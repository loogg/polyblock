# PolyBlock Phase 4 验收标准与审查记录（声明式扩展积木包与虚拟外设沙箱模拟）

- **架构依据**：[system-architecture.md](../architecture/system-architecture.md)（第 7 节：声明式积木扩展包与沙箱虚拟外设模拟架构）
- **当前状态**：已全项验收通过（17/17 单元与真实 WASM 集成测试通过、生产构建通过、内置浏览器全链路交互与多分辨率视觉审查通过、已部署至 GitHub Pages）

## 1. 验收清单与实测结果

| 编号 | 类别 | 验证对象与条件 | 预期结果 | 执行方式 | 实际结果 |
|---|---|---|---|---|---|
| E1 | 单元测试 | `ExtensionRegistry` 校验、占位符模板渲染、import/require 去重、自定义包增删 | Lua/Python 生成代码准确且导入去重，非法 JSON/ID 冲突正确拦截 | `npm test` (`extensions.test.ts`) | **通过** |
| E2 | 构建检查 | TypeScript 严格类型检查 + Vite 生产打包 | 0 TS 错误，WASM 与 Worker 资源完整输出 | `npm run build` | **通过** |
| E3 | 业务链路 | 真实 Wasmoon Lua 5.4 与 MicroPython WASM 运行 `led_blink` 与 `temp_guard`（28°C 正常绿灯 / 48°C 高温红灯告警） | 正确加载 `board` Mock 模块并实时驱动虚拟外设面板 LED / RGB / OLED 与日志分支 | `npm test` (`wasmRuntime.test.ts`) + 内置浏览器实测 | **通过**（Python `led_blink.py` 392ms 自检亮灯/天蓝 RGB/OLED 双行；`temp_guard.py` 28°C 正常绿灯；拖动滑块至 48°C 并切 Lua 5.4 运行 `temp_guard.lua` 点亮 LED/红灯/OLED `ALARM: TEMP > 35C!` 并输出 WARN 日志；按键 A 交互切换正常；0 外部请求） |
| E4 | 交互覆盖 | 「扩展」页按项目启停 `virtual-board` / `dict-json` / `clock-timer` 并联动左侧分类条与搜索 | 左侧分类栏实时增删扩展分类，切换项目隔离保留 | 内置浏览器交互实测 | **通过**（启用 `秒表与计时器包` 后左侧实时出现紫色「计时」分类与 2 个计时积木；切换至「入门演示项目」确认不显示扩展分类，切回后完好保留；停用后即时移除） |
| E5 | 业务链路 | 自定义 `.polyext.json` 文件上传导入校验、画布分类与搜索联动、双语言代码生成及删除 | 导入 `my-robot-api.polyext.json` 自动启用并在左侧出现「机器人」分类与搜索命中，支持删除 | `npm test` (`extensions.test.ts`) + 内置浏览器文件上传实测 | **通过**（通过页面「导入扩展包」成功上传 `my-robot-api.polyext.json`，卡片数升至 `4 / 4`，左侧出现粉色「机器人」分类且搜索「机器人」准确命中 2 个自定义积木；点击删除按钮即时移除并同步更新分类条） |
| E6 | 视觉审查 | 1440×900 浅色、1280×720 深色及 1024×768 窄宽下虚拟外设「模拟」面板、四页签检视器与扩展页布局 | 排版紧凑无重叠、无裁切，LED/RGB/OLED 质感清晰 | 内置浏览器多分辨率截图目视与边界测量 | **通过**（初审发现窄面板下右侧四页签「校验 ✓」溢出约 19px 及「复位」按钮纵向换行 2 处问题；修复 `.pane-header.has-board` 弹性截断与 `.vboard-reset-btn` 防换行后，复测 `1024×768` 与 `1280×720` 深色截图确认 0px 溢出、页签与复制按钮保持 4px 净距、「复位」单行居中） |
| E7 | 发布交付 | 推送至 `loogg/polyblock` 并通过 GitHub Pages Actions 部署 | Actions 全部 17 项测试及部署绿灯 | `gh run watch` | **通过**（GitHub Pages 线上地址：https://loogg.github.io/polyblock/ ） |

## 2. 本轮实测发现与修复闭环
1. **窄宽下四页签检视器头部轻微裁切**（已修复并复验）：启用虚拟外设后右侧检视器包含 4 个页签（文件名 / 模拟 / 变量 / 校验），在 `1280×720`（面板宽 `336px`）与 `<=1120px`（面板宽 `296px`）下「校验 ✓」右侧被裁切。在 [CodeInspector.tsx](../../src/components/CodeInspector.tsx) 与 [global.css](../../src/styles/global.css) 中新增 `.pane-header.has-board` 与 `.pane-tab-code` 弹性截断规则后，`1024×768` 与 `1280×720` 下实测均为 `0px` 溢出。
2. **窄面板下虚拟板卡「复位」按钮纵向换行**（已修复并复验）：为虚拟外设标题与复位按钮增加 `.vboard-title`（单行省略）与 `.vboard-reset-btn`（`white-space: nowrap; flex-shrink: 0`），在 `1024×768` 及 `1280×720` 下稳定保持单行（高 `18px`）。
