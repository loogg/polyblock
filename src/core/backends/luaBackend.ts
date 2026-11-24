import * as Blockly from 'blockly';
import { luaGenerator, Order } from 'blockly/lua';
import {
  analyzeWorkspaceDiagnostics,
  extractSourceMap,
  SENTINEL_END_PREFIX,
  SENTINEL_START_PREFIX,
} from './sourceMap';
import type { GeneratedCodeResult, ScriptBackendAdapter } from './types';

let luaGeneratorsRegistered = false;
let luaDebugPass = false;

function registerLuaBlockGenerators(): void {
  if (luaGeneratorsRegistered) return;

  luaGenerator.forBlock['poly_on_start'] = (block, generator) => {
    const body = generator.statementToCode(block, 'BODY');
    const dedented = body.replace(/^  /gm, '');
    if (luaDebugPass) {
      return `-- 当程序启动\n${dedented}`;
    }
    return (
      `${SENTINEL_START_PREFIX}'${block.id}'__\n` +
      `-- 当程序启动\n` +
      `${dedented}` +
      `${SENTINEL_END_PREFIX}'${block.id}'__\n`
    );
  };

  luaGenerator.forBlock['poly_print'] = (block, generator) => {
    const value = generator.valueToCode(block, 'VALUE', Order.NONE) || '""';
    return `print(${value})\n`;
  };

  luaGenerator.forBlock['poly_log'] = (block, generator) => {
    const level = block.getFieldValue('LEVEL') || 'INFO';
    const msg = generator.valueToCode(block, 'MESSAGE', Order.NONE) || '""';
    return `print("[${level}] " .. tostring(${msg}))\n`;
  };

  luaGenerator.forBlock['poly_print_kv'] = (block, generator) => {
    const rawLabel = block.getFieldValue('LABEL') || 'value';
    const label = JSON.stringify(rawLabel);
    const value = generator.valueToCode(block, 'VALUE', Order.NONE) || 'nil';
    return `print(${label} .. " = " .. tostring(${value}))\n`;
  };

  luaGenerator.forBlock['poly_clear_log'] = () => {
    return `print("__POLYBLOCK_CLEAR__")\n`;
  };

  luaGenerator.forBlock['poly_repeat_times'] = (block, generator) => {
    const times = generator.valueToCode(block, 'TIMES', Order.NONE) || '0';
    const branch = generator.statementToCode(block, 'DO');
    return `for _count = 1, ${times} do\n${branch}end\n`;
  };

  luaGenerator.forBlock['poly_for_range'] = (block, generator) => {
    const variableName = generator.getVariableName(block.getFieldValue('VAR'));
    const from = generator.valueToCode(block, 'FROM', Order.NONE) || '1';
    const to = generator.valueToCode(block, 'TO', Order.NONE) || '1';
    const by = generator.valueToCode(block, 'BY', Order.NONE) || '1';
    const branch = generator.statementToCode(block, 'DO');
    const stepPart = by.trim() === '1' ? '' : `, ${by}`;
    return `for ${variableName} = ${from}, ${to}${stepPart} do\n${branch}end\n`;
  };

  luaGenerator.forBlock['poly_wait_ms'] = (block, generator) => {
    const ms = generator.valueToCode(block, 'MS', Order.NONE) || '0';
    if (luaDebugPass) {
      return `__poly_sleep(${ms}):await()\n`;
    }
    const helper = generator.provideFunction_('poly_wait_ms', [
      `local function ${generator.FUNCTION_NAME_PLACEHOLDER_}(ms)`,
      `  local t0 = os.clock()`,
      `  while (os.clock() - t0) * 1000 < ms do end`,
      `end`,
    ]);
    return `${helper}(${ms})\n`;
  };

  luaGenerator.forBlock['poly_comment'] = (block) => {
    const text = (block.getFieldValue('TEXT') || '').replace(/\r?\n/g, ' ');
    return `-- ${text}\n`;
  };

  luaGenerator.forBlock['poly_to_string'] = (block, generator) => {
    const value = generator.valueToCode(block, 'VALUE', Order.NONE) || '""';
    return [`tostring(${value})`, Order.HIGH];
  };

  luaGenerator.forBlock['poly_list_append'] = (block, generator) => {
    const listVar = generator.getVariableName(block.getFieldValue('LIST'));
    const item = generator.valueToCode(block, 'ITEM', Order.NONE) || 'nil';
    return `table.insert(${listVar}, ${item})\n`;
  };

  luaGeneratorsRegistered = true;
}

function buildLuaSnapshotExpr(
  entries: Array<{ label: string; ident: string }>,
): string {
  if (entries.length === 0) return '{}';
  const pairs = entries.map(
    ({ label, ident }) => `[${JSON.stringify(label)}] = ${ident}`,
  );
  return `{ ${pairs.join(', ')} }`;
}

export class LuaBackendAdapter implements ScriptBackendAdapter {
  readonly id = 'lua' as const;
  readonly name = 'Lua';
  readonly version = '5.4';
  readonly extension = 'lua';
  readonly fileName = 'main.lua';
  readonly accentColor = '#3b82f6';
  readonly description =
    '标准 Lua 5.4 脚本生成器，支持干净导出与沙箱逐块高亮、延时及断点单步调试。';

  generate(workspace: Blockly.Workspace): GeneratedCodeResult {
    registerLuaBlockGenerators();

    const prevPrefix = luaGenerator.STATEMENT_PREFIX;
    const prevSuffix = luaGenerator.STATEMENT_SUFFIX;

    // --- Pass 1: Clean display/export/board-download code + SourceMap ---
    luaDebugPass = false;
    luaGenerator.STATEMENT_PREFIX = `${SENTINEL_START_PREFIX}%1__\n`;
    luaGenerator.STATEMENT_SUFFIX = `${SENTINEL_END_PREFIX}%1__\n`;

    let rawClean = '';
    const varEntries: Array<{ label: string; ident: string }> = [];
    try {
      luaGenerator.init(workspace);
      for (const v of workspace.getVariableMap().getAllVariables()) {
        varEntries.push({
          label: v.getName(),
          ident: luaGenerator.getVariableName(v.getId()),
        });
      }
      rawClean = luaGenerator.workspaceToCode(workspace);
    } finally {
      luaGenerator.STATEMENT_PREFIX = prevPrefix;
      luaGenerator.STATEMENT_SUFFIX = prevSuffix;
    }

    const header = `-- 由 PolyBlock 自动生成 (Target: Lua 5.4)\n`;
    const combinedClean = rawClean.trim()
      ? `${header}${rawClean}`
      : `${header}-- 请从左侧拖入积木开始编排`;
    const { code, sourceMap, lineToBlock } = extractSourceMap(combinedClean);

    // --- Pass 2: Instrumented async sandbox debug code ---
    const snapExpr = buildLuaSnapshotExpr(varEntries);
    let debugBody = '';
    try {
      luaDebugPass = true;
      luaGenerator.STATEMENT_PREFIX = `__poly_step(%1, __poly_snap(${snapExpr})):await()\n`;
      luaGenerator.STATEMENT_SUFFIX = null;
      debugBody = luaGenerator.workspaceToCode(workspace);
    } finally {
      luaDebugPass = false;
      luaGenerator.STATEMENT_PREFIX = prevPrefix;
      luaGenerator.STATEMENT_SUFFIX = prevSuffix;
    }

    const debugCode = debugBody.trim()
      ? `${debugBody}\n__poly_final_snap(__poly_snap(${snapExpr}))\n`
      : '';

    return {
      language: this.id,
      code,
      debugCode,
      sourceMap,
      lineToBlock,
      diagnostics: analyzeWorkspaceDiagnostics(workspace),
      blockCount: workspace
        .getAllBlocks(false)
        .filter((b) => !b.isShadow()).length,
      variableNames: varEntries.map((v) => v.label),
    };
  }
}
