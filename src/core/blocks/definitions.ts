import * as Blockly from 'blockly';
import '@blockly/block-plus-minus';
import * as zhHans from 'blockly/msg/zh-hans';
import { extensionRegistry } from '../extensions/registry';
import { getSiblingScriptDropdownOptions } from './workspaceContextBridge';

let blocksRegistered = false;

/** Dynamic dropdown for sibling scripts inside the active handle (preserves serialized names cleanly). */
class ScriptNameFieldDropdown extends Blockly.FieldDropdown {
  private pendingValue: string | null = null;

  constructor() {
    super(function (this: Blockly.FieldDropdown) {
      const self = this as ScriptNameFieldDropdown;
      return getSiblingScriptDropdownOptions(
        self.pendingValue ?? self.getValue() ?? undefined,
      );
    });
  }

  protected override doClassValidation_(newValue?: string): string | null {
    const cleaned = String(newValue ?? '').trim();
    if (cleaned) {
      this.pendingValue = cleaned;
      this.getOptions(false);
    }
    const res = super.doClassValidation_(cleaned || undefined);
    this.pendingValue = null;
    return res;
  }
}

function createScriptNameField(): Blockly.FieldDropdown {
  return new ScriptNameFieldDropdown();
}

/**
 * Registers ONLY Layer 0 pure-language core blocks (zero hardware / zero timer / zero button hardcoding),
 * then delegates all runtime capabilities & peripheral packs to the unified declarative ExtensionRegistry.
 */
export function registerPolyBlocks(): void {
  if (blocksRegistered) return;

  // Apply Chinese simplified localization for built-in Blockly blocks
  Blockly.setLocale(zhHans as unknown as Record<string, string>);

  const coreBlockDefs = [
    // --- Layer 0 通用程序入口 ---
    {
      type: 'poly_on_start',
      message0: '当程序启动',
      message1: '%1',
      args1: [{ type: 'input_statement', name: 'BODY' }],
      style: 'event_blocks',
      tooltip:
        '程序主入口（on_start）。在事件驱动模式下运行于独立协程中，允许使用死循环与 sleep_ms 非阻塞等待，不影响事件回调响应。',
    },

    // --- 打印与日志 (Print & Logging) ---
    {
      type: 'poly_print',
      message0: '打印 %1',
      args0: [{ type: 'input_value', name: 'VALUE' }],
      previousStatement: null,
      nextStatement: null,
      style: 'print_blocks',
      tooltip: '向打印日志控制台输出文本或表达式的值。',
    },
    {
      type: 'poly_log',
      message0: '日志 %1 %2',
      args0: [
        {
          type: 'field_dropdown',
          name: 'LEVEL',
          options: [
            ['INFO', 'INFO'],
            ['WARN', 'WARN'],
            ['ERROR', 'ERROR'],
            ['OK', 'OK'],
          ],
        },
        { type: 'input_value', name: 'MESSAGE' },
      ],
      previousStatement: null,
      nextStatement: null,
      style: 'print_blocks',
      tooltip: '输出带级别标签的结构化日志，便于筛选与排查。',
    },
    {
      type: 'poly_print_kv',
      message0: '打印标签 %1 值 %2',
      args0: [
        { type: 'field_input', name: 'LABEL', text: 'result' },
        { type: 'input_value', name: 'VALUE' },
      ],
      previousStatement: null,
      nextStatement: null,
      style: 'print_blocks',
      tooltip: '以 "标签 = 值" 格式快速打印调试信息。',
    },

    // --- 控制 (Control) ---
    {
      type: 'poly_repeat_times',
      message0: '重复执行 %1 次',
      args0: [{ type: 'input_value', name: 'TIMES', check: 'Number' }],
      message1: '%1',
      args1: [{ type: 'input_statement', name: 'DO' }],
      previousStatement: null,
      nextStatement: null,
      style: 'control_blocks',
      tooltip: '将内部积木按指定次数循环执行。',
    },
    {
      type: 'poly_for_range',
      message0: '计次循环 %1 从 %2 到 %3 步长 %4',
      args0: [
        { type: 'field_variable', name: 'VAR', variable: 'i' },
        { type: 'input_value', name: 'FROM', check: 'Number' },
        { type: 'input_value', name: 'TO', check: 'Number' },
        { type: 'input_value', name: 'BY', check: 'Number' },
      ],
      message1: '%1',
      args1: [{ type: 'input_statement', name: 'DO' }],
      inputsInline: true,
      previousStatement: null,
      nextStatement: null,
      style: 'control_blocks',
      tooltip: '使用循环变量按起止值与步长（包含结束值）迭代执行。',
    },
    {
      type: 'poly_wait_ms',
      message0: '等待 %1 毫秒',
      args0: [{ type: 'input_value', name: 'MS', check: 'Number' }],
      inputsInline: true,
      previousStatement: null,
      nextStatement: null,
      style: 'control_blocks',
      tooltip:
        '非阻塞协程延时指定毫秒数（导出为 sleep_ms(ms) 或 await sleep_ms(ms)）。仅可在主程序 / on_start 协程中使用，禁止在同步事件回调内阻塞等待。',
    },
    {
      type: 'poly_comment',
      message0: '注释 %1',
      args0: [{ type: 'field_input', name: 'TEXT', text: '记录逻辑说明' }],
      previousStatement: null,
      nextStatement: null,
      style: 'control_blocks',
      tooltip: '在生成的目标脚本代码中保留对应注释行。',
    },

    // --- 局部变量 (Local Scoped Variable) ---
    {
      type: 'poly_local_set',
      message0: '局部变量 %1 = %2',
      args0: [
        { type: 'field_input', name: 'NAME', text: 'tmp' },
        { type: 'input_value', name: 'VALUE' },
      ],
      inputsInline: true,
      previousStatement: null,
      nextStatement: null,
      style: 'variable_local_blocks',
      tooltip:
        '声明或赋值仅在当前回调/函数体内有效的局部变量（在所属作用域顶部自动提升声明，不污染文件或句柄全局变量）。',
    },
    {
      type: 'poly_local_get',
      message0: '局部 %1',
      args0: [{ type: 'field_input', name: 'NAME', text: 'tmp' }],
      output: null,
      style: 'variable_local_blocks',
      tooltip: '读取当前回调或函数内定义的局部变量。',
    },

    // --- 文本辅助 ---
    {
      type: 'poly_to_string',
      message0: '转为文本 %1',
      args0: [{ type: 'input_value', name: 'VALUE' }],
      output: 'String',
      style: 'text_blocks',
      tooltip: '将数字、布尔或变量安全转换为字符串，方便拼接。',
    },
    {
      type: 'poly_str_replace',
      message0: '文本 %1 替换 %2 为 %3',
      args0: [
        { type: 'input_value', name: 'SRC', check: 'String' },
        { type: 'input_value', name: 'OLD', check: 'String' },
        { type: 'input_value', name: 'NEW', check: 'String' },
      ],
      inputsInline: true,
      output: 'String',
      style: 'text_blocks',
      tooltip: '将源文本中的指定子串替换为新内容。',
    },

    // --- 列表核心原语（纯值槽、零隐藏辅助函数注入，支持跨文件/单文件/局部变量与表达式） ---
    {
      type: 'poly_list_append',
      message0: '列表 %1 末尾追加 %2',
      args0: [
        { type: 'input_value', name: 'LIST' },
        { type: 'input_value', name: 'ITEM' },
      ],
      inputsInline: true,
      previousStatement: null,
      nextStatement: null,
      style: 'list_blocks',
      tooltip: '向指定列表（可拖入任意作用域变量或列表表达式）末尾追加一个元素。',
    },
    {
      type: 'poly_list_get',
      message0: '列表 %1 取第 %2 项',
      args0: [
        { type: 'input_value', name: 'LIST' },
        { type: 'input_value', name: 'INDEX', check: 'Number' },
      ],
      inputsInline: true,
      output: null,
      style: 'list_blocks',
      tooltip: '读取列表第 N 项（从 1 开始计数：Lua 导出 lst[N]，Python 导出 lst[N - 1]）。',
    },
    {
      type: 'poly_list_set',
      message0: '列表 %1 设置第 %2 项 = %3',
      args0: [
        { type: 'input_value', name: 'LIST' },
        { type: 'input_value', name: 'INDEX', check: 'Number' },
        { type: 'input_value', name: 'VALUE' },
      ],
      inputsInline: true,
      previousStatement: null,
      nextStatement: null,
      style: 'list_blocks',
      tooltip: '修改列表第 N 项的值（从 1 开始计数）。',
    },
    {
      type: 'poly_list_remove',
      message0: '列表 %1 移除第 %2 项',
      args0: [
        { type: 'input_value', name: 'LIST' },
        { type: 'input_value', name: 'INDEX', check: 'Number' },
      ],
      inputsInline: true,
      previousStatement: null,
      nextStatement: null,
      style: 'list_blocks',
      tooltip: '移除列表第 N 项（从 1 开始计数：Lua 导出 table.remove，Python 导出 pop）。',
    },

    // --- 字典核心原语（纯值槽、零外部依赖，支持跨文件/单文件/局部变量与嵌套字典） ---
    {
      type: 'poly_dict_new',
      message0: '空字典 { }',
      output: null,
      style: 'dict_blocks',
      tooltip: '创建一个空的键值字典（Lua table / Python dict），可用于变量赋值或嵌套子字典。',
    },
    {
      type: 'poly_dict_set',
      message0: '字典 %1 设置键 %2 = %3',
      args0: [
        { type: 'input_value', name: 'DICT' },
        { type: 'input_value', name: 'KEY', check: 'String' },
        { type: 'input_value', name: 'VAL' },
      ],
      inputsInline: true,
      previousStatement: null,
      nextStatement: null,
      style: 'dict_blocks',
      tooltip: '向指定字典（可拖入任意作用域变量或嵌套取键表达式）写入指定键名与值。',
    },
    {
      type: 'poly_dict_get',
      message0: '字典 %1 取键 %2',
      args0: [
        { type: 'input_value', name: 'DICT' },
        { type: 'input_value', name: 'KEY', check: 'String' },
      ],
      inputsInline: true,
      output: null,
      style: 'dict_blocks',
      tooltip: '从指定字典读取键对应的值（不存在返回空值 nil / None / null，支持多层嵌套读取）。',
    },
    {
      type: 'poly_dict_has',
      message0: '字典 %1 包含键 %2 ?',
      args0: [
        { type: 'input_value', name: 'DICT' },
        { type: 'input_value', name: 'KEY', check: 'String' },
      ],
      inputsInline: true,
      output: 'Boolean',
      style: 'dict_blocks',
      tooltip: '判断指定字典中是否存在该键名。',
    },
    {
      type: 'poly_dict_delete',
      message0: '字典 %1 删除键 %2',
      args0: [
        { type: 'input_value', name: 'DICT' },
        { type: 'input_value', name: 'KEY', check: 'String' },
      ],
      inputsInline: true,
      previousStatement: null,
      nextStatement: null,
      style: 'dict_blocks',
      tooltip: '从指定字典删除该键名（键不存在时静默跳过：Lua 导出 d[k] = nil，Python 导出 d.pop(k, None)）。',
    },
  ];

  Blockly.defineBlocksWithJsonArray(coreBlockDefs);

  // Imperative core block: load sibling script in the same handle (`require("name")`)
  Blockly.Blocks['poly_require_script'] = {
    init(this: Blockly.Block) {
      this.appendDummyInput()
        .appendField('加载脚本')
        .appendField(createScriptNameField(), 'SCRIPT');
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setInputsInline(true);
      this.setStyle('event_stmt_blocks');
      this.setTooltip(
        '加载同句柄内的其他脚本（Lua 导出 require("名称")，Python 导出 import 名称）。可放在「当程序启动」或条件分支内实现按需加载。',
      );
    },
  };

  // Cross-file shared function call blocks (statement & return-value variants).
  // Unlike Blockly's built-in `procedures_call*`, these NEVER auto-spawn ghost `procedures_def*`
  // blocks in the calling script and explicitly record `{ scriptName, fnName, params }`.
  interface SharedFnCallBlock extends Blockly.Block {
    sharedFnMeta_?: { scriptName: string; fnName: string; params: string[] };
    rebuildSharedCallShape_?: () => void;
  }

  const registerSharedFnCallBlock = (blockType: string, hasReturn: boolean) => {
    Blockly.Blocks[blockType] = {
      init(this: SharedFnCallBlock) {
        this.sharedFnMeta_ = {
          scriptName: 'utils',
          fnName: 'my_func',
          params: [],
        };
        this.setInputsInline(true);
        this.setStyle('procedure_blocks');
        if (hasReturn) {
          this.setOutput(true, null);
        } else {
          this.setPreviousStatement(true, null);
          this.setNextStatement(true, null);
        }
        this.rebuildSharedCallShape_ = () => {
          const meta = this.sharedFnMeta_ ?? {
            scriptName: 'utils',
            fnName: 'my_func',
            params: [],
          };
          const existingNames = this.inputList.map((inp) => inp.name);
          for (const name of existingNames) {
            if (name === 'HEADER') {
              this.removeInput(name, true);
            }
          }
          // Keep/update header at top (Style A1: all cross-file functions live uniformly in `shared`)
          const header = this.appendDummyInput('HEADER');
          header.appendField(`shared.${meta.fnName}`);

          // Remove stale ARG inputs beyond params.length
          for (const inp of [...this.inputList]) {
            if (inp.name.startsWith('ARG')) {
              const idx = Number(inp.name.slice(3));
              if (!Number.isInteger(idx) || idx < 0 || idx >= meta.params.length) {
                this.removeInput(inp.name, true);
              }
            }
          }

          meta.params.forEach((pName, idx) => {
            const argInputName = `ARG${idx}`;
            let inp = this.getInput(argInputName);
            if (!inp) {
              inp = this.appendValueInput(argInputName);
              inp.appendField(`${pName}:`);
            } else if (inp.fieldRow[0]) {
              inp.fieldRow[0].setValue(`${pName}:`);
            }
            this.moveInputBefore(argInputName, null);
          });

          if (meta.params.length > 0) {
            this.moveInputBefore('HEADER', 'ARG0');
          }

          this.setTooltip(
            `调用同句柄跨文件公共函数 shared.${meta.fnName}(${meta.params.join(', ')})（定义于 ${meta.scriptName}，自动归集至只读 shared 模块并在顶部自动引入）。`,
          );
        };
        this.rebuildSharedCallShape_();
      },
      saveExtraState(this: SharedFnCallBlock) {
        return {
          scriptName: this.sharedFnMeta_?.scriptName ?? 'utils',
          fnName: this.sharedFnMeta_?.fnName ?? 'my_func',
          params: [...(this.sharedFnMeta_?.params ?? [])],
        };
      },
      loadExtraState(
        this: SharedFnCallBlock,
        state: { scriptName?: string; fnName?: string; params?: string[] },
      ) {
        this.sharedFnMeta_ = {
          scriptName: String(state?.scriptName ?? 'utils').trim() || 'utils',
          fnName: String(state?.fnName ?? 'my_func').trim() || 'my_func',
          params: Array.isArray(state?.params)
            ? state.params.map((p) => String(p))
            : [],
        };
        this.rebuildSharedCallShape_?.();
      },
    };
  };

  registerSharedFnCallBlock('poly_call_shared_noreturn', false);
  registerSharedFnCallBlock('poly_call_shared_return', true);

  // Align selected built-in block styles with our MicroBlocks palette
  const styleOverrides: Record<string, string> = {
    controls_if: 'control_blocks',
    controls_whileUntil: 'control_blocks',
    controls_flow_statements: 'control_blocks',
    variables_get: 'variable_blocks',
    variables_set: 'variable_blocks',
    math_change: 'variable_blocks',
    math_number: 'math_blocks',
    math_arithmetic: 'math_blocks',
    math_modulo: 'math_blocks',
    math_random_int: 'math_blocks',
    math_round: 'math_blocks',
    math_single: 'math_blocks',
    logic_compare: 'logic_blocks',
    logic_operation: 'logic_blocks',
    logic_negate: 'logic_blocks',
    logic_boolean: 'logic_blocks',
    logic_null: 'logic_blocks',
    text: 'text_blocks',
    text_join: 'text_blocks',
    text_length: 'text_blocks',
    lists_create_with: 'list_blocks',
    lists_length: 'list_blocks',
    procedures_defnoreturn: 'procedure_blocks',
    procedures_defreturn: 'procedure_blocks',
    procedures_callnoreturn: 'procedure_blocks',
    procedures_callreturn: 'procedure_blocks',
  };

  for (const [blockType, styleName] of Object.entries(styleOverrides)) {
    const def = Blockly.Blocks[blockType];
    if (def && typeof def.init === 'function') {
      const origInit = def.init;
      def.init = function patchedInit(this: Blockly.Block) {
        origInit.call(this);
        this.setStyle(styleName);
      };
    }
  }

  // Extend native Blockly `controls_flow_statements` (break/continue) so its
  // `getSurroundLoop()` validator recognizes our custom `poly_repeat_times` and `poly_for_range` loops.
  const POLY_LOOP_TYPES = new Set([
    'poly_repeat_times',
    'poly_for_range',
    'controls_repeat',
    'controls_repeat_ext',
    'controls_forEach',
    'controls_for',
    'controls_whileUntil',
  ]);
  const flowDef = Blockly.Blocks['controls_flow_statements'];
  if (flowDef && typeof flowDef.init === 'function') {
    const origFlowInit = flowDef.init;
    flowDef.init = function patchedFlowInit(
      this: Blockly.Block & { getSurroundLoop?: () => Blockly.Block | null },
    ) {
      origFlowInit.call(this);
      this.getSurroundLoop = function (this: Blockly.Block) {
        let cur: Blockly.Block | null = this;
        do {
          if (POLY_LOOP_TYPES.has(cur.type)) return cur;
          cur = cur.getSurroundParent();
        } while (cur);
        return null;
      };
    };
  }

  // Register all built-in declarative extension packs (rt, virtual-board, clock-timer) & custom packs
  extensionRegistry.ensureInitialized();

  blocksRegistered = true;
}
