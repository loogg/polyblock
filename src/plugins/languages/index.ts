import { backendRegistry } from '../../core/backends/registry';
import type { LanguagePlugin } from '../../core/backends/types';
import { createJsLanguagePlugin } from './js';
import { createLuaLanguagePlugin } from './lua';
import { createPythonLanguagePlugin } from './python';

let defaultsRegistered = false;

/**
 * Returns the default language plugin descriptors shipped with PolyBlock.
 * Concrete target languages live strictly under `src/plugins/languages/` outside `src/core/`,
 * and register inward into `backendRegistry` at app / test startup.
 */
export function getDefaultLanguagePlugins(): readonly LanguagePlugin[] {
  return [
    createLuaLanguagePlugin(),
    createPythonLanguagePlugin(),
    createJsLanguagePlugin(),
  ];
}

/**
 * Registers all shipped language plugins into the language-agnostic `backendRegistry`.
 * Safe to invoke multiple times (idempotent).
 */
export function registerDefaultLanguagePlugins(): void {
  if (defaultsRegistered) return;
  defaultsRegistered = true;
  for (const plugin of getDefaultLanguagePlugins()) {
    if (!backendRegistry.has(plugin.id)) {
      backendRegistry.registerPlugin(plugin);
    }
  }
}
