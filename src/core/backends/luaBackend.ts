import * as Blockly from 'blockly';
import { luaGenerator, Order } from 'blockly/lua';
import {
  buildLuaHoistedLocalsLine,
  codegenContext,
  resetCodegenPassContext,
} from './codegenContext';
import {
  buildEntryDispatchRouters,
  hasExternalKeepAliveHat,
  isEventDrivenWorkspace,
  resolveHandleSharedPythonVars,
} from './eventMode';
import {
  getActiveHandleScriptId,
  getActiveHandleScripts,
  getActiveHandleSharedFunctions,
} from '../blocks/timerConfigBridge';
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
let luaDeclaredLocalsByRoot = new Map<string, Set<string>>();
let luaSharedFnRequiredScripts = new Set<string>();

function getLuaScopeRootId(block: Blockly.Block): string {
  return block.getRootBlock().id;
}

function getCurrentLuaScriptName(): string {
  const curId = getActiveHandleScriptId();
  if (!curId) return '';
  return getActiveHandleScripts().find((s) => s.id === curId)?.name ?? '';
}

function collectManualRequireScripts(workspace: Blockly.Workspace): Set<string> {
  const out = new Set<string>();
  for (const blk of workspace.getAllBlocks(false)) {
    if (blk.isShadow() || !blk.isEnabled()) continue;
    if (blk.type === 'poly_require_script') {
      const name = String(blk.getFieldValue('SCRIPT') || '').trim();
      if (name) out.add(name);
    }
  }
  return out;
}

function registerLuaBlockGenerators(): void {
  if (luaGeneratorsRegistered) return;

  luaGenerator.forBlock['poly_on_start'] = (block, generator) => {
    const hoistedLocals = buildLuaHoistedLocalsLine([block], 'BODY', '  ');
    const body = generator.statementToCode(block, 'BODY');
    if (codegenContext.debugPass) {
      return `function on_start()\n${hoistedLocals}${body}end\n`;
    }
    return (
      `${SENTINEL_START_PREFIX}'${block.id}'__\n` +
      `function on_start()\n` +
      `${hoistedLocals}${body}` +
      `end\n` +
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
    if (codegenContext.debugPass) {
      return `print("__POLYBLOCK_CLEAR__")\n`;
    }
    return `-- 清空控制台（仅 PolyBlock 沙箱调试生效）\n`;
  };

  luaGenerator.forBlock['poly_repeat_times'] = (block, generator) => {
    const times = generator.valueToCode(block, 'TIMES', Order.NONE) || '0';
    let branch = generator.statementToCode(block, 'DO');
    if (codegenContext.debugPass && !branch.trim()) {
      branch = '  __poly_yield_check()\n';
    }
    return `for _count = 1, ${times} do\n${branch}end\n`;
  };

  luaGenerator.forBlock['poly_for_range'] = (block, generator) => {
    const variableName = generator.getVariableName(block.getFieldValue('VAR'));
    const from = generator.valueToCode(block, 'FROM', Order.NONE) || '1';
    const to = generator.valueToCode(block, 'TO', Order.NONE) || '1';
    const by = generator.valueToCode(block, 'BY', Order.NONE) || '1';
    let branch = generator.statementToCode(block, 'DO');
    if (codegenContext.debugPass && !branch.trim()) {
      branch = '  __poly_yield_check()\n';
    }
    const stepPart = by.trim() === '1' ? '' : `, ${by}`;
    return `for ${variableName} = ${from}, ${to}${stepPart} do\n${branch}end\n`;
  };

  luaGenerator.forBlock['poly_wait_ms'] = (block, generator) => {
    const ms = generator.valueToCode(block, 'MS', Order.NONE) || '0';
    return `sleep_ms(${ms})\n`;
  };

  // Ensure empty `while true do end` loops in debugPass still preempt cleanly inside `on_start` coroutine
  const origWhileUntil = luaGenerator.forBlock['controls_whileUntil'];
  if (origWhileUntil) {
    luaGenerator.forBlock['controls_whileUntil'] = (block, generator) => {
      const code = origWhileUntil(block, generator);
      if (
        codegenContext.debugPass &&
        typeof code === 'string' &&
        !block.getInputTargetBlock('DO')
      ) {
        return code.replace(/do\nend/, 'do\n  __poly_yield_check()\nend');
      }
      return code;
    };
  }

  luaGenerator.forBlock['poly_comment'] = (block) => {
    const text = (block.getFieldValue('TEXT') || '').replace(/\r?\n/g, ' ');
    return `-- ${text}\n`;
  };

  luaGenerator.forBlock['poly_require_script'] = (block) => {
    const scriptName = String(block.getFieldValue('SCRIPT') || 'timers').trim() || 'timers';
    return `require(${JSON.stringify(scriptName)})\n`;
  };

  luaGenerator.forBlock['poly_local_set'] = (block, generator) => {
    const rawName = String(block.getFieldValue('NAME') || 'tmp');
    const ident = sanitizeLocalIdent(rawName);
    const val = generator.valueToCode(block, 'VALUE', Order.NONE) || 'nil';
    const rootId = getLuaScopeRootId(block);
    if (codegenContext.luaHoistedLocalsByRoot.get(rootId)?.has(ident)) {
      return `${ident} = ${val}\n`;
    }
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

  // 2-tier custom functions in Lua + function-top hoisting of nested `poly_local_set`:
  // - Cross-file shared (`handle.sharedFunctions`): global `function foo(...)`
  // - File-private (default): `local function foo(...)` (never pollutes `_G`)
  const origLuaDefReturn = luaGenerator.forBlock['procedures_defreturn'];
  const origLuaDefNoReturn = luaGenerator.forBlock['procedures_defnoreturn'];
  if (origLuaDefReturn) {
    const wrapLuaDef =
      (orig: typeof origLuaDefReturn) =>
      (block: Blockly.Block, generator: typeof luaGenerator) => {
        const hoistedLocals = buildLuaHoistedLocalsLine([block], 'STACK', '  ');
        const out = orig(block, generator);
        const rawName = String(block.getFieldValue('NAME') || '').trim();
        const procIdent = generator.getProcedureName(rawName);
        const defKey = `%${procIdent}`;
        const defs = (
          generator as unknown as { definitions_: Record<string, string> }
        ).definitions_;
        const existing = defs[defKey];
        if (typeof existing === 'string') {
          let nextCode = existing;
          if (hoistedLocals) {
            nextCode = nextCode.replace(
              /(^|\n)((?:local\s+)?function\s+[^\n]+\n)/,
              `$1$2${hoistedLocals}`,
            );
          }
          const sharedFnSet = new Set(getActiveHandleSharedFunctions() ?? []);
          if (!sharedFnSet.has(rawName)) {
            nextCode = nextCode.replace(/(^|\n)function /, '$1local function ');
          }
          defs[defKey] = nextCode;
        }
        return out;
      };
    luaGenerator.forBlock['procedures_defreturn'] = wrapLuaDef(origLuaDefReturn);
    if (origLuaDefNoReturn) {
      luaGenerator.forBlock['procedures_defnoreturn'] = wrapLuaDef(origLuaDefNoReturn);
    }
  }

  const emitLuaSharedFnCall = (
    block: Blockly.Block,
    generator: typeof luaGenerator,
  ): string => {
    const meta = (
      block as Blockly.Block & {
        sharedFnMeta_?: { scriptName: string; fnName: string; params: string[] };
      }
    ).sharedFnMeta_ ?? { scriptName: 'utils', fnName: 'my_func', params: [] };
    const curScriptName = getCurrentLuaScriptName();
    if (meta.scriptName && meta.scriptName !== curScriptName) {
      luaSharedFnRequiredScripts.add(meta.scriptName);
    }
    const fnIdent = generator.getProcedureName(meta.fnName);
    const args = meta.params.map(
      (_p, idx) => generator.valueToCode(block, `ARG${idx}`, Order.NONE) || 'nil',
    );
    return `${fnIdent}(${args.join(', ')})`;
  };

  luaGenerator.forBlock['poly_call_shared_noreturn'] = (block, generator) => {
    return `${emitLuaSharedFnCall(block, generator)}\n`;
  };

  luaGenerator.forBlock['poly_call_shared_return'] = (block, generator) => {
    return [emitLuaSharedFnCall(block, generator), Order.HIGH];
  };

  luaGeneratorsRegistered = true;
}

function collectLuaFileLocalVarIdents(
  workspace: Blockly.Workspace,
  varIdToIdent: Map<string, string>,
  sharedVarNames: Set<string>,
): string[] {
  const varMap = workspace.getVariableMap();
  const FOR_LOOP_TYPES = new Set([
    'poly_for_range',
    'controls_for',
    'controls_forEach',
  ]);

  const isShadowedByAncestor = (blk: Blockly.Block, varId: string, varName: string): boolean => {
    let cur: Blockly.Block | null = blk.getSurroundParent();
    while (cur) {
      if (
        cur.type === 'procedures_defnoreturn' ||
        cur.type === 'procedures_defreturn'
      ) {
        const proc = cur as Blockly.Block & {
          getProcedureDef?: () => [string, string[], boolean];
        };
        const def = proc.getProcedureDef?.();
        if (def && Array.isArray(def[1]) && def[1].includes(varName)) {
          return true;
        }
      }
      if (FOR_LOOP_TYPES.has(cur.type) && String(cur.getFieldValue('VAR') || '') === varId) {
        return true;
      }
      cur = cur.getSurroundParent();
    }
    return false;
  };

  const neededIds = new Set<string>();
  const recordFieldVar = (blk: Blockly.Block, fName: string, rawVal: unknown) => {
    if (fName === 'VAR' && FOR_LOOP_TYPES.has(blk.type)) return;
    const vId = String(rawVal || '');
    if (!vId) return;
    const model = varMap.getVariableById(vId);
    if (!model) return;
    const vName = model.getName();
    if (sharedVarNames.has(vName)) return;
    if (isShadowedByAncestor(blk, vId, vName)) return;
    neededIds.add(vId);
  };

  for (const blk of workspace.getAllBlocks(false)) {
    if (blk.isShadow() || !blk.isEnabled()) continue;
    for (const fName of ['VAR', 'LIST']) {
      if (!blk.getField(fName)) continue;
      recordFieldVar(blk, fName, blk.getFieldValue(fName));
    }
    for (const inp of blk.inputList) {
      for (const field of inp.fieldRow) {
        if (field instanceof Blockly.FieldVariable && field.name) {
          recordFieldVar(blk, field.name, field.getValue());
        }
      }
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of varMap.getAllVariables()) {
    if (!neededIds.has(v.getId())) continue;
    const ident = varIdToIdent.get(v.getId());
    if (ident && !seen.has(ident)) {
      seen.add(ident);
      out.push(ident);
    }
  }
  return out;
}

/** Inserts file-local `local x = nil` declarations cleanly right after top `require(...)` imports. */
function injectLuaFileLocalDecls(body: string, decls: string[]): string {
  if (decls.length === 0) return body;
  const declBlock = decls.join('\n');
  if (!body.trim()) return declBlock;

  const lines = body.split('\n');
  let insertAfter = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (/^(?:local\s+[A-Za-z0-9_]+\s*=\s*)?require\s*\(/.test(trimmed)) {
      insertAfter = i;
      continue;
    }
    break;
  }
  if (insertAfter < 0) {
    return `${declBlock}\n\n${body}`;
  }
  const head = lines.slice(0, insertAfter + 1).join('\n');
  const tail = lines.slice(insertAfter + 1).join('\n').replace(/^\n+/, '');
  return tail ? `${head}\n\n${declBlock}\n\n${tail}` : `${head}\n\n${declBlock}`;
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

function buildLuaEventLoopDriver(keepAliveExternal: boolean): string {
  return `
__poly_event_mode = true
local _has_start = (type(on_start) == "function")
local _has_run = (type(on_run) == "function")
local _has_timer = (type(on_timer) == "function")
local _has_ext = ${keepAliveExternal ? 'true' : '(type(on_button) == "function")'}

if _has_start then
  __poly_start_co = coroutine.create(on_start)
end

local function __poly_call_cb(cbName, fn, ...)
  if type(fn) ~= "function" then return end
  __poly_cb_enter(cbName)
  debug.sethook(function()
    if __poly_is_stop_requested() and cbName ~= "on_stop" then
      error("__POLY_STOP_CB__", 0)
    end
    if __poly_cb_expired() then
      error("事件回调 " .. cbName .. " 执行超时（疑似死循环），已按单次回调超时保护中断。", 2)
    end
  end, "", 4000)
  local _ok, _err = pcall(fn, ...)
  debug.sethook()
  __poly_cb_exit()
  if not _ok and _err ~= "__POLY_STOP_CB__" then
    error(_err, 0)
  end
end

local function __poly_run_start_slice()
  if __poly_start_co == nil or coroutine.status(__poly_start_co) == "dead" then
    __poly_start_co = nil
    __poly_co_done()
    return
  end
  local _slice_ms = __poly_get_time_slice_ms()
  local _slice_wall_start = __poly_now_ms()
  local _empty_checks = 0
  while true do
    local _ok, _tag, _a, _b = coroutine.resume(__poly_start_co)
    if not _ok then
      __poly_start_co = nil
      __poly_co_done()
      error(_tag, 0)
    end
    if coroutine.status(__poly_start_co) == "dead" then
      __poly_start_co = nil
      __poly_co_done()
      return
    end
    if _tag == "__POLY_SLEEP__" then
      __poly_co_sleep(_a or 0)
      return
    elseif _tag == "__POLY_STEP__" then
      __poly_step_start(_a, _b):await()
      if __poly_is_stop_requested() then
        __poly_start_co = nil
        __poly_co_done()
        return
      end
      if (__poly_now_ms() - _slice_wall_start) >= _slice_ms then
        __poly_co_yield_slice()
        return
      end
    elseif _tag == "__POLY_SLICE_CHECK__" then
      _empty_checks = _empty_checks + 1
      if _empty_checks >= 1000 or (__poly_now_ms() - _slice_wall_start) >= _slice_ms then
        __poly_co_yield_slice()
        return
      end
    else
      __poly_co_yield_slice()
      return
    end
  end
end

local function __poly_refresh_handlers()
  __poly_sync_handlers(
    type(on_run) == "function",
    type(on_timer) == "function",
    _has_ext or (type(on_button) == "function")
  )
end

if __poly_init_scheduler(_has_start, _has_run, _has_timer, _has_ext) then
  while true do
    local _ev = __poly_next_event():await()
    if _ev == "start_resume" then
      __poly_run_start_slice()
      __poly_refresh_handlers()
    elseif _ev == "run" then
      __poly_call_cb("on_run", on_run)
      __poly_refresh_handlers()
    elseif type(_ev) == "string" and _ev:sub(1, 6) == "timer:" then
      local _tid = tonumber(_ev:sub(7))
      if _tid ~= nil then __poly_call_cb("on_timer", on_timer, _tid) end
      __poly_refresh_handlers()
    elseif type(_ev) == "string" and _ev:sub(1, 7) == "button:" then
      local _k, _p = _ev:match("^button:([^:]+):([01])$")
      if _k ~= nil then __poly_call_cb("on_button", on_button, _k, _p == "1") end
      __poly_refresh_handlers()
    elseif type(_ev) == "string" and _ev:sub(1, 6) == "event:" then
      local _ename = __poly_last_event_name()
      local _fn = _G[_ename]
      if type(_fn) == "function" then
        local _argc = __poly_last_event_argc()
        if _argc == 0 then __poly_call_cb(_ename, _fn)
        elseif _argc == 1 then __poly_call_cb(_ename, _fn, __poly_last_event_arg(1))
        elseif _argc == 2 then __poly_call_cb(_ename, _fn, __poly_last_event_arg(1), __poly_last_event_arg(2))
        elseif _argc == 3 then __poly_call_cb(_ename, _fn, __poly_last_event_arg(1), __poly_last_event_arg(2), __poly_last_event_arg(3))
        else __poly_call_cb(_ename, _fn, __poly_last_event_arg(1), __poly_last_event_arg(2), __poly_last_event_arg(3), __poly_last_event_arg(4))
        end
      end
      __poly_refresh_handlers()
    else
      break
    end
  end
end
__poly_call_cb("on_stop", on_stop)
`;
}

export class LuaBackendAdapter implements ScriptBackendAdapter {
  readonly id = 'lua' as const;
  readonly name = 'Lua';
  readonly version = '5.4';
  readonly extension = 'lua';
  readonly fileName = 'main.lua';
  readonly accentColor = '#3b82f6';
  readonly description =
    '标准 Lua 5.4 脚本生成器，支持干净导出（含顶层零闭包事件回调 ABI）与沙箱异步事件调试。';

  generate(workspace: Blockly.Workspace): GeneratedCodeResult {
    registerLuaBlockGenerators();

    const prevPrefix = luaGenerator.STATEMENT_PREFIX;
    const prevSuffix = luaGenerator.STATEMENT_SUFFIX;
    const eventDriven = isEventDrivenWorkspace(workspace);
    const keepAliveExternal = hasExternalKeepAliveHat(workspace);

    // --- Pass 1: Clean display/export/board-download code + SourceMap ---
    resetCodegenPassContext({ debugPass: false, eventDrivenMode: eventDriven });
    luaDeclaredLocalsByRoot = new Map();
    luaSharedFnRequiredScripts = new Set();
    const manualRequires = collectManualRequireScripts(workspace);
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

    // 3-tier scope alignment with Python:
    // - Cross-file shared variables (`handle.sharedVariables`): bare `_G` globals (no `local`)
    // - Single-file globals: file-top `local <ident> = nil` upvalues (never leak into `_G`!)
    const sharedLuaInfo = resolveHandleSharedPythonVars(
      getActiveHandleScripts(),
      workspace,
    );
    const sharedLuaNames = new Set(sharedLuaInfo.entries.map((e) => e.name));
    const fileLocalDecls = collectLuaFileLocalVarIdents(
      workspace,
      varIdToIdent,
      sharedLuaNames,
    ).map((ident) => `local ${ident} = nil`);

    const cleanRouter = buildEntryDispatchRouters(workspace, 'lua', false);
    const cleanAutoImports = [...cleanRouter.autoImports];
    for (const sName of luaSharedFnRequiredScripts) {
      if (manualRequires.has(sName)) continue;
      const imp = `require(${JSON.stringify(sName)})`;
      if (!cleanAutoImports.includes(imp)) cleanAutoImports.push(imp);
    }
    const cleanPrepend = cleanAutoImports
      .filter((imp) => !rawClean.includes(imp))
      .join('\n');
    const mergedCleanBody = injectLuaFileLocalDecls(
      [
        cleanPrepend,
        rawClean.trim(),
        cleanRouter.routerCode.trim(),
      ]
        .filter(Boolean)
        .join('\n\n'),
      fileLocalDecls,
    );

    const header = eventDriven
      ? `-- 由 PolyBlock 自动生成 (Target: Lua 5.4 · Event-Driven ABI)\n`
      : `-- 由 PolyBlock 自动生成 (Target: Lua 5.4)\n`;
    const combinedClean = mergedCleanBody
      ? `${header}${mergedCleanBody}\n`
      : `${header}-- 请从左侧拖入积木开始编排`;
    const { code, sourceMap, lineToBlock } = extractSourceMap(combinedClean);

    // --- Pass 2: Instrumented async sandbox debug code ---
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
      resetCodegenPassContext({ debugPass: true, eventDrivenMode: eventDriven });
      luaDeclaredLocalsByRoot = new Map();
      luaSharedFnRequiredScripts = new Set();
      luaGenerator.STATEMENT_PREFIX = `__poly_tick(%1, __poly_snap(${snapExpr}))\n`;
      luaGenerator.STATEMENT_SUFFIX = null;
      debugBody = luaGenerator.workspaceToCode(workspace);
    } finally {
      resetCodegenPassContext({ debugPass: false, eventDrivenMode: false });
      luaGenerator.STATEMENT_PREFIX = prevPrefix;
      luaGenerator.STATEMENT_SUFFIX = prevSuffix;
    }

    const debugRouter = buildEntryDispatchRouters(workspace, 'lua', true);
    const debugAutoImports = [...debugRouter.autoImports];
    for (const sName of luaSharedFnRequiredScripts) {
      if (manualRequires.has(sName)) continue;
      const imp = `require(${JSON.stringify(sName)})`;
      if (!debugAutoImports.includes(imp)) debugAutoImports.push(imp);
    }
    const debugPrepend = debugAutoImports
      .filter((imp) => !debugBody.includes(imp))
      .join('\n');
    const fullDebugBody = injectLuaFileLocalDecls(
      [
        debugPrepend,
        debugBody.trim(),
        debugRouter.routerCode.trim(),
      ]
        .filter(Boolean)
        .join('\n\n'),
      fileLocalDecls,
    );

    const driver = eventDriven
      ? buildLuaEventLoopDriver(keepAliveExternal)
      : `if type(on_start) == "function" then\n  on_start()\nend\n`;
    const debugCode = fullDebugBody
      ? `${fullDebugBody}\n${driver}\n__poly_final_snap(__poly_snap(${snapExpr}))\n`
      : '';
    const moduleDebugCode = fullDebugBody ? `${fullDebugBody}\n` : '';

    return {
      language: this.id,
      code,
      debugCode,
      moduleDebugCode,
      sourceMap,
      lineToBlock,
      diagnostics: analyzeWorkspaceDiagnostics(workspace, 'lua'),
      blockCount: workspace
        .getAllBlocks(false)
        .filter((b) => !b.isShadow()).length,
      variableNames: varEntries.map((v) => v.label),
      variableScopes,
      isEventDriven: eventDriven,
    };
  }
}
