import type * as Blockly from 'blockly';

export const EVENT_DRIVEN_HAT_TYPES = new Set<string>([
  'poly_on_run',
  'poly_on_stop',
  'poly_on_timer',
  'poly_on_button',
]);

export const EVENT_DRIVEN_RT_TYPES = new Set<string>([
  'poly_set_run_period',
  'poly_run_control',
  'poly_start_timer',
  'poly_stop_timer',
  'poly_get_timer_value',
  'poly_is_timer_running',
]);

export const ALL_VALID_TOP_HAT_TYPES = new Set<string>([
  'poly_on_start',
  'poly_on_run',
  'poly_on_stop',
  'poly_on_timer',
  'poly_on_button',
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

/**
 * Returns true if the workspace uses any Phase 5 event-driven lifecycle,
 * timer, or hardware callback block. Pure sequential scripts (only poly_on_start)
 * remain in clean top-level script mode for 100% backward compatibility.
 */
export function isEventDrivenWorkspace(workspace: Blockly.Workspace): boolean {
  for (const blk of workspace.getAllBlocks(false)) {
    if (blk.isShadow() || !blk.isEnabled()) continue;
    if (
      EVENT_DRIVEN_HAT_TYPES.has(blk.type) ||
      EVENT_DRIVEN_RT_TYPES.has(blk.type)
    ) {
      return true;
    }
  }
  return false;
}
