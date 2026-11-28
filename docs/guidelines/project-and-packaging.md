# 工程目录、打包导出与扩展包平权规范

> 归属：`docs/guidelines/` · 配套协议：[`docs/specs/extension-pack-spec.md`](../specs/extension-pack-spec.md)

---

## 1. 全资产成品 JSON 化与彻底平权（零 `isBuiltin` 特权）

- `src/packs/*.polyext.json`、`src/boards/*.polyboard.json`、`src/demos/<demo>/` 与 `src/templates/` 仅作为**出厂默认种子清单**，与用户导出文件保持 100% 同构，经统一 `manifest.json` 顺序清单与同一套校验器加载。
- **彻底禁止 `builtin` 字段与特权判定**：
  - 便携 JSON 协议严禁出现 `builtin` 字段；
  - 运行时与 UI 严禁区分“内置包 vs 自定义包”，严禁保留 `RT_PACK` / `VIRTUAL_BOARD_PACK` / `CAP_RT*` / `'generic-script'` 等硬编码包/板型 ID 常量。
- **全局库完全平权**：任意扩展包与板型均享有同等操作权（查看源码、附加库源码、同 ID 覆盖升级、导出、移除；板型仅限至少保留 1 个），通过差分持久化 +「恢复默认」还原出厂种子；恢复默认时同步清理项目中失效的自定义全局包/板型引用。
- **板型开放语言校验**：`validateTargetProfile` 仅对 `defaultLanguage` 执行开放标识符格式校验（`^[a-z][a-z0-9_-]{0,23}$`），不在加载阶段提前强转，实例化工程时再按当前已注册语言插件归一化，确保指向热注册或未来语言的板型规格无损保留。

---

## 2. 元数据声明式驱动（零硬编码扫描）

- 扩展包的能力开关、帽块生命周期/保活（`hat.mode` / `hat.keepsAlive`）、模拟控件事件（`simWidgets[].emitEvent`）、句柄通道池（`handleConfigs`）、运行时监控（`sections[].runtimeMonitor`）统一由 `.polyext.json` / `.polyboard.json` 声明驱动。
- **严禁**在编译器、Worker、调度器或 UI 中按具体包 ID、具体积木名或具体外设事件名写特例分支；若发现需要给某个默认包开特例，一律补齐声明式协议字段。
- 多语言声明（`imports`、`code`、`sources`、`hat.condition`、`hat.branchComment`）统一按 `Record<ScriptLanguageId, ...>` 映射，严禁写死二元语言键。

---

## 3. 标准工程目录与零嵌套协议

### 3.1 零 JSON 套 JSON
- `project.polyblock.json` **严禁内嵌任何扩展包或板型定义正文**（禁止出现 `localExtensions` / `bundledExtensions` / `localTargetProfile` 等内嵌资产字段）。
- 它只记录项目元数据、目标语言（`language`）、引用 ID（`targetProfileId`、`enabledCapabilities`）以及句柄与脚本数据。

### 3.2 100% 同构目录结构
仓库演示工程（`src/demos/<demoId>/`）与完整工程归档（`.polyblock.zip`）保持完全一致的目录布局：

```text
<project-root>/
├── project.polyblock.json          # 纯工程配置与积木脚本（仅存引用 ID）
├── extensions/<id>.polyext.json    # 项目实际引用的独立扩展包文件
└── boards/<id>.polyboard.json      # 项目锁定的独立目标板型文件（可选）
```

---

## 4. 两类导出边界与严格版本锁定

1. **PolyBlock 工程归档（源文件，用于分享与重新编辑）**：
   - **纯工程文件 `.polyblock.json`**：仅保存引用 ID 与积木数据，零内嵌包。
   - **完整工程包 `.polyblock.zip`**：打包项目实际引用的**全部**扩展包（含全局包快照，零默认包特判）与精确匹配 `targetProfileId` 的目标板型（若原板型不存在则不写入错配回退板型）。
   - **导入严格版本锁定（Strict Version Pinning）**：导入 `.polyblock.zip` 时，随包的 `extensions/*.polyext.json` 与 `boards/*.polyboard.json` 严格锁定在**该项目的本地覆盖作用域**内，**绝不污染全局库**；全局库后续升级不会破坏旧工程，用户亦可随时解除锁定回退全局版。
2. **目标真机部署代码（编译产物，直接给设备运行）**：
   - 仅导出**当前项目选定目标语言**的纯净脚本（单脚本 / 当前句柄 `.zip` / 全部句柄 `.zip`）与胜出的真实 `libs`。
   - **严格剥离 `sandboxMock`**，不掺入多语言目录或 `.polyblock.json` 源文件。

---

## 5. 三层作用域模块解析（`moduleResolver.ts`）

- **唯一查找优先级**：`当前句柄脚本 (handle)` > `项目私有/锁定包 (project)` > `全局扩展包 (global)`。
- **同层级冲突阻断**：同一作用域层级内若有两个已启用包声明同一 `moduleName`，触发静态 Error 阻断运行与导出。
- **交付属性与优先级正交**：`libs[]`（真实脚本库，沙箱与导出共用）与 `sandboxMock`（仅沙箱挂载，导出严格剥离）不参与优先级竞争；高优先级 `sandboxMock` 可干净抑制低优先级同名 `libs[]`。
