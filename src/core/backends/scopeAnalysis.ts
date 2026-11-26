import * as Blockly from 'blockly';
import type {
  ScopedVariableItem,
  VariableScopeNode,
} from '../../types/project';
import { getActiveHandleSharedVariables } from '../blocks/timerConfigBridge';
import { extensionRegistry } from '../extensions/registry';

const RESERVED_IDENTS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
  'true', 'until', 'while',
  'def', 'class', 'from', 'import', 'as', 'pass', 'None', 'True', 'False',
  'lambda', 'global', 'nonlocal', 'try', 'except', 'finally', 'with', 'yield',
  'async', 'await', 'id', 'key', 'pressed',
]);

/** Converts any user local variable label into a safe Lua/Python identifier. */
export function sanitizeLocalIdent(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed) return '_tmp';
  let cleaned = trimmed.replace(/[^A-Za-z0-9_]/g, '_');
  if (/^[0-9]/.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }
  if (!cleaned || /^_+$/.test(cleaned)) {
    // Deterministic ASCII hash for non-ASCII names (e.g. Chinese)
    let hash = 0;
    for (let i = 0; i < trimmed.length; i++) {
      hash = (hash * 31 + trimmed.charCodeAt(i)) >>> 0;
    }
    return `_loc_${hash.toString(36)}`;
  }
  if (RESERVED_IDENTS.has(cleaned)) {
    return `${cleaned}_v`;
  }
  return cleaned;
}

function describeTopScope(block: Blockly.Block): {
  label: string;
  shortLabel: string;
  category: VariableScopeNode['category'];
} {
  if (block.type === 'poly_on_start') {
    return { label: 'on_start (主启动)', shortLabel: 'on_start', category: 'lifecycle' };
  }
  if (
    block.type === 'procedures_defnoreturn' ||
    block.type === 'procedures_defreturn'
  ) {
    const fnName = String(block.getFieldValue('NAME') || 'func');
    return {
      label: `函数 ${fnName}()`,
      shortLabel: fnName,
      category: 'function',
    };
  }
  const extHatScope = extensionRegistry.renderHatScopeInfo(block);
  if (extHatScope) {
    return extHatScope;
  }
  return { label: '顶层脚本', shortLabel: '顶层', category: 'top' };
}

export interface WorkspaceScopeAnalysis {
  scopes: VariableScopeNode[];
  allLocalEntries: Array<{ label: string; ident: string }>;
}

/**
 * Statically partitions all workspace variables, procedure parameters, and
 * `poly_local_set`/`poly_local_get` locals into a clear Scope Tree:
 *  - Shared Handle Globals (touched across >= 2 scopes, or unused global vars)
 *  - Per-Callback & Per-Function nodes (with local vars, params, and single-scope vars)
 */
export function analyzeWorkspaceScopes(
  workspace: Blockly.Workspace,
  varIdToIdent: Map<string, string>,
): WorkspaceScopeAnalysis {
  const allVars = workspace.getVariableMap().getAllVariables();
  const varNameById = new Map<string, string>();
  for (const v of allVars) {
    varNameById.set(v.getId(), v.getName());
  }

  const topBlocks = workspace
    .getTopBlocks(true)
    .filter((b) => !b.isShadow() && b.isEnabled());

  // Track which top scopes touch each global workspace variable
  const globalUsage = new Map<
    string,
    { scopes: Set<string>; shortLabels: Set<string>; firstBlockId?: string }
  >();
  const localGlobalMap = new Map<string, string>(); // label -> ident

  interface RawScope {
    id: string;
    label: string;
    shortLabel: string;
    category: VariableScopeNode['category'];
    blockId: string;
    params: ScopedVariableItem[];
    locals: Map<string, ScopedVariableItem>;
    globalIdsUsed: Map<string, string>; // varId -> firstBlockId in this scope
  }

  const rawScopes: RawScope[] = [];

  for (const top of topBlocks) {
    const info = describeTopScope(top);
    const scopeId = `scope_${top.id}`;
    const raw: RawScope = {
      id: scopeId,
      label: info.label,
      shortLabel: info.shortLabel,
      category: info.category,
      blockId: top.id,
      params: [],
      locals: new Map(),
      globalIdsUsed: new Map(),
    };

    // Extract procedure parameters if function block
    const paramNames = new Set<string>();
    if (
      top.type === 'procedures_defnoreturn' ||
      top.type === 'procedures_defreturn'
    ) {
      const procBlock = top as Blockly.Block & {
        getProcedureDef?: () => [string, string[], boolean];
      };
      const def = procBlock.getProcedureDef?.();
      if (def && Array.isArray(def[1])) {
        for (const pName of def[1]) {
          paramNames.add(pName);
          const matchingVar = allVars.find((v) => v.getName() === pName);
          const ident =
            (matchingVar && varIdToIdent.get(matchingVar.getId())) ||
            sanitizeLocalIdent(pName);
          raw.params.push({
            name: pName,
            ident,
            kind: 'param',
            firstBlockId: top.id,
          });
        }
        if (def[1].length > 0) {
          raw.label = `函数 ${def[0]}(${def[1].join(', ')})`;
        }
      }
    }

    const descendants = top.getDescendants(true);
    for (const blk of descendants) {
      if (blk.isShadow() || !blk.isEnabled()) continue;

      if (blk.type === 'poly_local_set' || blk.type === 'poly_local_get') {
        const rawLabel = String(blk.getFieldValue('NAME') || 'tmp').trim() || 'tmp';
        const ident = sanitizeLocalIdent(rawLabel);
        localGlobalMap.set(rawLabel, ident);
        if (!raw.locals.has(rawLabel)) {
          raw.locals.set(rawLabel, {
            name: rawLabel,
            ident,
            kind: 'local',
            firstBlockId: blk.id,
          });
        }
        continue;
      }

      // Inspect any Blockly field_variable fields on this block
      for (const input of blk.inputList) {
        for (const field of input.fieldRow) {
          if (field instanceof Blockly.FieldVariable) {
            const varId = field.getValue();
            if (!varId) continue;
            const vName = varNameById.get(varId);
            if (!vName || paramNames.has(vName)) continue;

            if (!raw.globalIdsUsed.has(varId)) {
              raw.globalIdsUsed.set(varId, blk.id);
            }
            let usage = globalUsage.get(varId);
            if (!usage) {
              usage = {
                scopes: new Set(),
                shortLabels: new Set(),
                firstBlockId: blk.id,
              };
              globalUsage.set(varId, usage);
            }
            usage.scopes.add(scopeId);
            usage.shortLabels.add(info.shortLabel);
          }
        }
      }
    }

    rawScopes.push(raw);
  }

  // Partition vars cleanly into 3 tiers:
  // 1) Cross-file Handle Shared (`handle.sharedVariables`)
  // 2) Single-file globals (used across >= 2 callbacks or unused file-scoped vars)
  // 3) Single-callback file vars (shown directly inside that callback's node)
  const explicitSharedSet = new Set(getActiveHandleSharedVariables() ?? []);
  const handleSharedVars: ScopedVariableItem[] = [];
  const fileGlobalVars: ScopedVariableItem[] = [];
  const singleScopeOwner = new Map<string, string>(); // varId -> scopeId

  for (const v of allVars) {
    const vid = v.getId();
    const usage = globalUsage.get(vid);
    const ident = varIdToIdent.get(vid) ?? v.getName();

    // Skip variables that only exist as procedure params
    const isOnlyParam =
      (!usage || usage.scopes.size === 0) &&
      rawScopes.some((s) => s.params.some((p) => p.name === v.getName()));
    if (isOnlyParam) continue;

    if (explicitSharedSet.has(v.getName())) {
      handleSharedVars.push({
        name: v.getName(),
        ident,
        kind: 'shared',
        firstBlockId: usage?.firstBlockId,
        usedInScopes: usage ? Array.from(usage.shortLabels) : undefined,
      });
    } else if (!usage || usage.scopes.size !== 1) {
      fileGlobalVars.push({
        name: v.getName(),
        ident,
        kind: 'scope-global',
        firstBlockId: usage?.firstBlockId,
        usedInScopes: usage ? Array.from(usage.shortLabels) : undefined,
      });
    } else {
      const [onlyScopeId] = Array.from(usage.scopes);
      singleScopeOwner.set(vid, onlyScopeId);
    }
  }

  const scopes: VariableScopeNode[] = [];

  if (handleSharedVars.length > 0) {
    scopes.push({
      id: 'shared',
      label: '跨文件全局 (Handle)',
      category: 'shared',
      variables: handleSharedVars,
    });
  }

  if (fileGlobalVars.length > 0) {
    scopes.push({
      id: 'file_globals',
      label: '单文件全局 (File)',
      category: 'top',
      variables: fileGlobalVars,
    });
  }

  for (const raw of rawScopes) {
    const vars: ScopedVariableItem[] = [...raw.params, ...raw.locals.values()];

    for (const [vid, blkId] of raw.globalIdsUsed.entries()) {
      if (singleScopeOwner.get(vid) === raw.id) {
        const vName = varNameById.get(vid);
        if (vName) {
          vars.push({
            name: vName,
            ident: varIdToIdent.get(vid) ?? vName,
            kind: 'scope-global',
            firstBlockId: blkId,
          });
        }
      }
    }

    // Keep callback/function nodes visible when they have vars OR are event/function scopes
    if (vars.length > 0 || raw.category !== 'top') {
      scopes.push({
        id: raw.id,
        label: raw.label,
        category: raw.category,
        blockId: raw.blockId,
        variables: vars,
      });
    }
  }

  const allLocalEntries = Array.from(localGlobalMap.entries()).map(
    ([label, ident]) => ({ label, ident }),
  );

  return { scopes, allLocalEntries };
}
