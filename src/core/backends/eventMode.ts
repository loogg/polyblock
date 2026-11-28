import type * as Blockly from 'blockly';
import type { RuntimeHandle } from '../../types/project';
import {
  getActiveHandleScriptId,
  getActiveHandleScripts,
  getActiveHandleSharedFunctions,
  getActiveHandleSharedVariables,
  isCurrentHandleScriptEntry,
  type ActiveHandleScriptMeta,
  type DeclaredFunctionMeta,
  type DispatchBranchMeta,
} from '../blocks/workspaceContextBridge';
import { extensionRegistry } from '../extensions/registry';
import type { ExtensionHatSpec } from '../extensions/types';
import { sanitizeLocalIdent } from './scopeAnalysis';
import type { EntryDispatchBranchSpec, ScriptBackendAdapter } from './types';

export interface UnifiedHatSpec {
  eventName: string;
  mode: 'singleton' | 'dispatch';
  params: string[];
  isCoroutine: boolean;
  keepsAlive: boolean;
}

/** Canonical unified hat metadata for core `poly_on_start` (eliminates hardcoded special cases). */
export const CORE_ON_START_HAT_SPEC: UnifiedHatSpec = {
  eventName: 'on_start',
  mode: 'singleton',
  params: [],
  isCoroutine: true,
  keepsAlive: false,
};

/** Single source of truth for hat metadata across core `poly_on_start` and all declarative extension hats. */
export function getUnifiedHatSpec(blockType: string): UnifiedHatSpec | undefined {
  if (blockType === 'poly_on_start') return CORE_ON_START_HAT_SPEC;
  const def = extensionRegistry.getHatBlockDef(blockType);
  if (!def) return undefined;
  const hat: ExtensionHatSpec = def.hat;
  return {
    eventName: hat.eventName,
    mode: hat.mode,
    params: hat.params ?? [],
    isCoroutine: false,
    keepsAlive: hat.keepsAlive !== false,
  };
}

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

function jsonSubtreeUsesWait(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((item) => jsonSubtreeUsesWait(item));
  const obj = node as Record<string, unknown>;
  if (obj.enabled === false) return false;
  if (obj.type === 'poly_wait_ms') return true;
  if (obj.inputs && typeof obj.inputs === 'object') {
    for (const v of Object.values(obj.inputs as Record<string, unknown>)) {
      if (jsonSubtreeUsesWait(v)) return true;
    }
  }
  if (obj.next && jsonSubtreeUsesWait(obj.next)) return true;
  if (obj.block && jsonSubtreeUsesWait(obj.block)) return true;
  return false;
}

function jsonSubtreeCalledProcedures(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) jsonSubtreeCalledProcedures(item, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.enabled === false) return;
  if (
    obj.type === 'procedures_callnoreturn' ||
    obj.type === 'procedures_callreturn'
  ) {
    const extra = obj.extraState as { name?: string } | undefined;
    if (typeof extra?.name === 'string' && extra.name.trim()) {
      out.add(extra.name.trim());
    }
  } else if (
    obj.type === 'poly_call_shared_noreturn' ||
    obj.type === 'poly_call_shared_return'
  ) {
    const extra = obj.extraState as { fnName?: string } | undefined;
    if (typeof extra?.fnName === 'string' && extra.fnName.trim()) {
      out.add(extra.fnName.trim());
    }
  }
  if (obj.inputs && typeof obj.inputs === 'object') {
    for (const v of Object.values(obj.inputs as Record<string, unknown>)) {
      jsonSubtreeCalledProcedures(v, out);
    }
  }
  if (obj.next) jsonSubtreeCalledProcedures(obj.next, out);
  if (obj.block) jsonSubtreeCalledProcedures(obj.block, out);
}

/**
 * Extracts declared top-level callback names, explicitly loaded sibling script names,
 * dispatch branches, referenced variables, and custom procedure metadata from a workspace JSON.
 */
export function inspectWorkspaceScriptMeta(
  workspaceJson: Record<string, unknown>,
  scriptId = '',
  scriptName = '',
): {
  declaredEvents: string[];
  requiredScripts: string[];
  hasExternalKeepAliveHat: boolean;
  dispatchBranches: DispatchBranchMeta[];
  declaredVariables: string[];
  declaredFunctions: DeclaredFunctionMeta[];
} {
  const declared = new Set<string>();
  const required = new Set<string>();
  let hasExternalKeepAlive = false;
  const dispatchBranches: DispatchBranchMeta[] = [];
  const declaredFunctions: DeclaredFunctionMeta[] = [];
  const fnCallGraph = new Map<string, Set<string>>();
  const usedFnNames = new Set<string>();
  const declaredVariables = new Set<string>();

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

  const perTypeIdx = new Map<string, number>();
  topList.forEach((top) => {
    if (!top || top.enabled === false) return;
    const t = String(top.type ?? '');
    const typeIdx = perTypeIdx.get(t) ?? 0;
    perTypeIdx.set(t, typeIdx + 1);
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
        const directWait = jsonSubtreeUsesWait(top);
        const callees = new Set<string>();
        jsonSubtreeCalledProcedures(top, callees);
        fnCallGraph.set(fnName, callees);
        declaredFunctions.push({
          name: fnName,
          params,
          hasReturn: t === 'procedures_defreturn',
          usesSleep: directWait,
          calledProcedures: Array.from(callees),
          scriptId,
          scriptName,
        });
      }
      return;
    }

    const hatSpec = getUnifiedHatSpec(t);
    if (!hatSpec) return;
    declared.add(hatSpec.eventName);
    if (hatSpec.keepsAlive) {
      hasExternalKeepAlive = true;
    }

    if (hatSpec.mode === 'dispatch') {
      const fields =
        top.fields && typeof top.fields === 'object'
          ? (top.fields as Record<string, unknown>)
          : {};
      const info = extensionRegistry.renderExtractedDispatchBranchFromFields(
        t,
        fields,
        typeIdx,
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
          condition: info.condition,
          comment: info.comment,
          scriptId,
          scriptName,
        });
      }
    }
  });

  // Propagate `usesSleep` transitively inside this script's procedures
  const sleepFnNames = new Set(
    declaredFunctions.filter((f) => f.usesSleep).map((f) => f.name),
  );
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const fn of declaredFunctions) {
      if (sleepFnNames.has(fn.name)) continue;
      const callees = fnCallGraph.get(fn.name);
      if (!callees) continue;
      for (const c of callees) {
        if (sleepFnNames.has(c)) {
          sleepFnNames.add(fn.name);
          fn.usesSleep = true;
          propagated = true;
          break;
        }
      }
    }
  }

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
    if (fields && fields.VAR !== undefined) {
      recordVarField(fields.VAR, nextExcluded);
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
    hasExternalKeepAliveHat: hasExternalKeepAlive,
    dispatchBranches,
    declaredVariables: Array.from(declaredVariables),
    declaredFunctions,
  };
}

/** Single-source-of-truth helper building ActiveHandleScriptMeta[] for every script in a handle. */
export function buildHandleScriptsMeta(
  handle: RuntimeHandle,
): ActiveHandleScriptMeta[] {
  const metas: ActiveHandleScriptMeta[] = handle.scripts.map((s) => {
    const meta = inspectWorkspaceScriptMeta(s.workspace, s.id, s.name);
    return {
      id: s.id,
      name: s.name,
      isEntry: s.id === handle.entryScriptId,
      declaredEvents: meta.declaredEvents,
      requiredScripts: meta.requiredScripts,
      hasExternalKeepAliveHat: meta.hasExternalKeepAliveHat,
      dispatchBranches: meta.dispatchBranches,
      declaredVariables: meta.declaredVariables,
      declaredFunctions: meta.declaredFunctions,
    };
  });

  // Handle-wide transitive `usesSleep` fixed-point closure strictly across shared functions
  const sharedFnSet = new Set(
    (handle.sharedFunctions ?? []).map((n) => n.trim()).filter(Boolean),
  );
  const sleepSharedFnNames = new Set<string>();
  for (const scr of metas) {
    for (const fn of scr.declaredFunctions ?? []) {
      if (fn.usesSleep && sharedFnSet.has(fn.name)) {
        sleepSharedFnNames.add(fn.name);
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const scr of metas) {
      for (const fn of scr.declaredFunctions ?? []) {
        if (fn.usesSleep) continue;
        for (const callee of fn.calledProcedures ?? []) {
          if (sleepSharedFnNames.has(callee)) {
            fn.usesSleep = true;
            if (sharedFnSet.has(fn.name)) {
              sleepSharedFnNames.add(fn.name);
            }
            changed = true;
            break;
          }
        }
      }
    }
  }

  return metas;
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

export interface HandleSharedInfo {
  /** Safe collision-free shared module name (usually `shared`). */
  moduleName: string;
  /** Explicit cross-file shared variables mapped to deterministic Lua/Python attributes. */
  entries: Array<{ name: string; attr: string }>;
}

/**
 * Resolves the collision-free `shared` module name and attribute mapping purely from
 * explicit `handle.sharedVariables` (and optional `handle.sharedFunctions` so `moduleName`
 * is still resolved when a handle has shared functions even with zero shared variables!).
 */
export function resolveHandleSharedInfo(
  scriptsMeta: ActiveHandleScriptMeta[],
  explicitSharedNames?: string[] | null,
  explicitSharedFunctions?: string[] | null,
): HandleSharedInfo {
  const activeVars =
    explicitSharedNames !== undefined
      ? explicitSharedNames
      : getActiveHandleSharedVariables();
  const activeFns =
    explicitSharedFunctions !== undefined
      ? explicitSharedFunctions
      : getActiveHandleSharedFunctions();

  const sharedVarNames: string[] = [];
  if (activeVars && activeVars.length > 0) {
    const seen = new Set<string>();
    for (const raw of activeVars) {
      const n = raw.trim();
      if (n && !seen.has(n)) {
        seen.add(n);
        sharedVarNames.push(n);
      }
    }
  }
  const hasSharedFns = Boolean(activeFns && activeFns.some((n) => n.trim()));

  if (sharedVarNames.length === 0 && !hasSharedFns) {
    return { moduleName: '', entries: [] };
  }

  const existingScriptNames = new Set(scriptsMeta.map((s) => s.name));
  const moduleName =
    ['shared', '_poly_shared', '_handle_shared'].find(
      (cand) => !existingScriptNames.has(cand),
    ) ?? '_poly_shared_mod';

  const usedAttrs = new Set<string>();
  const entries: Array<{ name: string; attr: string }> = [];
  for (const name of sharedVarNames) {
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

function getHandleSiblingScripts() {
  const currentId = getActiveHandleScriptId();
  return getActiveHandleScripts().filter((s) => s.id !== currentId);
}

/**
 * Generates the handle-wide central dispatch router(s) (driven by `hat.mode === 'dispatch'`)
 * EXCLUSIVELY in the entry script (`main.<ext>`).
 *
 * Strictly does NOT auto-import ordinary companion scripts at file top — companion scripts
 * must be loaded explicitly by the user via `poly_require_script` (verified by static diagnostics).
 * Uses each language plugin's `adapter.formatDispatchRouter` hook to stay language-agnostic.
 */
export function buildEntryDispatchRouters(
  workspace: Blockly.Workspace,
  adapter: ScriptBackendAdapter,
  debugPass: boolean,
): { autoImports: string[]; routerCode: string } {
  if (!isCurrentHandleScriptEntry()) {
    return { autoImports: [], routerCode: '' };
  }

  const allBranches: EntryDispatchBranchSpec[] = [];
  const localUsedFnNames = new Set<string>();
  const currentId = getActiveHandleScriptId() ?? 'entry';
  const currentMeta = getActiveHandleScripts().find((s) => s.id === currentId);
  const currentName = currentMeta?.name ?? 'main';

  const topBlocks = workspace.getTopBlocks(true);
  const perTypeIdx = new Map<string, number>();
  topBlocks.forEach((blk) => {
    if (blk.isShadow() || !blk.isEnabled()) return;
    const typeIdx = perTypeIdx.get(blk.type) ?? 0;
    perTypeIdx.set(blk.type, typeIdx + 1);
    const info = extensionRegistry.renderExtractedDispatchBranchFromBlock(blk, typeIdx);
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
      condition: info.condition,
      comment: info.comment,
      scriptId: currentId,
      scriptName: currentName,
      isLocal: true,
    });
  });

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

  const byEvent = new Map<string, EntryDispatchBranchSpec[]>();
  for (const br of allBranches) {
    const list = byEvent.get(br.eventName) ?? [];
    list.push(br);
    byEvent.set(br.eventName, list);
  }

  const routedEvents = new Map<string, EntryDispatchBranchSpec[]>();
  for (const [evName, list] of byEvent.entries()) {
    if (list.some((b) => b.alwaysExtract || !b.isLocal)) {
      routedEvents.set(evName, list);
    }
  }

  if (routedEvents.size === 0) {
    return { autoImports: [], routerCode: '' };
  }

  const autoImportSet = new Set<string>();
  const routerBlocks: string[] = [];
  for (const [eventName, rawBranches] of routedEvents.entries()) {
    // Sort deterministically by numeric dupKey when possible (T0, T1, T2...)
    const sorted = [...rawBranches].sort((a, b) => {
      const na = Number(a.dupKey);
      const nb = Number(b.dupKey);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return a.dupKey.localeCompare(b.dupKey);
    });
    const formatted = adapter.formatDispatchRouter(eventName, sorted, debugPass);
    for (const imp of formatted.autoImports) {
      autoImportSet.add(imp);
    }
    if (formatted.code) {
      routerBlocks.push(formatted.code);
    }
  }

  return {
    autoImports: Array.from(autoImportSet),
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
 * Pure metadata-driven check across the entire handle:
 * Returns true whenever ANY script in the active handle defines a hat whose `hat.keepsAlive` is true
 * (e.g. `on_button`, `on_drive_estop`, `on_can_rx`). Zero hardcoded event-name exclusions!
 */
export function hasExternalKeepAliveHat(workspace: Blockly.Workspace): boolean {
  for (const blk of workspace.getTopBlocks(true)) {
    if (blk.isShadow() || !blk.isEnabled()) continue;
    if (getUnifiedHatSpec(blk.type)?.keepsAlive) {
      return true;
    }
  }
  for (const sib of getHandleSiblingScripts()) {
    if (sib.hasExternalKeepAliveHat) {
      return true;
    }
  }
  return false;
}
