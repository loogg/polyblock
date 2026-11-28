import type { LanguagePlugin } from '../../../core/backends/types';
import { JS_DIALECT, JsBackendAdapter } from './jsBackend';
import { BrowserJsWorkerRunner } from './jsRunner';

export { JS_DIALECT, JsBackendAdapter, BrowserJsWorkerRunner };

export function createJsLanguagePlugin(): LanguagePlugin {
  return {
    id: JS_DIALECT.id,
    dialect: JS_DIALECT,
    createBackend: () => new JsBackendAdapter(),
    createRunner: () => new BrowserJsWorkerRunner(),
  };
}
