import * as Blockly from 'blockly';
import { luaGenerator, Order as LuaOrder } from 'blockly/lua';
import { Order as PyOrder, pythonGenerator } from 'blockly/python';
import {
  buildLuaHoistedLocalsLine,
  buildPythonGlobalLineForBlocks,
  buildPythonHoistedLocalsLine,
  codegenContext,
  formatLuaVarRef,
  formatPythonVarRef,
} from '../backends/codegenContext';
import type { BlockCategorySpec, ToolboxBlockSpec } from '../blocks/catalog';
import { createChannelIdField } from '../blocks/channelField';
import {
  DEFAULT_CHANNEL_COUNT,
  formatChannelLabel,
  getActiveChannelPoolConfig,
  getActiveHandleScriptId,
  getActiveHandleScripts,
  isCurrentHandleScriptEntry,
} from '../blocks/timerConfigBridge';
import { hasCapability } from '../capabilities/registry';
import { BUILTIN_EXTENSION_PACKS } from './builtinPacks';
import type {
  CategoryTargetSpec,
  CoreCategoryTarget,
  ExtensionBlockDef,
  ExtensionHatSpec,
  ExtensionModuleSource,
  ExtensionPackImports,
  ExtensionSectionSpec,
  HandleConfigSpec,
  PackAttributeBadge,
  PolyExtensionPack,
  ResolvedHandleChannelPoolSpec,
  ResolvedPackSection,
  SimWidgetEventTrigger,
  SimWidgetKind,
  SimWidgetSpec,
} from './types';

export const STORAGE_CUSTOM_EXTENSIONS_KEY = 'polyblock.extensions.custom.v2';
export const DEFAULT_PACK_TOOLBOX_ORDER = 100;
export const OPEN_HANDLE_CHANNEL_CONFIG_CALLBACK = 'OPEN_HANDLE_CHANNEL_CONFIG';

export const CORE_CATEGORY_LABELS: Record<CoreCategoryTarget, string> = {
  event: '事件',
  print: '打印',
  control: '控制',
  variables: '变量',
  math: '运算',
  logic: '逻辑',
  text: '文本',
  lists: '列表',
  dicts: '字典',
  functions: '函数',
};

const VALID_CORE_CATEGORY_TARGETS = new Set<string>(
  Object.keys(CORE_CATEGORY_LABELS),
);

function parseCategoryTarget(raw: unknown): CategoryTargetSpec {
  if (typeof raw === 'string' && VALID_CORE_CATEGORY_TARGETS.has(raw)) {
    return raw as CoreCategoryTarget;
  }
  return 'own';
}

/** Returns all blocks across all sections of a pack in declaration order. */
export function getAllPackBlocks(pack: PolyExtensionPack): ExtensionBlockDef[] {
  return pack.sections.flatMap((s) => s.blocks);
}

/**
 * Normalizes a pack's `sections[]` into `ResolvedPackSection[]` with guaranteed derived
 * `capId`, `channelPool.configKey`, `channelPool.prefix`, `color`, `visible`, and `toolboxOrder`.
 */
export function resolvePackSections(
  pack: PolyExtensionPack,
): ResolvedPackSection[] {
  const isMultiSection = pack.sections.length > 1;
  return pack.sections.map((sec) => {
    const capId = isMultiSection ? `${pack.id}.${sec.id}` : pack.id;
    const resolvedConfigs: ResolvedHandleChannelPoolSpec[] = (
      sec.handleConfigs ?? []
    )
      .filter((c) => c.kind === 'channel-pool')
      .map((c) => ({
        kind: 'channel-pool',
        configKey: c.configKey?.trim() || capId,
        label: c.label,
        prefix: c.prefix?.trim() || 'CH',
        min: c.min,
        max: c.max,
        defaultCount: c.defaultCount,
        ...(c.presets ? { presets: c.presets } : {}),
        ...(c.hint ? { hint: c.hint } : {}),
      }));

    return {
      capId,
      sectionId: sec.id,
      label: sec.label,
      description: sec.description,
      visible: sec.visible !== false,
      categoryTarget: sec.categoryTarget ?? 'own',
      toolboxOrder: sec.toolboxOrder ?? DEFAULT_PACK_TOOLBOX_ORDER,
      color: sec.color ?? pack.color,
      handleConfigs: resolvedConfigs,
      channelPool: resolvedConfigs[0],
      blocks: sec.blocks,
      isMultiSection,
    };
  });
}

export function findSectionForBlockType(
  pack: PolyExtensionPack,
  blockType: string,
): ResolvedPackSection | undefined {
  return resolvePackSections(pack).find((sec) =>
    sec.blocks.some((b) => b.type === blockType),
  );
}

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
 * Statement/value blocks may provide Lua-only, Python-only, or dual-language templates.
 */
export function getPackSupportedLanguages(pack: PolyExtensionPack): {
  lua: boolean;
  python: boolean;
  label: string;
} {
  const nonHatBlocks = getAllPackBlocks(pack).filter((b) => b.kind !== 'hat');
  if (nonHatBlocks.length === 0) {
    return { lua: true, python: true, label: 'Lua 5.4 / Python 3' };
  }
  const lua = nonHatBlocks.some((b) => Boolean(b.lua?.template));
  const python = nonHatBlocks.some((b) => Boolean(b.python?.template));
  const label =
    lua && python
      ? 'Lua 5.4 / Python 3'
      : lua
        ? '仅 Lua 5.4'
        : '仅 Python 3';
  return { lua, python, label };
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
  if (langs.lua && !langs.python) {
    badges.push({ id: 'lang-only', label: '仅 Lua', tone: 'tag' });
  } else if (langs.python && !langs.lua) {
    badges.push({ id: 'lang-only', label: '仅 Python', tone: 'tag' });
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

const SENTINEL_START = '__PB_S:';
const SENTINEL_END = '__PB_E:';
const PLACEHOLDER_RE =
  /\{\{([A-Za-z0-9_]+)(?::([a-z0-9_]+)(?::([A-Za-z0-9_]+))?)?\}\}/g;

const VALID_SIM_WIDGET_KINDS = new Set<SimWidgetKind>([
  'led',
  'tricolor',
  'rgb',
  'bar',
  'screen',
  'slider',
  'toggle',
  'button',
]);

function indentLines(code: string, extraSpaces: string): string {
  if (!code) return '';
  return code
    .split('\n')
    .map((line) => (line.length > 0 ? `${extraSpaces}${line}` : line))
    .join('\n');
}

function buildArgKindMap(def: ExtensionBlockDef): Map<string, string> {
  const map = new Map<string, string>();
  for (const arg of def.args0 ?? []) {
    if (typeof arg.name === 'string' && typeof arg.type === 'string') {
      map.set(arg.name, arg.type);
    }
  }
  return map;
}

function renderTemplate(
  template: string,
  def: ExtensionBlockDef,
  block: Blockly.Block,
  lang: 'lua' | 'python',
  pack?: PolyExtensionPack,
  section?: ResolvedPackSection,
): string {
  const argKinds = buildArgKindMap(def);
  const pool =
    section?.channelPool ??
    (pack ? findSectionForBlockType(pack, def.type)?.channelPool : undefined);
  const poolKey = pool?.configKey ?? 'default';
  const poolPrefix = pool?.prefix ?? 'CH';
  const poolDefault = pool?.defaultCount ?? DEFAULT_CHANNEL_COUNT;

  return template.replace(
    PLACEHOLDER_RE,
    (_full, argName: string, mod?: string, modParam?: string) => {
      const argType = argKinds.get(argName);
      let rawValue = '';

      if (argType === 'input_value') {
        if (lang === 'lua') {
          rawValue = luaGenerator.valueToCode(block, argName, LuaOrder.NONE) || '""';
        } else {
          rawValue =
            pythonGenerator.valueToCode(block, argName, PyOrder.NONE) || '""';
        }
        return rawValue;
      }

      if (argType === 'field_variable') {
        const varId = String(block.getFieldValue(argName) || '');
        return lang === 'lua'
          ? formatLuaVarRef(varId, luaGenerator, block)
          : formatPythonVarRef(varId, pythonGenerator, block);
      }

      rawValue = String(block.getFieldValue(argName) ?? '');

      if (mod === 'json') {
        return JSON.stringify(rawValue);
      }
      if (mod === 'int') {
        const n = Number(rawValue);
        return String(Number.isFinite(n) ? Math.trunc(n) : 0);
      }
      if (mod === 'min10_int') {
        const n = Number(rawValue);
        return String(Number.isFinite(n) ? Math.max(10, Math.round(n)) : 100);
      }
      if (mod === 'bool_lua') {
        return rawValue === 'true' || rawValue === 'TRUE' || rawValue === '1'
          ? 'true'
          : 'false';
      }
      if (mod === 'bool_py') {
        return rawValue === 'true' || rawValue === 'TRUE' || rawValue === '1'
          ? 'True'
          : 'False';
      }
      if (mod === 'edge_lua' || mod === 'edge_py') {
        const param = modParam || 'pressed';
        return rawValue === 'press' || rawValue === 'true' || rawValue === '1'
          ? param
          : `not ${param}`;
      }
      if (mod === 'edge_zh') {
        return rawValue === 'press' || rawValue === 'true' || rawValue === '1'
          ? '按下'
          : '释放';
      }
      if (mod === 'channel_comment_lua') {
        const tid = Math.trunc(Number(rawValue || 0));
        const alias = getActiveChannelPoolConfig(poolKey, poolDefault).aliases[
          String(tid)
        ];
        return alias ? ` -- ${poolPrefix}${tid}: ${alias}` : '';
      }
      if (mod === 'channel_comment_py') {
        const tid = Math.trunc(Number(rawValue || 0));
        const alias = getActiveChannelPoolConfig(poolKey, poolDefault).aliases[
          String(tid)
        ];
        return alias ? `  # ${poolPrefix}${tid}: ${alias}` : '';
      }
      if (mod === 'channel_label') {
        const tid = Math.trunc(Number(rawValue || 0));
        return formatChannelLabel(
          tid,
          getActiveChannelPoolConfig(poolKey, poolDefault),
          poolPrefix,
        );
      }
      return rawValue;
    },
  );
}

/**
 * Renders a hat template string directly from serialized `fields` (without requiring a live Blockly.Block).
 * Used to inspect sibling scripts' extracted dispatch branches (`on_timer_0`, etc.) for entry-script routing.
 */
function renderTemplateFromRawFields(
  template: string,
  fields: Record<string, unknown>,
  section: ResolvedPackSection,
): string {
  const pool = section.channelPool;
  const poolKey = pool?.configKey ?? 'default';
  const poolPrefix = pool?.prefix ?? 'CH';
  const poolDefault = pool?.defaultCount ?? DEFAULT_CHANNEL_COUNT;

  return template.replace(
    PLACEHOLDER_RE,
    (_full, argName: string, mod?: string, modParam?: string) => {
      const rawValue = String(fields[argName] ?? '');
      if (mod === 'json') return JSON.stringify(rawValue);
      if (mod === 'int') {
        const n = Number(rawValue);
        return String(Number.isFinite(n) ? Math.trunc(n) : 0);
      }
      if (mod === 'min10_int') {
        const n = Number(rawValue);
        return String(Number.isFinite(n) ? Math.max(10, Math.round(n)) : 100);
      }
      if (mod === 'bool_lua') {
        return rawValue === 'true' || rawValue === 'TRUE' || rawValue === '1'
          ? 'true'
          : 'false';
      }
      if (mod === 'bool_py') {
        return rawValue === 'true' || rawValue === 'TRUE' || rawValue === '1'
          ? 'True'
          : 'False';
      }
      if (mod === 'edge_lua' || mod === 'edge_py') {
        const param = modParam || 'pressed';
        return rawValue === 'press' || rawValue === 'true' || rawValue === '1'
          ? param
          : `not ${param}`;
      }
      if (mod === 'edge_zh') {
        return rawValue === 'press' || rawValue === 'true' || rawValue === '1'
          ? '按下'
          : '释放';
      }
      if (mod === 'channel_comment_lua') {
        const tid = Math.trunc(Number(rawValue || 0));
        const alias = getActiveChannelPoolConfig(poolKey, poolDefault).aliases[
          String(tid)
        ];
        return alias ? ` -- ${poolPrefix}${tid}: ${alias}` : '';
      }
      if (mod === 'channel_comment_py') {
        const tid = Math.trunc(Number(rawValue || 0));
        const alias = getActiveChannelPoolConfig(poolKey, poolDefault).aliases[
          String(tid)
        ];
        return alias ? `  # ${poolPrefix}${tid}: ${alias}` : '';
      }
      if (mod === 'channel_label') {
        const tid = Math.trunc(Number(rawValue || 0));
        return formatChannelLabel(
          tid,
          getActiveChannelPoolConfig(poolKey, poolDefault),
          poolPrefix,
        );
      }
      return rawValue;
    },
  );
}

/**
 * Registers a single declarative block (including dynamic `field_channel_id` dropdowns
 * and top-level `hat` event callbacks) into Blockly.
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

/**
 * Pure content-based import hoisting & deduplication across ALL packs and sections.
 * Zero hardcoded module names: identical trimmed import lines collapse to one hoisted line.
 */
function hoistImports(generator: unknown, imports: string[] | undefined): void {
  if (!imports || imports.length === 0) return;
  const defs = (generator as { definitions_: Record<string, string> }).definitions_;
  for (const rawImp of imports) {
    const imp = rawImp.trim();
    if (!imp) continue;
    defs[`imp_${imp}`] = imp;
  }
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

function registerHatGenerators(
  pack: PolyExtensionPack,
  b: ExtensionBlockDef,
  hatSpec: ExtensionHatSpec,
  section: ResolvedPackSection,
): void {
  const paramsStr = (hatSpec.params ?? []).join(', ');
  const branchParamsStr = hatSpec.extractBranchFnPrefix ? '' : paramsStr;

  // --- Lua Hat Generator ---
  luaGenerator.forBlock[b.type] = (block, generator) => {
    hoistImports(generator, hatSpec.imports?.lua);

    if (hatSpec.mode === 'singleton') {
      const hoistedLocals = buildLuaHoistedLocalsLine([block], 'BODY', '  ');
      const body = generator.statementToCode(block, 'BODY');
      if (codegenContext.debugPass) {
        return `function ${hatSpec.eventName}(${paramsStr})\n${hoistedLocals}${body}end\n`;
      }
      return (
        `${SENTINEL_START}'${block.id}'__\n` +
        `function ${hatSpec.eventName}(${paramsStr})\n` +
        `${hoistedLocals}${body}` +
        `end\n` +
        `${SENTINEL_END}'${block.id}'__\n`
      );
    }

    // Dispatch mode: aggregate all enabled hats of this block type
    const dispatchKey = `${hatSpec.eventName}:${b.type}`;
    if (codegenContext.emittedDispatchEvents.has(dispatchKey)) return '';
    codegenContext.emittedDispatchEvents.add(dispatchKey);

    const matchingHats = block.workspace
      .getTopBlocks(true)
      .filter((top) => top.type === b.type && !top.isShadow() && top.isEnabled());
    if (matchingHats.length === 0) return '';

    if (shouldExtractDispatchBranchesForEvent(hatSpec)) {
      // Centralized entry routing: emit ONLY the extracted global branch functions (`on_timer_0`, `on_button_A_press`, etc.).
      // The handle's entry script (`main.lua`) aggregates ALL branches across the handle into ONE router!
      const fnPrefix = hatSpec.extractBranchFnPrefix ?? `${hatSpec.eventName}_`;
      const usedFnNames = new Set<string>();
      const fnDefs: string[] = [];

      matchingHats.forEach((hatBlk, idx) => {
        const comment = hatSpec.branchCommentLua
          ? renderTemplate(
              hatSpec.branchCommentLua,
              b,
              hatBlk,
              'lua',
              pack,
              section,
            )
          : '';
        const rawKey = hatSpec.duplicateKeyTemplate
          ? renderTemplate(
              hatSpec.duplicateKeyTemplate,
              b,
              hatBlk,
              'lua',
              pack,
              section,
            )
          : String(idx);
        const safeSuffix = rawKey.replace(/[^A-Za-z0-9_]+/g, '_') || String(idx);
        let fnName = `${fnPrefix}${safeSuffix}`;
        let dupIdx = 2;
        while (usedFnNames.has(fnName)) {
          fnName = `${fnPrefix}${safeSuffix}_${dupIdx}`;
          dupIdx += 1;
        }
        usedFnNames.add(fnName);

        const hoistedLocals = buildLuaHoistedLocalsLine([hatBlk], 'BODY', '  ');
        const rawBody = generator.statementToCode(hatBlk, 'BODY');
        const headerComment = comment.trim() ? `${comment.trim()}\n` : '';
        if (codegenContext.debugPass) {
          fnDefs.push(`function ${fnName}(${branchParamsStr})\n${hoistedLocals}${rawBody}end\n`);
        } else {
          fnDefs.push(
            `${SENTINEL_START}'${hatBlk.id}'__\n` +
              `${headerComment}` +
              `function ${fnName}(${branchParamsStr})\n` +
              `${hoistedLocals}${rawBody}` +
              `end\n` +
              `${SENTINEL_END}'${hatBlk.id}'__\n`,
          );
        }
      });

      return `${fnDefs.join('\n')}`;
    }

    const hoistedInlineLocals = buildLuaHoistedLocalsLine(matchingHats, 'BODY', '  ');
    const branches: string[] = [];
    matchingHats.forEach((hatBlk, idx) => {
      const kw = idx === 0 ? 'if' : 'elseif';
      const cond = hatSpec.conditionLua
        ? renderTemplate(hatSpec.conditionLua, b, hatBlk, 'lua', pack, section)
        : 'true';
      const comment = hatSpec.branchCommentLua
        ? renderTemplate(hatSpec.branchCommentLua, b, hatBlk, 'lua', pack, section)
        : '';
      const rawBody = generator.statementToCode(hatBlk, 'BODY');
      const indentedBody = indentLines(rawBody, '  ');
      if (codegenContext.debugPass) {
        branches.push(`  ${kw} ${cond} then${comment}\n${indentedBody}`);
      } else {
        branches.push(
          `${SENTINEL_START}'${hatBlk.id}'__\n` +
            `  ${kw} ${cond} then${comment}\n` +
            `${indentedBody}` +
            `${SENTINEL_END}'${hatBlk.id}'__\n`,
        );
      }
    });

    return `function ${hatSpec.eventName}(${paramsStr})\n${hoistedInlineLocals}${branches.join('')}  end\nend\n`;
  };

  // --- Python Hat Generator ---
  pythonGenerator.forBlock[b.type] = (block, generator) => {
    hoistImports(generator, hatSpec.imports?.python);
    const defKw = codegenContext.debugPass ? 'async def' : 'def';
    const formalParams = hatSpec.params ?? [];
    const branchFormalParams = hatSpec.extractBranchFnPrefix ? [] : formalParams;

    if (hatSpec.mode === 'singleton') {
      const body = generator.statementToCode(block, 'BODY');
      const globalLine = buildPythonGlobalLineForBlocks(
        [block],
        generator,
        formalParams,
      );
      const hoistedLocals = buildPythonHoistedLocalsLine([block], 'BODY', '  ');
      const safeBody = body.trim() ? body : '  pass\n';
      if (codegenContext.debugPass) {
        return `${defKw} ${hatSpec.eventName}(${paramsStr}):\n${globalLine}${hoistedLocals}${safeBody}\n`;
      }
      return (
        `${SENTINEL_START}'${block.id}'__\n` +
        `${defKw} ${hatSpec.eventName}(${paramsStr}):\n` +
        `${globalLine}${hoistedLocals}${safeBody}` +
        `${SENTINEL_END}'${block.id}'__\n`
      );
    }

    const dispatchKey = `${hatSpec.eventName}:${b.type}`;
    if (codegenContext.emittedDispatchEvents.has(dispatchKey)) return '';
    codegenContext.emittedDispatchEvents.add(dispatchKey);

    const matchingHats = block.workspace
      .getTopBlocks(true)
      .filter((top) => top.type === b.type && !top.isShadow() && top.isEnabled());
    if (matchingHats.length === 0) return '';

    if (shouldExtractDispatchBranchesForEvent(hatSpec)) {
      const fnPrefix = hatSpec.extractBranchFnPrefix ?? `${hatSpec.eventName}_`;
      const usedFnNames = new Set<string>();
      const fnDefs: string[] = [];

      matchingHats.forEach((hatBlk, idx) => {
        const comment = hatSpec.branchCommentPython
          ? renderTemplate(
              hatSpec.branchCommentPython,
              b,
              hatBlk,
              'python',
              pack,
              section,
            )
          : '';
        const rawKey = hatSpec.duplicateKeyTemplate
          ? renderTemplate(
              hatSpec.duplicateKeyTemplate,
              b,
              hatBlk,
              'python',
              pack,
              section,
            )
          : String(idx);
        const safeSuffix = rawKey.replace(/[^A-Za-z0-9_]+/g, '_') || String(idx);
        let fnName = `${fnPrefix}${safeSuffix}`;
        let dupIdx = 2;
        while (usedFnNames.has(fnName)) {
          fnName = `${fnPrefix}${safeSuffix}_${dupIdx}`;
          dupIdx += 1;
        }
        usedFnNames.add(fnName);

        const rawBody = generator.statementToCode(hatBlk, 'BODY');
        const branchGlobalLine = buildPythonGlobalLineForBlocks(
          [hatBlk],
          generator,
          branchFormalParams,
        );
        const branchHoistedLocals = buildPythonHoistedLocalsLine(
          [hatBlk],
          'BODY',
          '  ',
        );
        const safeBody = rawBody.trim() ? rawBody : '  pass\n';
        const headerComment = comment.trim() ? `${comment.trim()}\n` : '';
        if (codegenContext.debugPass) {
          fnDefs.push(
            `${defKw} ${fnName}(${branchParamsStr}):\n${branchGlobalLine}${branchHoistedLocals}${safeBody}\n`,
          );
        } else {
          fnDefs.push(
            `${SENTINEL_START}'${hatBlk.id}'__\n` +
              `${headerComment}` +
              `${defKw} ${fnName}(${branchParamsStr}):\n` +
              `${branchGlobalLine}${branchHoistedLocals}${safeBody}` +
              `${SENTINEL_END}'${hatBlk.id}'__\n`,
          );
        }
      });

      return `${fnDefs.join('\n')}`;
    }

    const dispatchGlobalLine = buildPythonGlobalLineForBlocks(
      matchingHats,
      generator,
      formalParams,
    );
    const dispatchHoistedLocals = buildPythonHoistedLocalsLine(
      matchingHats,
      'BODY',
      '  ',
    );
    const branches: string[] = [];
    matchingHats.forEach((hatBlk, idx) => {
      const kw = idx === 0 ? 'if' : 'elif';
      const cond = hatSpec.conditionPython
        ? renderTemplate(hatSpec.conditionPython, b, hatBlk, 'python', pack, section)
        : 'True';
      const comment = hatSpec.branchCommentPython
        ? renderTemplate(
            hatSpec.branchCommentPython,
            b,
            hatBlk,
            'python',
            pack,
            section,
          )
        : '';
      const rawBody = generator.statementToCode(hatBlk, 'BODY');
      const indentedBody = rawBody.trim()
        ? indentLines(rawBody, '  ')
        : '    pass\n';
      if (codegenContext.debugPass) {
        branches.push(`  ${kw} ${cond}:${comment}\n${indentedBody}`);
      } else {
        branches.push(
          `${SENTINEL_START}'${hatBlk.id}'__\n` +
            `  ${kw} ${cond}:${comment}\n` +
            `${indentedBody}` +
            `${SENTINEL_END}'${hatBlk.id}'__\n`,
        );
      }
    });

    return `${defKw} ${hatSpec.eventName}(${paramsStr}):\n${dispatchGlobalLine}${dispatchHoistedLocals}${branches.join('')}\n`;
  };
}

function registerPackIntoBlocklyAndGenerators(pack: PolyExtensionPack): void {
  const sections = resolvePackSections(pack);

  for (const section of sections) {
    for (const b of section.blocks) {
      registerSingleBlockInBlockly(pack, b, section);

      if (b.kind === 'hat' && b.hat) {
        registerHatGenerators(pack, b, b.hat, section);
        continue;
      }

      if (b.lua) {
        const luaSpec = b.lua;
        const luaImports =
          luaSpec.imports !== undefined ? luaSpec.imports : pack.imports?.lua;
        luaGenerator.forBlock[b.type] = (block, generator) => {
          hoistImports(generator, luaImports);
          const rendered = renderTemplate(
            luaSpec.template,
            b,
            block,
            'lua',
            pack,
            section,
          );
          if (b.kind === 'value') {
            return [rendered, LuaOrder.ATOMIC];
          }
          return `${rendered}\n`;
        };
      } else {
        luaGenerator.forBlock[b.type] = () => {
          if (b.kind === 'value') {
            return ['nil --[[ 未提供 Lua 模板 ]]', LuaOrder.ATOMIC];
          }
          return `-- [PolyBlock] 积木 "${b.type}" 仅支持 Python，未提供 lua.template\n`;
        };
      }

      if (b.python) {
        const pySpec = b.python;
        const pyImports =
          pySpec.imports !== undefined ? pySpec.imports : pack.imports?.python;
        pythonGenerator.forBlock[b.type] = (block, generator) => {
          hoistImports(generator, pyImports);
          const rendered = renderTemplate(
            pySpec.template,
            b,
            block,
            'python',
            pack,
            section,
          );
          if (b.kind === 'value') {
            return [rendered, PyOrder.ATOMIC];
          }
          return `${rendered}\n`;
        };
      } else {
        pythonGenerator.forBlock[b.type] = () => {
          if (b.kind === 'value') {
            return ['None  # 未提供 Python 模板', PyOrder.ATOMIC];
          }
          return `# [PolyBlock] 积木 "${b.type}" 仅支持 Lua，未提供 python.template\n`;
        };
      }
    }
  }
}

function validateEmitEvent(raw: unknown): SimWidgetEventTrigger | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') {
    throw new Error('emitEvent 必须是对象');
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.eventName !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(obj.eventName)
  ) {
    throw new Error(
      'emitEvent.eventName 必须是合法的函数名标识符（如 on_button / on_can_rx）',
    );
  }
  return {
    eventName: obj.eventName,
    ...(Array.isArray(obj.args)
      ? {
          args: obj.args.filter(
            (a): a is string | number | boolean =>
              typeof a === 'string' ||
              typeof a === 'number' ||
              typeof a === 'boolean',
          ),
        }
      : {}),
    ...(obj.trigger === 'rising' || obj.trigger === 'change'
      ? { trigger: obj.trigger }
      : {}),
  };
}

function validateSimWidgets(raw: unknown): SimWidgetSpec[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('simWidgets 必须是数组');
  }
  const out: SimWidgetSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      throw new Error('simWidgets 中的每一项必须是对象');
    }
    const w = item as Record<string, unknown>;
    if (
      typeof w.kind !== 'string' ||
      !VALID_SIM_WIDGET_KINDS.has(w.kind as SimWidgetKind)
    ) {
      throw new Error(
        `无效的模拟控件类型 "${String(w.kind)}"，支持：led / tricolor / rgb / bar / screen / slider / toggle / button`,
      );
    }
    if (typeof w.key !== 'string' || !w.key.trim()) {
      throw new Error(`模拟控件 (${w.kind}) 缺少非空 key 字段`);
    }
    if (typeof w.label !== 'string' || !w.label.trim()) {
      throw new Error(`模拟控件 (${w.key}) 缺少非空 label 字段`);
    }
    const emitEvent = validateEmitEvent(w.emitEvent);
    out.push({
      kind: w.kind as SimWidgetKind,
      key: w.key.trim(),
      label: w.label.trim(),
      ...(w.default !== undefined
        ? { default: w.default as SimWidgetSpec['default'] }
        : {}),
      ...(typeof w.color === 'string' && w.color.trim()
        ? { color: w.color.trim() }
        : {}),
      ...(typeof w.min === 'number' && Number.isFinite(w.min) ? { min: w.min } : {}),
      ...(typeof w.max === 'number' && Number.isFinite(w.max) ? { max: w.max } : {}),
      ...(typeof w.step === 'number' && Number.isFinite(w.step) && w.step > 0
        ? { step: w.step }
        : {}),
      ...(typeof w.unit === 'string' ? { unit: w.unit } : {}),
      ...(typeof w.maxLines === 'number' &&
      Number.isFinite(w.maxLines) &&
      w.maxLines >= 1
        ? { maxLines: Math.min(12, Math.trunc(w.maxLines)) }
        : {}),
      ...(typeof w.hint === 'string' ? { hint: w.hint } : {}),
      ...(Array.isArray(w.marks)
        ? { marks: w.marks.filter((m): m is string => typeof m === 'string') }
        : {}),
      ...(typeof w.activeLabel === 'string' ? { activeLabel: w.activeLabel } : {}),
      ...(typeof w.idleLabel === 'string' ? { idleLabel: w.idleLabel } : {}),
      ...(emitEvent ? { emitEvent } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function validateHandleConfigs(raw: unknown): HandleConfigSpec[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error('handleConfigs 必须是数组');
  const out: HandleConfigSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      throw new Error('handleConfigs 中的每一项必须是对象');
    }
    const obj = item as Record<string, unknown>;
    if (obj.kind !== 'channel-pool') {
      throw new Error(
        `暂不支持的 handleConfigs.kind "${String(obj.kind)}"（当前支持：channel-pool）`,
      );
    }
    const min = Number.isFinite(Number(obj.min))
      ? Math.max(1, Math.trunc(Number(obj.min)))
      : 1;
    const max = Number.isFinite(Number(obj.max))
      ? Math.max(min, Math.min(32, Math.trunc(Number(obj.max))))
      : 32;
    const defaultCount = Number.isFinite(Number(obj.defaultCount))
      ? Math.max(min, Math.min(max, Math.trunc(Number(obj.defaultCount))))
      : Math.min(max, 8);
    out.push({
      kind: 'channel-pool',
      ...(typeof obj.configKey === 'string' && obj.configKey.trim()
        ? { configKey: obj.configKey.trim() }
        : {}),
      label:
        typeof obj.label === 'string' && obj.label.trim() ? obj.label.trim() : '通道',
      ...(typeof obj.prefix === 'string' && obj.prefix.trim()
        ? { prefix: obj.prefix.trim() }
        : {}),
      min,
      max,
      defaultCount,
      ...(Array.isArray(obj.presets)
        ? {
            presets: obj.presets.filter(
              (n): n is number => typeof n === 'number' && Number.isFinite(n),
            ),
          }
        : {}),
      ...(typeof obj.hint === 'string' ? { hint: obj.hint } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function validateImports(raw: unknown): ExtensionPackImports | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('imports 必须是对象（含 lua / python 数组）');
  const obj = raw as Record<string, unknown>;
  const lua = Array.isArray(obj.lua)
    ? obj.lua.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : undefined;
  const python = Array.isArray(obj.python)
    ? obj.python.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : undefined;
  if (!lua?.length && !python?.length) return undefined;
  return {
    ...(lua?.length ? { lua } : {}),
    ...(python?.length ? { python } : {}),
  };
}

function validateModuleSource(
  raw: unknown,
  fieldLabel: string,
): ExtensionModuleSource | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') {
    throw new Error(`${fieldLabel} 必须是对象`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.moduleName !== 'string' || !obj.moduleName.trim()) {
    throw new Error(`${fieldLabel}.moduleName 必填`);
  }
  return {
    moduleName: obj.moduleName.trim(),
    ...(typeof obj.luaSource === 'string' ? { luaSource: obj.luaSource } : {}),
    ...(typeof obj.pythonSource === 'string'
      ? { pythonSource: obj.pythonSource }
      : {}),
    ...(obj.role === 'entry' || obj.role === 'helper' ? { role: obj.role } : {}),
  };
}

function validateLibs(raw: unknown): ExtensionModuleSource[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('libs 必须是数组');
  }
  const out: ExtensionModuleSource[] = [];
  const seen = new Set<string>();
  for (const [idx, item] of raw.entries()) {
    const mod = validateModuleSource(item, `libs[${idx}]`);
    if (!mod) continue;
    if (seen.has(mod.moduleName)) {
      throw new Error(`扩展包 libs[] 中存在重复的 moduleName "${mod.moduleName}"`);
    }
    seen.add(mod.moduleName);
    out.push(mod);
  }
  return out.length > 0 ? out : undefined;
}

function validateBlockDef(
  raw: unknown,
  seenBlockTypes: Set<string>,
): ExtensionBlockDef {
  if (!raw || typeof raw !== 'object') {
    throw new Error('每个积木定义必须是对象');
  }
  const blk = raw as Record<string, unknown>;
  if (typeof blk.type !== 'string' || !blk.type.trim()) {
    throw new Error('每个积木必须包含非空 type 字段');
  }
  if (seenBlockTypes.has(blk.type)) {
    throw new Error(`扩展包内存在重复积木类型 "${blk.type}"`);
  }
  seenBlockTypes.add(blk.type);

  if (blk.kind !== 'statement' && blk.kind !== 'value' && blk.kind !== 'hat') {
    throw new Error(
      `积木 ${blk.type} 的 kind 必须为 "statement"、"value" 或 "hat"`,
    );
  }
  if (typeof blk.message0 !== 'string' || !blk.message0.trim()) {
    throw new Error(`积木 ${blk.type} 缺少 message0`);
  }
  if (blk.kind === 'hat') {
    const hatObj = blk.hat as Record<string, unknown> | undefined;
    if (
      !hatObj ||
      typeof hatObj.eventName !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(hatObj.eventName)
    ) {
      throw new Error(`事件帽块 ${blk.type} 缺少合法的 hat.eventName`);
    }
    if (hatObj.mode !== 'singleton' && hatObj.mode !== 'dispatch') {
      throw new Error(
        `事件帽块 ${blk.type} 的 hat.mode 必须为 "singleton" 或 "dispatch"`,
      );
    }
  } else {
    const luaSpec = blk.lua as Record<string, unknown> | undefined;
    const pySpec = blk.python as Record<string, unknown> | undefined;
    const hasLua = Boolean(luaSpec && typeof luaSpec.template === 'string');
    const hasPy = Boolean(pySpec && typeof pySpec.template === 'string');
    if (luaSpec !== undefined && !hasLua) {
      throw new Error(`积木 ${blk.type} 的 lua 对象缺少字符串字段 template`);
    }
    if (pySpec !== undefined && !hasPy) {
      throw new Error(`积木 ${blk.type} 的 python 对象缺少字符串字段 template`);
    }
    if (!hasLua && !hasPy) {
      throw new Error(
        `积木 ${blk.type} 至少需要提供 lua.template 或 python.template 之一`,
      );
    }
  }
  return blk as unknown as ExtensionBlockDef;
}

function validateSections(raw: unknown): ExtensionSectionSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('扩展包必须至少包含 1 个 sections 组件定义');
  }

  const out: ExtensionSectionSpec[] = [];
  const seenIds = new Set<string>();
  const seenBlockTypes = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      throw new Error('sections 中的每一项必须是对象');
    }
    const s = item as Record<string, unknown>;
    if (typeof s.id !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(s.id)) {
      throw new Error(
        '每个 section 的 id 必填，且只能包含字母、数字、横线或下划线（1~32 字符）',
      );
    }
    if (seenIds.has(s.id)) {
      throw new Error(`扩展包内存在重复的 section id "${s.id}"`);
    }
    seenIds.add(s.id);
    if (typeof s.label !== 'string' || !s.label.trim()) {
      throw new Error(`section "${s.id}" 缺少非空 label`);
    }
    if (!Array.isArray(s.blocks) || s.blocks.length === 0) {
      throw new Error(`section "${s.id}" 必须至少包含 1 个 blocks 积木定义`);
    }
    const blocks = s.blocks.map((b) => validateBlockDef(b, seenBlockTypes));
    const rawOrder = Number(s.toolboxOrder);
    const handleConfigs = validateHandleConfigs(s.handleConfigs);

    out.push({
      id: s.id,
      label: s.label.trim().slice(0, 12),
      ...(typeof s.description === 'string' ? { description: s.description } : {}),
      visible: s.visible !== false,
      categoryTarget: parseCategoryTarget(s.categoryTarget),
      ...(Number.isFinite(rawOrder)
        ? { toolboxOrder: Math.max(0, Math.min(9999, Math.round(rawOrder))) }
        : {}),
      ...(typeof s.color === 'string' && s.color.startsWith('#')
        ? { color: s.color }
        : {}),
      ...(handleConfigs ? { handleConfigs } : {}),
      blocks,
    });
  }
  return out;
}

export function validateExtensionPack(raw: unknown): PolyExtensionPack {
  if (!raw || typeof raw !== 'object') {
    throw new Error('扩展包 JSON 必须是对象');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !/^[a-zA-Z0-9_-]{2,48}$/.test(obj.id)) {
    throw new Error(
      '扩展包 id 必填，且只能包含字母、数字、横线或下划线（2~48 字符）',
    );
  }
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    throw new Error('扩展包 name 必填');
  }
  const sections = validateSections(obj.sections);
  const iconLabelRaw =
    typeof obj.iconLabel === 'string' && obj.iconLabel.trim()
      ? obj.iconLabel.trim()
      : sections[0].label;

  const imports = validateImports(obj.imports);
  const simWidgets = validateSimWidgets(obj.simWidgets);
  const sandboxMock = validateModuleSource(obj.sandboxMock, 'sandboxMock');
  const libs = validateLibs(obj.libs);
  if (
    sandboxMock &&
    libs?.some((lib) => lib.moduleName === sandboxMock.moduleName)
  ) {
    throw new Error(
      `单包内禁止将同一 moduleName="${sandboxMock.moduleName}" 同时写入 libs[] 与 sandboxMock（同一模块名在单包内只能二选一：真实库放 libs[]，仅沙箱假桩放 sandboxMock）`,
    );
  }
  const tags = Array.isArray(obj.tags)
    ? obj.tags
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((t) => t.trim().slice(0, 12))
        .slice(0, 6)
    : undefined;

  return {
    ...(typeof obj.$schema === 'string' ? { $schema: obj.$schema } : {}),
    format: 'polyblock-extension',
    version: 1,
    id: obj.id,
    name: obj.name.trim(),
    packVersion: typeof obj.packVersion === 'string' ? obj.packVersion : '1.0.0',
    iconLabel: iconLabelRaw.slice(0, 6),
    color:
      typeof obj.color === 'string' && obj.color.startsWith('#')
        ? obj.color
        : '#6366f1',
    description:
      typeof obj.description === 'string'
        ? obj.description
        : '用户自定义扩展积木包',
    builtin: Boolean(obj.builtin),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(imports ? { imports } : {}),
    sections,
    ...(simWidgets ? { simWidgets } : {}),
    ...(sandboxMock ? { sandboxMock } : {}),
    ...(libs ? { libs } : {}),
  };
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
  private initialized = false;

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
      registerPackIntoBlocklyAndGenerators(pack);
    }
    if (persistCustom && !pack.builtin) {
      this.persistCustomPacks();
    }
  }

  /**
   * Synchronizes the currently active project's embedded packs into Blockly & Lua/Python generators.
   * Restores global definitions for any previously overridden IDs, then applies project-local overrides.
   */
  setActiveProjectLocalPacks(localPacks: PolyExtensionPack[] = []): void {
    this.ensureInitialized();
    const prevOverriddenIds = Array.from(this.activeLocalPacks.keys());
    this.activeLocalPacks.clear();

    for (const oldId of prevOverriddenIds) {
      const globalPack = this.packs.get(oldId);
      if (globalPack) {
        registerPackIntoBlocklyAndGenerators(globalPack);
      }
    }

    for (const rawPack of localPacks) {
      const normalized: PolyExtensionPack = { ...rawPack, builtin: false };
      this.activeLocalPacks.set(normalized.id, normalized);
      registerPackIntoBlocklyAndGenerators(normalized);
    }
  }

  /**
   * Validates a project-local embedded pack.
   * Fully pluggable: project-local packs MAY intentionally use the SAME pack ID as any
   * global/preinstalled pack (including `rt` or `virtual-board`) to override it strictly
   * inside this project without modifying the global library.
   */
  validateProjectLocalPack(raw: unknown): PolyExtensionPack {
    this.ensureInitialized();
    const valid = validateExtensionPack(raw);
    return { ...valid, builtin: false };
  }

  /**
   * Imports a custom pack into the GLOBAL library.
   * Global preinstalled packs stay protected from being overwritten/deleted in the global library
   * (override them at project scope via `localExtensions` instead).
   */
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
      ? renderTemplate(hat.scopeLabelTemplate, def, block, 'lua', pack, section)
      : hat.eventName;
    const shortLabel = hat.scopeShortTemplate
      ? renderTemplate(hat.scopeShortTemplate, def, block, 'lua', pack, section)
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
    return renderTemplate(
      found.hat.duplicateKeyTemplate,
      found.block,
      block,
      'lua',
      found.pack,
      found.section,
    );
  }

  /**
   * Renders extracted dispatch branch metadata from either serialized JSON fields or a live Blockly block.
   * Works generically for ALL `mode: 'dispatch'` hats (both `on_timer` with explicit `extractBranchFnPrefix`
   * and `on_button` / custom dispatch hats that route centrally in `main` when split across files).
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
    conditionLua: string;
    conditionPython: string;
    commentLua: string;
    commentPython: string;
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
      ? renderTemplateFromRawFields(hat.duplicateKeyTemplate, fields, section)
      : String(fallbackIndex);
    const safeSuffix = rawKey.replace(/[^A-Za-z0-9_]+/g, '_') || String(fallbackIndex);
    return {
      blockType,
      eventName: hat.eventName,
      fnPrefix,
      baseFnName: `${fnPrefix}${safeSuffix}`,
      dupKey: rawKey,
      params,
      passParams,
      alwaysExtract,
      conditionLua: hat.conditionLua
        ? renderTemplateFromRawFields(hat.conditionLua, fields, section)
        : 'true',
      conditionPython: hat.conditionPython
        ? renderTemplateFromRawFields(hat.conditionPython, fields, section)
        : 'True',
      commentLua: hat.branchCommentLua
        ? renderTemplateFromRawFields(hat.branchCommentLua, fields, section)
        : '',
      commentPython: hat.branchCommentPython
        ? renderTemplateFromRawFields(hat.branchCommentPython, fields, section)
        : '',
    };
  }

  /** Renders extracted dispatch branch metadata directly from a live Blockly hat block. */
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

  /**
   * Resolves all currently enabled sections (respecting both whole-pack IDs like `"rt"`
   * and fine-grained section IDs like `"rt.timers"`). Deduplicated by `section.capId`.
   */
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

  /** Lists all unique packs that have at least one enabled section. */
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

  /**
   * Generic core-category block injector: returns toolbox blocks from ALL enabled, visible
   * pack sections whose declarative `categoryTarget` matches `coreCategoryId`.
   */
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

  /**
   * Returns all modules to mount into the browser WASM sandbox (`sandboxMock` + `libs[]`).
   * Note: For deterministic priority ordering & same-tier conflict detection across handle/project/global,
   * use `resolveProjectModules()` in `moduleResolver.ts`.
   */
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

  /** Returns ONLY real pure-script library files (`libs[]`) that should be shipped with target exports. */
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

  /**
   * Automatically resolves active Simulator panel cards from enabled blocks:
   * - Requires a runnable driver (`sandboxMock` or `libs[]`) AND non-empty `simWidgets`;
   * - When any block in the pack declares `simWidgetKeys`, strictly filters `simWidgets` to ONLY
   *   keys referenced by currently enabled blocks (omitting the card if 0 widgets remain).
   */
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

  /** Lists all enabled section-level channel pools across all enabled packs. */
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
   * Converts all enabled, visible standalone sections (`categoryTarget === 'own'`)
   * into ordered Blockly toolbox categories. Automatically derives the flyout config
   * shortcut button whenever a standalone section declares a `channel-pool` config.
   */
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
