import luaWasmAsset from 'wasmoon/dist/glue.wasm?url';
import LuaWorker from './lua.worker.ts?worker';
import { WorkerWasmRunner } from '../../../core/runners/workerWasmRunner';

export class WasmoonLuaRunner extends WorkerWasmRunner {
  constructor() {
    super({
      id: 'browser-lua-wasmoon',
      name: '浏览器 Lua 5.4 沙箱 (Wasmoon WASM)',
      shortLabel: 'Lua 5.4 WASM',
      language: 'lua',
      description:
        '基于 WebAssembly 的纯前端 Lua 5.4 调试沙箱，支持常驻事件循环、多路编号定时器、逐块高亮与断点单步。',
      wasmAssetUrl: luaWasmAsset,
      createWorker: () => new LuaWorker(),
    });
  }
}
