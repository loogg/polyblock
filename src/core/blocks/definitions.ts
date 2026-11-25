import * as Blockly from 'blockly';
import '@blockly/block-plus-minus';
import * as zhHans from 'blockly/msg/zh-hans';
import { extensionRegistry } from '../extensions/registry';
import {
  buildTimerDropdownOptions,
  EDIT_TIMER_ALIAS_SENTINEL,
  triggerTimerAliasPrompt,
} from './timerConfigBridge';

let blocksRegistered = false;

class TimerIdFieldDropdown extends Blockly.FieldDropdown {
  private pendingValue: string | null = null;

  constructor() {
    super(function (this: Blockly.FieldDropdown) {
      const self = this as TimerIdFieldDropdown;
      return buildTimerDropdownOptions(self.pendingValue ?? self.getValue());
    });
  }

  protected override doClassValidation_(newValue?: string): string | null {
    if (newValue === EDIT_TIMER_ALIAS_SENTINEL) {
      const curRaw = this.getValue();
      const curId = curRaw && /^\d+$/.test(curRaw) ? Number(curRaw) : 0;
      setTimeout(() => triggerTimerAliasPrompt(curId), 0);
      return null;
    }
    if (typeof newValue === 'string' && /^\d+$/.test(newValue)) {
      const n = Number(newValue);
      if (Number.isInteger(n) && n >= 0 && n < 32) {
        this.pendingValue = newValue;
        this.getOptions(false);
      }
    }
    const res = super.doClassValidation_(newValue);
    this.pendingValue = null;
    return res;
  }
}

function createTimerIdField(): Blockly.FieldDropdown {
  return new TimerIdFieldDropdown();
}

export function registerPolyBlocks(): void {
  if (blocksRegistered) return;

  // Apply Chinese simplified localization for built-in Blockly blocks
  Blockly.setLocale(zhHans as unknown as Record<string, string>);

  const customBlockDefs = [
    // --- 事件与生命周期 (Event & Lifecycle) ---
    {
      type: 'poly_on_start',
      message0: '当程序启动',
      message1: '%1',
      args1: [{ type: 'input_statement', name: 'BODY' }],
      style: 'event_blocks',
      tooltip: '程序主入口（on_start），点击运行后执行一次初始化逻辑。',
    },
    {
      type: 'poly_on_run',
      message0: '当周期运行 on_run 每 %1 ms',
      args0: [
        {
          type: 'field_number',
          name: 'PERIOD_MS',
          value: 100,
          min: 10,
          max: 60000,
          precision: 1,
        },
      ],
      message1: '%1',
      args1: [{ type: 'input_statement', name: 'BODY' }],
      inputsInline: true,
      style: 'event_blocks',
      tooltip:
        '周期主回调（on_run，默认每 100ms 触发一次），运行后进入常驻事件循环直到手动停止。',
    },
    {
      type: 'poly_on_stop',
      message0: '当程序停止 (on_stop)',
      message1: '%1',
      args1: [{ type: 'input_statement', name: 'BODY' }],
      style: 'event_blocks',
      tooltip: '手动停止常驻事件循环时自动执行一次收尾清理（如熄灭 LED / 复位输出）。',
    },
    {
      type: 'poly_set_run_period',
      message0: '设置 on_run 周期为 %1 ms',
      args0: [{ type: 'input_value', name: 'MS', check: 'Number' }],
      inputsInline: true,
      previousStatement: null,
      nextStatement: null,
      style: 'event_stmt_blocks',
      tooltip: '动态修改 on_run 周期回调的触发间隔（毫秒）。',
    },
    {
      type: 'poly_run_control',
      message0: '%1 on_run 周期运行',
      args0: [
        {
          type: 'field_dropdown',
          name: 'ACTION',
          options: [
            ['启动', 'start'],
            ['停止', 'stop'],
          ],
        },
      ],
      inputsInline: true,
      previousStatement: null,
      nextStatement: null,
      style: 'event_stmt_blocks',
      tooltip: '在运行时启动或暂停 on_run 周期调度（对应 rt.start_run / rt.stop_run）。',
    },
    {
      type: 'poly_on_button',
      message0: '当按键 %1 %2 时',
      args0: [
        {
          type: 'field_dropdown',
          name: 'KEY',
          options: [
            ['按键 A', 'A'],
            ['按键 B', 'B'],
          ],
        },
        {
          type: 'field_dropdown',
          name: 'EDGE',
          options: [
            ['按下', 'press'],
            ['释放', 'release'],
          ],
        },
      ],
      message1: '%1',
      args1: [{ type: 'input_statement', name: 'BODY' }],
      inputsInline: true,
      style: 'event_blocks',
      tooltip:
        '硬件按键边沿事件回调，自动聚合成顶层 on_button(key, pressed) 分发函数（零闭包）。',
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
    {
      type: 'poly_clear_log',
      message0: '清空日志控制台',
      previousStatement: null,
      nextStatement: null,
      style: 'print_blocks',
      tooltip: '发送清空标记，清理当前日志控制台显示。',
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
      tooltip: '非阻塞延时指定毫秒数后再继续执行后续积木（沙箱中支持随时停止）。',
    },
    {
      type: 'poly_comment',
      message0: '注释 %1',
      args0: [{ type: 'field_input', name: 'TEXT', text: '记录逻辑说明' }],
      previousStatement: null,
      nextStatement: null,
      style: 'control_blocks',
      tooltip: '在生成的 Lua / Python 代码中保留对应注释行。',
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
        '声明或赋值仅在当前回调/函数体内有效的局部变量（Lua 生成 local，Python 保持函数局部，不污染句柄全局变量）。',
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

    // --- 列表辅助 ---
    {
      type: 'poly_list_append',
      message0: '向列表 %1 追加 %2',
      args0: [
        { type: 'field_variable', name: 'LIST', variable: 'items' },
        { type: 'input_value', name: 'ITEM' },
      ],
      inputsInline: true,
      previousStatement: null,
      nextStatement: null,
      style: 'list_blocks',
      tooltip: '向指定列表变量末尾追加一个元素。',
    },
  ];

  Blockly.defineBlocksWithJsonArray(customBlockDefs);

  // --- 多路硬件风格定时器积木（动态读取当前项目通道数 0..N-1 与别名）---
  Blockly.Blocks['poly_on_timer'] = {
    init(this: Blockly.Block) {
      this.appendDummyInput()
        .appendField('当定时器')
        .appendField(createTimerIdField(), 'TIMER_ID')
        .appendField('触发时');
      this.appendStatementInput('BODY');
      this.setInputsInline(true);
      this.setStyle('timer_hat_blocks');
      this.setTooltip(
        '绑定指定通道 ID 的定时器到期回调，自动聚合成顶层 on_timer(id) 分发函数（零闭包）。',
      );
    },
  };

  Blockly.Blocks['poly_start_timer'] = {
    init(this: Blockly.Block) {
      this.appendDummyInput()
        .appendField('启动定时器')
        .appendField(createTimerIdField(), 'TIMER_ID');
      this.appendValueInput('PERIOD_MS')
        .setCheck('Number')
        .appendField('周期');
      this.appendValueInput('REPEAT')
        .setCheck('Number')
        .appendField('ms 重复');
      this.appendDummyInput().appendField('次');
      this.setInputsInline(true);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setStyle('timer_blocks');
      this.setTooltip(
        '启动或重置指定通道定时器（rt.start_timer(id, period_ms, repeat)）：repeat=0 持续循环，1 单次，N 触发 N 次后停止。',
      );
    },
  };

  Blockly.Blocks['poly_stop_timer'] = {
    init(this: Blockly.Block) {
      this.appendDummyInput()
        .appendField('停止定时器')
        .appendField(createTimerIdField(), 'TIMER_ID');
      this.setInputsInline(true);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setStyle('timer_blocks');
      this.setTooltip('停止指定通道定时器（rt.stop_timer(id)）。');
    },
  };

  Blockly.Blocks['poly_get_timer_value'] = {
    init(this: Blockly.Block) {
      this.appendDummyInput()
        .appendField('定时器')
        .appendField(createTimerIdField(), 'TIMER_ID')
        .appendField('已过毫秒数');
      this.setInputsInline(true);
      this.setOutput(true, 'Number');
      this.setStyle('timer_blocks');
      this.setTooltip(
        '读取指定定时器本周期已流逝的毫秒数（rt.get_timer_value(id)，0 → period_ms，未运行返回 0）。',
      );
    },
  };

  Blockly.Blocks['poly_is_timer_running'] = {
    init(this: Blockly.Block) {
      this.appendDummyInput()
        .appendField('定时器')
        .appendField(createTimerIdField(), 'TIMER_ID')
        .appendField('正在运行?');
      this.setInputsInline(true);
      this.setOutput(true, 'Boolean');
      this.setStyle('timer_blocks');
      this.setTooltip('检查指定通道定时器当前是否处于运行状态（rt.is_timer_running(id)）。');
    },
  };

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
    lists_getIndex: 'list_blocks',
    lists_setIndex: 'list_blocks',
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

  // Also ensure built-in & saved custom extension packs are registered into Blockly & generators
  extensionRegistry.ensureInitialized();

  blocksRegistered = true;
}
