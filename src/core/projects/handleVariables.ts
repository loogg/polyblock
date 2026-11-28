import type {
  RuntimeHandle,
  VariableInitialValue,
} from '../../types/project';
import { backendRegistry } from '../backends/registry';
import { extensionRegistry } from '../extensions/registry';

export type VariableScopeKind = 'shared' | 'file';

export type HandleVariableMutation =
  | {
      kind: 'create';
      name: string;
      scope: VariableScopeKind;
      initialValue?: VariableInitialValue;
    }
  | { kind: 'rename'; oldName: string; newName: string }
  | { kind: 'delete'; name: string }
  | {
      kind: 'set-initial';
      name: string;
      scope: VariableScopeKind;
      initialValue: VariableInitialValue;
    };

export function normalizeVariableInitialValue(
  raw?: VariableInitialValue | null,
): VariableInitialValue {
  if (!raw || typeof raw !== 'object') return { kind: 'null' };
  switch (raw.kind) {
    case 'number':
      return {
        kind: 'number',
        value: Number.isFinite(Number(raw.value)) ? Number(raw.value) : 0,
      };
    case 'boolean':
      return { kind: 'boolean', value: Boolean(raw.value) };
    case 'string':
      return { kind: 'string', value: String(raw.value ?? '') };
    case 'list':
      return { kind: 'list' };
    case 'dict':
      return { kind: 'dict' };
    default:
      return { kind: 'null' };
  }
}

interface SerializedVarEntry {
  id: string;
  name: string;
  type?: string;
}

const EXTRA_RESERVED_MODULE_IDENTS = new Set([
  'shared',
  'module',
  'exports',
  'require',
]);

function isReservedVarName(name: string): boolean {
  if (EXTRA_RESERVED_MODULE_IDENTS.has(name)) return true;
  for (const dialect of backendRegistry.listDialects()) {
    if (dialect.keywords.includes(name)) return true;
  }
  for (const pack of extensionRegistry.listAllWithLocal()) {
    if (pack.sandboxMock?.moduleName === name) return true;
    for (const lib of pack.libs ?? []) {
      if (lib.moduleName === name) return true;
    }
  }
  return false;
}

export function validateSharedVariableName(
  rawName: string,
  existingNames: string[],
  ignoreName?: string,
  scopeLabel = '变量',
): { valid: true; trimmed: string } | { valid: false; error: string } {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return { valid: false, error: `请输入${scopeLabel}名称` };
  }
  if (/^[0-9]/.test(trimmed)) {
    return {
      valid: false,
      error: `${scopeLabel}名不能以数字开头，请使用字母、下划线或中文（如 count、步数）`,
    };
  }
  if (!/^[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*$/.test(trimmed)) {
    return {
      valid: false,
      error: '仅支持中文、英文字母、数字和下划线（不能包含空格或标点符号）',
    };
  }
  if (isReservedVarName(trimmed)) {
    return {
      valid: false,
      error: `「${trimmed}」是语言关键字或保留模块名，请换一个名称`,
    };
  }
  if (
    trimmed !== ignoreName &&
    existingNames.some((n) => n.trim() === trimmed)
  ) {
    return {
      valid: false,
      error: `${scopeLabel}「${trimmed}」已存在，请换一个名称`,
    };
  }
  return { valid: true, trimmed };
}

function readSerializedVars(
  workspaceJson: Record<string, unknown>,
): SerializedVarEntry[] {
  const raw = workspaceJson?.variables;
  if (!Array.isArray(raw)) return [];
  const out: SerializedVarEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : '';
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!id || !name) continue;
    out.push({
      id,
      name,
      ...(typeof obj.type === 'string' && obj.type ? { type: obj.type } : {}),
    });
  }
  return out;
}

function makeStableSharedVarId(name: string, existingIds: Set<string>): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  const safeSlug = name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 12);
  const base = `hvar_${safeSlug ? `${safeSlug}_` : ''}${hash.toString(36)}`;
  let id = base;
  let idx = 2;
  while (existingIds.has(id)) {
    id = `${base}_${idx}`;
    idx += 1;
  }
  existingIds.add(id);
  return id;
}

/** Collects non-parameter workspace variable names actively referenced by enabled blocks in a workspace JSON. */
export function collectUsedVariableNamesInJson(
  workspaceJson: Record<string, unknown>,
): string[] {
  const used = new Set<string>();
  const varNameById = new Map<string, string>();
  for (const v of readSerializedVars(workspaceJson)) {
    varNameById.set(v.id, v.name);
  }

  const blocksContainer = workspaceJson?.blocks as
    | { blocks?: Array<Record<string, unknown>> }
    | undefined;
  const topList = Array.isArray(blocksContainer?.blocks)
    ? blocksContainer.blocks
    : [];

  const recordField = (rawField: unknown, excluded: Set<string>) => {
    if (!rawField) return;
    let name = '';
    if (typeof rawField === 'object') {
      const fo = rawField as Record<string, unknown>;
      if (typeof fo.name === 'string' && fo.name.trim()) name = fo.name.trim();
      else if (typeof fo.id === 'string' && varNameById.has(fo.id)) {
        name = varNameById.get(fo.id)!;
      }
    } else if (typeof rawField === 'string' && varNameById.has(rawField)) {
      name = varNameById.get(rawField)!;
    }
    if (name && !excluded.has(name)) used.add(name);
  };

  const visit = (node: unknown, excluded: Set<string>) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, excluded);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.enabled === false) return;

    let nextExcluded = excluded;
    if (
      obj.type === 'procedures_defnoreturn' ||
      obj.type === 'procedures_defreturn'
    ) {
      const extra = obj.extraState as
        | { params?: Array<{ name?: string }> }
        | undefined;
      if (Array.isArray(extra?.params) && extra.params.length > 0) {
        nextExcluded = new Set(excluded);
        for (const p of extra.params) {
          if (typeof p?.name === 'string' && p.name.trim()) {
            nextExcluded.add(p.name.trim());
          }
        }
      }
    }
    const fields = obj.fields as Record<string, unknown> | undefined;
    if (fields && fields.VAR !== undefined) {
      recordField(fields.VAR, nextExcluded);
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
  return Array.from(used);
}

/** Collects all Blockly variable IDs referenced by any block in a workspace JSON. */
function collectReferencedVarIds(
  workspaceJson: Record<string, unknown>,
): Set<string> {
  const used = new Set<string>();
  const blocksContainer = workspaceJson?.blocks as
    | { blocks?: Array<Record<string, unknown>> }
    | undefined;
  const topList = Array.isArray(blocksContainer?.blocks)
    ? blocksContainer.blocks
    : [];

  const checkField = (rawField: unknown) => {
    if (!rawField) return;
    if (typeof rawField === 'object') {
      const id = (rawField as Record<string, unknown>).id;
      if (typeof id === 'string' && id) used.add(id);
    } else if (typeof rawField === 'string' && rawField) {
      used.add(rawField);
    }
  };

  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    const fields = obj.fields as Record<string, unknown> | undefined;
    if (fields && fields.VAR !== undefined) {
      checkField(fields.VAR);
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
  return used;
}

/** Rewrites block variable references from `fromId` to `toId` inside a cloned workspace JSON. */
function replaceVarIdInWorkspaceJson(
  node: unknown,
  fromId: string,
  toId: string,
): unknown {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((item) => replaceVarIdInWorkspaceJson(item, fromId, toId));
  }
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'VAR' && v && typeof v === 'object') {
      const fo = v as Record<string, unknown>;
      out[k] = fo.id === fromId ? { ...fo, id: toId } : v;
    } else if (k === 'VAR' && v === fromId) {
      out[k] = toId;
    } else {
      out[k] = replaceVarIdInWorkspaceJson(v, fromId, toId);
    }
  }
  return out;
}

/** Returns the authoritative list of explicit cross-file shared variable names (`handle.sharedVariables`). */
export function collectHandleSharedVariableNames(
  handle: RuntimeHandle,
): string[] {
  if (!Array.isArray(handle.sharedVariables)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of handle.sharedVariables) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Collects ALL variable names (both shared and single-file) present in a single script's workspace JSON. */
export function collectScriptVariableNames(
  workspaceJson: Record<string, unknown>,
): string[] {
  return readSerializedVars(workspaceJson).map((v) => v.name);
}

/** Collects ALL variable names across every script in the handle (useful for cross-file creation collision checks). */
export function collectAllVariableNamesInHandle(
  handle: RuntimeHandle,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of collectHandleSharedVariableNames(handle)) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  for (const scr of handle.scripts) {
    for (const v of readSerializedVars(scr.workspace)) {
      if (!seen.has(v.name)) {
        seen.add(v.name);
        out.push(v.name);
      }
    }
  }
  return out;
}

/**
 * Returns a workspace JSON guaranteed to contain every explicit cross-file shared variable
 * (preserving all existing `{ name, id }` entries untouched and NEVER touching single-file variables).
 */
export function syncHandleVariablesIntoWorkspaceJson(
  workspaceJson: Record<string, unknown>,
  sharedNames: string[],
): Record<string, unknown> {
  if (sharedNames.length === 0) return workspaceJson;
  const existing = readSerializedVars(workspaceJson);
  const existingNames = new Set(existing.map((v) => v.name));
  const missing = sharedNames.filter((n) => !existingNames.has(n));
  if (missing.length === 0) return workspaceJson;

  const usedIds = new Set(existing.map((v) => v.id));
  const nextVars: SerializedVarEntry[] = [
    ...existing,
    ...missing.map((name) => ({
      id: makeStableSharedVarId(name, usedIds),
      name,
    })),
  ];
  return {
    ...workspaceJson,
    variables: nextVars,
  };
}

/**
 * Applies a variable create / rename / delete mutation strictly respecting the 3-tier scope model:
 * - `shared` (跨文件全局): synced in `handle.sharedVariables` AND across all sibling scripts.
 * - `file` (单文件全局): strictly isolated to `sourceScriptId`, NEVER leaks into sibling scripts!
 */
export function applyHandleVariableMutation(
  handle: RuntimeHandle,
  sourceScriptId: string,
  mutation: HandleVariableMutation,
): { handle: RuntimeHandle; keptInSiblings: string[] } {
  const keptInSiblings: string[] = [];
  const currentShared = collectHandleSharedVariableNames(handle);
  const sharedSet = new Set(currentShared);

  if (mutation.kind === 'create') {
    const name = mutation.name.trim();
    const initVal = normalizeVariableInitialValue(mutation.initialValue);
    if (!name) {
      return { handle: { ...handle, sharedVariables: currentShared }, keptInSiblings };
    }
    if (mutation.scope !== 'shared') {
      // Single-file variable: strictly private to source script (store initialValue on source script)
      const nextScripts = handle.scripts.map((scr) =>
        scr.id === sourceScriptId
          ? {
              ...scr,
              variableInitialValues: {
                ...(scr.variableInitialValues ?? {}),
                [name]: initVal,
              },
            }
          : scr,
      );
      return {
        handle: { ...handle, sharedVariables: currentShared, scripts: nextScripts },
        keptInSiblings,
      };
    }
    const nextShared = sharedSet.has(name)
      ? currentShared
      : [...currentShared, name];
    const nextHandleInitials = {
      ...(handle.variableInitialValues ?? {}),
      [name]: initVal,
    };
    const nextScripts = handle.scripts.map((scr) => {
      if (scr.id === sourceScriptId) return scr;
      return {
        ...scr,
        workspace: syncHandleVariablesIntoWorkspaceJson(scr.workspace, [name]),
      };
    });
    return {
      handle: {
        ...handle,
        sharedVariables: nextShared,
        variableInitialValues: nextHandleInitials,
        scripts: nextScripts,
      },
      keptInSiblings,
    };
  }

  if (mutation.kind === 'set-initial') {
    const name = mutation.name.trim();
    if (!name) return { handle, keptInSiblings };
    const initVal = normalizeVariableInitialValue(mutation.initialValue);
    if (mutation.scope === 'shared') {
      return {
        handle: {
          ...handle,
          variableInitialValues: {
            ...(handle.variableInitialValues ?? {}),
            [name]: initVal,
          },
        },
        keptInSiblings,
      };
    }
    return {
      handle: {
        ...handle,
        scripts: handle.scripts.map((scr) =>
          scr.id === sourceScriptId
            ? {
                ...scr,
                variableInitialValues: {
                  ...(scr.variableInitialValues ?? {}),
                  [name]: initVal,
                },
              }
            : scr,
        ),
      },
      keptInSiblings,
    };
  }

  if (mutation.kind === 'rename') {
    const oldName = mutation.oldName.trim();
    const newName = mutation.newName.trim();
    if (!oldName || !newName || oldName === newName) {
      return { handle: { ...handle, sharedVariables: currentShared }, keptInSiblings };
    }
    if (!sharedSet.has(oldName)) {
      // Single-file variable rename: migrate initialValue entry inside sourceScriptId only
      const nextScripts = handle.scripts.map((scr) => {
        if (scr.id !== sourceScriptId || !scr.variableInitialValues?.[oldName]) {
          return scr;
        }
        const nextInit = { ...scr.variableInitialValues };
        nextInit[newName] = nextInit[oldName];
        delete nextInit[oldName];
        return { ...scr, variableInitialValues: nextInit };
      });
      return {
        handle: { ...handle, sharedVariables: currentShared, scripts: nextScripts },
        keptInSiblings,
      };
    }
    const nextShared = Array.from(
      new Set(currentShared.map((n) => (n === oldName ? newName : n))),
    );
    const nextHandleInitials = { ...(handle.variableInitialValues ?? {}) };
    if (nextHandleInitials[oldName]) {
      nextHandleInitials[newName] = nextHandleInitials[oldName];
      delete nextHandleInitials[oldName];
    }
    const nextScripts = handle.scripts.map((scr) => {
      if (scr.id === sourceScriptId) return scr;
      const existing = readSerializedVars(scr.workspace);
      const usedIds = new Set(existing.map((v) => v.id));
      const oldEntry = existing.find((v) => v.name === oldName);
      const newEntry = existing.find((v) => v.name === newName);

      if (oldEntry && newEntry) {
        const mergedBlocks = replaceVarIdInWorkspaceJson(
          scr.workspace.blocks,
          oldEntry.id,
          newEntry.id,
        );
        return {
          ...scr,
          workspace: {
            ...scr.workspace,
            blocks: mergedBlocks,
            variables: existing.filter((v) => v.id !== oldEntry.id),
          },
        };
      }
      if (oldEntry) {
        return {
          ...scr,
          workspace: {
            ...scr.workspace,
            variables: existing.map((v) =>
              v.id === oldEntry.id ? { ...v, name: newName } : v,
            ),
          },
        };
      }
      if (!newEntry) {
        return {
          ...scr,
          workspace: {
            ...scr.workspace,
            variables: [
              ...existing,
              { id: makeStableSharedVarId(newName, usedIds), name: newName },
            ],
          },
        };
      }
      return scr;
    });
    return {
      handle: {
        ...handle,
        sharedVariables: nextShared,
        variableInitialValues: nextHandleInitials,
        scripts: nextScripts,
      },
      keptInSiblings,
    };
  }

  // delete
  const targetName = mutation.name.trim();
  if (!targetName) {
    return { handle: { ...handle, sharedVariables: currentShared }, keptInSiblings };
  }
  if (!sharedSet.has(targetName)) {
    const nextScripts = handle.scripts.map((scr) => {
      if (scr.id !== sourceScriptId || !scr.variableInitialValues?.[targetName]) {
        return scr;
      }
      const nextInit = { ...scr.variableInitialValues };
      delete nextInit[targetName];
      return { ...scr, variableInitialValues: nextInit };
    });
    return {
      handle: { ...handle, sharedVariables: currentShared, scripts: nextScripts },
      keptInSiblings,
    };
  }

  const nextScripts = handle.scripts.map((scr) => {
    if (scr.id === sourceScriptId) return scr;
    const existing = readSerializedVars(scr.workspace);
    const targetEntry = existing.find((v) => v.name === targetName);
    if (!targetEntry) return scr;
    const referencedIds = collectReferencedVarIds(scr.workspace);
    if (referencedIds.has(targetEntry.id)) {
      keptInSiblings.push(scr.name);
      return scr;
    }
    return {
      ...scr,
      workspace: {
        ...scr.workspace,
        variables: existing.filter((v) => v.id !== targetEntry.id),
      },
    };
  });

  // Remove from `handle.sharedVariables` & `variableInitialValues` only if no sibling still actively references it
  const nextShared =
    keptInSiblings.length > 0
      ? currentShared
      : currentShared.filter((n) => n !== targetName);
  const nextHandleInitials = { ...(handle.variableInitialValues ?? {}) };
  if (keptInSiblings.length === 0) {
    delete nextHandleInitials[targetName];
  }

  return {
    handle: {
      ...handle,
      sharedVariables: nextShared,
      variableInitialValues: nextHandleInitials,
      scripts: nextScripts,
    },
    keptInSiblings,
  };
}
