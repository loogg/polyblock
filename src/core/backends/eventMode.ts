import type * as Blockly from 'blockly';
import type { RuntimeHandle, ScriptLanguageId } from '../../types/project';
import {
  getActiveHandleScriptId,
  getActiveHandleScripts,
  getActiveHandleSharedFunctions,
  getActiveHandleSharedVariables,
  isCurrentHandleScriptEntry,
  type ActiveHandleScriptMeta,
  type DeclaredFunctionMeta,
  type DispatchBranchMeta,
} from '../blocks/timerConfigBridge';
import { extensionRegistry } from '../extensions/registry';
import { collectHandleSharedVariableNames } from '../projects/handleVariables';
import { sanitizeLocalIdent } from './scopeAnalysis';

export const CORE_TOP_HAT_TYPES = new Set<string>([
  'poly_on_start',
  'poly_require_script',
  'procedures_defnoreturn',
  'procedures_defreturn',
]);

/** Returns true if a block type is a valid top-level hat (core entry/require/procedure OR any declarative extension hat). */
export function isValidTopHatType(blockType: string): boolean {
  return (
    CORE_TOP_HAT_TYPES.has(blockType) ||
    extensionRegistry.isDeclarativeHatBlock(blockType)
  );
}

/**
 * Extracts declared top-level global callback names (e.g. 'on_start', 'on_run', 'on_timer'),
 * required sibling script names, and extracted Scheme A dispatch branches (`on_timer_0`, etc.)
 * directly from a serialized Blockly workspace JSON.
 */
export function inspectWorkspaceScriptMeta(
  workspaceJson: Record<string, unknown>,
  scriptId = '',
  scriptName = '',
): {
  declaredEvents: string[];
  requiredScripts: string[];
  dispatchBranches: DispatchBranchMeta[];
  declaredVariables: string[];
  declaredFunctions: DeclaredFunctionMeta[];
} {
  const declared = new Set<string>();
  const required = new Set<string>();
  const dispatchBranches: DispatchBranchMeta[] = [];
  const declaredFunctions: DeclaredFunctionMeta[] = [];
  const usedFnNames = new Set<string>();
  const declaredVariables = new Set<string>();

  // Map Blockly variable id -> user variable name from workspaceJson.variables
  const varNameById = new Map<string, string>();
  const rawVars = workspaceJson?.variables;
  if (Array.isArray(rawVars)) {
    for (const v of rawVars) {
      if (v && typeof v === 'object') {
        const vo = v as Record<string, unknown>;
        const id = typeof vo.id === 'string' ? vo.id : '';
        const name = typeof vo.name === 'string' ? vo.name.trim() : '';
        if (id && name) varNameById.set(id, name);
      }
    }
  }

  const blocksContainer = workspaceJson?.blocks as
    | { blocks?: Array<Record<string, unknown>> }
    | undefined;
  const topList = Array.isArray(blocksContainer?.blocks)
    ? blocksContainer.blocks
    : [];

  topList.forEach((top, idx) => {
    if (!top || top.enabled === false) return;
    const t = String(top.type ?? '');
    if (t === 'poly_on_start') {
      declared.add('on_start');
      return;
    }
    if (t === 'procedures_defnoreturn' || t === 'procedures_defreturn') {
      const fields =
        top.fields && typeof top.fields === 'object'
          ? (top.fields as Record<string, unknown>)
          : {};
      const fnName = String(fields.NAME ?? '').trim();
      if (fnName) {
        const extra = top.extraState as
          | { params?: Array<{ name?: string }> }
          | undefined;
        const params = Array.isArray(extra?.params)
          ? extra.params
              .map((p) => (typeof p?.name === 'string' ? p.name.trim() : ''))
              .filter(Boolean)
          : [];
        declaredFunctions.push({
          name: fnName,
          params,
          hasReturn: t === 'procedures_defreturn',
          scriptId,
          scriptName,
        });
      }
      return;
    }
    const hatDef = extensionRegistry.getHatBlockDef(t);
    if (!hatDef) return;
    declared.add(hatDef.hat.eventName);

    if (hatDef.hat.mode === 'dispatch') {
      const fields =
        top.fields && typeof top.fields === 'object'
          ? (top.fields as Record<string, unknown>)
          : {};
      const info = extensionRegistry.renderExtractedDispatchBranchFromFields(
        t,
        fields,
        idx,
      );
      if (info) {
        let fnName = info.baseFnName;
        let dupIdx = 2;
        while (usedFnNames.has(fnName)) {
          fnName = `${info.baseFnName}_${dupIdx}`;
          dupIdx += 1;
        }
        usedFnNames.add(fnName);
        dispatchBranches.push({
          blockType: info.blockType,
          eventName: info.eventName,
          fnPrefix: info.fnPrefix,
          fnName,
          dupKey: info.dupKey,
          params: info.params,
          passParams: info.passParams,
          alwaysExtract: info.alwaysExtract,
          conditionLua: info.conditionLua,
          conditionPython: info.conditionPython,
          commentLua: info.commentLua,
          commentPython: info.commentPython,
          scriptId,
          scriptName,
        });
      }
    }
  });

  // Deep scan for `poly_require_script` and actively referenced workspace variables
  // (excluding formal parameter names inside procedure definitions).
  const recordVarField = (rawField: unknown, excludedParams: Set<string>) => {
    if (!rawField) return;
    let resolvedName = '';
    if (typeof rawField === 'object') {
      const fo = rawField as Record<string, unknown>;
      if (typeof fo.name === 'string' && fo.name.trim()) {
        resolvedName = fo.name.trim();
      } else if (typeof fo.id === 'string' && varNameById.has(fo.id)) {
        resolvedName = varNameById.get(fo.id)!;
      }
    } else if (typeof rawField === 'string' && varNameById.has(rawField)) {
      resolvedName = varNameById.get(rawField)!;
    }
    if (resolvedName && !excludedParams.has(resolvedName)) {
      declaredVariables.add(resolvedName);
    }
  };

  const visit = (node: unknown, excludedParams: Set<string>) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, excludedParams);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.enabled === false) return;

    let nextExcluded = excludedParams;
    if (
      obj.type === 'procedures_defnoreturn' ||
      obj.type === 'procedures_defreturn'
    ) {
      const extra = obj.extraState as
        | { params?: Array<{ name?: string }> }
        | undefined;
      if (Array.isArray(extra?.params) && extra.params.length > 0) {
        nextExcluded = new Set(excludedParams);
        for (const p of extra.params) {
          if (typeof p?.name === 'string' && p.name.trim()) {
            nextExcluded.add(p.name.trim());
          }
        }
      }
    }

    const fields = obj.fields as Record<string, unknown> | undefined;
    if (obj.type === 'poly_require_script') {
      const targetName = String(fields?.SCRIPT ?? '').trim();
      if (targetName) required.add(targetName);
    }
    if (fields) {
      if (fields.VAR !== undefined) recordVarField(fields.VAR, nextExcluded);
      if (fields.LIST !== undefined) recordVarField(fields.LIST, nextExcluded);
    }

    if (obj.inputs && typeof obj.inputs === 'object') {
      for (const v of Object.values(obj.inputs as Record<string, unknown>)) {
        visit(v, nextExcluded);
      }
    }
    if (obj.next) visit(obj.next, nextExcluded);
    if (obj.block) visit(obj.block, nextExcluded);
  };
  visit(topList, new Set<string>());

  return {
    declaredEvents: Array.from(declared),
    requiredScripts: Array.from(required),
    dispatchBranches,
    declaredVariables: Array.from(declaredVariables),
    declaredFunctions,
  };
}

/** Single-source-of-truth helper building ActiveHandleScriptMeta[] for every script in a handle. */
export function buildHandleScriptsMeta(
  handle: RuntimeHandle,
): ActiveHandleScriptMeta[] {
  return handle.scripts.map((s) => {
    const meta = inspectWorkspaceScriptMeta(s.workspace, s.id, s.name);
    return {
      id: s.id,
      name: s.name,
      isEntry: s.id === handle.entryScriptId,
      declaredEvents: meta.declaredEvents,
      requiredScripts: meta.requiredScripts,
      dispatchBranches: meta.dispatchBranches,
      declaredVariables: meta.declaredVariables,
      declaredFunctions: meta.declaredFunctions,
    };
  });
}

/**
 * Resolves all cross-file shared custom functions defined across every script in the active handle
 * (merging live procedures from `liveWorkspace` for the current script).
 */
export function collectHandleSharedFunctionEntries(
  scriptsMeta: ActiveHandleScriptMeta[],
  explicitSharedFnNames?: string[] | null,
  liveWorkspace?: Blockly.Workspace,
  liveScriptId?: string | null,
): DeclaredFunctionMeta[] {
  const sharedNames =
    explicitSharedFnNames !== undefined
      ? explicitSharedFnNames
      : getActiveHandleSharedFunctions();
  if (!sharedNames || sharedNames.length === 0) return [];
  const sharedSet = new Set(sharedNames);
  const currentId = liveScriptId ?? getActiveHandleScriptId();
  const out: DeclaredFunctionMeta[] = [];

  for (const scr of scriptsMeta) {
    if (liveWorkspace && currentId && scr.id === currentId) {
      for (const top of liveWorkspace.getTopBlocks(true)) {
        if (top.isShadow() || !top.isEnabled()) continue;
        if (
          top.type !== 'procedures_defnoreturn' &&
          top.type !== 'procedures_defreturn'
        ) {
          continue;
        }
        const proc = top as Blockly.Block & {
          getProcedureDef?: () => [string, string[], boolean];
        };
        const def = proc.getProcedureDef?.();
        const name = (def?.[0] ?? String(top.getFieldValue('NAME') || '')).trim();
        if (name && sharedSet.has(name)) {
          out.push({
            name,
            params: Array.isArray(def?.[1]) ? [...def[1]] : [],
            hasReturn: top.type === 'procedures_defreturn',
            scriptId: scr.id,
            scriptName: scr.name,
          });
        }
      }
    } else {
      for (const fn of scr.declaredFunctions ?? []) {
        if (sharedSet.has(fn.name)) {
          out.push(fn);
        }
      }
    }
  }
  return out;
}

/** Collects non-parameter workspace variable names actively used by enabled blocks in a live workspace. */
function collectLiveWorkspaceVariableNames(
  workspace: Blockly.Workspace,
): string[] {
  const used = new Set<string>();
  const varMap = workspace.getVariableMap();

  const getEnclosingProcedureParams = (blk: Blockly.Block): Set<string> => {
    const params = new Set<string>();
    let cur: Blockly.Block | null = blk;
    while (cur) {
      if (
        cur.type === 'procedures_defnoreturn' ||
        cur.type === 'procedures_defreturn'
      ) {
        const proc = cur as Blockly.Block & {
          getProcedureDef?: () => [string, string[], boolean];
        };
        const def = proc.getProcedureDef?.();
        if (def && Array.isArray(def[1])) {
          for (const p of def[1]) params.add(p);
        }
      }
      cur = cur.getSurroundParent();
    }
    return params;
  };

  for (const blk of workspace.getAllBlocks(false)) {
    if (blk.isShadow() || !blk.isEnabled()) continue;
    const varFieldNames = ['VAR', 'LIST'];
    let paramsCache: Set<string> | null = null;
    for (const fName of varFieldNames) {
      if (!blk.getField(fName)) continue;
      const rawVal = blk.getFieldValue(fName);
      if (!rawVal) continue;
      const model = varMap.getVariableById(String(rawVal));
      if (!model) continue;
      const vName = model.getName().trim();
      if (!vName) continue;
      if (!paramsCache) paramsCache = getEnclosingProcedureParams(blk);
      if (!paramsCache.has(vName)) {
        used.add(vName);
      }
    }
  }
  return Array.from(used);
}

export interface HandlePythonSharedVarsInfo {
  /** Safe collision-free Python module name (usually `shared`). */
  moduleName: string;
  /** Sorted cross-file shared variables mapped to deterministic Python attributes. */
  entries: Array<{ name: string; attr: string }>;
}

/**
 * Resolves the authoritative cross-file shared variables for the active RuntimeHandle:
 * 1. Explicit `explicitSharedNames` (passed directly when building for a `RuntimeHandle`),
 * 2. Active bridge list `getActiveHandleSharedVariables()` (set by workbench / runner / exporter),
 * 3. Legacy fallback (when neither is set, e.g. older standalone tests): variables actively used across >= 2 scripts.
 */
export function resolveHandleSharedPythonVars(
  scriptsMeta: ActiveHandleScriptMeta[],
  liveWorkspace?: Blockly.Workspace,
  liveScriptId?: string | null,
  explicitSharedNames?: string[] | null,
): HandlePythonSharedVarsInfo {
  const activeExplicit =
    explicitSharedNames !== undefined
      ? explicitSharedNames
      : getActiveHandleSharedVariables();

  let sharedNames: string[] = [];
  if (activeExplicit !== null) {
    const seen = new Set<string>();
    for (const raw of activeExplicit) {
      const n = raw.trim();
      if (n && !seen.has(n)) {
        seen.add(n);
        sharedNames.push(n);
      }
    }
  } else if (scriptsMeta.length >= 2) {
    const currentId = liveScriptId ?? getActiveHandleScriptId();
    const varScriptCounts = new Map<string, number>();

    for (const scr of scriptsMeta) {
      const names =
        liveWorkspace && currentId && scr.id === currentId
          ? collectLiveWorkspaceVariableNames(liveWorkspace)
          : scr.declaredVariables ?? [];
      for (const name of new Set(names)) {
        varScriptCounts.set(name, (varScriptCounts.get(name) ?? 0) + 1);
      }
    }

    sharedNames = Array.from(varScriptCounts.entries())
      .filter(([, count]) => count >= 2)
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b));
  }

  if (sharedNames.length === 0) {
    return { moduleName: '', entries: [] };
  }

  const existingScriptNames = new Set(scriptsMeta.map((s) => s.name));
  const moduleName =
    ['shared', '_poly_shared', '_handle_shared'].find(
      (cand) => !existingScriptNames.has(cand),
    ) ?? '_poly_shared_vars';

  const usedAttrs = new Set<string>();
  const entries: Array<{ name: string; attr: string }> = [];
  for (const name of sharedNames) {
    const base = sanitizeLocalIdent(name);
    let attr = base;
    let idx = 2;
    while (usedAttrs.has(attr)) {
      attr = `${base}_${idx}`;
      idx += 1;
    }
    usedAttrs.add(attr);
    entries.push({ name, attr });
  }

  return { moduleName, entries };
}

/**
 * Builds the auto-generated read-only `shared.py` source module for a Python handle whenever
 * the handle has >= 1 explicit cross-file shared variable (`handle.sharedVariables`).
 * Returns `null` when the handle has no cross-file shared variables.
 */
export function buildHandlePythonSharedModule(
  handle: RuntimeHandle,
  liveScriptOverride?: { scriptId: string; workspace: Record<string, unknown> },
): {
  moduleName: string;
  fileName: string;
  entries: Array<{ name: string; attr: string }>;
  pythonSource: string;
} | null {
  const effectiveHandle: RuntimeHandle = liveScriptOverride
    ? {
        ...handle,
        scripts: handle.scripts.map((s) =>
          s.id === liveScriptOverride.scriptId
            ? { ...s, workspace: liveScriptOverride.workspace }
            : s,
        ),
      }
    : handle;
  const metas = buildHandleScriptsMeta(effectiveHandle);
  const explicitShared = collectHandleSharedVariableNames(effectiveHandle);
  const info = resolveHandleSharedPythonVars(
    metas,
    undefined,
    undefined,
    explicitShared,
  );
  if (!info.moduleName || info.entries.length === 0) {
    return null;
  }
  const lines = [
    '# 由 PolyBlock 自动生成的同句柄跨文件共享变量模块（只读）',
    ...info.entries.map((e) => `${e.attr} = None`),
    '',
  ];
  return {
    moduleName: info.moduleName,
    fileName: `${info.moduleName}.py`,
    entries: info.entries,
    pythonSource: lines.join('\n'),
  };
}

function getHandleSiblingScripts() {
  const currentId = getActiveHandleScriptId();
  return getActiveHandleScripts().filter((s) => s.id !== currentId);
}

/** Collects explicitly required sibling script names from a live Blockly workspace. */
function collectLiveRequiredScripts(workspace: Blockly.Workspace): Set<string> {
  const required = new Set<string>();
  for (const blk of workspace.getAllBlocks(false)) {
    if (blk.isShadow() || !blk.isEnabled() || blk.type !== 'poly_require_script') {
      continue;
    }
    const target = String(blk.getFieldValue('SCRIPT') || '').trim();
    if (target) required.add(target);
  }
  return required;
}

function sanitizePyIdent(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '_');
  if (!cleaned) return 'mod';
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * Generates the handle-wide central dispatch router(s) (e.g. `function on_timer(id)` / `def on_timer(id):`)
 * EXCLUSIVELY in the entry script (`main.lua` / `main.py`), aggregating:
 * - Local extracted dispatch branches in the entry script itself
 * - All extracted dispatch branches across every sibling script in the same handle
 *
 * Also returns `autoImports` (e.g. `require("timers")` or `import sys` / `import timers`)
 * ONLY for sibling scripts referenced by the router that were NOT already explicitly loaded via
 * `poly_require_script` in the entry script (so conditional `if cond then require("timers") end` stays intact!).
 */
export function buildEntryDispatchRouters(
  workspace: Blockly.Workspace,
  language: ScriptLanguageId,
  debugPass: boolean,
): { autoImports: string[]; routerCode: string } {
  if (!isCurrentHandleScriptEntry()) {
    return { autoImports: [], routerCode: '' };
  }

  interface AggregatedBranch extends DispatchBranchMeta {
    isLocal: boolean;
  }

  const allBranches: AggregatedBranch[] = [];
  const localUsedFnNames = new Set<string>();
  const currentId = getActiveHandleScriptId() ?? 'entry';
  const currentMeta = getActiveHandleScripts().find((s) => s.id === currentId);
  const currentName = currentMeta?.name ?? 'main';

  // 1. Collect live extracted dispatch branches from the current (entry) workspace
  const topBlocks = workspace.getTopBlocks(true);
  topBlocks.forEach((blk, idx) => {
    if (blk.isShadow() || !blk.isEnabled()) return;
    const info = extensionRegistry.renderExtractedDispatchBranchFromBlock(blk, idx);
    if (!info) return;
    let fnName = info.baseFnName;
    let dupIdx = 2;
    while (localUsedFnNames.has(fnName)) {
      fnName = `${info.baseFnName}_${dupIdx}`;
      dupIdx += 1;
    }
    localUsedFnNames.add(fnName);
    allBranches.push({
      blockType: info.blockType,
      eventName: info.eventName,
      fnPrefix: info.fnPrefix,
      fnName,
      dupKey: info.dupKey,
      params: info.params,
      passParams: info.passParams,
      alwaysExtract: info.alwaysExtract,
      conditionLua: info.conditionLua,
      conditionPython: info.conditionPython,
      commentLua: info.commentLua,
      commentPython: info.commentPython,
      scriptId: currentId,
      scriptName: currentName,
      isLocal: true,
    });
  });

  // 2. Collect extracted dispatch branches from all sibling scripts in this handle
  for (const sib of getHandleSiblingScripts()) {
    for (const br of sib.dispatchBranches ?? []) {
      allBranches.push({
        ...br,
        scriptId: sib.id,
        scriptName: sib.name,
        isLocal: false,
      });
    }
  }

  if (allBranches.length === 0) {
    return { autoImports: [], routerCode: '' };
  }

  // Group branches by `eventName` (e.g. 'on_timer', 'on_button', custom dispatch hats)
  const byEvent = new Map<string, AggregatedBranch[]>();
  for (const br of allBranches) {
    const list = byEvent.get(br.eventName) ?? [];
    list.push(br);
    byEvent.set(br.eventName, list);
  }

  // Keep ONLY event groups that route centrally via extracted branch functions:
  // either `alwaysExtract` (e.g. `on_timer`) OR at least one branch lives in a sibling script!
  const routedEvents = new Map<string, AggregatedBranch[]>();
  for (const [evName, list] of byEvent.entries()) {
    if (list.some((b) => b.alwaysExtract || !b.isLocal)) {
      routedEvents.set(evName, list);
    }
  }

  if (routedEvents.size === 0) {
    return { autoImports: [], routerCode: '' };
  }

  const manuallyRequired = collectLiveRequiredScripts(workspace);
  const autoImports: string[] = [];
  const autoImportSet = new Set<string>();
  const addImport = (line: string) => {
    if (!autoImportSet.has(line)) {
      autoImportSet.add(line);
      autoImports.push(line);
    }
  };

  let hasAnySiblingBranch = false;
  for (const list of routedEvents.values()) {
    for (const br of list) {
      if (!br.isLocal) {
        hasAnySiblingBranch = true;
        if (!manuallyRequired.has(br.scriptName)) {
          if (language === 'lua') {
            addImport(`require(${JSON.stringify(br.scriptName)})`);
          } else {
            addImport(`import ${sanitizePyIdent(br.scriptName)}`);
          }
        }
      }
    }
  }
  if (language === 'python' && hasAnySiblingBranch) {
    addImport('import sys');
  }

  const routerBlocks: string[] = [];
  for (const [eventName, rawBranches] of routedEvents.entries()) {
    // Sort deterministically by numeric dupKey when possible (T0, T1, T2...)
    const sorted = [...rawBranches].sort((a, b) => {
      const na = Number(a.dupKey);
      const nb = Number(b.dupKey);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return a.dupKey.localeCompare(b.dupKey);
    });
    const paramsStr = (sorted[0].params ?? []).join(', ');

    if (language === 'lua') {
      const lines: string[] = [];
      sorted.forEach((br, idx) => {
        const kw = idx === 0 ? 'if' : 'elseif';
        const callArgs = br.passParams ? paramsStr : '';
        const srcTag = br.isLocal
          ? ''
          : br.commentLua
            ? ` (${br.scriptName}.lua)`
            : ` -- ${br.scriptName}.lua`;
        const callLine = br.isLocal
          ? `    ${br.fnName}(${callArgs})`
          : `    if ${br.fnName} then ${br.fnName}(${callArgs}) end`;
        lines.push(`  ${kw} ${br.conditionLua} then${br.commentLua}${srcTag}\n${callLine}`);
      });
      routerBlocks.push(
        `function ${eventName}(${paramsStr})\n${lines.join('\n')}\n  end\nend\n`,
      );
    } else {
      const defKw = debugPass ? 'async def' : 'def';
      const lines: string[] = [];
      sorted.forEach((br, idx) => {
        const kw = idx === 0 ? 'if' : 'elif';
        const callArgs = br.passParams ? paramsStr : '';
        const srcTag = br.isLocal
          ? ''
          : br.commentPython
            ? ` (${br.scriptName}.py)`
            : `  # ${br.scriptName}.py`;
        if (br.isLocal) {
          const callExpr = debugPass
            ? `await ${br.fnName}(${callArgs})`
            : `${br.fnName}(${callArgs})`;
          lines.push(`  ${kw} ${br.conditionPython}:${br.commentPython}${srcTag}\n    ${callExpr}`);
        } else {
          const modKey = JSON.stringify(sanitizePyIdent(br.scriptName));
          if (debugPass) {
            lines.push(
              `  ${kw} ${br.conditionPython}:${br.commentPython}${srcTag}\n` +
                `    _m = sys.modules.get(${modKey})\n` +
                `    if _m and hasattr(_m, ${JSON.stringify(br.fnName)}):\n` +
                `      _ret = getattr(_m, ${JSON.stringify(br.fnName)})(${callArgs})\n` +
                `      if hasattr(_ret, 'send'):\n` +
                `        await _ret`,
            );
          } else {
            lines.push(
              `  ${kw} ${br.conditionPython}:${br.commentPython}${srcTag}\n` +
                `    _m = sys.modules.get(${modKey})\n` +
                `    if _m and hasattr(_m, ${JSON.stringify(br.fnName)}):\n` +
                `      _m.${br.fnName}(${callArgs})`,
            );
          }
        }
      });
      routerBlocks.push(`${defKw} ${eventName}(${paramsStr}):\n${lines.join('\n')}\n`);
    }
  }

  return {
    autoImports,
    routerCode: routerBlocks.join('\n'),
  };
}

/**
 * Pure hat-driven event-loop detection across the entire handle:
 * Returns true whenever ANY script in the active handle (current workspace OR any sibling
 * script in the same handle) contains a declarative `kind: 'hat'` callback block.
 */
export function isEventDrivenWorkspace(workspace: Blockly.Workspace): boolean {
  for (const blk of workspace.getTopBlocks(true)) {
    if (blk.isShadow() || !blk.isEnabled()) continue;
    if (extensionRegistry.isDeclarativeHatBlock(blk.type)) {
      return true;
    }
  }
  for (const sib of getHandleSiblingScripts()) {
    if (sib.declaredEvents.some((ev) => ev !== 'on_start')) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if the workspace (or any sibling script in the same handle) defines an external
 * event hat (e.g. `on_button`, `on_drive_estop`, `on_can_rx`) whose `hat.keepsAlive !== false`
 * and is not `on_run` itself.
 */
export function hasExternalKeepAliveHat(workspace: Blockly.Workspace): boolean {
  for (const blk of workspace.getTopBlocks(true)) {
    if (blk.isShadow() || !blk.isEnabled()) continue;
    const hatDef = extensionRegistry.getHatBlockDef(blk.type);
    if (!hatDef) continue;
    if (
      hatDef.hat.eventName !== 'on_run' &&
      hatDef.hat.eventName !== 'on_stop' &&
      hatDef.hat.eventName !== 'on_timer' &&
      hatDef.hat.keepsAlive !== false
    ) {
      return true;
    }
  }
  for (const sib of getHandleSiblingScripts()) {
    if (
      sib.declaredEvents.some(
        (ev) =>
          ev !== 'on_start' &&
          ev !== 'on_run' &&
          ev !== 'on_stop' &&
          ev !== 'on_timer',
      )
    ) {
      return true;
    }
  }
  return false;
}
