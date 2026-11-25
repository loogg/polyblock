import * as Blockly from 'blockly';
import { luaGenerator, Order as LuaOrder } from 'blockly/lua';
import { Order as PyOrder, pythonGenerator } from 'blockly/python';
import type { BlockCategorySpec, ToolboxBlockSpec } from '../blocks/catalog';
import { BUILTIN_EXTENSION_PACKS } from './builtinPacks';
import type {
  ExtensionBlockDef,
  ExtensionSandboxMock,
  PolyExtensionPack,
  SimWidgetKind,
  SimWidgetSpec,
} from './types';

const VALID_SIM_WIDGET_KINDS = new Set<SimWidgetKind>([
  'led',
  'rgb',
  'bar',
  'screen',
  'slider',
  'toggle',
  'button',
]);

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
        `无效的模拟控件类型 "${String(w.kind)}"，支持：led / rgb / bar / screen / slider / toggle / button`,
      );
    }
    if (typeof w.key !== 'string' || !w.key.trim()) {
      throw new Error(`模拟控件 (${w.kind}) 缺少非空 key 字段`);
    }
    if (typeof w.label !== 'string' || !w.label.trim()) {
      throw new Error(`模拟控件 (${w.key}) 缺少非空 label 字段`);
    }
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
    });
  }
  return out.length > 0 ? out : undefined;
}

export const STORAGE_CUSTOM_EXTENSIONS_KEY = 'polyblock.extensions.custom.v1';

const PLACEHOLDER_RE = /\{\{([A-Za-z0-9_]+)(?::([a-z_]+))?\}\}/g;

function buildArgKindMap(
  def: ExtensionBlockDef,
): Map<string, string> {
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
): string {
  const argKinds = buildArgKindMap(def);

  return template.replace(PLACEHOLDER_RE, (_full, argName: string, mod?: string) => {
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
    return rawValue;
  });
}

function registerPackIntoBlocklyAndGenerators(pack: PolyExtensionPack): void {
  const blockDefs = pack.blocks.map((b) => {
    const jsonDef: Record<string, unknown> = {
      type: b.type,
      message0: b.message0,
      args0: b.args0 ?? [],
      inputsInline: b.inputsInline ?? true,
      colour: pack.color,
      tooltip: b.tooltip ?? `${pack.name} · ${b.type}`,
    };

    if (b.kind === 'statement') {
      jsonDef.previousStatement = null;
      jsonDef.nextStatement = null;
    } else {
      jsonDef.output = b.outputType ?? null;
    }

    return jsonDef;
  });

  Blockly.defineBlocksWithJsonArray(blockDefs);

  for (const b of pack.blocks) {
    // Lua code generator
    luaGenerator.forBlock[b.type] = (block, generator) => {
      const defs = (generator as unknown as { definitions_: Record<string, string> })
        .definitions_;
      for (const [idx, imp] of (b.lua.imports ?? []).entries()) {
        defs[`ext_${pack.id}_imp_${idx}`] = imp;
      }
      const rendered = renderTemplate(b.lua.template, b, block, 'lua');
      if (b.kind === 'value') {
        return [rendered, LuaOrder.ATOMIC];
      }
      return `${rendered}\n`;
    };

    // Python code generator
    pythonGenerator.forBlock[b.type] = (block, generator) => {
      const defs = (generator as unknown as { definitions_: Record<string, string> })
        .definitions_;
      for (const [idx, imp] of (b.python.imports ?? []).entries()) {
        defs[`ext_${pack.id}_imp_${idx}`] = imp;
      }
      const rendered = renderTemplate(b.python.template, b, block, 'python');
      if (b.kind === 'value') {
        return [rendered, PyOrder.ATOMIC];
      }
      return `${rendered}\n`;
    };
  }
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
    if (blk.kind !== 'statement' && blk.kind !== 'value') {
      throw new Error(`积木 ${blk.type} 的 kind 必须为 "statement" 或 "value"`);
    }
    if (typeof blk.message0 !== 'string' || !blk.message0.trim()) {
      throw new Error(`积木 ${blk.type} 缺少 message0`);
    }
    const luaSpec = blk.lua as Record<string, unknown> | undefined;
    const pySpec = blk.python as Record<string, unknown> | undefined;
    if (!luaSpec || typeof luaSpec.template !== 'string') {
      throw new Error(`积木 ${blk.type} 缺少 lua.template`);
    }
    if (!pySpec || typeof pySpec.template !== 'string') {
      throw new Error(`积木 ${blk.type} 缺少 python.template`);
    }
  }

  const simWidgets = validateSimWidgets(obj.simWidgets);

  return {
    format: 'polyblock-extension',
    version: 1,
    id: obj.id,
    name: obj.name.trim(),
    packVersion: typeof obj.packVersion === 'string' ? obj.packVersion : '1.0.0',
    categoryLabel: obj.categoryLabel.trim().slice(0, 6),
    color: typeof obj.color === 'string' && obj.color.startsWith('#') ? obj.color : '#6366f1',
    description:
      typeof obj.description === 'string' ? obj.description : '用户自定义扩展积木包',
    builtin: Boolean(obj.builtin),
    hasVirtualBoardUi: Boolean(obj.hasVirtualBoardUi),
    blocks: obj.blocks as ExtensionBlockDef[],
    sandboxMock: obj.sandboxMock as ExtensionSandboxMock | undefined,
    ...(simWidgets ? { simWidgets } : {}),
  };
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

    // Restore user-imported custom GLOBAL extension packs from localStorage
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
    // Only bind into Blockly immediately if not currently overridden by an active project-local pack
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

    // Restore any global pack whose ID was previously overridden by the previous project
    for (const oldId of prevOverriddenIds) {
      const globalPack = this.packs.get(oldId);
      if (globalPack) {
        registerPackIntoBlocklyAndGenerators(globalPack);
      }
    }

    // Register current project's embedded packs (overriding same-ID global packs)
    for (const rawPack of localPacks) {
      const normalized: PolyExtensionPack = { ...rawPack, builtin: false };
      this.activeLocalPacks.set(normalized.id, normalized);
      registerPackIntoBlocklyAndGenerators(normalized);
    }
  }

  /** Validates a project-embedded .polyext.json (disallows overriding built-in packs, allows overriding global custom packs). */
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

  /** Looks up a pack in global library only. */
  get(packId: string): PolyExtensionPack | undefined {
    this.ensureInitialized();
    return this.packs.get(packId);
  }

  /** Resolves a pack with project-local precedence over global library. */
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

  getSandboxMocks(
    enabledIds: string[],
    localPacks?: PolyExtensionPack[],
  ): ExtensionSandboxMock[] {
    return this.getEnabledPacks(enabledIds, localPacks)
      .map((p) => p.sandboxMock)
      .filter((m): m is ExtensionSandboxMock => Boolean(m));
  }

  toCategorySpecs(
    enabledIds: string[],
    localPacks?: PolyExtensionPack[],
  ): BlockCategorySpec[] {
    return this.getEnabledPacks(enabledIds, localPacks).map((pack) => {
      const blocks: ToolboxBlockSpec[] = pack.blocks.map((b) => {
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
          ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
        };
      });

      // Attach hardware button edge callback hat directly to the virtual-board peripheral pack
      // so projects without virtual-board never see button callback blocks.
      if (pack.id === 'virtual-board') {
        blocks.push({
          kind: 'block',
          type: 'poly_on_button',
          keywords: '当按键 按下 释放 回调 硬件 事件 on_button key A B board',
          fields: { KEY: 'A', EDGE: 'press' },
        });
      }

      return {
        id: `ext_${pack.id}`,
        label: pack.categoryLabel,
        color: pack.color,
        blocks,
      };
    });
  }
}

export const extensionRegistry = new ExtensionRegistry();
