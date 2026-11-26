import type * as Blockly from 'blockly';
import type { RuntimeHandle, ScriptLanguageId } from '../../types/project';
import {
  getActiveHandleScriptId,
  getActiveHandleScripts,
  isCurrentHandleScriptEntry,
  type ActiveHandleScriptMeta,
  type DispatchBranchMeta,
} from '../blocks/timerConfigBridge';
import { extensionRegistry } from '../extensions/registry';

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
} {
  const declared = new Set<string>();
  const required = new Set<string>();
  const dispatchBranches: DispatchBranchMeta[] = [];
  const usedFnNames = new Set<string>();

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
    const hatDef = extensionRegistry.getHatBlockDef(t);
    if (!hatDef) return;
    declared.add(hatDef.hat.eventName);

    if (hatDef.hat.mode === 'dispatch' && hatDef.hat.extractBranchFnPrefix) {
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

  // Deep scan for `poly_require_script` anywhere inside top-level or `on_start`
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.enabled === false) return;
    if (obj.type === 'poly_require_script') {
      const fields = obj.fields as Record<string, unknown> | undefined;
      const targetName = String(fields?.SCRIPT ?? '').trim();
      if (targetName) required.add(targetName);
    }
    if (obj.inputs && typeof obj.inputs === 'object') {
      for (const v of Object.values(obj.inputs as Record<string, unknown>)) {
        visit(v);
      }
    }
    if (obj.next) visit(obj.next);
    if (obj.block) visit(obj.block);
  };
  visit(topList);

  return {
    declaredEvents: Array.from(declared),
    requiredScripts: Array.from(required),
    dispatchBranches,
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
    };
  });
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

  // Group branches by `eventName` (e.g. 'on_timer')
  const byEvent = new Map<string, AggregatedBranch[]>();
  for (const br of allBranches) {
    const list = byEvent.get(br.eventName) ?? [];
    list.push(br);
    byEvent.set(br.eventName, list);
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
  for (const br of allBranches) {
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
  if (language === 'python' && hasAnySiblingBranch) {
    addImport('import sys');
  }

  const routerBlocks: string[] = [];
  for (const [eventName, rawBranches] of byEvent.entries()) {
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
        const srcTag = br.isLocal
          ? ''
          : br.commentLua
            ? ` (${br.scriptName}.lua)`
            : ` -- ${br.scriptName}.lua`;
        const callLine = br.isLocal
          ? `    ${br.fnName}()`
          : `    if ${br.fnName} then ${br.fnName}() end`;
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
        const srcTag = br.isLocal
          ? ''
          : br.commentPython
            ? ` (${br.scriptName}.py)`
            : `  # ${br.scriptName}.py`;
        if (br.isLocal) {
          const callExpr = debugPass ? `await ${br.fnName}()` : `${br.fnName}()`;
          lines.push(`  ${kw} ${br.conditionPython}:${br.commentPython}${srcTag}\n    ${callExpr}`);
        } else {
          const modKey = JSON.stringify(sanitizePyIdent(br.scriptName));
          if (debugPass) {
            lines.push(
              `  ${kw} ${br.conditionPython}:${br.commentPython}${srcTag}\n` +
                `    _m = sys.modules.get(${modKey})\n` +
                `    if _m and hasattr(_m, ${JSON.stringify(br.fnName)}):\n` +
                `      _ret = getattr(_m, ${JSON.stringify(br.fnName)})()\n` +
                `      if hasattr(_ret, 'send'):\n` +
                `        await _ret`,
            );
          } else {
            lines.push(
              `  ${kw} ${br.conditionPython}:${br.commentPython}${srcTag}\n` +
                `    _m = sys.modules.get(${modKey})\n` +
                `    if _m and hasattr(_m, ${JSON.stringify(br.fnName)}):\n` +
                `      _m.${br.fnName}()`,
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
