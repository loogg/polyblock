import type {
  PolyExtensionPack,
  SimStateMap,
  SimWidgetSpec,
} from './types';

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

export function buildDefaultSimState(packs: PolyExtensionPack[]): SimStateMap {
  const out: SimStateMap = {};
  for (const pack of packs) {
    for (const w of pack.simWidgets ?? []) {
      out[w.key] = getWidgetDefaultValue(w);
    }
  }
  return out;
}

export function buildPackResetPatch(pack: PolyExtensionPack): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const w of pack.simWidgets ?? []) {
    patch[w.key] = getWidgetDefaultValue(w);
  }
  return patch;
}

function findMaxLines(key: string, packs: PolyExtensionPack[]): number {
  for (const pack of packs) {
    for (const w of pack.simWidgets ?? []) {
      if (w.key === key && w.kind === 'screen') {
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
  // Backwards-compatible aliases for virtual-board OLED commands
  let targetKey = kind;
  let mode: 'set' | 'append' | 'clear' = 'set';

  if (kind === 'oled_clear') {
    targetKey = 'oled';
    mode = 'clear';
  } else if (kind === 'oled_show') {
    targetKey = 'oled';
    mode = 'append';
  } else if (kind.endsWith(':clear')) {
    targetKey = kind.slice(0, -6);
    mode = 'clear';
  } else if (kind.endsWith(':append')) {
    targetKey = kind.slice(0, -7);
    mode = 'append';
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
