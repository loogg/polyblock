import type { ScriptLanguageId } from '../../types/project';
import { LuaBackendAdapter } from './luaBackend';
import { PythonBackendAdapter } from './pythonBackend';
import type { ScriptBackendAdapter } from './types';

class BackendRegistry {
  private readonly adapters = new Map<ScriptLanguageId, ScriptBackendAdapter>();

  constructor() {
    this.register(new LuaBackendAdapter());
    this.register(new PythonBackendAdapter());
  }

  register(adapter: ScriptBackendAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: ScriptLanguageId): ScriptBackendAdapter {
    const found = this.adapters.get(id);
    if (!found) {
      throw new Error(`Unsupported script backend: ${id}`);
    }
    return found;
  }

  list(): ScriptBackendAdapter[] {
    return Array.from(this.adapters.values());
  }
}

export const backendRegistry = new BackendRegistry();
