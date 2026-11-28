import mpWasmAsset from '@micropython/micropython-webassembly-pyscript/micropython.wasm?url';
import PythonWorker from './python.worker.ts?worker';
import { WorkerWasmRunner } from '../../../core/runners/workerWasmRunner';

export class MicroPythonWasmRunner extends WorkerWasmRunner {
  constructor() {
    super({
      id: 'browser-python-micropython',
      name: '浏览器 Python 3 沙箱 (MicroPython WASM)',
      shortLabel: 'MicroPython WASM',
      language: 'python',
      description:
        '基于 MicroPython WebAssembly 的轻量 Python 3 调试沙箱，支持常驻事件循环、多路编号定时器与异步断点单步。',
      wasmAssetUrl: mpWasmAsset,
      createWorker: () => new PythonWorker(),
    });
  }
}
