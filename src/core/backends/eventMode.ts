import type * as Blockly from 'blockly';
import { extensionRegistry } from '../extensions/registry';

export const CORE_TOP_HAT_TYPES = new Set<string>([
  'poly_on_start',
  'procedures_defnoreturn',
  'procedures_defreturn',
]);

export const TIMER_ID_BLOCK_TYPES = new Set<string>([
  'poly_on_timer',
  'poly_start_timer',
  'poly_stop_timer',
  'poly_get_timer_value',
  'poly_is_timer_running',
]);

/** Returns true if a block type is a valid top-level hat (core entry/procedure OR any declarative extension hat). */
export function isValidTopHatType(blockType: string): boolean {
  return (
    CORE_TOP_HAT_TYPES.has(blockType) ||
    extensionRegistry.isDeclarativeHatBlock(blockType)
  );
}

/**
 * Returns true if the workspace uses any declarative event hat or runtime-pack block
 * (e.g. rt-lifecycle, rt-timers, virtual-board on_button, or user custom `.polyext.json` hats).
 * Pure sequential scripts (only poly_on_start) remain in clean top-level script mode.
 */
export function isEventDrivenWorkspace(workspace: Blockly.Workspace): boolean {
  for (const blk of workspace.getAllBlocks(false)) {
    if (blk.isShadow() || !blk.isEnabled()) continue;
    if (extensionRegistry.isEventDrivenBlock(blk.type)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if the workspace defines any external event hat (e.g. `on_button`, `on_robot_estop`,
 * `on_can_rx`) whose `hat.keepsAlive !== false` and is not `on_run` itself.
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
  return false;
}
