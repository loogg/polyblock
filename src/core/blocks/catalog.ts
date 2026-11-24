import * as Blockly from 'blockly';

export interface ToolboxBlockSpec {
  kind: 'block';
  type: string;
  keywords: string;
  inputs?: Record<string, { shadow?: Record<string, unknown> }>;
  fields?: Record<string, unknown>;
  extraState?: Record<string, unknown>;
}

export interface BlockCategorySpec {
  id: string;
  label: string;
  color: string;
  custom?: 'VARIABLE' | 'PROCEDURE';
  blocks: ToolboxBlockSpec[];
}

const numShadow = (num: number) => ({
  shadow: { type: 'math_number', fields: { NUM: num } },
});

const textShadow = (text: string) => ({
  shadow: { type: 'text', fields: { TEXT: text } },
});

export const BLOCK_CATEGORIES: BlockCategorySpec[] = [
  {
    id: 'event',
    label: '事件',
    color: '#e0911f',
    blocks: [
      {
        kind: 'block',
        type: 'poly_on_start',
        keywords: '当程序启动 start main 入口 事件',
      },
      {
        kind: 'block',
        type: 'poly_comment',
        keywords: '注释 comment 备注 说明',
      },
    ],
  },
  {
    id: 'print',
    label: '打印',
    color: '#0d9488',
    blocks: [
      {
        kind: 'block',
        type: 'poly_print',
        keywords: '打印 print 输出 console 控制台 日志',
        inputs: { VALUE: textShadow('Hello PolyBlock!') },
      },
      {
        kind: 'block',
        type: 'poly_log',
        keywords: '日志 log info warn error ok 分级 调试',
        fields: { LEVEL: 'INFO' },
        inputs: { MESSAGE: textShadow('状态正常') },
      },
      {
        kind: 'block',
        type: 'poly_print_kv',
        keywords: '打印标签 变量 调试 debug kv label',
        fields: { LABEL: 'total' },
        inputs: { VALUE: numShadow(0) },
      },
      {
        kind: 'block',
        type: 'poly_clear_log',
        keywords: '清空日志 clear console 清理',
      },
    ],
  },
  {
    id: 'control',
    label: '控制',
    color: '#d97706',
    blocks: [
      {
        kind: 'block',
        type: 'poly_repeat_times',
        keywords: '重复执行 循环 repeat times 次',
        inputs: { TIMES: numShadow(3) },
      },
      {
        kind: 'block',
        type: 'poly_for_range',
        keywords: '计次循环 for range 步长 迭代',
        inputs: {
          FROM: numShadow(1),
          TO: numShadow(5),
          BY: numShadow(1),
        },
      },
      {
        kind: 'block',
        type: 'poly_wait_ms',
        keywords: '等待 延时 暂停 睡眠 wait sleep delay ms 毫秒',
        inputs: { MS: numShadow(500) },
      },
      {
        kind: 'block',
        type: 'controls_if',
        keywords: '如果 那么 否则 if else elif 条件 分支',
      },
      {
        kind: 'block',
        type: 'controls_whileUntil',
        keywords: '当 重复 while until 条件循环',
      },
      {
        kind: 'block',
        type: 'controls_flow_statements',
        keywords: '跳出 继续 循环 break continue',
      },
    ],
  },
  {
    id: 'variables',
    label: '变量',
    color: '#db2777',
    custom: 'VARIABLE',
    blocks: [],
  },
  {
    id: 'math',
    label: '运算',
    color: '#16a34a',
    blocks: [
      {
        kind: 'block',
        type: 'math_number',
        keywords: '数字 数值 number 常量',
        fields: { NUM: 10 },
      },
      {
        kind: 'block',
        type: 'math_arithmetic',
        keywords: '加 减 乘 除 幂 算术 运算 + - * / math',
        inputs: { A: numShadow(1), B: numShadow(2) },
      },
      {
        kind: 'block',
        type: 'math_modulo',
        keywords: '取余 模 mod % 余数',
        inputs: { DIVIDEND: numShadow(10), DIVISOR: numShadow(3) },
      },
      {
        kind: 'block',
        type: 'math_random_int',
        keywords: '随机 整数 random randint',
        inputs: { FROM: numShadow(1), TO: numShadow(100) },
      },
      {
        kind: 'block',
        type: 'math_round',
        keywords: '四舍五入 取整 round floor ceil',
        inputs: { NUM: numShadow(3.6) },
      },
      {
        kind: 'block',
        type: 'math_single',
        keywords: '平方根 绝对值 数学 sqrt abs neg',
        inputs: { NUM: numShadow(9) },
      },
    ],
  },
  {
    id: 'logic',
    label: '逻辑',
    color: '#2563eb',
    blocks: [
      {
        kind: 'block',
        type: 'logic_compare',
        keywords: '比较 等于 大于 小于 == != > <',
        inputs: { A: numShadow(10), B: numShadow(10) },
      },
      {
        kind: 'block',
        type: 'logic_operation',
        keywords: '且 或 and or 逻辑',
      },
      {
        kind: 'block',
        type: 'logic_negate',
        keywords: '非 取反 not 逻辑',
      },
      {
        kind: 'block',
        type: 'logic_boolean',
        keywords: '真 假 true false 布尔',
      },
      {
        kind: 'block',
        type: 'logic_null',
        keywords: '空 null nil none',
      },
    ],
  },
  {
    id: 'text',
    label: '文本',
    color: '#0891b2',
    blocks: [
      {
        kind: 'block',
        type: 'text',
        keywords: '文本 字符串 string text',
        fields: { TEXT: 'PolyBlock' },
      },
      {
        kind: 'block',
        type: 'text_join',
        keywords: '拼接 连接 concat join 字符串',
        extraState: { itemCount: 2 },
        inputs: {
          ADD0: textShadow('第 '),
          ADD1: textShadow('1 轮'),
        },
      },
      {
        kind: 'block',
        type: 'poly_to_string',
        keywords: '转文本 tostring str 格式化',
        inputs: { VALUE: numShadow(42) },
      },
      {
        kind: 'block',
        type: 'text_length',
        keywords: '文本长度 length len',
        inputs: { VALUE: textShadow('abc') },
      },
    ],
  },
  {
    id: 'lists',
    label: '列表',
    color: '#7c3aed',
    blocks: [
      {
        kind: 'block',
        type: 'lists_create_with',
        keywords: '创建列表 数组 list array table',
        extraState: { itemCount: 3 },
        inputs: {
          ADD0: numShadow(10),
          ADD1: numShadow(20),
          ADD2: numShadow(30),
        },
      },
      {
        kind: 'block',
        type: 'poly_list_append',
        keywords: '追加 插入 列表 append push insert',
        inputs: { ITEM: numShadow(40) },
      },
      {
        kind: 'block',
        type: 'lists_length',
        keywords: '列表长度 len length',
      },
      {
        kind: 'block',
        type: 'lists_getIndex',
        keywords: '获取列表项 索引 index get',
      },
      {
        kind: 'block',
        type: 'lists_setIndex',
        keywords: '设置列表项 修改 set index',
      },
    ],
  },
  {
    id: 'functions',
    label: '函数',
    color: '#4f46e5',
    custom: 'PROCEDURE',
    blocks: [],
  },
];

function stripKeywords(spec: ToolboxBlockSpec): Record<string, unknown> {
  const { keywords: _k, ...blocklyBlock } = spec;
  return blocklyBlock;
}

/**
 * Builds a Blockly flyoutToolbox JSON definition for either:
 * - A search query across all categories, or
 * - A single selected category (including dynamic VARIABLE / PROCEDURE blocks).
 */
export function buildFlyoutToolbox(
  workspace: Blockly.WorkspaceSvg | null,
  categoryId: string,
  searchQuery: string,
  extraCategories: BlockCategorySpec[] = [],
): Blockly.utils.toolbox.ToolboxInfo {
  const allCategories = [...BLOCK_CATEGORIES, ...extraCategories];
  const q = searchQuery.trim().toLowerCase();

  const topSpacer: Blockly.utils.toolbox.FlyoutItemInfo = {
    kind: 'sep',
    gap: '44',
  };

  if (q) {
    const matched: Blockly.utils.toolbox.FlyoutItemInfoArray = [];
    for (const cat of allCategories) {
      for (const blk of cat.blocks) {
        if (
          blk.keywords.toLowerCase().includes(q) ||
          blk.type.toLowerCase().includes(q) ||
          cat.label.toLowerCase().includes(q)
        ) {
          matched.push(stripKeywords(blk) as unknown as Blockly.utils.toolbox.BlockInfo);
        }
      }
    }

    if (matched.length === 0) {
      return {
        kind: 'flyoutToolbox',
        contents: [
          topSpacer,
          {
            kind: 'label',
            text: `未找到匹配 “${searchQuery.trim()}” 的积木`,
          },
        ],
      };
    }

    return {
      kind: 'flyoutToolbox',
      contents: [
        topSpacer,
        { kind: 'label', text: `搜索结果 (${matched.length})` },
        ...matched,
      ],
    };
  }

  const category =
    allCategories.find((c) => c.id === categoryId) ?? allCategories[0];

  if (category.custom === 'VARIABLE' && workspace) {
    const vars = workspace.getVariableMap().getAllVariables();
    const items: Blockly.utils.toolbox.FlyoutItemInfoArray = [
      topSpacer,
      { kind: 'label', text: '变量管理' },
      {
        kind: 'button',
        text: '+ 新建变量',
        callbackkey: 'CREATE_VARIABLE',
      },
    ];

    if (vars.length > 0) {
      const firstId = vars[0].getId();
      items.push(
        {
          kind: 'block',
          type: 'variables_set',
          fields: { VAR: { id: firstId } },
          inputs: { VALUE: numShadow(0) },
        } as unknown as Blockly.utils.toolbox.BlockInfo,
        {
          kind: 'block',
          type: 'math_change',
          fields: { VAR: { id: firstId } },
          inputs: { DELTA: numShadow(1) },
        } as unknown as Blockly.utils.toolbox.BlockInfo,
      );

      for (const v of vars) {
        items.push({
          kind: 'block',
          type: 'variables_get',
          fields: { VAR: { id: v.getId() } },
        } as unknown as Blockly.utils.toolbox.BlockInfo);
      }
    }

    return { kind: 'flyoutToolbox', contents: items };
  }

  if (category.custom === 'PROCEDURE' && workspace) {
    const items: Blockly.utils.toolbox.FlyoutItemInfoArray = [
      topSpacer,
      { kind: 'label', text: '自定义函数' },
      {
        kind: 'block',
        type: 'procedures_defnoreturn',
        fields: { NAME: 'my_func' },
      } as unknown as Blockly.utils.toolbox.BlockInfo,
      {
        kind: 'block',
        type: 'procedures_defreturn',
        fields: { NAME: 'calc_value' },
      } as unknown as Blockly.utils.toolbox.BlockInfo,
      {
        kind: 'block',
        type: 'procedures_ifreturn',
      } as unknown as Blockly.utils.toolbox.BlockInfo,
    ];

    const [noReturnProcs, returnProcs] = Blockly.Procedures.allProcedures(workspace);
    for (const [name, params] of noReturnProcs) {
      items.push({
        kind: 'block',
        type: 'procedures_callnoreturn',
        extraState: { name, params },
      } as unknown as Blockly.utils.toolbox.BlockInfo);
    }
    for (const [name, params] of returnProcs) {
      items.push({
        kind: 'block',
        type: 'procedures_callreturn',
        extraState: { name, params },
      } as unknown as Blockly.utils.toolbox.BlockInfo);
    }

    return { kind: 'flyoutToolbox', contents: items };
  }

  return {
    kind: 'flyoutToolbox',
    contents: [
      topSpacer,
      { kind: 'label', text: category.label },
      ...category.blocks.map(
        (b) => stripKeywords(b) as unknown as Blockly.utils.toolbox.BlockInfo,
      ),
    ],
  };
}
