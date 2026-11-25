import * as Blockly from 'blockly';
import { luaGenerator, Order as LuaOrder } from 'blockly/lua';
import { Order as PyOrder, pythonGenerator } from 'blockly/python';
import { codegenContext } from '../backends/codegenContext';
import type { BlockCategorySpec, ToolboxBlockSpec } from '../blocks/catalog';
import { createChannelIdField } from '../blocks/channelField';
import {
  DEFAULT_TIMER_POOL_KEY,
  formatChannelLabel,
  getActiveChannelPoolConfig,
} from '../blocks/timerConfigBridge';
import { BUILTIN_EXTENSION_PACKS } from './builtinPacks';
import type {
  ExtensionBlockDef,
  ExtensionHatSpec,
  ExtensionSandboxMock,
  HandleChannelPoolSpec,
  PackAttributeBadge,
  PolyExtensionPack,
  SimWidgetEventTrigger,
  SimWidgetKind,
  SimWidgetSpec,
} from './types';

export const STORAGE_CUSTOM_EXTENSIONS_KEY = 'polyblock.extensions.custom.v1';
export const DEFAULT_PACK_TOOLBOX_ORDER = 100;

/**
 * Derives objective multi-attribute badges from a pack's actual declarative contents
 * (plus optional user-authored `tags`), allowing a single pack to combine peripheral
 * widgets, event callbacks, channel pools, and pure API functions seamlessly.
 */
export function derivePackBadges(pack: PolyExtensionPack): PackAttributeBadge[] {
  const badges: PackAttributeBadge[] = [];
  const widgetCount = pack.simWidgets?.length ?? 0;
  const hasHat = pack.blocks.some((b) => b.kind === 'hat');
  const hasPool = Boolean(pack.handleChannelPool);
  const hasApiBlocks = pack.blocks.some(
    (b) => b.kind === 'statement' || b.kind === 'value',
  );

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

  if (hasHat) {
    badges.push({
      id: 'hat',
      label: '事件回调',
      tone: 'event',
    });
  }

  if (hasPool && pack.handleChannelPool) {
    const p = pack.handleChannelPool;
    badges.push({
      id: 'pool',
      label: `通道池 ${p.prefix}0~${p.max - 1}`,
      tone: 'pool',
    });
  }

  if (hasApiBlocks && widgetCount === 0 && !hasPool && !pack.hasRtMonitorUi) {
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
const PLACEHOLDER_RE = /\{\{([A-Za-z0-9_]+)(?::([a-z0-9_]+)(?::([A-Za-z0-9_]+))?)?\}\}/g;

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
): string {
  const argKinds = buildArgKindMap(def);
  const poolKey = pack?.handleChannelPool?.configKey ?? DEFAULT_TIMER_POOL_KEY;
  const poolPrefix = pack?.handleChannelPool?.prefix ?? 'T';
  const poolDefault = pack?.handleChannelPool?.defaultCount ?? 8;

  return template.replace(
    PLACEHOLDER_RE,
    (_full, argName: string, mod?: string, modParam?: string) => {
      const argType = argKinds.get(argName);
      let rawValue = '';

      if (argType === 'input_value') {
        if (lang === 'lua') {
          rawValue = luaGenerator.valueToCode(block, argName, LuaOrder.NONE) || '""';
        } else {
          rawValue = pythonGenerator.valueToCode(block, argName, PyOrder.NONE) || '""';
        }
        return rawValue;
      }

      if (argType === 'field_variable') {
        const varId = block.getFieldValue(argName);
        return lang === 'lua'
          ? luaGenerator.getVariableName(varId)
          : pythonGenerator.getVariableName(varId);
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
      if (mod === 'action_run') {
        return rawValue === 'stop' ? 'stop_run' : 'start_run';
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
): void {
  const hasChannelField = (b.args0 ?? []).some(
    (arg) => arg.type === 'field_channel_id',
  );

  if (!hasChannelField) {
    const jsonDef: Record<string, unknown> = {
      type: b.type,
      message0: b.message0,
      args0: b.args0 ?? [],
      inputsInline: b.inputsInline ?? true,
      tooltip: b.tooltip ?? `${pack.name} · ${b.type}`,
    };

    if (b.blockStyle) {
      jsonDef.style = b.blockStyle;
    } else {
      jsonDef.colour = pack.color;
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
          const pool = pack.handleChannelPool;
          ensureDummy().appendField(
            createChannelIdField({
              configKey: pool?.configKey ?? DEFAULT_TIMER_POOL_KEY,
              prefix: pool?.prefix ?? 'T',
              label: pool?.label ?? '定时器通道',
              defaultCount: pool?.defaultCount ?? 8,
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
        this.setColour(pack.color);
      }
      this.setTooltip(b.tooltip ?? `${pack.name} · ${b.type}`);
    },
  };
}

function getPythonGlobalLine(): string {
  if (codegenContext.pythonGlobalVarIdents.length === 0) return '';
  return `  global ${codegenContext.pythonGlobalVarIdents.join(', ')}\n`;
}

function hoistImports(
  generator: unknown,
  packId: string,
  imports: string[] | undefined,
): void {
  if (!imports || imports.length === 0) return;
  const defs = (generator as { definitions_: Record<string, string> }).definitions_;
  for (const [idx, imp] of imports.entries()) {
    // Deduplicate common `rt` import identically across rt-lifecycle and rt-timers
    const key =
      imp === 'local rt = require("rt")' || imp === 'import rt'
        ? 'import_rt'
        : `ext_${packId}_imp_${idx}`;
    defs[key] = imp;
  }
}

function registerHatGenerators(
  pack: PolyExtensionPack,
  b: ExtensionBlockDef,
  hatSpec: ExtensionHatSpec,
): void {
  const paramsStr = (hatSpec.params ?? []).join(', ');

  // --- Lua Hat Generator ---
  luaGenerator.forBlock[b.type] = (block, generator) => {
    hoistImports(generator, pack.id, hatSpec.importsLua);

    if (hatSpec.mode === 'singleton') {
      const prelude = hatSpec.preludeLua
        ? `${renderTemplate(hatSpec.preludeLua, b, block, 'lua', pack)}\n`
        : '';
      const body = generator.statementToCode(block, 'BODY');
      if (codegenContext.debugPass) {
        return `${prelude}function ${hatSpec.eventName}(${paramsStr})\n${body}end\n`;
      }
      return (
        `${SENTINEL_START}'${block.id}'__\n` +
        `${prelude}` +
        `function ${hatSpec.eventName}(${paramsStr})\n` +
        `${body}` +
        `end\n` +
        `${SENTINEL_END}'${block.id}'__\n`
      );
    }

    // Dispatch mode: aggregate all enabled hats of this block type into ONE top-level function
    const dispatchKey = `${hatSpec.eventName}:${b.type}`;
    if (codegenContext.emittedDispatchEvents.has(dispatchKey)) return '';
    codegenContext.emittedDispatchEvents.add(dispatchKey);

    const matchingHats = block.workspace
      .getTopBlocks(true)
      .filter((top) => top.type === b.type && !top.isShadow() && top.isEnabled());
    if (matchingHats.length === 0) return '';

    const branches: string[] = [];
    matchingHats.forEach((hatBlk, idx) => {
      const kw = idx === 0 ? 'if' : 'elseif';
      const cond = hatSpec.conditionLua
        ? renderTemplate(hatSpec.conditionLua, b, hatBlk, 'lua', pack)
        : 'true';
      const comment = hatSpec.branchCommentLua
        ? renderTemplate(hatSpec.branchCommentLua, b, hatBlk, 'lua', pack)
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

    return `function ${hatSpec.eventName}(${paramsStr})\n${branches.join('')}  end\nend\n`;
  };

  // --- Python Hat Generator ---
  pythonGenerator.forBlock[b.type] = (block, generator) => {
    hoistImports(generator, pack.id, hatSpec.importsPython);
    const defKw = codegenContext.debugPass ? 'async def' : 'def';
    const globalLine = getPythonGlobalLine();

    if (hatSpec.mode === 'singleton') {
      const prelude = hatSpec.preludePython
        ? `${renderTemplate(hatSpec.preludePython, b, block, 'python', pack)}\n`
        : '';
      const body = generator.statementToCode(block, 'BODY');
      const safeBody = body.trim() ? body : '  pass\n';
      if (codegenContext.debugPass) {
        return `${prelude}${defKw} ${hatSpec.eventName}(${paramsStr}):\n${globalLine}${safeBody}\n`;
      }
      return (
        `${SENTINEL_START}'${block.id}'__\n` +
        `${prelude}` +
        `${defKw} ${hatSpec.eventName}(${paramsStr}):\n` +
        `${globalLine}${safeBody}` +
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

    const branches: string[] = [];
    matchingHats.forEach((hatBlk, idx) => {
      const kw = idx === 0 ? 'if' : 'elif';
      const cond = hatSpec.conditionPython
        ? renderTemplate(hatSpec.conditionPython, b, hatBlk, 'python', pack)
        : 'True';
      const comment = hatSpec.branchCommentPython
        ? renderTemplate(hatSpec.branchCommentPython, b, hatBlk, 'python', pack)
        : '';
      const rawBody = generator.statementToCode(hatBlk, 'BODY');
      const indentedBody = rawBody.trim() ? indentLines(rawBody, '  ') : '    pass\n';
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

    return `${defKw} ${hatSpec.eventName}(${paramsStr}):\n${globalLine}${branches.join('')}\n`;
  };
}

function registerPackIntoBlocklyAndGenerators(pack: PolyExtensionPack): void {
  for (const b of pack.blocks) {
    registerSingleBlockInBlockly(pack, b);

    if (b.kind === 'hat' && b.hat) {
      registerHatGenerators(pack, b, b.hat);
      continue;
    }

    if (b.lua) {
      const luaSpec = b.lua;
      luaGenerator.forBlock[b.type] = (block, generator) => {
        hoistImports(generator, pack.id, luaSpec.imports);
        const rendered = renderTemplate(luaSpec.template, b, block, 'lua', pack);
        if (b.kind === 'value') {
          return [rendered, LuaOrder.ATOMIC];
        }
        return `${rendered}\n`;
      };
    }

    if (b.python) {
      const pySpec = b.python;
      pythonGenerator.forBlock[b.type] = (block, generator) => {
        hoistImports(generator, pack.id, pySpec.imports);
        const rendered = renderTemplate(pySpec.template, b, block, 'python', pack);
        if (b.kind === 'value') {
          return [rendered, PyOrder.ATOMIC];
        }
        return `${rendered}\n`;
      };
    }
  }
}

function validateEmitEvent(raw: unknown): SimWidgetEventTrigger | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') {
    throw new Error('emitEvent 必须是对象');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.eventName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(obj.eventName)) {
    throw new Error('emitEvent.eventName 必须是合法的函数名标识符（如 on_button / on_can_rx）');
  }
  return {
    eventName: obj.eventName,
    ...(Array.isArray(obj.args)
      ? {
          args: obj.args.filter(
            (a): a is string | number | boolean =>
              typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean',
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
      ...(typeof w.color === 'string' && w.color.trim() ? { color: w.color.trim() } : {}),
      ...(typeof w.min === 'number' && Number.isFinite(w.min) ? { min: w.min } : {}),
      ...(typeof w.max === 'number' && Number.isFinite(w.max) ? { max: w.max } : {}),
      ...(typeof w.step === 'number' && Number.isFinite(w.step) && w.step > 0
        ? { step: w.step }
        : {}),
      ...(typeof w.unit === 'string' ? { unit: w.unit } : {}),
      ...(typeof w.maxLines === 'number' && Number.isFinite(w.maxLines) && w.maxLines >= 1
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

function validateHandleChannelPool(
  raw: unknown,
  packId: string,
): HandleChannelPoolSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('handleChannelPool 必须是对象');
  const obj = raw as Record<string, unknown>;
  const min = Number.isFinite(Number(obj.min)) ? Math.max(1, Math.trunc(Number(obj.min))) : 1;
  const max = Number.isFinite(Number(obj.max))
    ? Math.max(min, Math.min(32, Math.trunc(Number(obj.max))))
    : 32;
  const defaultCount = Number.isFinite(Number(obj.defaultCount))
    ? Math.max(min, Math.min(max, Math.trunc(Number(obj.defaultCount))))
    : Math.min(max, 8);
  return {
    configKey:
      typeof obj.configKey === 'string' && obj.configKey.trim()
        ? obj.configKey.trim()
        : packId,
    label: typeof obj.label === 'string' && obj.label.trim() ? obj.label.trim() : '通道',
    prefix: typeof obj.prefix === 'string' && obj.prefix.trim() ? obj.prefix.trim() : 'CH',
    min,
    max,
    defaultCount,
    ...(Array.isArray(obj.presets)
      ? { presets: obj.presets.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) }
      : {}),
    ...(typeof obj.hint === 'string' ? { hint: obj.hint } : {}),
    ...(typeof obj.fieldName === 'string' && obj.fieldName.trim()
      ? { fieldName: obj.fieldName.trim() }
      : {}),
  };
}

export function validateExtensionPack(raw: unknown): PolyExtensionPack {
  if (!raw || typeof raw !== 'object') {
    throw new Error('扩展包 JSON 必须是对象');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !/^[a-zA-Z0-9_-]{2,48}$/.test(obj.id)) {
    throw new Error('扩展包 id 必填，且只能包含字母、数字、横线或下划线（2~48 字符）');
  }
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    throw new Error('扩展包 name 必填');
  }
  if (typeof obj.categoryLabel !== 'string' || !obj.categoryLabel.trim()) {
    throw new Error('扩展包 categoryLabel 必填');
  }
  if (!Array.isArray(obj.blocks) || obj.blocks.length === 0) {
    throw new Error('扩展包必须至少包含 1 个 blocks 积木定义');
  }

  for (const blk of obj.blocks as Array<Record<string, unknown>>) {
    if (typeof blk.type !== 'string' || !blk.type.trim()) {
      throw new Error('每个积木必须包含非空 type 字段');
    }
    if (blk.kind !== 'statement' && blk.kind !== 'value' && blk.kind !== 'hat') {
      throw new Error(`积木 ${blk.type} 的 kind 必须为 "statement"、"value" 或 "hat"`);
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
        throw new Error(`事件帽块 ${blk.type} 的 hat.mode 必须为 "singleton" 或 "dispatch"`);
      }
    } else {
      const luaSpec = blk.lua as Record<string, unknown> | undefined;
      const pySpec = blk.python as Record<string, unknown> | undefined;
      if (!luaSpec || typeof luaSpec.template !== 'string') {
        throw new Error(`积木 ${blk.type} 缺少 lua.template`);
      }
      if (!pySpec || typeof pySpec.template !== 'string') {
        throw new Error(`积木 ${blk.type} 缺少 python.template`);
      }
    }
  }

  const simWidgets = validateSimWidgets(obj.simWidgets);
  const handleChannelPool = validateHandleChannelPool(obj.handleChannelPool, obj.id);
  const rawOrder = Number(obj.toolboxOrder);
  const toolboxOrder = Number.isFinite(rawOrder)
    ? Math.max(0, Math.min(9999, Math.round(rawOrder)))
    : obj.packKind === 'runtime'
      ? 15
      : DEFAULT_PACK_TOOLBOX_ORDER;
  const tags = Array.isArray(obj.tags)
    ? obj.tags
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((t) => t.trim().slice(0, 12))
        .slice(0, 6)
    : undefined;

  return {
    format: 'polyblock-extension',
    version: 1,
    id: obj.id,
    name: obj.name.trim(),
    packVersion: typeof obj.packVersion === 'string' ? obj.packVersion : '1.0.0',
    categoryLabel: obj.categoryLabel.trim().slice(0, 6),
    color:
      typeof obj.color === 'string' && obj.color.startsWith('#')
        ? obj.color
        : typeof obj.categoryColor === 'string' && obj.categoryColor.startsWith('#')
          ? obj.categoryColor
          : '#6366f1',
    description:
      typeof obj.description === 'string' ? obj.description : '用户自定义扩展积木包',
    builtin: Boolean(obj.builtin),
    toolboxOrder,
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(obj.packKind === 'runtime' || obj.packKind === 'peripheral'
      ? { packKind: obj.packKind }
      : {}),
    categoryTarget: obj.categoryTarget === 'event' ? 'event' : 'own',
    ...(obj.flyoutButton && typeof obj.flyoutButton === 'object'
      ? { flyoutButton: obj.flyoutButton as PolyExtensionPack['flyoutButton'] }
      : {}),
    hasRtMonitorUi: Boolean(obj.hasRtMonitorUi),
    hasVirtualBoardUi: Boolean(obj.hasVirtualBoardUi),
    ...(handleChannelPool ? { handleChannelPool } : {}),
    blocks: obj.blocks as ExtensionBlockDef[],
    sandboxMock: obj.sandboxMock as ExtensionSandboxMock | undefined,
    ...(simWidgets ? { simWidgets } : {}),
  };
}

function buildToolboxBlocksForPack(pack: PolyExtensionPack): ToolboxBlockSpec[] {
  return pack.blocks.map((b) => {
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
      keywords: `${pack.name} ${pack.categoryLabel} ${b.keywords ?? ''} ${b.message0}`,
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

  validateProjectLocalPack(raw: unknown): PolyExtensionPack {
    this.ensureInitialized();
    const valid = validateExtensionPack(raw);
    const existingGlobal = this.packs.get(valid.id);
    if (existingGlobal?.builtin) {
      throw new Error(`扩展包 ID "${valid.id}" 与系统内置包冲突，请更换自定义 ID`);
    }
    return { ...valid, builtin: false };
  }

  importCustomPack(raw: unknown): PolyExtensionPack {
    this.ensureInitialized();
    const valid = validateExtensionPack(raw);
    const existing = this.packs.get(valid.id);
    if (existing?.builtin) {
      throw new Error(`扩展包 ID "${valid.id}" 与内置包冲突，请更换自定义 ID`);
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
      localStorage.setItem(STORAGE_CUSTOM_EXTENSIONS_KEY, JSON.stringify(customOnly));
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

  resolvePack(
    packId: string,
    localPacks?: PolyExtensionPack[],
  ): PolyExtensionPack | undefined {
    this.ensureInitialized();
    if (localPacks) {
      const localMatch = localPacks.find((p) => p.id === packId);
      if (localMatch) return localMatch;
    } else {
      const activeLocal = this.activeLocalPacks.get(packId);
      if (activeLocal) return activeLocal;
    }
    return this.packs.get(packId);
  }

  findPackForBlockType(blockType: string): PolyExtensionPack | undefined {
    this.ensureInitialized();
    for (const pack of this.activeLocalPacks.values()) {
      if (pack.blocks.some((b) => b.type === blockType)) {
        return pack;
      }
    }
    for (const pack of this.packs.values()) {
      if (pack.blocks.some((b) => b.type === blockType)) {
        return pack;
      }
    }
    return undefined;
  }

  getBlockDef(
    blockType: string,
  ): { pack: PolyExtensionPack; block: ExtensionBlockDef } | undefined {
    this.ensureInitialized();
    for (const pack of this.activeLocalPacks.values()) {
      const blk = pack.blocks.find((b) => b.type === blockType);
      if (blk) return { pack, block: blk };
    }
    for (const pack of this.packs.values()) {
      const blk = pack.blocks.find((b) => b.type === blockType);
      if (blk) return { pack, block: blk };
    }
    return undefined;
  }

  getHatBlockDef(
    blockType: string,
  ): { pack: PolyExtensionPack; block: ExtensionBlockDef; hat: ExtensionHatSpec } | undefined {
    const found = this.getBlockDef(blockType);
    if (found && found.block.kind === 'hat' && found.block.hat) {
      return { pack: found.pack, block: found.block, hat: found.block.hat };
    }
    return undefined;
  }

  isDeclarativeHatBlock(blockType: string): boolean {
    return Boolean(this.getHatBlockDef(blockType));
  }

  isEventDrivenBlock(blockType: string): boolean {
    const found = this.getBlockDef(blockType);
    if (!found) return false;
    return found.block.kind === 'hat' || Boolean(found.pack.hasRtMonitorUi);
  }

  renderHatScopeInfo(block: Blockly.Block): {
    label: string;
    shortLabel: string;
    category: 'lifecycle' | 'timer' | 'button' | 'function';
  } | null {
    const found = this.getHatBlockDef(block.type);
    if (!found) return null;
    const { pack, block: def, hat } = found;
    const label = hat.scopeLabelTemplate
      ? renderTemplate(hat.scopeLabelTemplate, def, block, 'lua', pack)
      : hat.eventName;
    const shortLabel = hat.scopeShortTemplate
      ? renderTemplate(hat.scopeShortTemplate, def, block, 'lua', pack)
      : hat.eventName;
    return {
      label,
      shortLabel,
      category: hat.scopeCategory ?? 'button',
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
    );
  }

  getEnabledPacks(
    enabledIds: string[],
    localPacks?: PolyExtensionPack[],
  ): PolyExtensionPack[] {
    this.ensureInitialized();
    const out: PolyExtensionPack[] = [];
    const seen = new Set<string>();
    for (const id of enabledIds) {
      if (seen.has(id)) continue;
      const pack = this.resolvePack(id, localPacks);
      if (pack) {
        seen.add(id);
        out.push(pack);
      }
    }
    return out;
  }

  /** Returns toolbox blocks from enabled packs that merge into the core `事件` category (e.g. rt-lifecycle). */
  getEventCategoryBlocks(
    enabledIds: string[],
    localPacks?: PolyExtensionPack[],
  ): ToolboxBlockSpec[] {
    const out: ToolboxBlockSpec[] = [];
    for (const pack of this.getEnabledPacks(enabledIds, localPacks)) {
      if (pack.categoryTarget === 'event') {
        out.push(...buildToolboxBlocksForPack(pack));
      }
    }
    return out;
  }

  getSandboxMocks(
    enabledIds: string[],
    localPacks?: PolyExtensionPack[],
  ): ExtensionSandboxMock[] {
    return this.getEnabledPacks(enabledIds, localPacks)
      .filter((p) => Boolean(p.sandboxMock))
      .map((p) => ({
        ...p.sandboxMock!,
        packId: p.id,
      }));
  }

  getChannelPoolPacks(
    enabledIds: string[],
    localPacks?: PolyExtensionPack[],
  ): PolyExtensionPack[] {
    return this.getEnabledPacks(enabledIds, localPacks).filter((p) =>
      Boolean(p.handleChannelPool),
    );
  }

  hasRtMonitor(
    enabledIds: string[],
    localPacks?: PolyExtensionPack[],
  ): boolean {
    return this.getEnabledPacks(enabledIds, localPacks).some((p) =>
      Boolean(p.hasRtMonitorUi),
    );
  }

  /** Converts enabled standalone-category packs (`categoryTarget !== 'event'`) into ordered Blockly toolbox categories. */
  toCategorySpecs(
    enabledIds: string[],
    localPacks?: PolyExtensionPack[],
  ): BlockCategorySpec[] {
    return this.getEnabledPacks(enabledIds, localPacks)
      .filter((pack) => pack.categoryTarget !== 'event')
      .map((pack) => ({
        id: pack.id === 'rt-timers' ? 'timers' : `ext_${pack.id}`,
        label: pack.categoryLabel,
        color: pack.color,
        order: pack.toolboxOrder ?? DEFAULT_PACK_TOOLBOX_ORDER,
        isExtension: true,
        blocks: buildToolboxBlocksForPack(pack),
        ...(pack.flyoutButton ? { flyoutButton: pack.flyoutButton } : {}),
      }));
  }
}

export const extensionRegistry = new ExtensionRegistry();
