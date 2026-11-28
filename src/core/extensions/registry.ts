import * as Blockly from 'blockly';
import type { ScriptLanguageId } from '../../types/project';
import {
  backendRegistry,
  getLanguageDialect,
  getSupportedLanguageIds,
} from '../backends/registry';
import type { ScriptBackendAdapter } from '../backends/types';
import type { BlockCategorySpec, ToolboxBlockSpec } from '../blocks/catalog';
import { createChannelIdField } from '../blocks/channelField';
import {
  DEFAULT_CHANNEL_COUNT,
  getActiveHandleScriptId,
  getActiveHandleScripts,
  isCurrentHandleScriptEntry,
} from '../blocks/workspaceContextBridge';
import { hasCapability } from '../capabilities/matching';
import { DEFAULT_EXTENSION_PACKS } from './defaultPacks';
import {
  DEFAULT_PACK_TOOLBOX_ORDER,
  findSectionForBlockType,
  getAllPackBlocks,
  renderExtensionTemplate,
  renderTemplateFromRawFields,
  resolvePackSections,
} from './templateRenderer';
import type {
  CoreCategoryTarget,
  ExtensionBlockDef,
  ExtensionHatSpec,
  PackAttributeBadge,
  PolyExtensionPack,
  ResolvedHandleChannelPoolSpec,
  ResolvedPackSection,
} from './types';
import { CORE_CATEGORY_LABELS, validateExtensionPack } from './validator';

export {
  CORE_CATEGORY_LABELS,
  DEFAULT_PACK_TOOLBOX_ORDER,
  findSectionForBlockType,
  getAllPackBlocks,
  resolvePackSections,
  validateExtensionPack,
};

export const STORAGE_GLOBAL_EXTENSIONS_KEY = 'polyblock.extensions.global.v4';
export const OPEN_HANDLE_CHANNEL_CONFIG_CALLBACK = 'OPEN_HANDLE_CHANNEL_CONFIG';

interface PersistedPacksPatch {
  packs?: unknown[];
  removedIds?: unknown[];
}

const DEFAULT_PACK_JSON_BY_ID = new Map<string, string>(
  DEFAULT_EXTENSION_PACKS.map((p) => [p.id, JSON.stringify(p)]),
);

/** Computes whether a pack is fully enabled, partially enabled (fine-grained sections), or disabled. */
export function getPackEnableState(
  pack: PolyExtensionPack,
  enabledCapabilities: string[],
): {
  status: 'full' | 'partial' | 'none';
  enabledCount: number;
  totalCount: number;
  enabledSectionCapIds: string[];
} {
  const sections = resolvePackSections(pack);
  if (!sections[0]?.isMultiSection) {
    const on = enabledCapabilities.includes(pack.id);
    return {
      status: on ? 'full' : 'none',
      enabledCount: on ? 1 : 0,
      totalCount: 1,
      enabledSectionCapIds: on ? [pack.id] : [],
    };
  }

  const enabledSections = sections.filter((s) =>
    hasCapability(enabledCapabilities, s.capId),
  );
  const status =
    enabledSections.length === 0
      ? 'none'
      : enabledSections.length === sections.length
        ? 'full'
        : 'partial';
  return {
    status,
    enabledCount: enabledSections.length,
    totalCount: sections.length,
    enabledSectionCapIds: enabledSections.map((s) => s.capId),
  };
}

/**
 * Scheme 1 fine-grained capability toggle helper:
 * - Toggling whole pack (`"rt"`): full -> none; none/partial -> full (`"rt"`).
 * - Toggling single section (`"rt.timers"`): flips that section, auto-collapses to `"rt"`
 *   when all sections become enabled, or strips `"rt"` completely when none remain.
 */
export function togglePackOrSectionCapability(
  capId: string,
  enabledCapabilities: string[],
  localPacks?: PolyExtensionPack[],
): {
  nextCapabilities: string[];
  action: 'enabled' | 'disabled';
  displayName: string;
} {
  const dotIdx = capId.indexOf('.');
  const isSectionToggle = dotIdx > 0;
  const basePackId = isSectionToggle ? capId.slice(0, dotIdx) : capId;
  const pack = extensionRegistry.resolvePack(basePackId, localPacks);

  if (!pack || pack.sections.length <= 1) {
    const exists = enabledCapabilities.includes(capId);
    const nextCapabilities = exists
      ? enabledCapabilities.filter((id) => id !== capId)
      : [...enabledCapabilities, capId];
    return {
      nextCapabilities,
      action: exists ? 'disabled' : 'enabled',
      displayName: pack?.name ?? capId,
    };
  }

  const sections = resolvePackSections(pack);
  const state = getPackEnableState(pack, enabledCapabilities);
  const prefix = `${pack.id}.`;
  const withoutPack = enabledCapabilities.filter(
    (c) => c !== pack.id && !c.startsWith(prefix),
  );

  if (!isSectionToggle) {
    if (state.status === 'full') {
      return {
        nextCapabilities: withoutPack,
        action: 'disabled',
        displayName: pack.name,
      };
    }
    return {
      nextCapabilities: [...withoutPack, pack.id],
      action: 'enabled',
      displayName: pack.name,
    };
  }

  const targetSec = sections.find((s) => s.capId === capId);
  const displayName = targetSec ? `${pack.name} · ${targetSec.label}` : capId;
  const curSet = new Set(state.enabledSectionCapIds);
  const wasOn = curSet.has(capId);
  if (wasOn) {
    curSet.delete(capId);
  } else {
    curSet.add(capId);
  }

  let nextCapabilities: string[];
  if (curSet.size === 0) {
    nextCapabilities = withoutPack;
  } else if (curSet.size === sections.length) {
    nextCapabilities = [...withoutPack, pack.id];
  } else {
    const ordered = sections
      .map((s) => s.capId)
      .filter((id) => curSet.has(id));
    nextCapabilities = [...withoutPack, ...ordered];
  }

  return {
    nextCapabilities,
    action: wasOn ? 'disabled' : 'enabled',
    displayName,
  };
}

export function formatSectionPlacement(section: ResolvedPackSection): string {
  if (!section.visible) return '隐藏';
  if (section.categoryTarget !== 'own') {
    return `并入「${CORE_CATEGORY_LABELS[section.categoryTarget]}」`;
  }
  return `#${section.toolboxOrder}`;
}

export function formatPackPlacementSummary(pack: PolyExtensionPack): string {
  const sections = resolvePackSections(pack);
  if (sections.length > 1) {
    return `${sections.length} 个组件`;
  }
  const sec = sections[0];
  if (!sec.visible) return '隐藏';
  return sec.categoryTarget !== 'own'
    ? `并入「${CORE_CATEGORY_LABELS[sec.categoryTarget]}」`
    : `分类序 #${sec.toolboxOrder}`;
}

/**
 * Inspects which target script languages a pack's blocks support.
 * Statement/value blocks may provide single-language or multi-language templates.
 */
export function getPackSupportedLanguages(pack: PolyExtensionPack): {
  supported: ScriptLanguageId[];
  label: string;
} {
  const supportedIds = getSupportedLanguageIds();
  const nonHatBlocks = getAllPackBlocks(pack).filter((b) => b.kind !== 'hat');
  const supported: ScriptLanguageId[] =
    nonHatBlocks.length === 0
      ? [...supportedIds]
      : supportedIds.filter((lang) =>
          nonHatBlocks.some((b) => Boolean(b.code?.[lang]?.template)),
        );
  const label =
    supported.length === 1
      ? `仅 ${getLanguageDialect(supported[0]).displayName}`
      : supported.map((lang) => getLanguageDialect(lang).displayName).join(' / ');
  return {
    supported,
    label,
  };
}

/**
 * Derives objective multi-attribute badges from a pack's actual declarative contents
 * (across all sections + optional user-authored `tags`).
 */
export function derivePackBadges(pack: PolyExtensionPack): PackAttributeBadge[] {
  const badges: PackAttributeBadge[] = [];
  const sections = resolvePackSections(pack);
  const allBlocks = getAllPackBlocks(pack);
  const hasSimDriver = Boolean(pack.sandboxMock || (pack.libs?.length ?? 0) > 0);
  const widgetCount = hasSimDriver ? (pack.simWidgets?.length ?? 0) : 0;
  const hasHat = allBlocks.some((b) => b.kind === 'hat');
  const pools = sections
    .map((s) => s.channelPool)
    .filter((p): p is ResolvedHandleChannelPoolSpec => Boolean(p));
  const hasApiBlocks = allBlocks.some(
    (b) => b.kind === 'statement' || b.kind === 'value',
  );

  if (sections.length > 1) {
    badges.push({
      id: 'sections',
      label: `${sections.length} 组件`,
      tone: 'tag',
    });
  }

  if (widgetCount > 0) {
    badges.push({
      id: 'sim',
      label: `外设模拟 · ${widgetCount}控件`,
      tone: 'sim',
    });
  } else if (pack.sandboxMock) {
    badges.push({
      id: 'sim',
      label: '沙箱模拟',
      tone: 'sim',
    });
  }

  if (pack.libs && pack.libs.length > 0) {
    badges.push({
      id: 'pack-libs',
      label:
        pack.libs.length === 1
          ? '内置脚本库'
          : `内置脚本库 · ${pack.libs.length}文件`,
      tone: 'lib',
    });
  }

  const langs = getPackSupportedLanguages(pack);
  if (langs.supported.length === 1) {
    badges.push({
      id: 'lang-only',
      label: `仅 ${getLanguageDialect(langs.supported[0]).shortLabel}`,
      tone: 'tag',
    });
  }

  if (hasHat) {
    badges.push({
      id: 'hat',
      label: '事件回调',
      tone: 'event',
    });
  }

  for (const p of pools) {
    badges.push({
      id: `pool-${p.configKey}`,
      label: `通道池 ${p.prefix}0~${p.max - 1}`,
      tone: 'pool',
    });
  }

  if (
    hasApiBlocks &&
    widgetCount === 0 &&
    pools.length === 0 &&
    !hasHat &&
    !(pack.libs && pack.libs.length > 0)
  ) {
    badges.push({
      id: 'lib',
      label: '功能库',
      tone: 'lib',
    });
  }

  const seenLabels = new Set(badges.map((b) => b.label));
  for (const tag of pack.tags ?? []) {
    const trimmed = tag.trim();
    if (!trimmed || seenLabels.has(trimmed)) continue;
    seenLabels.add(trimmed);
    badges.push({
      id: `tag-${trimmed}`,
      label: trimmed,
      tone: 'tag',
    });
  }

  return badges;
}

export type BlockMessageSegment =
  | { kind: 'text'; text: string }
  | { kind: 'arg'; label: string; index: number };

function cleanDropdownOptionLabel(raw: string): string {
  return raw
    .replace(/\s*[（(][A-Za-z0-9_/\s+-]+[)）]\s*/g, '')
    .trim();
}

function resolveBlockArgPreviewLabel(
  block: ExtensionBlockDef,
  argIndex1Based: number,
  section?: ResolvedPackSection,
  prevText = '',
): string {
  const arg = block.args0?.[argIndex1Based - 1];
  if (!arg || typeof arg !== 'object') return '参数';
  const argType = typeof arg.type === 'string' ? arg.type : '';
  const argName = typeof arg.name === 'string' ? arg.name : '';

  if (argType === 'field_dropdown' && Array.isArray(arg.options)) {
    const rawLabels = (arg.options as unknown[])
      .map((opt) => (Array.isArray(opt) && typeof opt[0] === 'string' ? opt[0] : ''))
      .map(cleanDropdownOptionLabel)
      .filter(Boolean);
    if (rawLabels.length > 0) {
      // Deduplicate repeated prefix already spoken right before the slot (e.g. "按键 " + "按键 A" -> "A")
      const tailWord = prevText.trim().split(/\s+/).pop() ?? '';
      const labels =
        tailWord.length >= 2 && rawLabels.every((l) => l.startsWith(tailWord))
          ? rawLabels.map((l) => l.slice(tailWord.length).trim() || l)
          : rawLabels;
      if (labels.length === 1) return labels[0];
      if (labels.length === 2) return `${labels[0]}/${labels[1]}`;
      return `${labels[0]}/${labels[1]}…`;
    }
    return '选项';
  }

  if (argType === 'field_channel_id') {
    const prefix = section?.channelPool?.prefix;
    return prefix ? `${prefix}0` : '通道';
  }

  if (argType === 'field_checkbox') return '开/关';
  if (argType === 'field_number') {
    return arg.value !== undefined ? String(arg.value) : '数值';
  }
  if (argType === 'field_variable') {
    return typeof arg.variable === 'string' && arg.variable.trim()
      ? arg.variable.trim()
      : '变量';
  }
  if (argType === 'field_input') {
    const t = typeof arg.text === 'string' ? arg.text.trim() : '';
    return t && t.length <= 6 ? t : '文本';
  }

  if (argType === 'input_value') {
    const shadow = argName ? block.shadows?.[argName] : undefined;
    if (shadow) {
      if (shadow.type === 'math_number') {
        return shadow.value !== undefined ? String(shadow.value) : '数值';
      }
      if (shadow.type === 'text') {
        const s = typeof shadow.value === 'string' ? shadow.value.trim() : '';
        return s && s.length <= 6 && !/\s/.test(s) ? s : '文本';
      }
    }
    if (argName && !/^(ARG\d*|VAL|VALUE|INPUT\d*)$/i.test(argName) && argName.length <= 8) {
      return argName.toLowerCase();
    }
    return '参数';
  }

  return '参数';
}

/**
 * Parses a Blockly `message0` template into human-readable display segments:
 * - Unescapes Blockly literal `%%` -> `%`
 * - Resolves `%1`, `%2`, ... placeholders into meaningful parameter previews derived
 *   declaratively from `args0`, `shadows`, and `section.channelPool` (zero empty boxes).
 */
export function parseExtensionBlockMessage(
  block: ExtensionBlockDef,
  section?: ResolvedPackSection,
): BlockMessageSegment[] {
  const message0 = block.message0;
  const segments: BlockMessageSegment[] = [];
  const tokenRe = /%%|%(\d+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const pushText = (chunk: string) => {
    if (!chunk) return;
    const prev = segments[segments.length - 1];
    if (prev && prev.kind === 'text') {
      prev.text += chunk;
    } else {
      segments.push({ kind: 'text', text: chunk });
    }
  };

  while ((match = tokenRe.exec(message0)) !== null) {
    if (match.index > lastIndex) {
      pushText(message0.slice(lastIndex, match.index));
    }
    if (match[0] === '%%') {
      pushText('%');
    } else {
      const argIdx = Number(match[1]);
      const prevSeg = segments[segments.length - 1];
      const prevText = prevSeg && prevSeg.kind === 'text' ? prevSeg.text : '';
      const label = resolveBlockArgPreviewLabel(block, argIdx, section, prevText);
      segments.push({ kind: 'arg', label, index: argIdx });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < message0.length) {
    pushText(message0.slice(lastIndex));
  }

  return segments
    .map((seg) =>
      seg.kind === 'text' ? { kind: 'text' as const, text: seg.text.trim() } : seg,
    )
    .filter((seg) => seg.kind === 'arg' || seg.text.length > 0);
}

/**
 * Formats a Blockly extension block into a clean, self-explanatory plain-text label
 * for diagnostics and tooltips (e.g. `设置板载 LED 点亮/熄灭`, `启动/停止 周期运行`).
 */
export function formatExtensionBlockLabel(
  block: ExtensionBlockDef,
  section?: ResolvedPackSection,
): string {
  return parseExtensionBlockMessage(block, section)
    .map((seg) => (seg.kind === 'text' ? seg.text : seg.label))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tracks the last registered Blockly visual definition fingerprint per block type to avoid redundant overwrites. */
const registeredBlockVisualFingerprints = new Map<string, string>();

function buildBlockVisualFingerprint(
  b: ExtensionBlockDef,
  section: ResolvedPackSection,
  fullTooltip: string,
  hasChannelField: boolean,
): string {
  const pool = section.channelPool;
  return JSON.stringify({
    type: b.type,
    kind: b.kind,
    message0: b.message0,
    args0: b.args0 ?? [],
    inputsInline: b.inputsInline ?? true,
    outputType: b.outputType ?? null,
    blockStyle: b.blockStyle ?? null,
    color: section.color,
    tooltip: fullTooltip,
    hasChannelField,
    ...(hasChannelField
      ? {
          pool: pool
            ? {
                configKey: pool.configKey,
                prefix: pool.prefix,
                label: pool.label,
                defaultCount: pool.defaultCount,
                max: pool.max,
              }
            : null,
        }
      : {}),
  });
}

/**
 * Registers a single declarative block (including dynamic `field_channel_id` dropdowns
 * and top-level `hat` event callbacks) into Blockly's visual block registry.
 * Skips identical re-registrations and cleanly replaces modified definitions without
 * triggering Blockly's spurious overwrite console warnings.
 */
function registerSingleBlockInBlockly(
  pack: PolyExtensionPack,
  b: ExtensionBlockDef,
  section: ResolvedPackSection,
): void {
  const blockColor = section.color;
  const pool = section.channelPool;
  const baseTooltip = b.tooltip ?? `${pack.name} · ${b.type}`;
  const fullTooltip =
    b.sandboxRunnable === false
      ? `${baseTooltip}（仅真机导出，浏览器沙箱不支持模拟运行）`
      : baseTooltip;
  const hasChannelField = (b.args0 ?? []).some(
    (arg) => arg.type === 'field_channel_id',
  );

  const fingerprint = buildBlockVisualFingerprint(
    b,
    section,
    fullTooltip,
    hasChannelField,
  );
  if (
    Blockly.Blocks[b.type] &&
    registeredBlockVisualFingerprints.get(b.type) === fingerprint
  ) {
    return;
  }
  if (Blockly.Blocks[b.type]) {
    delete Blockly.Blocks[b.type];
  }

  if (!hasChannelField) {
    const jsonDef: Record<string, unknown> = {
      type: b.type,
      message0: b.message0,
      args0: b.args0 ?? [],
      inputsInline: b.inputsInline ?? true,
      tooltip: fullTooltip,
    };

    if (b.blockStyle) {
      jsonDef.style = b.blockStyle;
    } else {
      jsonDef.colour = blockColor;
    }

    if (b.kind === 'hat') {
      jsonDef.message1 = '%1';
      jsonDef.args1 = [{ type: 'input_statement', name: 'BODY' }];
    } else if (b.kind === 'statement') {
      jsonDef.previousStatement = null;
      jsonDef.nextStatement = null;
    } else {
      jsonDef.output = b.outputType ?? null;
    }

    Blockly.defineBlocksWithJsonArray([jsonDef]);
    registeredBlockVisualFingerprints.set(b.type, fingerprint);
    return;
  }

  // Imperative Blockly builder for blocks using dynamic per-handle `field_channel_id` dropdowns
  Blockly.Blocks[b.type] = {
    init(this: Blockly.Block) {
      const args = b.args0 ?? [];
      const tokens = b.message0.split(/(%\d+)/g).filter((t) => t.length > 0);
      let curDummy: Blockly.Input | null = null;

      const ensureDummy = () => {
        if (!curDummy) {
          curDummy = this.appendDummyInput();
        }
        return curDummy;
      };

      for (const tok of tokens) {
        const m = /^%(\d+)$/.exec(tok);
        if (!m) {
          const text = tok.trim();
          if (text) {
            ensureDummy().appendField(text);
          }
          continue;
        }
        const argIdx = Number(m[1]) - 1;
        const arg = args[argIdx];
        if (!arg) continue;
        const argType = String(arg.type ?? '');
        const argName = String(arg.name ?? `ARG${argIdx}`);

        if (argType === 'field_channel_id') {
          ensureDummy().appendField(
            createChannelIdField({
              configKey: pool?.configKey ?? 'default',
              prefix: pool?.prefix ?? 'CH',
              label: pool?.label ?? '通道',
              defaultCount: pool?.defaultCount ?? DEFAULT_CHANNEL_COUNT,
              maxCount: pool?.max ?? 64,
            }),
            argName,
          );
        } else if (argType === 'input_value') {
          curDummy = null;
          const inp = this.appendValueInput(argName);
          if (typeof arg.check === 'string' || Array.isArray(arg.check)) {
            inp.setCheck(arg.check as string | string[]);
          }
        } else if (argType === 'field_dropdown' && Array.isArray(arg.options)) {
          ensureDummy().appendField(
            new Blockly.FieldDropdown(arg.options as Array<[string, string]>),
            argName,
          );
        } else if (argType === 'field_number') {
          ensureDummy().appendField(
            new Blockly.FieldNumber(
              Number(arg.value ?? 0),
              typeof arg.min === 'number' ? arg.min : undefined,
              typeof arg.max === 'number' ? arg.max : undefined,
              typeof arg.precision === 'number' ? arg.precision : undefined,
            ),
            argName,
          );
        } else if (argType === 'field_input') {
          ensureDummy().appendField(
            new Blockly.FieldTextInput(String(arg.text ?? '')),
            argName,
          );
        } else if (argType === 'field_checkbox') {
          ensureDummy().appendField(
            new Blockly.FieldCheckbox(Boolean(arg.checked)),
            argName,
          );
        } else if (argType === 'field_variable') {
          ensureDummy().appendField(
            new Blockly.FieldVariable(String(arg.variable ?? 'item')),
            argName,
          );
        } else if (argType === 'field_label') {
          ensureDummy().appendField(
            new Blockly.FieldLabel(String(arg.text ?? '')),
            argName,
          );
        }
      }

      if (b.kind === 'hat') {
        this.appendStatementInput('BODY');
      } else if (b.kind === 'statement') {
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
      } else {
        this.setOutput(true, b.outputType ?? null);
      }

      this.setInputsInline(b.inputsInline ?? true);
      if (b.blockStyle) {
        this.setStyle(b.blockStyle);
      } else {
        this.setColour(blockColor);
      }
      this.setTooltip(fullTooltip);
    },
  };
  registeredBlockVisualFingerprints.set(b.type, fingerprint);
}

function shouldExtractDispatchBranchesForEvent(
  hatSpec: ExtensionHatSpec,
): boolean {
  if (hatSpec.extractBranchFnPrefix) return true;
  if (!isCurrentHandleScriptEntry()) return true;
  const curId = getActiveHandleScriptId();
  return getActiveHandleScripts().some(
    (s) =>
      s.id !== curId &&
      (s.dispatchBranches ?? []).some((b) => b.eventName === hatSpec.eventName),
  );
}

function registerPackIntoBackend(
  pack: PolyExtensionPack,
  adapter: ScriptBackendAdapter,
): void {
  const sections = resolvePackSections(pack);
  for (const section of sections) {
    for (const b of section.blocks) {
      if (b.kind === 'hat' && b.hat) {
        const hat = b.hat;
        adapter.registerExtensionHat({
          pack,
          section,
          block: b,
          hat,
          shouldExtractBranches: () =>
            shouldExtractDispatchBranchesForEvent(hat),
        });
      } else {
        adapter.registerExtensionBlock({ pack, section, block: b });
      }
    }
  }
}

/**
 * Registers visual Blockly blocks and delegates per-language generator binding
 * dynamically to every attached `ScriptBackendAdapter` (zero language hardcoding, zero circular imports!).
 */
function registerPackIntoBlocklyAndGenerators(
  pack: PolyExtensionPack,
  adapters: Iterable<ScriptBackendAdapter>,
): void {
  const sections = resolvePackSections(pack);

  for (const section of sections) {
    for (const b of section.blocks) {
      registerSingleBlockInBlockly(pack, b, section);
    }
  }

  for (const adapter of adapters) {
    registerPackIntoBackend(pack, adapter);
  }
}

function buildToolboxBlocksForSection(
  pack: PolyExtensionPack,
  section: ResolvedPackSection,
): ToolboxBlockSpec[] {
  return section.blocks.map((b) => {
    const inputs: Record<string, { shadow?: Record<string, unknown> }> = {};
    for (const [argName, sh] of Object.entries(b.shadows ?? {})) {
      inputs[argName] = {
        shadow:
          sh.type === 'math_number'
            ? { type: 'math_number', fields: { NUM: sh.value } }
            : { type: 'text', fields: { TEXT: sh.value } },
      };
    }

    return {
      kind: 'block',
      type: b.type,
      keywords: `${pack.name} ${section.label} ${b.keywords ?? ''} ${b.message0}`,
      ...(b.fields ? { fields: b.fields } : {}),
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    };
  });
}

class ExtensionRegistry {
  /** Global extension packs (initialized from `src/packs/` defaults + localStorage delta, 100% equal rights). */
  private readonly packs = new Map<string, PolyExtensionPack>();
  /** Default seed pack IDs explicitly removed by the user (cleared on `resetToDefaults()`). */
  private readonly removedDefaultIds = new Set<string>();
  /** Currently active project's embedded local packs (override same-ID global packs without polluting global). */
  private readonly activeLocalPacks = new Map<string, PolyExtensionPack>();
  /** Attached target script backends bound via `backendRegistry.register(...)` (inverts circular dependency). */
  private readonly attachedBackends = new Map<ScriptLanguageId, ScriptBackendAdapter>();
  private initialized = false;

  constructor() {
    backendRegistry.onAdapterLifecycle((ev) => {
      if (ev.kind === 'attached') {
        this.attachBackend(ev.adapter);
      } else {
        this.detachBackend(ev.id);
      }
    });
  }

  /**
   * Attaches a `ScriptBackendAdapter` so all currently active packs (and any future packs)
   * automatically register their declarative blocks and hats into that backend.
   */
  attachBackend(adapter: ScriptBackendAdapter): void {
    this.attachedBackends.set(adapter.id, adapter);
    if (!this.initialized) {
      this.ensureInitialized();
      return;
    }
    for (const [id, pack] of this.packs.entries()) {
      if (!this.activeLocalPacks.has(id)) {
        registerPackIntoBackend(pack, adapter);
      }
    }
    for (const localPack of this.activeLocalPacks.values()) {
      registerPackIntoBackend(localPack, adapter);
    }
  }

  detachBackend(id: ScriptLanguageId): void {
    this.attachedBackends.delete(id);
  }

  /** Lists all global packs merged with active project-local overrides (local shadows global by ID). */
  listAllWithLocal(): PolyExtensionPack[] {
    this.ensureInitialized();
    const merged = new Map<string, PolyExtensionPack>();
    for (const [id, pack] of this.packs.entries()) {
      merged.set(id, pack);
    }
    for (const [id, pack] of this.activeLocalPacks.entries()) {
      merged.set(id, pack);
    }
    return Array.from(merged.values());
  }

  ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;

    for (const pack of DEFAULT_EXTENSION_PACKS) {
      this.register(pack, false);
    }

    try {
      const raw = localStorage.getItem(STORAGE_GLOBAL_EXTENSIONS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedPacksPatch;
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.removedIds)) {
            for (const rid of parsed.removedIds) {
              if (typeof rid === 'string' && DEFAULT_PACK_JSON_BY_ID.has(rid)) {
                this.removedDefaultIds.add(rid);
                this.packs.delete(rid);
              }
            }
          }
          if (Array.isArray(parsed.packs)) {
            for (const item of parsed.packs) {
              try {
                const valid = validateExtensionPack(item);
                this.removedDefaultIds.delete(valid.id);
                this.register(valid, false);
              } catch {
                // ignore corrupted entry
              }
            }
          }
        }
      }
    } catch {
      // ignore storage errors in test/private envs
    }
  }

  /**
   * Returns true if `pack` is byte-identical to an unmodified default seed pack in `src/packs/`.
   * Pure content equality (zero privileged built-in identity): used only to skip redundant
   * `localStorage` diff copies for unchanged default seed packs.
   */
  isSameAsDefault(pack: PolyExtensionPack): boolean {
    const defaultJson = DEFAULT_PACK_JSON_BY_ID.get(pack.id);
    return defaultJson !== undefined && defaultJson === JSON.stringify(pack);
  }

  /** Returns true if the global pack catalog has any additions, overrides, or removals relative to defaults. */
  hasCatalogChanges(): boolean {
    this.ensureInitialized();
    if (this.removedDefaultIds.size > 0) return true;
    for (const p of this.packs.values()) {
      if (!this.isSameAsDefault(p)) return true;
    }
    return false;
  }

  register(pack: PolyExtensionPack, persist = true): void {
    this.removedDefaultIds.delete(pack.id);
    this.packs.set(pack.id, pack);
    if (!this.activeLocalPacks.has(pack.id)) {
      registerPackIntoBlocklyAndGenerators(pack, this.attachedBackends.values());
    }
    if (persist) {
      this.persistCatalogPatch();
    }
  }

  /**
   * Synchronizes the currently active project's embedded packs into Blockly & all registered backends.
   * Restores global definitions for any previously overridden IDs, then applies project-local overrides.
   */
  setActiveProjectLocalPacks(localPacks: PolyExtensionPack[] = []): void {
    this.ensureInitialized();
    const prevList = Array.from(this.activeLocalPacks.values());
    if (
      prevList.length === localPacks.length &&
      prevList.every((p, idx) => p === localPacks[idx])
    ) {
      return;
    }
    const prevOverriddenIds = Array.from(this.activeLocalPacks.keys());
    const nextLocalIds = new Set(localPacks.map((p) => p.id));
    this.activeLocalPacks.clear();

    for (const oldId of prevOverriddenIds) {
      if (nextLocalIds.has(oldId)) continue;
      const globalPack = this.packs.get(oldId);
      if (globalPack) {
        registerPackIntoBlocklyAndGenerators(
          globalPack,
          this.attachedBackends.values(),
        );
      }
    }

    for (const rawPack of localPacks) {
      this.activeLocalPacks.set(rawPack.id, rawPack);
      registerPackIntoBlocklyAndGenerators(
        rawPack,
        this.attachedBackends.values(),
      );
    }
  }

  /**
   * Executes `fn` with `localPacks` temporarily active as the project-local override scope,
   * unconditionally restoring the previous scope in `finally` (safe for non-active project export/compile).
   */
  withLocalPacks<T>(
    localPacks: PolyExtensionPack[] | undefined,
    fn: () => T,
  ): T {
    this.ensureInitialized();
    const prev = Array.from(this.activeLocalPacks.values());
    const next = localPacks ?? [];
    const sameOrderAndRefs =
      prev.length === next.length &&
      prev.every((p, idx) => p === next[idx]);
    if (sameOrderAndRefs) {
      return fn();
    }
    this.setActiveProjectLocalPacks(next);
    try {
      return fn();
    } finally {
      this.setActiveProjectLocalPacks(prev);
    }
  }

  validateProjectLocalPack(raw: unknown): PolyExtensionPack {
    this.ensureInitialized();
    return validateExtensionPack(raw);
  }

  /** Imports a new global pack or updates an existing pack with the same ID (100% equal rights). */
  importPack(raw: unknown): PolyExtensionPack {
    this.ensureInitialized();
    const valid = validateExtensionPack(raw);
    this.register(valid, true);
    return valid;
  }

  /** Removes any pack from the global catalog (zero built-in lock). */
  removePack(packId: string): boolean {
    this.ensureInitialized();
    if (!this.packs.has(packId)) return false;
    this.packs.delete(packId);
    if (DEFAULT_PACK_JSON_BY_ID.has(packId)) {
      this.removedDefaultIds.add(packId);
    }
    this.persistCatalogPatch();
    return true;
  }

  /** Restores the global pack catalog to factory defaults from `src/packs/`. */
  resetToDefaults(): void {
    this.ensureInitialized();
    this.packs.clear();
    this.removedDefaultIds.clear();
    for (const pack of DEFAULT_EXTENSION_PACKS) {
      this.register(pack, false);
    }
    try {
      localStorage.removeItem(STORAGE_GLOBAL_EXTENSIONS_KEY);
    } catch {
      // ignore storage errors
    }
  }

  private persistCatalogPatch(): void {
    try {
      const changedPacks = Array.from(this.packs.values()).filter(
        (p) => !this.isSameAsDefault(p),
      );
      const removedIds = Array.from(this.removedDefaultIds);
      if (changedPacks.length === 0 && removedIds.length === 0) {
        localStorage.removeItem(STORAGE_GLOBAL_EXTENSIONS_KEY);
      } else {
        localStorage.setItem(
          STORAGE_GLOBAL_EXTENSIONS_KEY,
          JSON.stringify({ packs: changedPacks, removedIds }),
        );
      }
    } catch {
      // ignore quota errors
    }
  }

  /** Lists all packs currently registered in the global catalog (never includes project-embedded packs). */
  listAll(): PolyExtensionPack[] {
    this.ensureInitialized();
    return Array.from(this.packs.values());
  }

  get(packId: string): PolyExtensionPack | undefined {
    this.ensureInitialized();
    return this.packs.get(packId);
  }

  /** Resolves a pack by whole pack ID (`"rt"`) OR section capability ID (`"rt.timers"`). */
  resolvePack(
    capOrPackId: string,
    localPacks?: PolyExtensionPack[],
  ): PolyExtensionPack | undefined {
    this.ensureInitialized();
    const dotIdx = capOrPackId.indexOf('.');
    const basePackId = dotIdx > 0 ? capOrPackId.slice(0, dotIdx) : capOrPackId;
    if (localPacks) {
      const localMatch = localPacks.find((p) => p.id === basePackId);
      if (localMatch) return localMatch;
    } else {
      const activeLocal = this.activeLocalPacks.get(basePackId);
      if (activeLocal) return activeLocal;
    }
    return this.packs.get(basePackId);
  }

  /** Finds the owning pack, resolved section, and block definition for any declarative block type. */
  findOwnerForBlockType(
    blockType: string,
  ):
    | {
        pack: PolyExtensionPack;
        section: ResolvedPackSection;
        block: ExtensionBlockDef;
      }
    | undefined {
    this.ensureInitialized();
    const searchPacks = [
      ...this.activeLocalPacks.values(),
      ...Array.from(this.packs.values()).filter(
        (p) => !this.activeLocalPacks.has(p.id),
      ),
    ];
    for (const pack of searchPacks) {
      for (const sec of resolvePackSections(pack)) {
        const blk = sec.blocks.find((b) => b.type === blockType);
        if (blk) {
          return { pack, section: sec, block: blk };
        }
      }
    }
    return undefined;
  }

  getHatBlockDef(
    blockType: string,
  ):
    | {
        pack: PolyExtensionPack;
        section: ResolvedPackSection;
        block: ExtensionBlockDef;
        hat: ExtensionHatSpec;
      }
    | undefined {
    const found = this.findOwnerForBlockType(blockType);
    if (found && found.block.kind === 'hat' && found.block.hat) {
      return {
        pack: found.pack,
        section: found.section,
        block: found.block,
        hat: found.block.hat,
      };
    }
    return undefined;
  }

  isDeclarativeHatBlock(blockType: string): boolean {
    return Boolean(this.getHatBlockDef(blockType));
  }

  renderHatScopeInfo(block: Blockly.Block): {
    label: string;
    shortLabel: string;
    category: 'lifecycle' | 'event' | 'function';
  } | null {
    const found = this.getHatBlockDef(block.type);
    if (!found) return null;
    const { pack, section, block: def, hat } = found;
    const defaultLang = backendRegistry.getDefaultId();
    const label = hat.scopeLabelTemplate
      ? renderExtensionTemplate(
          hat.scopeLabelTemplate,
          def,
          block,
          defaultLang,
          {},
          pack,
          section,
        )
      : hat.eventName;
    const shortLabel = hat.scopeShortTemplate
      ? renderExtensionTemplate(
          hat.scopeShortTemplate,
          def,
          block,
          defaultLang,
          {},
          pack,
          section,
        )
      : hat.eventName;
    return {
      label,
      shortLabel,
      category: hat.scopeCategory ?? 'event',
    };
  }

  renderHatDuplicateKey(block: Blockly.Block): string | null {
    const found = this.getHatBlockDef(block.type);
    if (!found || found.hat.mode !== 'dispatch' || !found.hat.duplicateKeyTemplate) {
      return null;
    }
    return renderExtensionTemplate(
      found.hat.duplicateKeyTemplate,
      found.block,
      block,
      backendRegistry.getDefaultId(),
      {},
      found.pack,
      found.section,
    );
  }

  /**
   * Renders extracted dispatch branch metadata from serialized JSON fields across all registered languages.
   */
  renderExtractedDispatchBranchFromFields(
    blockType: string,
    fields: Record<string, unknown>,
    fallbackIndex = 0,
  ): {
    blockType: string;
    eventName: string;
    fnPrefix: string;
    baseFnName: string;
    dupKey: string;
    params: string[];
    passParams: boolean;
    alwaysExtract: boolean;
    condition: Partial<Record<ScriptLanguageId, string>>;
    comment: Partial<Record<ScriptLanguageId, string>>;
  } | null {
    const found = this.getHatBlockDef(blockType);
    if (!found || found.hat.mode !== 'dispatch') {
      return null;
    }
    const { section, hat } = found;
    const alwaysExtract = Boolean(hat.extractBranchFnPrefix);
    const fnPrefix = hat.extractBranchFnPrefix ?? `${hat.eventName}_`;
    const params = [...(hat.params ?? [])];
    const passParams = !alwaysExtract && params.length > 0;
    const rawKey = hat.duplicateKeyTemplate
      ? renderTemplateFromRawFields(
          hat.duplicateKeyTemplate,
          fields,
          section,
          backendRegistry.getDefaultId(),
        )
      : String(fallbackIndex);
    const safeSuffix = rawKey.replace(/[^A-Za-z0-9_]+/g, '_') || String(fallbackIndex);
    const condition: Partial<Record<ScriptLanguageId, string>> = {};
    const comment: Partial<Record<ScriptLanguageId, string>> = {};
    for (const lang of getSupportedLanguageIds()) {
      const condTpl = hat.condition?.[lang];
      condition[lang] = condTpl
        ? renderTemplateFromRawFields(condTpl, fields, section, lang)
        : getLanguageDialect(lang).boolTrue;
      const cmtTpl = hat.branchComment?.[lang];
      comment[lang] = cmtTpl
        ? renderTemplateFromRawFields(cmtTpl, fields, section, lang)
        : '';
    }
    return {
      blockType,
      eventName: hat.eventName,
      fnPrefix,
      baseFnName: `${fnPrefix}${safeSuffix}`,
      dupKey: rawKey,
      params,
      passParams,
      alwaysExtract,
      condition,
      comment,
    };
  }

  renderExtractedDispatchBranchFromBlock(
    block: Blockly.Block,
    fallbackIndex = 0,
  ) {
    const fields: Record<string, unknown> = {};
    for (const input of block.inputList) {
      for (const field of input.fieldRow) {
        if (field.name) {
          fields[field.name] = field.getValue();
        }
      }
    }
    return this.renderExtractedDispatchBranchFromFields(
      block.type,
      fields,
      fallbackIndex,
    );
  }

  getEnabledSections(
    enabledIds: string[],
    localPacks?: PolyExtensionPack[],
  ): Array<{ pack: PolyExtensionPack; section: ResolvedPackSection }> {
    this.ensureInitialized();
    const out: Array<{ pack: PolyExtensionPack; section: ResolvedPackSection }> = [];
    const seenCapIds = new Set<string>();
    const candidatePackIds = new Set<string>();

    for (const id of enabledIds) {
      const dotIdx = id.indexOf('.');
      candidatePackIds.add(dotIdx > 0 ? id.slice(0, dotIdx) : id);
    }

    for (const packId of candidatePackIds) {
      const pack = this.resolvePack(packId, localPacks);
      if (!pack) continue;
      for (const sec of resolvePackSections(pack)) {
        if (seenCapIds.has(sec.capId)) continue;
        if (hasCapability(enabledIds, sec.capId)) {
          seenCapIds.add(sec.capId);
          out.push({ pack, section: sec });
        }
      }
    }
    return out;
  }

  getEnabledPacks(
    enabledIds: string[],
    localPacks?: PolyExtensionPack[],
  ): PolyExtensionPack[] {
    const out: PolyExtensionPack[] = [];
    const seen = new Set<string>();
    for (const { pack } of this.getEnabledSections(enabledIds, localPacks)) {
      if (seen.has(pack.id)) continue;
      seen.add(pack.id);
      out.push(pack);
    }
    return out;
  }

  getMergedBlocksForCategory(
    coreCategoryId: CoreCategoryTarget,
    enabledIds: string[],
    localPacks?: PolyExtensionPack[],
  ): ToolboxBlockSpec[] {
    const out: ToolboxBlockSpec[] = [];
    for (const { pack, section } of this.getEnabledSections(
      enabledIds,
      localPacks,
    )) {
      if (section.visible && section.categoryTarget === coreCategoryId) {
        out.push(...buildToolboxBlocksForSection(pack, section));
      }
    }
    return out;
  }

  getActiveSimPacks(
    enabledIds: string[],
    localPacks?: PolyExtensionPack[],
  ): PolyExtensionPack[] {
    const enabledByPack = new Map<
      string,
      { pack: PolyExtensionPack; blocks: ExtensionBlockDef[] }
    >();
    for (const { pack, section } of this.getEnabledSections(
      enabledIds,
      localPacks,
    )) {
      const entry = enabledByPack.get(pack.id);
      if (entry) {
        entry.blocks.push(...section.blocks);
      } else {
        enabledByPack.set(pack.id, { pack, blocks: [...section.blocks] });
      }
    }

    const out: PolyExtensionPack[] = [];
    for (const { pack, blocks } of enabledByPack.values()) {
      if (!pack.simWidgets || pack.simWidgets.length === 0) continue;
      if (!pack.sandboxMock && !(pack.libs && pack.libs.length > 0)) continue;

      const packUsesBlockWidgetKeys = getAllPackBlocks(pack).some(
        (b) => (b.simWidgetKeys?.length ?? 0) > 0,
      );
      if (!packUsesBlockWidgetKeys) {
        out.push(pack);
        continue;
      }

      const activeKeys = new Set<string>();
      for (const blk of blocks) {
        for (const k of blk.simWidgetKeys ?? []) {
          activeKeys.add(k);
        }
      }
      const filteredWidgets = pack.simWidgets.filter((w) =>
        activeKeys.has(w.key),
      );
      if (filteredWidgets.length > 0) {
        out.push({ ...pack, simWidgets: filteredWidgets });
      }
    }
    return out;
  }

  getChannelPools(
    enabledIds: string[],
    localPacks?: PolyExtensionPack[],
  ): Array<{
    pack: PolyExtensionPack;
    section: ResolvedPackSection;
    pool: ResolvedHandleChannelPoolSpec;
  }> {
    const out: Array<{
      pack: PolyExtensionPack;
      section: ResolvedPackSection;
      pool: ResolvedHandleChannelPoolSpec;
    }> = [];
    for (const { pack, section } of this.getEnabledSections(
      enabledIds,
      localPacks,
    )) {
      if (section.channelPool) {
        out.push({ pack, section, pool: section.channelPool });
      }
    }
    return out;
  }

  /**
   * Declaratively summarizes enabled runtime monitor cards (`scheduler` / `timers`) and the active
   * timer channel pool `configKey` purely from enabled sections' `runtimeMonitor` metadata.
   */
  getRuntimeMonitorSummary(
    enabledCaps: string[],
    localExts?: PolyExtensionPack[],
  ): {
    hasSchedulerMonitor: boolean;
    hasTimerMonitor: boolean;
    timerPoolConfigKey: string | null;
  } {
    let hasSchedulerMonitor = false;
    let hasTimerMonitor = false;
    let timerPoolConfigKey: string | null = null;

    for (const { section } of this.getEnabledSections(enabledCaps, localExts)) {
      if (section.runtimeMonitor === 'scheduler') {
        hasSchedulerMonitor = true;
      } else if (section.runtimeMonitor === 'timers') {
        hasTimerMonitor = true;
        if (!timerPoolConfigKey && section.channelPool?.configKey) {
          timerPoolConfigKey = section.channelPool.configKey;
        }
      }
    }

    return {
      hasSchedulerMonitor,
      hasTimerMonitor,
      timerPoolConfigKey,
    };
  }

  toCategorySpecs(
    enabledIds: string[],
    localPacks?: PolyExtensionPack[],
  ): BlockCategorySpec[] {
    return this.getEnabledSections(enabledIds, localPacks)
      .filter(
        ({ section }) => section.visible && section.categoryTarget === 'own',
      )
      .map(({ pack, section }) => ({
        id: section.isMultiSection
          ? `ext_${pack.id}_${section.sectionId}`
          : `ext_${pack.id}`,
        label: section.label,
        color: section.color,
        order: section.toolboxOrder,
        isExtension: true,
        blocks: buildToolboxBlocksForSection(pack, section),
        ...(section.channelPool
          ? {
              flyoutButton: {
                text: `⚙ 配置本句柄${section.channelPool.label}`,
                callbackKey: OPEN_HANDLE_CHANNEL_CONFIG_CALLBACK,
              },
            }
          : {}),
      }));
  }
}

export const extensionRegistry = new ExtensionRegistry();
