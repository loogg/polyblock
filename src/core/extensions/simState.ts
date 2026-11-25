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

export function getWidgetDefaultValue(w: SimWidgetSpec): unknown {
  if (w.default !== undefined) {
    return Array.isArray(w.default) ? [...w.default] : w.default;
  }
  switch (w.kind) {
    case 'led':
    case 'toggle':
    case 'button':
      return false;
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
 * Applies a worker DEVICE_EVENT (`__poly_sim_set` / `__poly_device_emit`) into the
 * shared simulator state map and returns both the next map and the exact key patch
 * to broadcast to all concurrent handle Workers.
 */
export function applySimDeviceEvent(
  prev: SimStateMap,
  kind: string,
  value: unknown,
  packs: PolyExtensionPack[],
): { next: SimStateMap; broadcastPatch: Record<string, unknown> } {
  let targetKey = kind;
  let mode: 'set' | 'append' | 'clear' = 'set';

  if (kind === 'oled_clear') {
    targetKey = qualifySimKey('virtual-board', 'oled');
    mode = 'clear';
  } else if (kind === 'oled_show') {
    targetKey = qualifySimKey('virtual-board', 'oled');
    mode = 'append';
  } else if (kind.endsWith(':clear')) {
    targetKey = kind.slice(0, -6);
    mode = 'clear';
  } else if (kind.endsWith(':append')) {
    targetKey = kind.slice(0, -7);
    mode = 'append';
  }

  if (!targetKey.includes('::') && !targetKey.startsWith(GLOBAL_SIM_KEY_PREFIX)) {
    // If an unqualified legacy key matches a unique widget in an enabled pack, normalize it
    for (const p of packs) {
      if ((p.simWidgets ?? []).some((w) => w.key === targetKey)) {
        targetKey = qualifySimKey(p.id, targetKey);
        break;
      }
    }
  }

  let nextVal: unknown;
  if (mode === 'clear') {
    nextVal = [];
  } else if (mode === 'append') {
    const maxLines = findMaxLines(targetKey, packs);
    const curArr = Array.isArray(prev[targetKey])
      ? (prev[targetKey] as string[])
      : typeof prev[targetKey] === 'string' && prev[targetKey]
        ? [String(prev[targetKey])]
        : [];
    nextVal = [...curArr, String(value)].slice(-maxLines);
  } else {
    nextVal = value;
  }

  const next: SimStateMap = { ...prev, [targetKey]: nextVal };
  return {
    next,
    broadcastPatch: { [targetKey]: nextVal },
  };
}
