import * as Blockly from 'blockly';
import {
  buildChannelDropdownOptions,
  DEFAULT_CHANNEL_COUNT,
  EDIT_TIMER_ALIAS_SENTINEL,
  MAX_CHANNEL_COUNT,
  triggerChannelAliasPrompt,
} from './workspaceContextBridge';

export interface ChannelFieldOptions {
  configKey?: string;
  prefix?: string;
  label?: string;
  defaultCount?: number;
  maxCount?: number;
}

/**
 * Dynamic Blockly FieldDropdown for per-handle integer channel pools (0..N-1).
 * Strictly isolated by `configKey` so multiple channel-pool packs (e.g. timers, PWM, CAN)
 * never collide in counts, prefixes, or handle-local aliases.
 */
export class ChannelIdFieldDropdown extends Blockly.FieldDropdown {
  readonly configKey: string;
  readonly prefix: string;
  readonly poolLabel: string;
  readonly defaultCount: number;
  readonly maxCount: number;
  private pendingValue: string | null = null;

  constructor(opts: ChannelFieldOptions = {}) {
    const configKey = opts.configKey || 'default';
    const prefix = opts.prefix || 'CH';
    const poolLabel = opts.label || '通道';
    const defaultCount = opts.defaultCount ?? DEFAULT_CHANNEL_COUNT;
    const maxCount = opts.maxCount ?? MAX_CHANNEL_COUNT;

    super(function (this: Blockly.FieldDropdown) {
      const self = this as ChannelIdFieldDropdown;
      return buildChannelDropdownOptions(
        self.configKey,
        self.prefix,
        self.pendingValue ?? self.getValue(),
        self.defaultCount,
        self.maxCount,
      );
    });

    this.configKey = configKey;
    this.prefix = prefix;
    this.poolLabel = poolLabel;
    this.defaultCount = defaultCount;
    this.maxCount = maxCount;
  }

  protected override doClassValidation_(newValue?: string): string | null {
    if (newValue === EDIT_TIMER_ALIAS_SENTINEL) {
      const curRaw = this.getValue();
      const curId = curRaw && /^\d+$/.test(curRaw) ? Number(curRaw) : 0;
      const req = {
        configKey: this.configKey,
        channelId: curId,
        prefix: this.prefix,
        label: this.poolLabel,
      };
      setTimeout(() => triggerChannelAliasPrompt(req), 0);
      return null;
    }
    if (typeof newValue === 'string' && /^\d+$/.test(newValue)) {
      const n = Number(newValue);
      if (Number.isInteger(n) && n >= 0 && n < this.maxCount) {
        this.pendingValue = newValue;
        this.getOptions(false);
      }
    }
    const res = super.doClassValidation_(newValue);
    this.pendingValue = null;
    return res;
  }
}

export function createChannelIdField(
  opts: ChannelFieldOptions = {},
): Blockly.FieldDropdown {
  return new ChannelIdFieldDropdown(opts);
}
