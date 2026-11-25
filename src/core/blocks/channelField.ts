import * as Blockly from 'blockly';
import {
  buildTimerDropdownOptions,
  EDIT_TIMER_ALIAS_SENTINEL,
  triggerTimerAliasPrompt,
} from './timerConfigBridge';

/**
 * Dynamic Blockly FieldDropdown for per-handle integer channel pools (0..N-1).
 * Preserves out-of-range channel IDs cleanly on load so static diagnostics can flag them,
 * and supports the inline "edit alias" shortcut right inside the dropdown.
 */
export class ChannelIdFieldDropdown extends Blockly.FieldDropdown {
  private pendingValue: string | null = null;

  constructor() {
    super(function (this: Blockly.FieldDropdown) {
      const self = this as ChannelIdFieldDropdown;
      return buildTimerDropdownOptions(self.pendingValue ?? self.getValue());
    });
  }

  protected override doClassValidation_(newValue?: string): string | null {
    if (newValue === EDIT_TIMER_ALIAS_SENTINEL) {
      const curRaw = this.getValue();
      const curId = curRaw && /^\d+$/.test(curRaw) ? Number(curRaw) : 0;
      setTimeout(() => triggerTimerAliasPrompt(curId), 0);
      return null;
    }
    if (typeof newValue === 'string' && /^\d+$/.test(newValue)) {
      const n = Number(newValue);
      if (Number.isInteger(n) && n >= 0 && n < 32) {
        this.pendingValue = newValue;
        this.getOptions(false);
      }
    }
    const res = super.doClassValidation_(newValue);
    this.pendingValue = null;
    return res;
  }
}

export function createChannelIdField(): Blockly.FieldDropdown {
  return new ChannelIdFieldDropdown();
}
