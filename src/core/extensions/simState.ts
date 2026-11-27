import type {
  PolyExtensionPack,
  SimStateMap,
  SimWidgetSpec,
} from './types';

export const GLOBAL_SIM_KEY_PREFIX = 'global:';

/**
 * Qualifies a simulator widget key with its owning pack ID to prevent collisions when
 * multiple extension packs use short common keys like "speed" or "led".
 * Keys prefixed with "global:" stay unprefixed for intentional cross-pack sharing.
 */
export function qualifySimKey(packId: string, rawKey: string): string {
  if (!packId || rawKey.startsWith(GLOBAL_SIM_KEY_PREFIX) || rawKey.includes('::')) {
    return rawKey;
  }
  return `${packId}::${rawKey}`;
}

export interface ResolvedTricolorState {
  color: 'red' | 'green' | 'blue' | 'off';
  hex: string;
  labelZh: string;
  active: boolean;
}

/**
 * Strictly normalizes a `tricolor` indicator value to one of the 3 discrete colors
 * (Red / Green / Blue) or OFF. Rejects arbitrary full-spectrum hex colors so hardware
 * 3-color lamps behave authentically and stay distinct from full-color `rgb` widgets.
 */
export function resolveTricolorState(raw: unknown): ResolvedTricolorState {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (s === 'red' || s === 'r' || s === '#ef4444' || s === '#ff0000') {
    return { color: 'red', hex: '#ef4444', labelZh: '红', active: true };
  }
  if (s === 'green' || s === 'g' || s === '#10b981' || s === '#22c55e' || s === '#00ff00') {
    return { color: 'green', hex: '#10b981', labelZh: '绿', active: true };
  }
  if (s === 'blue' || s === 'b' || s === '#3b82f6' || s === '#0000ff') {
    return { color: 'blue', hex: '#3b82f6', labelZh: '蓝', active: true };
  }
  return { color: 'off', hex: '#1e293b', labelZh: '关', active: false };
}

export function getWidgetDefaultValue(w: SimWidgetSpec): unknown {
  if (w.default !== undefined) {
    return Array.isArray(w.default) ? [...w.default] : w.default;
  }
  switch (w.kind) {
    case 'led':
    case 'toggle':
    case 'button':
      return false;
    case 'tricolor':
    case 'rgb':
      return '#1e293b';
    case 'bar':
    case 'slider':
      return w.min ?? 0;
    case 'screen':
      return [];
  }
}

export function readPackWidgetValue(
  simState: SimStateMap,
  packId: string,
  w: SimWidgetSpec,
): unknown {
  const fullKey = qualifySimKey(packId, w.key);
  if (Object.prototype.hasOwnProperty.call(simState, fullKey)) {
    return simState[fullKey];
  }
  if (Object.prototype.hasOwnProperty.call(simState, w.key)) {
    return simState[w.key];
  }
  return getWidgetDefaultValue(w);
}

export function buildDefaultSimState(packs: PolyExtensionPack[]): SimStateMap {
  const out: SimStateMap = {};
  for (const pack of packs) {
    for (const w of pack.simWidgets ?? []) {
      out[qualifySimKey(pack.id, w.key)] = getWidgetDefaultValue(w);
    }
  }
  return out;
}

export function buildPackResetPatch(pack: PolyExtensionPack): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const w of pack.simWidgets ?? []) {
    patch[qualifySimKey(pack.id, w.key)] = getWidgetDefaultValue(w);
  }
  return patch;
}

/**
 * Resolves declarative `emitEvent.args` placeholders (`$value`, `$state:<key>`)
 * into concrete primitive arguments for dispatching to active handle Workers.
 */
export function resolveWidgetEventArgs(
  packId: string,
  widget: SimWidgetSpec,
  nextValue: unknown,
  simState: SimStateMap,
): unknown[] {
  const templateArgs = widget.emitEvent?.args;
  if (!templateArgs || templateArgs.length === 0) {
    return [nextValue];
  }
  return templateArgs.map((arg) => {
    if (arg === '$value') return nextValue;
    if (typeof arg === 'string' && arg.startsWith('$state:')) {
      const refKey = arg.slice(7);
      const qKey = qualifySimKey(packId, refKey);
      return Object.prototype.hasOwnProperty.call(simState, qKey)
        ? simState[qKey]
        : simState[refKey];
    }
    return arg;
  });
}

function findMaxLines(fullOrRawKey: string, packs: PolyExtensionPack[]): number {
  for (const pack of packs) {
    for (const w of pack.simWidgets ?? []) {
      if (
        w.kind === 'screen' &&
        (qualifySimKey(pack.id, w.key) === fullOrRawKey || w.key === fullOrRawKey)
      ) {
        return w.maxLines ?? 4;
      }
    }
  }
  return 4;
}

/**
 * Applies a single `:clear` / `:append` / set mutation on a simulator state key
 * and returns the normalized target key and next value (shared by both UI and Workers).
 */
export function resolveScopedSimStateMutation(
  prevState: Record<string, unknown>,
  qualifiedKind: string,
  value: unknown,
  maxLines = 8,
): { targetKey: string; nextVal: unknown } {
  if (qualifiedKind.endsWith(':clear')) {
    return { targetKey: qualifiedKind.slice(0, -6), nextVal: [] };
  }
  if (qualifiedKind.endsWith(':append')) {
    const targetKey = qualifiedKind.slice(0, -7);
    const curArr = Array.isArray(prevState[targetKey])
      ? (prevState[targetKey] as string[])
      : typeof prevState[targetKey] === 'string' && prevState[targetKey]
        ? [String(prevState[targetKey])]
        : [];
    return {
      targetKey,
      nextVal: [...curArr, String(value)].slice(-maxLines),
    };
  }
  return { targetKey: qualifiedKind, nextVal: value };
}

/**
 * Applies a worker DEVICE_EVENT (`__poly_sim_set`) into the shared simulator state map
 * and returns both the next map and the exact key patch to broadcast to concurrent Workers.
 */
export function applySimDeviceEvent(
  prev: SimStateMap,
  kind: string,
  value: unknown,
  packs: PolyExtensionPack[],
): { next: SimStateMap; broadcastPatch: Record<string, unknown> } {
  const baseKey = kind.endsWith(':append')
    ? kind.slice(0, -7)
    : kind.endsWith(':clear')
      ? kind.slice(0, -6)
      : kind;
  const maxLines = findMaxLines(baseKey, packs);
  const { targetKey, nextVal } = resolveScopedSimStateMutation(
    prev,
    kind,
    value,
    maxLines,
  );

  const next: SimStateMap = { ...prev, [targetKey]: nextVal };
  return {
    next,
    broadcastPatch: { [targetKey]: nextVal },
  };
}
