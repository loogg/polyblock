import type * as Blockly from 'blockly';
import {
  getActiveHandleScripts,
  getActiveHandleScriptId,
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
 * Extracts declared top-level global callback names (e.g. 'on_start', 'on_run', 'on_timer')
 * and required sibling script names directly from a serialized Blockly workspace JSON.
 */
export function inspectWorkspaceScriptMeta(workspaceJson: Record<string, unknown>): {
  declaredEvents: string[];
  requiredScripts: string[];
} {
  const declared = new Set<string>();
  const required = new Set<string>();

  const blocksContainer = workspaceJson?.blocks as
    | { blocks?: Array<Record<string, unknown>> }
    | undefined;
  const topList = Array.isArray(blocksContainer?.blocks)
    ? blocksContainer.blocks
    : [];

  for (const top of topList) {
    if (!top || top.enabled === false) continue;
    const t = String(top.type ?? '');
    if (t === 'poly_on_start') {
      declared.add('on_start');
    } else {
      const hatDef = extensionRegistry.getHatBlockDef(t);
      if (hatDef) {
        declared.add(hatDef.hat.eventName);
      }
    }
  }

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
      const scriptName = String(fields?.SCRIPT ?? '').trim();
      if (scriptName) required.add(scriptName);
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
  };
}

function getHandleSiblingScripts() {
  const currentId = getActiveHandleScriptId();
  return getActiveHandleScripts().filter((s) => s.id !== currentId);
}

/**
 * Pure hat-driven event-loop detection across the entire handle:
 * Returns true whenever ANY script in the active handle (current workspace OR any sibling
 * script in the same handle) contains a declarative `kind: 'hat'` callback block.
 * Zero extra `requiresEventLoop` or `hasRtMonitorUi` flags needed!
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
