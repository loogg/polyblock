# 原生 Blockly 积木准入与代码生成规范

> 归属：`docs/guidelines/` · 配合 [`runtime-and-scope.md`](./runtime-and-scope.md) 与 [`docs/languages/`](../languages/README.md) 执行

---

## 1. 原生 Blockly 积木准入硬门禁

每次把新的原生 Blockly 积木加入工具箱前，**必须实测全部已注册目标语言的默认生成器与交互校验源码**，逐项核查以下 5 条；任一条不满足，即覆写生成器、打补丁或改用 `poly_*` 自定义块：

1. **作用域严格对齐**：凡读写变量、循环变量或定义/调用函数，必须严格对齐 3 级变量、纯循环局部隔离与 2 级函数模型（覆写 `variables_get/set`、`math_change`、`text_append`、循环与 `procedures_*`，禁止默认 `global` 散弹声明或未用变量污染顶层）。
2. **纯值槽原则**：列表、字典等容器操作积木统一用 `input_value` 接收容器表达式，作用域自然随拖入的变量走；**禁止**用 `field_variable` 扫描推断容器作用域。
3. **零隐藏魔术代码**：**严禁**通过 Blockly `provideFunction_` 向导出代码注入隐藏辅助函数，**严禁**注入隐式类型兜底（如 `or 0`、`isinstance(x, Number)`、`typeof x === 'number'`）。
4. **跨语言语义与校验协同**：
   - 逐语言核查原生陷阱：如 Lua `text_join` 非字符串/数字须包 `tostring(...)`、`poly_str_replace` 模式字符转义、Lua `goto continue` 配套 `::continue::` 且 `controls_flow_statements.getSurroundLoop` 识别自定义循环；列表 1-based / 0-based 与标准库按需导入。
   - 链式访问与字面量运算符优先级 `Order` 须准确（如 Lua 索引返回 `Order.ATOMIC`、`{}` 返回 `Order.HIGH`），避免生成 `(a['b'])['val'] = 0` 触发语法歧义。
5. **双产线与调试/协程兼容**：
   - `cleanCode`（预览与真机导出）必须零哨兵、零调试桩；
   - `debugCode` / `moduleDebugCode` 核查与行号哨兵（`STATEMENT_PREFIX` / `STATEMENT_SUFFIX`）、`breakpointableLines`、空循环看门狗让出点以及字符串/注释字面量扫描是否冲突；确保 `controls_flow_statements` 等语句块未错误抑制前后缀（`suppressPrefixSuffix = false`）。

---

## 2. 禁止跨文件幽灵函数

- 跨文件公共函数调用统一使用独立积木 `poly_call_shared_noreturn` / `poly_call_shared_return`，防止 Blockly 内置 `procedures_call*` 在调用方画布静默生成幽灵 `procedures_def*`。

---

## 3. 语言插件物理边界与单向无环依赖

- **物理外置高内聚**：每种目标语言独立置于 `src/plugins/languages/<lang>/` 下，通过单一 `LanguagePlugin` 独占封装 `LanguageDialect`、代码生成后端与可选浏览器运行器及 Worker，由应用入口（`src/main.tsx`）与测试引导由外向内主动注册。
- **核心零语言耦合与零环依赖**：`src/core/`（非测试）与 `src/workers/` 严禁出现具体语言实现文件或反向 `import src/plugins/`；`src/core/backends/registry.ts` 保持单向无环叶节点（下游 `extensionRegistry` / `runnerManager` 通过 `onAdapterLifecycle` / `onPluginChange` 订阅）。
- **语言无关模块零硬编码**：`ScriptLanguageId` 开放为纯 `string`；全语言插件平权（至少保留 1 个）。严禁在语言无关模块（`backends/types.ts`、`runners/manager.ts`、`scopeAnalysis.ts`、`highlight.ts`、`scriptLibScanner.ts`、`moduleResolver.ts`、`logParser.ts`、共享调度器等）中硬编码语言枚举、二元语言字段、语言专属命名或传输层硬编码文案（须从 `runner.kind` / `runner.transportLabel` 派生）。
- **声明式积木展示文案**：面向用户的扩展积木展示统一通过 `parseExtensionBlockMessage` / `formatExtensionBlockLabel` 从 `args0`、`shadows` 与通道池推导可读参数语义，严禁暴露原始 `%1`、空占位框或 `▢` 缺字占位符。
