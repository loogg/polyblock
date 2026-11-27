import type * as Blockly from 'blockly';
import type { ScriptLanguageId } from '../../types/project';
import { LANGUAGE_DIALECTS } from '../backends/types';
import {
  DEFAULT_CHANNEL_COUNT,
  formatChannelLabel,
  getActiveChannelPoolConfig,
} from '../blocks/workspaceContextBridge';
import type {
  ExtensionBlockDef,
  PolyExtensionPack,
  ResolvedHandleChannelPoolSpec,
  ResolvedPackSection,
} from './types';

export const DEFAULT_PACK_TOOLBOX_ORDER = 100;

const PLACEHOLDER_RE =
  /\{\{([A-Za-z0-9_]+)(?::([a-z0-9_]+)(?::([A-Za-z0-9_]+))?)?\}\}/g;

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
      ...(sec.runtimeMonitor ? { runtimeMonitor: sec.runtimeMonitor } : {}),
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

export function indentLines(code: string, extraSpaces: string): string {
  if (!code) return '';
  return code
    .split('\n')
    .map((line) => (line.length > 0 ? `${extraSpaces}${line}` : line))
    .join('\n');
}

/**
 * Pure content-based import hoisting & deduplication across ALL packs and sections.
 * Zero hardcoded module names: identical trimmed import lines collapse to one hoisted line.
 */
export function hoistImports(
  generator: unknown,
  imports: string[] | undefined,
): void {
  if (!imports || imports.length === 0) return;
  const defs = (generator as { definitions_: Record<string, string> }).definitions_;
  for (const rawImp of imports) {
    const imp = rawImp.trim();
    if (!imp) continue;
    defs[`imp_${imp}`] = imp;
  }
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

export function formatTemplateModifier(
  rawValue: string,
  mod: string | undefined,
  modParam: string | undefined,
  lang: ScriptLanguageId,
  poolKey: string,
  poolPrefix: string,
  poolDefault: number,
): string {
  if (mod === 'json') {
    return JSON.stringify(rawValue);
  }
  if (mod === 'int') {
    const n = Number(rawValue);
    return String(Number.isFinite(n) ? Math.trunc(n) : 0);
  }
  if (mod === 'bool') {
    const dialect = LANGUAGE_DIALECTS[lang];
    return rawValue === 'true' || rawValue === 'TRUE' || rawValue === '1'
      ? dialect.boolTrue
      : dialect.boolFalse;
  }
  if (mod === 'edge') {
    const dialect = LANGUAGE_DIALECTS[lang];
    const param = modParam || 'pressed';
    return rawValue === 'press' || rawValue === 'true' || rawValue === '1'
      ? param
      : `${dialect.notOp}${param}`;
  }
  if (mod === 'edge_zh') {
    return rawValue === 'press' || rawValue === 'true' || rawValue === '1'
      ? '按下'
      : '释放';
  }
  if (mod === 'channel_comment') {
    const dialect = LANGUAGE_DIALECTS[lang];
    const tid = Math.trunc(Number(rawValue || 0));
    const alias = getActiveChannelPoolConfig(poolKey, poolDefault).aliases[
      String(tid)
    ];
    return alias ? `${dialect.lineCommentPrefix}${poolPrefix}${tid}: ${alias}` : '';
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
}

export interface TemplateFieldResolvers {
  resolveValueInput?: (block: Blockly.Block, argName: string) => string;
  resolveVarField?: (block: Blockly.Block, argName: string) => string;
}

/**
 * Language-agnostic declarative template renderer used by every `ScriptBackendAdapter`.
 * Zero imports of `blockly/lua` or `blockly/python`: backends inject their own input/var resolvers.
 */
export function renderExtensionTemplate(
  template: string,
  def: ExtensionBlockDef,
  block: Blockly.Block,
  lang: ScriptLanguageId,
  resolvers: TemplateFieldResolvers = {},
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

      if (argType === 'input_value' && resolvers.resolveValueInput) {
        return resolvers.resolveValueInput(block, argName);
      }

      if (argType === 'field_variable' && resolvers.resolveVarField) {
        return resolvers.resolveVarField(block, argName);
      }

      const rawValue = String(block.getFieldValue(argName) ?? '');
      return formatTemplateModifier(
        rawValue,
        mod,
        modParam,
        lang,
        poolKey,
        poolPrefix,
        poolDefault,
      );
    },
  );
}

/**
 * Renders a hat template string directly from serialized `fields` (without requiring a live Blockly.Block).
 * Used to inspect sibling scripts' extracted dispatch branches (`on_timer_0`, etc.) for entry-script routing.
 */
export function renderTemplateFromRawFields(
  template: string,
  fields: Record<string, unknown>,
  section: ResolvedPackSection,
  lang: ScriptLanguageId,
): string {
  const pool = section.channelPool;
  const poolKey = pool?.configKey ?? 'default';
  const poolPrefix = pool?.prefix ?? 'CH';
  const poolDefault = pool?.defaultCount ?? DEFAULT_CHANNEL_COUNT;

  return template.replace(
    PLACEHOLDER_RE,
    (_full, argName: string, mod?: string, modParam?: string) =>
      formatTemplateModifier(
        String(fields[argName] ?? ''),
        mod,
        modParam,
        lang,
        poolKey,
        poolPrefix,
        poolDefault,
      ),
  );
}
