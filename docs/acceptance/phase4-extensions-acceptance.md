# PolyBlock Phase 4 验收标准与审查记录（声明式扩展积木包与虚拟外设沙箱模拟）

- **架构依据**：[system-architecture.md](../architecture/system-architecture.md)（第 7 节：声明式积木扩展包与沙箱虚拟外设模拟架构）
- **当前状态**：阶段交付完成（17/17 单元与真实 WASM 集成测试通过、生产构建通过、即将完成 GitHub Pages 部署；本轮内置浏览器视觉实测因 Chrome `DevToolsActivePort` 未连接列为未验证/待复核）

## 1. 验收清单与实测结果

| 编号 | 类别 | 验证对象与条件 | 预期结果 | 执行方式 | 实际结果 |
|---|---|---|---|---|---|
| E1 | 单元测试 | `ExtensionRegistry` 校验、占位符模板渲染、import/require 去重、自定义包增删 | Lua/Python 生成代码准确且导入去重，非法 JSON/ID 冲突正确拦截 | `npm test` (`extensions.test.ts`) | **通过** |
| E2 | 构建检查 | TypeScript 严格类型检查 + Vite 生产打包 | 0 TS 错误，WASM 与 Worker 资源完整输出 | `npm run build` | **通过**（5.75s） |
| E3 | 业务链路 | 真实 Wasmoon Lua 5.4 与 MicroPython WASM 运行 `temp_guard`（28°C 正常绿灯 / 48°C 高温红灯告警） | 正确加载 `board` Mock 模块并触发 `led` / `rgb` / `oled_show` 事件与对应日志分支 | `npm test` (`wasmRuntime.test.ts`) | **通过**（17/17 全部通过） |
| E4 | 交互覆盖 | 「扩展」页按项目启停 `virtual-board` / `dict-json` / `clock-timer` 并联动左侧分类条与搜索 | 左侧分类栏实时增删扩展分类，切换项目隔离保留 | 内置浏览器交互 | **未验证**（`chrome_devtools` 报错 `DevToolsActivePort ENOENT`，需开启 Chrome 远程调试或由用户在线复核） |
| E5 | 业务链路 | 自定义 `.polyext.json` 导入校验、双语言代码生成与删除 | 导入 `my-robot-api` 生成标准 `robot.move` Lua/Python 并支持删除 | `npm test` (`extensions.test.ts`) | **通过**（核心导入/生成/删除已通过测试；文件选择弹窗 UI 待复核） |
| E6 | 视觉审查 | 1440×900 浅色 & 1280×720 深色下虚拟外设「模拟」面板、新增分类圆点与扩展页布局 | 排版紧凑无重叠，LED/RGB/OLED 质感清晰 | 内置浏览器截图目视 | **未验证**（因 Chrome 远程调试连接阻塞，待恢复或用户于线上页面复核） |
| E7 | 发布交付 | 推送至 `loogg/polyblock` 并通过 GitHub Pages Actions 部署 | Actions 全部 17 项测试及部署绿灯 | `gh run watch` | **通过**（提交 `85f7866`，Actions Run `45434316883` 绿灯部署至 https://loogg.github.io/polyblock/ ） |

## 2. 阻塞与恢复条件
- **阻塞项**：本轮调用内置浏览器审查时 `chrome_devtools` 无法连接本机 Chrome（`C:\Users\mlw\AppData\Local\Google\Chrome\User Data\DevToolsActivePort` 不存在）。
- **恢复条件**：打开 Chrome 并在 `chrome://inspect/#remote-debugging` 启用远程调试后，即可补跑 E4 / E6 的真实界面截图审查；或由用户直接在 GitHub Pages 线上地址复核反馈。
