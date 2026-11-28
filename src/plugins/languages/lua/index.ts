import type { LanguagePlugin } from '../../../core/backends/types';
import { LUA_DIALECT, LuaBackendAdapter } from './luaBackend';
import { WasmoonLuaRunner } from './luaRunner';

export { LUA_DIALECT, LuaBackendAdapter, WasmoonLuaRunner };

export function createLuaLanguagePlugin(): LanguagePlugin {
  return {
    id: LUA_DIALECT.id,
    dialect: LUA_DIALECT,
    createBackend: () => new LuaBackendAdapter(),
    createRunner: () => new WasmoonLuaRunner(),
  };
}
