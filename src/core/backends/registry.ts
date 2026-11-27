import type {
  ScriptLanguageId,
  VariableInitialValue,
} from '../../types/project';
import { extensionRegistry } from '../extensions/registry';
import { LUA_DIALECT, LuaBackendAdapter } from './luaBackend';
import { PYTHON_DIALECT, PythonBackendAdapter } from './pythonBackend';
import {
  formatInitialValueForDialect,
  type LanguageDialect,
  type ScriptBackendAdapter,
} from './types';

/**
 * Single registration entry point for all built-in target language backends.
 * Adding a new target language (e.g. JS / Arduino / DSL) ONLY requires:
 *   1. Creating `<lang>Backend.ts` exporting `<LANG>_DIALECT` & `<Lang>BackendAdapter`
 *   2. Adding one entry to `BUILTIN_BACKEND_ENTRIES` below.
 * `ScriptLanguageId`, dialect lookup, syntax highlighting, file extension helpers,
 * library scanning, validation, and UI pickers all derive automatically from here.
 */
const BUILTIN_BACKEND_ENTRIES = [
  { getDialect: () => LUA_DIALECT, create: () => new LuaBackendAdapter() },
  { getDialect: () => PYTHON_DIALECT, create: () => new PythonBackendAdapter() },
] as const;

export type RegisteredLanguageId = ReturnType<
  (typeof BUILTIN_BACKEND_ENTRIES)[number]['getDialect']
>['id'];

class BackendRegistry {
  private readonly dialects = new Map<string, LanguageDialect>();
  private readonly adapters = new Map<string, ScriptBackendAdapter>();
  private dialectsLoaded = false;
  private initialized = false;

  /**
   * Lazily seeds dialect metadata on first access (safe under ANY ESM module import order
   * without triggering Blockly or `extensionRegistry` initialization).
   */
  private ensureDialectsLoaded(): void {
    if (this.dialectsLoaded) return;
    this.dialectsLoaded = true;
    for (const entry of BUILTIN_BACKEND_ENTRIES) {
      const dialect = entry.getDialect();
      if (!this.dialects.has(dialect.id)) {
        this.dialects.set(dialect.id, dialect);
      }
    }
  }

  private ensureInitialized(): void {
    this.ensureDialectsLoaded();
    if (this.initialized) return;
    this.initialized = true;
    for (const entry of BUILTIN_BACKEND_ENTRIES) {
      const dialect = entry.getDialect();
      if (!this.adapters.has(dialect.id)) {
        const adapter = entry.create();
        this.adapters.set(adapter.id, adapter);
        this.dialects.set(adapter.id, adapter.dialect);
        extensionRegistry.attachBackend(adapter);
      }
    }
  }

  /** Registers (or replaces) a target language backend & its dialect metadata dynamically. */
  register(adapter: ScriptBackendAdapter): void {
    this.ensureInitialized();
    this.adapters.set(adapter.id, adapter);
    this.dialects.set(adapter.id, adapter.dialect);
    extensionRegistry.attachBackend(adapter);
  }

  /** Unregisters a dynamically added language backend (cannot remove built-in backends). */
  unregister(id: string): boolean {
    this.ensureDialectsLoaded();
    if (BUILTIN_BACKEND_ENTRIES.some((e) => e.getDialect().id === id)) {
      return false;
    }
    const deletedAdapter = this.adapters.delete(id);
    const deletedDialect = this.dialects.delete(id);
    return deletedAdapter || deletedDialect;
  }

  get(id: ScriptLanguageId): ScriptBackendAdapter {
    this.ensureInitialized();
    const found = this.adapters.get(id);
    if (!found) {
      throw new Error(`Unsupported script backend: ${id}`);
    }
    return found;
  }

  tryGet(id: string): ScriptBackendAdapter | undefined {
    this.ensureInitialized();
    return this.adapters.get(id);
  }

  list(): ScriptBackendAdapter[] {
    this.ensureInitialized();
    return Array.from(this.adapters.values());
  }

  /** Lists all registered language IDs (synchronously safe without triggering extension init). */
  listIds(): ScriptLanguageId[] {
    this.ensureDialectsLoaded();
    return Array.from(this.dialects.keys()) as ScriptLanguageId[];
  }

  /** Returns the primary default language ID (first registered built-in backend). */
  getDefaultId(): ScriptLanguageId {
    this.ensureDialectsLoaded();
    return BUILTIN_BACKEND_ENTRIES[0].getDialect().id;
  }

  /** Returns the LanguageDialect for a registered language ID (throws if unregistered). */
  getDialect(id: ScriptLanguageId): LanguageDialect {
    this.ensureDialectsLoaded();
    const found = this.dialects.get(id);
    if (!found) {
      throw new Error(`Unsupported script language dialect: ${id}`);
    }
    return found;
  }

  tryGetDialect(id: string): LanguageDialect | undefined {
    this.ensureDialectsLoaded();
    return this.dialects.get(id);
  }

  listDialects(): LanguageDialect[] {
    this.ensureDialectsLoaded();
    return Array.from(this.dialects.values());
  }

  getDialectsMap(): Record<ScriptLanguageId, LanguageDialect> {
    this.ensureDialectsLoaded();
    const out = {} as Record<ScriptLanguageId, LanguageDialect>;
    for (const [id, dialect] of this.dialects.entries()) {
      out[id as ScriptLanguageId] = dialect;
    }
    return out;
  }

  isSupported(raw: unknown): raw is ScriptLanguageId {
    this.ensureDialectsLoaded();
    return typeof raw === 'string' && this.dialects.has(raw);
  }

  normalizeId(raw: unknown, fallback?: ScriptLanguageId): ScriptLanguageId {
    if (this.isSupported(raw)) return raw;
    return fallback ?? this.getDefaultId();
  }

  /** Returns comma-separated `.ext` list for `<input accept>` (e.g. `'.lua,.py'`). */
  getSupportedAcceptAttr(): string {
    return this.listDialects()
      .map((d) => `.${d.extension}`)
      .join(',');
  }

  /** Returns human-readable supported extensions label (e.g. `'.lua / .py'`). */
  formatSupportedExtensionsLabel(): string {
    return this.listDialects()
      .map((d) => `.${d.extension}`)
      .join(' / ');
  }

  /** Strips a trailing `.ext` matching any registered script language dialect. */
  stripScriptExtension(name: string): string {
    const escapedExts = this.listDialects()
      .map((d) => d.extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .sort((a, b) => b.length - a.length);
    if (escapedExts.length === 0) return name;
    const extRe = new RegExp(`\\.(?:${escapedExts.join('|')})$`, 'i');
    return name.replace(extRe, '');
  }

  formatInitialValue(
    init: VariableInitialValue | null | undefined,
    lang: ScriptLanguageId,
  ): string {
    return formatInitialValueForDialect(init, this.getDialect(lang));
  }
}

export const backendRegistry = new BackendRegistry();

export function getLanguageDialect(lang: ScriptLanguageId): LanguageDialect {
  return backendRegistry.getDialect(lang);
}

export function getSupportedLanguageIds(): ScriptLanguageId[] {
  return backendRegistry.listIds();
}

export function isSupportedLanguageId(raw: unknown): raw is ScriptLanguageId {
  return backendRegistry.isSupported(raw);
}

export function normalizeLanguageId(
  raw: unknown,
  fallback?: ScriptLanguageId,
): ScriptLanguageId {
  return backendRegistry.normalizeId(raw, fallback);
}

export function getSupportedScriptAcceptAttr(): string {
  return backendRegistry.getSupportedAcceptAttr();
}

export function formatSupportedExtensionsLabel(): string {
  return backendRegistry.formatSupportedExtensionsLabel();
}

export function stripScriptExtension(name: string): string {
  return backendRegistry.stripScriptExtension(name);
}

export function formatInitialValueForLanguage(
  init: VariableInitialValue | null | undefined,
  lang: ScriptLanguageId,
): string {
  return backendRegistry.formatInitialValue(init, lang);
}
