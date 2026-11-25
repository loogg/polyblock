import * as Blockly from 'blockly';
import { luaGenerator, Order } from 'blockly/lua';
import { getActiveTimerConfig } from '../blocks/timerConfigBridge';
import { isEventDrivenWorkspace } from './eventMode';
import {
  analyzeWorkspaceScopes,
  sanitizeLocalIdent,
} from './scopeAnalysis';
import {
  analyzeWorkspaceDiagnostics,
  extractSourceMap,
  SENTINEL_END_PREFIX,
  SENTINEL_START_PREFIX,
} from './sourceMap';
import type { GeneratedCodeResult, ScriptBackendAdapter } from './types';

let luaGeneratorsRegistered = false;
let luaDebugPass = false;
let luaEventDrivenMode = false;
let luaEmittedTimerDispatch = false;
let luaEmittedButtonDispatch = false;
let luaDeclaredLocalsByRoot = new Map<string, Set<string>>();

function getLuaScopeRootId(block: Blockly.Block): string {
  return block.getRootBlock().id;
}

function ensureLuaRtImport(generator: typeof luaGenerator): void {
  const defs = (generator as unknown as { definitions_: Record<string, string> })
    .definitions_;
  defs['import_rt'] = 'local rt = require("rt")';
}

function indentBlockLines(code: string, extraSpaces: string): string {
  if (!code) return '';
  return code
    .split('\n')
    .map((line) => (line.length > 0 ? `${extraSpaces}${line}` : line))
    .join('\n');
}

function getTimerAliasSuffix(id: number): string {
  const alias = getActiveTimerConfig().aliases[String(id)];
  return alias ? ` -- T${id}: ${alias}` : '';
}

function registerLuaBlockGenerators(): void {
  if (luaGeneratorsRegistered) return;

  luaGenerator.forBlock['poly_on_start'] = (block, generator) => {
    const body = generator.statementToCode(block, 'BODY');
    if (luaEventDrivenMode) {
      if (luaDebugPass) {
        return `function on_start()\n${body}end\n`;
      }
      return (
        `${SENTINEL_START_PREFIX}'${block.id}'__\n` +
        `function on_start()\n` +
        `${body}` +
        `end\n` +
        `${SENTINEL_END_PREFIX}'${block.id}'__\n`
      );
    }

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

  luaGenerator.forBlock['poly_on_run'] = (block, generator) => {
    ensureLuaRtImport(generator);
    const periodMs = Math.max(
      10,
      Math.round(Number(block.getFieldValue('PERIOD_MS') ?? 100)),
    );
    const body = generator.statementToCode(block, 'BODY');
    if (luaDebugPass) {
      return `rt.set_run_period(${periodMs})\nfunction on_run()\n${body}end\n`;
    }
    return (
      `${SENTINEL_START_PREFIX}'${block.id}'__\n` +
      `rt.set_run_period(${periodMs})\n` +
      `function on_run()\n` +
      `${body}` +
      `end\n` +
      `${SENTINEL_END_PREFIX}'${block.id}'__\n`
    );
  };

  luaGenerator.forBlock['poly_on_stop'] = (block, generator) => {
    const body = generator.statementToCode(block, 'BODY');
    if (luaDebugPass) {
      return `function on_stop()\n${body}end\n`;
    }
    return (
      `${SENTINEL_START_PREFIX}'${block.id}'__\n` +
      `function on_stop()\n` +
      `${body}` +
      `end\n` +
      `${SENTINEL_END_PREFIX}'${block.id}'__\n`
    );
  };

  luaGenerator.forBlock['poly_set_run_period'] = (block, generator) => {
    ensureLuaRtImport(generator);
    const ms = generator.valueToCode(block, 'MS', Order.NONE) || '100';
    return `rt.set_run_period(${ms})\n`;
  };

  luaGenerator.forBlock['poly_run_control'] = (block, generator) => {
    ensureLuaRtImport(generator);
    const action = block.getFieldValue('ACTION') || 'start';
    return action === 'stop' ? `rt.stop_run()\n` : `rt.start_run()\n`;
  };

  // Aggregate all enabled poly_on_timer hats into one top-level zero-closure `function on_timer(id)`
  luaGenerator.forBlock['poly_on_timer'] = (block, generator) => {
    if (luaEmittedTimerDispatch) return '';
    luaEmittedTimerDispatch = true;

    const timerHats = block.workspace
      .getTopBlocks(true)
      .filter((b) => b.type === 'poly_on_timer' && !b.isShadow() && b.isEnabled());
    if (timerHats.length === 0) return '';

    const branches: string[] = [];
    timerHats.forEach((hat, idx) => {
      const tid = Math.trunc(Number(hat.getFieldValue('TIMER_ID') ?? 0));
      const kw = idx === 0 ? 'if' : 'elseif';
      const aliasSuffix = getTimerAliasSuffix(tid);
      const rawBody = generator.statementToCode(hat, 'BODY');
      const indentedBody = indentBlockLines(rawBody, '  ');
      if (luaDebugPass) {
        branches.push(`  ${kw} id == ${tid} then${aliasSuffix}\n${indentedBody}`);
      } else {
        branches.push(
          `${SENTINEL_START_PREFIX}'${hat.id}'__\n` +
            `  ${kw} id == ${tid} then${aliasSuffix}\n` +
            `${indentedBody}` +
            `${SENTINEL_END_PREFIX}'${hat.id}'__\n`,
        );
      }
    });

    return `function on_timer(id)\n${branches.join('')}  end\nend\n`;
  };

  // Aggregate all enabled poly_on_button hats into one top-level zero-closure `function on_button(key, pressed)`
  luaGenerator.forBlock['poly_on_button'] = (block, generator) => {
    if (luaEmittedButtonDispatch) return '';
    luaEmittedButtonDispatch = true;

    const btnHats = block.workspace
      .getTopBlocks(true)
      .filter((b) => b.type === 'poly_on_button' && !b.isShadow() && b.isEnabled());
    if (btnHats.length === 0) return '';

    const branches: string[] = [];
    btnHats.forEach((hat, idx) => {
      const key = String(hat.getFieldValue('KEY') || 'A');
      const edge = String(hat.getFieldValue('EDGE') || 'press');
      const kw = idx === 0 ? 'if' : 'elseif';
      const cond =
        edge === 'press'
          ? `key == ${JSON.stringify(key)} and pressed`
          : `key == ${JSON.stringify(key)} and not pressed`;
      const rawBody = generator.statementToCode(hat, 'BODY');
      const indentedBody = indentBlockLines(rawBody, '  ');
      if (luaDebugPass) {
        branches.push(`  ${kw} ${cond} then\n${indentedBody}`);
      } else {
        branches.push(
          `${SENTINEL_START_PREFIX}'${hat.id}'__\n` +
            `  ${kw} ${cond} then\n` +
            `${indentedBody}` +
            `${SENTINEL_END_PREFIX}'${hat.id}'__\n`,
        );
      }
    });

    return `function on_button(key, pressed)\n${branches.join('')}  end\nend\n`;
  };

  luaGenerator.forBlock['poly_start_timer'] = (block, generator) => {
    ensureLuaRtImport(generator);
    const tid = Math.trunc(Number(block.getFieldValue('TIMER_ID') ?? 0));
    const periodMs = generator.valueToCode(block, 'PERIOD_MS', Order.NONE) || '500';
    const repeat = generator.valueToCode(block, 'REPEAT', Order.NONE) || '0';
    return `rt.start_timer(${tid}, ${periodMs}, ${repeat})${getTimerAliasSuffix(tid)}\n`;
  };

  luaGenerator.forBlock['poly_stop_timer'] = (block, generator) => {
    ensureLuaRtImport(generator);
    const tid = Math.trunc(Number(block.getFieldValue('TIMER_ID') ?? 0));
    return `rt.stop_timer(${tid})${getTimerAliasSuffix(tid)}\n`;
  };

  luaGenerator.forBlock['poly_get_timer_value'] = (block, generator) => {
    ensureLuaRtImport(generator);
    const tid = Math.trunc(Number(block.getFieldValue('TIMER_ID') ?? 0));
    return [`rt.get_timer_value(${tid})`, Order.HIGH];
  };

  luaGenerator.forBlock['poly_is_timer_running'] = (block, generator) => {
    ensureLuaRtImport(generator);
    const tid = Math.trunc(Number(block.getFieldValue('TIMER_ID') ?? 0));
    return [`rt.is_timer_running(${tid})`, Order.HIGH];
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

  luaGenerator.forBlock['poly_local_set'] = (block, generator) => {
    const rawName = String(block.getFieldValue('NAME') || 'tmp');
    const ident = sanitizeLocalIdent(rawName);
    const val = generator.valueToCode(block, 'VALUE', Order.NONE) || 'nil';
    const rootId = getLuaScopeRootId(block);
    let declared = luaDeclaredLocalsByRoot.get(rootId);
    if (!declared) {
      declared = new Set<string>();
      luaDeclaredLocalsByRoot.set(rootId, declared);
    }
    if (!declared.has(ident)) {
      declared.add(ident);
      return `local ${ident} = ${val}\n`;
    }
    return `${ident} = ${val}\n`;
  };

  luaGenerator.forBlock['poly_local_get'] = (block) => {
    const rawName = String(block.getFieldValue('NAME') || 'tmp');
    return [sanitizeLocalIdent(rawName), Order.ATOMIC];
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

const LUA_EVENT_LOOP_DRIVER = `
if type(on_start) == "function" then on_start() end
if __poly_should_loop(type(on_run) == "function", type(on_timer) == "function", type(on_button) == "function") then
  while true do
    local _ev = __poly_next_event():await()
    if _ev == "run" then
      if type(on_run) == "function" then on_run() end
    elseif type(_ev) == "string" and _ev:sub(1, 6) == "timer:" then
      local _tid = tonumber(_ev:sub(7))
      if type(on_timer) == "function" and _tid ~= nil then on_timer(_tid) end
    elseif type(_ev) == "string" and _ev:sub(1, 7) == "button:" then
      local _k, _p = _ev:match("^button:([^:]+):([01])$")
      if type(on_button) == "function" and _k ~= nil then on_button(_k, _p == "1") end
    else
      break
    end
  end
end
if type(on_stop) == "function" then on_stop() end
`;

export class LuaBackendAdapter implements ScriptBackendAdapter {
  readonly id = 'lua' as const;
  readonly name = 'Lua';
  readonly version = '5.4';
  readonly extension = 'lua';
  readonly fileName = 'main.lua';
  readonly accentColor = '#3b82f6';
  readonly description =
    '标准 Lua 5.4 脚本生成器，支持干净导出（含顶层 on_start/on_run/on_timer 嵌入式 ABI）与沙箱异步事件调试。';

  generate(workspace: Blockly.Workspace): GeneratedCodeResult {
    registerLuaBlockGenerators();

    const prevPrefix = luaGenerator.STATEMENT_PREFIX;
    const prevSuffix = luaGenerator.STATEMENT_SUFFIX;
    const eventDriven = isEventDrivenWorkspace(workspace);

    // --- Pass 1: Clean display/export/board-download code + SourceMap ---
    luaDebugPass = false;
    luaEventDrivenMode = eventDriven;
    luaEmittedTimerDispatch = false;
    luaEmittedButtonDispatch = false;
    luaDeclaredLocalsByRoot = new Map();
    luaGenerator.STATEMENT_PREFIX = `${SENTINEL_START_PREFIX}%1__\n`;
    luaGenerator.STATEMENT_SUFFIX = `${SENTINEL_END_PREFIX}%1__\n`;

    let rawClean = '';
    const varEntries: Array<{ label: string; ident: string }> = [];
    const varIdToIdent = new Map<string, string>();
    try {
      luaGenerator.init(workspace);
      for (const v of workspace.getVariableMap().getAllVariables()) {
        const ident = luaGenerator.getVariableName(v.getId());
        varEntries.push({ label: v.getName(), ident });
        varIdToIdent.set(v.getId(), ident);
      }
      rawClean = luaGenerator.workspaceToCode(workspace);
    } finally {
      luaGenerator.STATEMENT_PREFIX = prevPrefix;
      luaGenerator.STATEMENT_SUFFIX = prevSuffix;
    }

    const { scopes: variableScopes, allLocalEntries } = analyzeWorkspaceScopes(
      workspace,
      varIdToIdent,
    );

    const header = eventDriven
      ? `-- 由 PolyBlock 自动生成 (Target: Lua 5.4 · Event-Driven ABI)\n`
      : `-- 由 PolyBlock 自动生成 (Target: Lua 5.4)\n`;
    const combinedClean = rawClean.trim()
      ? `${header}${rawClean}`
      : `${header}-- 请从左侧拖入积木开始编排`;
    const { code, sourceMap, lineToBlock } = extractSourceMap(combinedClean);

    // --- Pass 2: Instrumented async sandbox debug code ---
    // Include local variable identifiers in __poly_snap: Lua naturally resolves
    // them to the active local inside their scope and nil (omitted by pairs) outside!
    const snapEntries = [...varEntries];
    const seenSnapLabels = new Set(varEntries.map((e) => e.label));
    for (const loc of allLocalEntries) {
      if (!seenSnapLabels.has(loc.label)) {
        seenSnapLabels.add(loc.label);
        snapEntries.push(loc);
      }
    }
    const snapExpr = buildLuaSnapshotExpr(snapEntries);
    let debugBody = '';
    try {
      luaDebugPass = true;
      luaEventDrivenMode = eventDriven;
      luaEmittedTimerDispatch = false;
      luaEmittedButtonDispatch = false;
      luaDeclaredLocalsByRoot = new Map();
      luaGenerator.STATEMENT_PREFIX = `__poly_step(%1, __poly_snap(${snapExpr})):await()\n`;
      luaGenerator.STATEMENT_SUFFIX = null;
      debugBody = luaGenerator.workspaceToCode(workspace);
    } finally {
      luaDebugPass = false;
      luaEventDrivenMode = false;
      luaGenerator.STATEMENT_PREFIX = prevPrefix;
      luaGenerator.STATEMENT_SUFFIX = prevSuffix;
    }

    const driver = eventDriven ? LUA_EVENT_LOOP_DRIVER : '';
    const debugCode = debugBody.trim()
      ? `${debugBody}\n${driver}\n__poly_final_snap(__poly_snap(${snapExpr}))\n`
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
      variableScopes,
      isEventDriven: eventDriven,
    };
  }
}
