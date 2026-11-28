import JsWorker from './js.worker.ts?worker';
import { WorkerWasmRunner } from '../../../core/runners/workerWasmRunner';

export class BrowserJsWorkerRunner extends WorkerWasmRunner {
  constructor() {
    super({
      id: 'browser-js-worker',
      name: '浏览器 JavaScript 沙箱 (Web Worker)',
      shortLabel: 'JS Worker',
      engineBadge: 'JS',
      kind: 'browser-worker',
      transportLabel: '原生 Web Worker · 零 WASM 体积',
      language: 'js',
      description:
        '基于独立 Web Worker 的零体积 ES2023 调试沙箱，原生支持 async/await 单轨协程、CommonJS 模块隔离、多路定时器与断点单步。',
      createWorker: () => new JsWorker(),
    });
  }
}
