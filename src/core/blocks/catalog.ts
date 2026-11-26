import * as Blockly from 'blockly';
import { extensionRegistry } from '../extensions/registry';
import type { CoreCategoryTarget } from '../extensions/types';
import { getActiveHandleSharedVariables } from './timerConfigBridge';

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
  /** Numeric sort order in the left Blockly toolbox (core: 10..90, extensions default: 100+). */
  order: number;
  /** True for categories originating from declarative extension packs. */
  isExtension?: boolean;
  custom?: 'VARIABLE' | 'PROCEDURE';
  flyoutButton?: { text: string; callbackKey: string };
  blocks: ToolboxBlockSpec[];
}

/** Single source of truth for Layer 0 core category order numbers (displayed in Extensions page legend). */
export const CORE_TOOLBOX_ORDERS = [
  { id: 'event', label: '事件', order: 10 },
  { id: 'print', label: '打印', order: 20 },
  { id: 'control', label: '控制', order: 30 },
  { id: 'variables', label: '变量', order: 40 },
  { id: 'math', label: '运算', order: 50 },
  { id: 'logic', label: '逻辑', order: 60 },
  { id: 'text', label: '文本', order: 70 },
  { id: 'lists', label: '列表', order: 80 },
  { id: 'functions', label: '函数', order: 90 },
] as const;

export const DEFAULT_EXTENSION_TOOLBOX_ORDER = 100;

const numShadow = (num: number) => ({
  shadow: { type: 'math_number', fields: { NUM: num } },
});

const textShadow = (text: string) => ({
  shadow: { type: 'text', fields: { TEXT: text } },
});

/** Core language-level event blocks (always present in Layer 0). */
const CORE_EVENT_BLOCKS: ToolboxBlockSpec[] = [
  {
    kind: 'block',
    type: 'poly_on_start',
    keywords: '当程序启动 on_start start main 入口 事件 初始化',
  },
  {
    kind: 'block',
    type: 'poly_require_script',
    keywords: '加载脚本 require 导入 模块 同句柄 脚本 timers',
  },
  {
    kind: 'block',
    type: 'poly_comment',
    keywords: '注释 comment 备注 说明',
  },
];

export const BLOCK_CATEGORIES: BlockCategorySpec[] = [
  {
    id: 'event',
    label: '事件',
    color: '#e0911f',
    order: 10,
    blocks: CORE_EVENT_BLOCKS,
  },
  {
    id: 'print',
    label: '打印',
    color: '#0d9488',
    order: 20,
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
    order: 30,
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
    order: 40,
    custom: 'VARIABLE',
    blocks: [
      {
        kind: 'block',
        type: 'poly_local_set',
        keywords: '局部变量 local 临时 变量 作用域 tmp',
        fields: { NAME: 'tmp' },
        inputs: { VALUE: numShadow(0) },
      },
      {
        kind: 'block',
        type: 'poly_local_get',
        keywords: '读取 局部 local 临时 变量 tmp',
        fields: { NAME: 'tmp' },
      },
    ],
  },
  {
    id: 'math',
    label: '运算',
    color: '#16a34a',
    order: 50,
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
    order: 60,
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
    order: 70,
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
    order: 80,
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
    order: 90,
    custom: 'PROCEDURE',
    blocks: [],
  },
];

function stripKeywords(spec: ToolboxBlockSpec): Record<string, unknown> {
  const { keywords: _k, ...blocklyBlock } = spec;
  return blocklyBlock;
}

/**
 * Merges Layer 0 core categories (10..90) with all enabled extension pack sections:
 * - Sections with `categoryTarget === 'own'` (and `visible !== false`) become standalone tabs sorted by `order`.
 * - Sections targeting any core category (`'event' | 'print' | 'control' | ...`) merge declaratively into that tab.
 */
export function getOrderedToolboxCategories(
  enabledCapabilities: string[] = [],
  extraExtensionCategories?: BlockCategorySpec[],
): BlockCategorySpec[] {
  const extCats =
    extraExtensionCategories ??
    extensionRegistry.toCategorySpecs(enabledCapabilities);

  const combined: Array<{ cat: BlockCategorySpec; seq: number }> = [];
  let seq = 0;

  for (const cat of BLOCK_CATEGORIES) {
    const mergedBlocks = extensionRegistry.getMergedBlocksForCategory(
      cat.id as CoreCategoryTarget,
      enabledCapabilities,
    );
    combined.push({
      cat:
        mergedBlocks.length > 0
          ? {
              ...cat,
              blocks: [...cat.blocks, ...mergedBlocks],
            }
          : cat,
      seq: seq++,
    });
  }

  for (const extCat of extCats) {
    combined.push({ cat: extCat, seq: seq++ });
  }

  combined.sort((a, b) => a.cat.order - b.cat.order || a.seq - b.seq);
  return combined.map((entry) => entry.cat);
}

/**
 * Backward-compatible helper returning ordered categories for the given enabled capabilities
 * (including any enabled packs whose `toolboxOrder` places them among or after core categories).
 */
export function getCoreCategoriesForCapabilities(
  enabledCapabilities: string[] = [],
): BlockCategorySpec[] {
  return getOrderedToolboxCategories(enabledCapabilities);
}

/**
 * Builds a Blockly flyoutToolbox JSON definition for either:
 * - A search query across all currently enabled categories, or
 * - A single selected category (including dynamic VARIABLE / PROCEDURE / channel-pool blocks).
 */
export function buildFlyoutToolbox(
  workspace: Blockly.WorkspaceSvg | null,
  categoryId: string,
  searchQuery: string,
  extraCategories: BlockCategorySpec[] = [],
  enabledCapabilities: string[] = [],
): Blockly.utils.toolbox.ToolboxInfo {
  const allCategories = getOrderedToolboxCategories(
    enabledCapabilities,
    extraCategories.length > 0 ? extraCategories : undefined,
  );
  const q = searchQuery.trim().toLowerCase();

  // Scale-compensated top spacer so the docked search bar never overlaps the flyout heading at any zoom (50%..160%)
  const wsScale =
    workspace && Number.isFinite(workspace.scale) && workspace.scale > 0
      ? workspace.scale
      : 0.92;
  const desiredClearancePx = wsScale < 0.72 ? 40 : 46;
  const topSpacer: Blockly.utils.toolbox.FlyoutItemInfo = {
    kind: 'sep',
    gap: String(Math.ceil(desiredClearancePx / wsScale)),
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
    const sharedSet = new Set(getActiveHandleSharedVariables() ?? []);
    const sharedVars = vars.filter((v) => sharedSet.has(v.getName()));
    const fileVars = vars.filter((v) => !sharedSet.has(v.getName()));

    const items: Blockly.utils.toolbox.FlyoutItemInfoArray = [
      topSpacer,
      { kind: 'label', text: '跨文件全局 (同句柄共享)' },
      {
        kind: 'button',
        text: '+ 新建跨文件变量',
        callbackkey: 'CREATE_SHARED_VARIABLE',
      },
    ];

    if (sharedVars.length > 0) {
      const firstSharedId = sharedVars[0].getId();
      items.push(
        {
          kind: 'block',
          type: 'variables_set',
          fields: { VAR: { id: firstSharedId } },
          inputs: { VALUE: numShadow(0) },
        } as unknown as Blockly.utils.toolbox.BlockInfo,
        {
          kind: 'block',
          type: 'math_change',
          fields: { VAR: { id: firstSharedId } },
          inputs: { DELTA: numShadow(1) },
        } as unknown as Blockly.utils.toolbox.BlockInfo,
      );
      for (const v of sharedVars) {
        items.push({
          kind: 'block',
          type: 'variables_get',
          fields: { VAR: { id: v.getId() } },
        } as unknown as Blockly.utils.toolbox.BlockInfo);
      }
    }

    items.push(
      { kind: 'sep', gap: '16' },
      { kind: 'label', text: '单文件全局 (仅本脚本)' },
      {
        kind: 'button',
        text: '+ 新建单文件变量',
        callbackkey: 'CREATE_FILE_VARIABLE',
      },
    );

    if (fileVars.length > 0) {
      const firstFileId = fileVars[0].getId();
      items.push(
        {
          kind: 'block',
          type: 'variables_set',
          fields: { VAR: { id: firstFileId } },
          inputs: { VALUE: numShadow(0) },
        } as unknown as Blockly.utils.toolbox.BlockInfo,
        {
          kind: 'block',
          type: 'math_change',
          fields: { VAR: { id: firstFileId } },
          inputs: { DELTA: numShadow(1) },
        } as unknown as Blockly.utils.toolbox.BlockInfo,
      );
      for (const v of fileVars) {
        items.push({
          kind: 'block',
          type: 'variables_get',
          fields: { VAR: { id: v.getId() } },
        } as unknown as Blockly.utils.toolbox.BlockInfo);
      }
    }

    items.push(
      { kind: 'sep', gap: '16' },
      { kind: 'label', text: '局部临时变量 (仅本回调/函数)' },
      {
        kind: 'block',
        type: 'poly_local_set',
        fields: { NAME: 'tmp' },
        inputs: { VALUE: numShadow(0) },
      } as unknown as Blockly.utils.toolbox.BlockInfo,
      {
        kind: 'block',
        type: 'poly_local_get',
        fields: { NAME: 'tmp' },
      } as unknown as Blockly.utils.toolbox.BlockInfo,
    );

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

  if (category.flyoutButton) {
    return {
      kind: 'flyoutToolbox',
      contents: [
        topSpacer,
        { kind: 'label', text: category.label },
        {
          kind: 'button',
          text: category.flyoutButton.text,
          callbackkey: category.flyoutButton.callbackKey,
        },
        ...category.blocks.map(
          (b) => stripKeywords(b) as unknown as Blockly.utils.toolbox.BlockInfo,
        ),
      ],
    };
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
