import * as Blockly from 'blockly';
import type { ScriptLanguageId } from '../../types/project';
import {
  LANGUAGE_DIALECTS,
  SUPPORTED_LANGUAGE_IDS,
  type ScriptBackendAdapter,
} from '../backends/types';
import type { BlockCategorySpec, ToolboxBlockSpec } from '../blocks/catalog';
import { createChannelIdField } from '../blocks/channelField';
import {
  DEFAULT_CHANNEL_COUNT,
  getActiveHandleScriptId,
  getActiveHandleScripts,
  isCurrentHandleScriptEntry,
} from '../blocks/workspaceContextBridge';
import { hasCapability } from '../capabilities/registry';
import { BUILTIN_EXTENSION_PACKS } from './builtinPacks';
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
  ExtensionModuleSource,
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

export const STORAGE_CUSTOM_EXTENSIONS_KEY = 'polyblock.extensions.custom.v3';
export const OPEN_HANDLE_CHANNEL_CONFIG_CALLBACK = 'OPEN_HANDLE_CHANNEL_CONFIG';

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
  const nonHatBlocks = getAllPackBlocks(pack).filter((b) => b.kind !== 'hat');
  const supported: ScriptLanguageId[] =
    nonHatBlocks.length === 0
      ? [...SUPPORTED_LANGUAGE_IDS]
      : SUPPORTED_LANGUAGE_IDS.filter((lang) =>
          nonHatBlocks.some((b) => Boolean(b.code?.[lang]?.template)),
        );
  const label =
    supported.length === 1
      ? `仅 ${LANGUAGE_DIALECTS[supported[0]].displayName}`
      : supported.map((lang) => LANGUAGE_DIALECTS[lang].displayName).join(' / ');
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
      label: `仅 ${LANGUAGE_DIALECTS[langs.supported[0]].shortLabel}`,
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

/**
 * Registers a single declarative block (including dynamic `field_channel_id` dropdowns
 * and top-level `hat` event callbacks) into Blockly's visual block registry.
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
              maxCount: pool?.max ?? 32,
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
  /** Built-in + user-imported GLOBAL packs (persisted in localStorage, shared across projects). */
  private readonly packs = new Map<string, PolyExtensionPack>();
  /** Currently active project's embedded local packs (override same-ID global packs without polluting global). */
  private readonly activeLocalPacks = new Map<string, PolyExtensionPack>();
  /** Attached target script backends bound via `backendRegistry.register(...)` (inverts circular dependency). */
  private readonly attachedBackends = new Map<ScriptLanguageId, ScriptBackendAdapter>();
  private initialized = false;

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

  ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;

    for (const pack of BUILTIN_EXTENSION_PACKS) {
      this.register(pack, false);
    }

    try {
      const raw = localStorage.getItem(STORAGE_CUSTOM_EXTENSIONS_KEY);
      if (raw) {
        const list = JSON.parse(raw) as unknown[];
        if (Array.isArray(list)) {
          for (const item of list) {
            try {
              const valid = validateExtensionPack(item);
              this.register({ ...valid, builtin: false }, false);
            } catch {
              // ignore corrupted custom entry
            }
          }
        }
      }
    } catch {
      // ignore storage errors in test/private envs
    }
  }

  register(pack: PolyExtensionPack, persistCustom = true): void {
    this.packs.set(pack.id, pack);
    if (!this.activeLocalPacks.has(pack.id)) {
      registerPackIntoBlocklyAndGenerators(pack, this.attachedBackends.values());
    }
    if (persistCustom && !pack.builtin) {
      this.persistCustomPacks();
    }
  }

  /**
   * Synchronizes the currently active project's embedded packs into Blockly & all registered backends.
   * Restores global definitions for any previously overridden IDs, then applies project-local overrides.
   */
  setActiveProjectLocalPacks(localPacks: PolyExtensionPack[] = []): void {
    this.ensureInitialized();
    const prevOverriddenIds = Array.from(this.activeLocalPacks.keys());
    this.activeLocalPacks.clear();

    for (const oldId of prevOverriddenIds) {
      const globalPack = this.packs.get(oldId);
      if (globalPack) {
        registerPackIntoBlocklyAndGenerators(
          globalPack,
          this.attachedBackends.values(),
        );
      }
    }

    for (const rawPack of localPacks) {
      const normalized: PolyExtensionPack = { ...rawPack, builtin: false };
      this.activeLocalPacks.set(normalized.id, normalized);
      registerPackIntoBlocklyAndGenerators(
        normalized,
        this.attachedBackends.values(),
      );
    }
  }

  validateProjectLocalPack(raw: unknown): PolyExtensionPack {
    this.ensureInitialized();
    const valid = validateExtensionPack(raw);
    return { ...valid, builtin: false };
  }

  importCustomPack(raw: unknown): PolyExtensionPack {
    this.ensureInitialized();
    const valid = validateExtensionPack(raw);
    const existing = this.packs.get(valid.id);
    if (existing?.builtin) {
      throw new Error(
        `全局库不允许覆盖预装包 "${valid.id}"；如需定制覆写，请在「项目配置 → 能力与外设」导入为项目内嵌包`,
      );
    }
    const customPack: PolyExtensionPack = { ...valid, builtin: false };
    this.register(customPack, true);
    return customPack;
  }

  removeCustomPack(packId: string): boolean {
    this.ensureInitialized();
    const pack = this.packs.get(packId);
    if (!pack || pack.builtin) return false;
    this.packs.delete(packId);
    this.persistCustomPacks();
    return true;
  }

  private persistCustomPacks(): void {
    try {
      const customOnly = Array.from(this.packs.values()).filter((p) => !p.builtin);
      localStorage.setItem(
        STORAGE_CUSTOM_EXTENSIONS_KEY,
        JSON.stringify(customOnly),
      );
    } catch {
      // ignore quota errors
    }
  }

  /** Lists ONLY built-in + global custom packs (never includes project-embedded packs). */
  listAll(): PolyExtensionPack[] {
    this.ensureInitialized();
    return Array.from(this.packs.values());
  }

  listBySource(source: 'builtin' | 'custom'): PolyExtensionPack[] {
    return this.listAll().filter((p) =>
      source === 'builtin' ? Boolean(p.builtin) : !p.builtin,
    );
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
      ...this.packs.values(),
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

  findPackForBlockType(blockType: string): PolyExtensionPack | undefined {
    return this.findOwnerForBlockType(blockType)?.pack;
  }

  getBlockDef(
    blockType: string,
  ):
    | {
        pack: PolyExtensionPack;
        section: ResolvedPackSection;
        block: ExtensionBlockDef;
      }
    | undefined {
    return this.findOwnerForBlockType(blockType);
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
    const label = hat.scopeLabelTemplate
      ? renderExtensionTemplate(
          hat.scopeLabelTemplate,
          def,
          block,
          SUPPORTED_LANGUAGE_IDS[0],
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
          SUPPORTED_LANGUAGE_IDS[0],
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
      SUPPORTED_LANGUAGE_IDS[0],
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
          SUPPORTED_LANGUAGE_IDS[0],
        )
      : String(fallbackIndex);
    const safeSuffix = rawKey.replace(/[^A-Za-z0-9_]+/g, '_') || String(fallbackIndex);
    const condition: Partial<Record<ScriptLanguageId, string>> = {};
    const comment: Partial<Record<ScriptLanguageId, string>> = {};
    for (const lang of SUPPORTED_LANGUAGE_IDS) {
      const condTpl = hat.condition?.[lang];
      condition[lang] = condTpl
        ? renderTemplateFromRawFields(condTpl, fields, section, lang)
        : LANGUAGE_DIALECTS[lang].boolTrue;
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

  getSandboxMocks(
    enabledIds: string[],
    localPacks?: PolyExtensionPack[],
  ): ExtensionModuleSource[] {
    const out: ExtensionModuleSource[] = [];
    for (const p of this.getEnabledPacks(enabledIds, localPacks)) {
      if (p.sandboxMock) {
        out.push({ ...p.sandboxMock, packId: p.id });
      }
      for (const lib of p.libs ?? []) {
        out.push({ ...lib, packId: p.id });
      }
    }
    return out;
  }

  getBundleModules(
    enabledIds: string[],
    localPacks?: PolyExtensionPack[],
  ): ExtensionModuleSource[] {
    const out: ExtensionModuleSource[] = [];
    for (const p of this.getEnabledPacks(enabledIds, localPacks)) {
      for (const lib of p.libs ?? []) {
        out.push({ ...lib, packId: p.id });
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
