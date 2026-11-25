import * as Blockly from 'blockly';
import { luaGenerator, Order as LuaOrder } from 'blockly/lua';
import { Order as PyOrder, pythonGenerator } from 'blockly/python';
import type { BlockCategorySpec, ToolboxBlockSpec } from '../blocks/catalog';
import { BUILTIN_EXTENSION_PACKS } from './builtinPacks';
import type {
  ExtensionBlockDef,
  ExtensionSandboxMock,
  PolyExtensionPack,
} from './types';

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
  };
}

class ExtensionRegistry {
  private readonly packs = new Map<string, PolyExtensionPack>();
  private initialized = false;

  ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;

    for (const pack of BUILTIN_EXTENSION_PACKS) {
      this.register(pack, false);
    }

    // Restore user-imported custom extension packs from localStorage
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
    registerPackIntoBlocklyAndGenerators(pack);
    if (persistCustom && !pack.builtin) {
      this.persistCustomPacks();
    }
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

  listAll(): PolyExtensionPack[] {
    this.ensureInitialized();
    return Array.from(this.packs.values());
  }

  get(packId: string): PolyExtensionPack | undefined {
    this.ensureInitialized();
    return this.packs.get(packId);
  }

  getEnabledPacks(enabledIds: string[]): PolyExtensionPack[] {
    this.ensureInitialized();
    const out: PolyExtensionPack[] = [];
    for (const id of enabledIds) {
      const pack = this.packs.get(id);
      if (pack) out.push(pack);
    }
    return out;
  }

  getSandboxMocks(enabledIds: string[]): ExtensionSandboxMock[] {
    return this.getEnabledPacks(enabledIds)
      .map((p) => p.sandboxMock)
      .filter((m): m is ExtensionSandboxMock => Boolean(m));
  }

  toCategorySpecs(enabledIds: string[]): BlockCategorySpec[] {
    return this.getEnabledPacks(enabledIds).map((pack) => {
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
