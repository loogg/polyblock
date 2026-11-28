import type {
  ScriptLanguageId,
  VariableInitialValue,
} from '../../types/project';
import {
  formatInitialValueForDialect,
  type LanguageDialect,
  type LanguagePlugin,
  type ScriptBackendAdapter,
} from './types';

type PluginChangeListener = (event: {
  kind: 'registered' | 'unregistered';
  id: string;
  plugin?: LanguagePlugin;
}) => void;

type AdapterLifecycleListener = (
  event:
    | { kind: 'attached'; adapter: ScriptBackendAdapter }
    | { kind: 'detached'; id: ScriptLanguageId },
) => void;

/**
 * Pure, language-agnostic, zero-cycle central registry for `LanguagePlugin` instances.
 * Concrete target languages live outside `src/core/` (under `src/plugins/languages/`)
 * and register inward via `backendRegistry.registerPlugin(...)` at startup or runtime.
 * Downstream consumers (such as `extensionRegistry` and `runnerManager`) subscribe outward
 * via `onAdapterLifecycle` / `onPluginChange` so this module stays a one-way Layer 0 leaf.
 */
class BackendRegistry {
  private readonly plugins = new Map<string, LanguagePlugin>();
  private readonly dialects = new Map<string, LanguageDialect>();
  private readonly adapters = new Map<string, ScriptBackendAdapter>();
  private readonly listeners = new Set<PluginChangeListener>();
  private readonly adapterListeners = new Set<AdapterLifecycleListener>();
  private initialized = false;
  private revision = 0;

  private notifyAdapterAttached(adapter: ScriptBackendAdapter): void {
    for (const listener of this.adapterListeners) {
      listener({ kind: 'attached', adapter });
    }
  }

  private notifyAdapterDetached(id: ScriptLanguageId): void {
    for (const listener of this.adapterListeners) {
      listener({ kind: 'detached', id });
    }
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
    for (const plugin of this.plugins.values()) {
      if (!this.adapters.has(plugin.id)) {
        const adapter = plugin.createBackend();
        this.adapters.set(adapter.id, adapter);
        this.dialects.set(adapter.id, adapter.dialect);
        this.notifyAdapterAttached(adapter);
      }
    }
  }

  /** Monotonic revision counter incremented on plugin register/unregister (for React useSyncExternalStore). */
  getRevision(): number {
    return this.revision;
  }

  /** Subscribes to runtime language plugin registration / unregistration (used by RunnerManager & UI). */
  onPluginChange(listener: PluginChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribes to concrete backend adapter attach / detach lifecycle events (used by
   * `extensionRegistry` to avoid a circular runtime import back into extensions).
   * Immediately replays any already-initialized adapters to the new subscriber.
   */
  onAdapterLifecycle(listener: AdapterLifecycleListener): () => void {
    this.adapterListeners.add(listener);
    for (const adapter of this.adapters.values()) {
      listener({ kind: 'attached', adapter });
    }
    return () => {
      this.adapterListeners.delete(listener);
    };
  }

  /** Lists all registered language plugin descriptors. */
  listPlugins(): LanguagePlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Registers (or replaces) a complete language plugin (dialect + backend + optional sandbox runner).
   * Defers adapter instantiation until first compiler access if not yet initialized,
   * and attaches immediately for hot runtime registrations.
   */
  registerPlugin(plugin: LanguagePlugin): void {
    this.plugins.set(plugin.id, plugin);
    this.dialects.set(plugin.id, plugin.dialect);
    if (this.initialized) {
      const adapter = plugin.createBackend();
      this.adapters.set(adapter.id, adapter);
      this.dialects.set(adapter.id, adapter.dialect);
      this.notifyAdapterAttached(adapter);
    } else {
      this.adapters.delete(plugin.id);
    }
    this.revision += 1;
    for (const listener of this.listeners) {
      listener({ kind: 'registered', id: plugin.id, plugin });
    }
  }

  /** Convenience helper to register an export-only backend adapter directly as a plugin. */
  register(adapter: ScriptBackendAdapter): void {
    this.registerPlugin({
      id: adapter.id,
      dialect: adapter.dialect,
      createBackend: () => adapter,
    });
  }

  /**
   * Unregisters a language plugin (all plugins are equal; at least 1 language plugin must remain).
   */
  unregister(id: string): boolean {
    if (!this.plugins.has(id) || this.plugins.size <= 1) {
      return false;
    }
    const deletedPlugin = this.plugins.delete(id);
    const deletedAdapter = this.adapters.delete(id);
    const deletedDialect = this.dialects.delete(id);
    const changed = deletedPlugin || deletedAdapter || deletedDialect;
    if (changed) {
      if (this.initialized) {
        this.notifyAdapterDetached(id as ScriptLanguageId);
      }
      this.revision += 1;
      for (const listener of this.listeners) {
        listener({ kind: 'unregistered', id });
      }
    }
    return changed;
  }

  get(id: ScriptLanguageId): ScriptBackendAdapter {
    this.ensureInitialized();
    const found = this.adapters.get(id);
    if (!found) {
      throw new Error(`Unsupported script backend: ${id}`);
    }
    return found;
  }

  has(id: string): boolean {
    return this.plugins.has(id);
  }

  list(): ScriptBackendAdapter[] {
    this.ensureInitialized();
    return Array.from(this.adapters.values());
  }

  /** Lists all registered language IDs (synchronously safe without triggering extension init). */
  listIds(): ScriptLanguageId[] {
    return Array.from(this.dialects.keys()) as ScriptLanguageId[];
  }

  /** Returns the primary default language ID (first currently registered language plugin). */
  getDefaultId(): ScriptLanguageId {
    const first = this.dialects.keys().next().value;
    if (!first) {
      throw new Error(
        'No language plugins registered in backendRegistry. Ensure `registerDefaultLanguagePlugins()` runs before use.',
      );
    }
    return first as ScriptLanguageId;
  }

  /** Returns the LanguageDialect for a registered language ID (throws if unregistered). */
  getDialect(id: ScriptLanguageId): LanguageDialect {
    const found = this.dialects.get(id);
    if (!found) {
      throw new Error(`Unsupported script language dialect: ${id}`);
    }
    return found;
  }

  tryGetDialect(id: string): LanguageDialect | undefined {
    return this.dialects.get(id);
  }

  listDialects(): LanguageDialect[] {
    return Array.from(this.dialects.values());
  }

  isSupported(raw: unknown): raw is ScriptLanguageId {
    return typeof raw === 'string' && this.dialects.has(raw);
  }

  normalizeId(raw: unknown, fallback?: ScriptLanguageId): ScriptLanguageId {
    if (this.isSupported(raw)) return raw;
    return fallback ?? this.getDefaultId();
  }

  /** Returns comma-separated `.ext` list for `<input accept>` (e.g. `'.lua,.py,.js'`). */
  getSupportedAcceptAttr(): string {
    return this.listDialects()
      .map((d) => `.${d.extension}`)
      .join(',');
  }

  /** Returns human-readable supported extensions label (e.g. `'.lua / .py / .js'`). */
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

  /** Detects a registered language ID from a filename extension, or falls back when unknown. */
  detectLanguageFromFileName(
    fileName: string,
    fallback: ScriptLanguageId = this.getDefaultId(),
  ): ScriptLanguageId {
    const lower = fileName.trim().toLowerCase();
    for (const d of this.listDialects()) {
      if (lower.endsWith(`.${d.extension.toLowerCase()}`)) {
        return d.id as ScriptLanguageId;
      }
    }
    return fallback;
  }

  /** Formats a structured VariableInitialValue into the target dialect's native literal syntax. */
  formatInitialValue(
    init: VariableInitialValue | null | undefined,
    language: ScriptLanguageId,
  ): string {
    return formatInitialValueForDialect(init, this.getDialect(language));
  }
}

export const backendRegistry = new BackendRegistry();

export function getSupportedLanguageIds(): ScriptLanguageId[] {
  return backendRegistry.listIds();
}

export function getLanguageDialect(id: ScriptLanguageId): LanguageDialect {
  return backendRegistry.getDialect(id);
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
  language: ScriptLanguageId,
): string {
  return backendRegistry.formatInitialValue(init, language);
}
