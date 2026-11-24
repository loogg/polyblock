import { LuaFactory } from 'wasmoon';

interface WorkerRunMessage {
  type: 'RUN';
  runId: string;
  code: string;
  wasmUrl: string;
}

let cachedWasmUrl: string | null = null;
let factory: LuaFactory | null = null;

function formatLuaArg(val: unknown): string {
  if (val === null || val === undefined) return 'nil';
  if (typeof val === 'object') {
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

self.onmessage = async (event: MessageEvent<WorkerRunMessage>) => {
  const msg = event.data;
  if (!msg || msg.type !== 'RUN') return;

  const { runId, code, wasmUrl } = msg;
  const startedAt = performance.now();

  try {
    if (!factory || cachedWasmUrl !== wasmUrl) {
      factory = new LuaFactory(wasmUrl);
      cachedWasmUrl = wasmUrl;
    }

    const engine = await factory.createEngine({ openStandardLibs: true });

    try {
      // Seed Lua PRNG so math.random produces fresh numbers across runs
      const seed = Math.floor(Date.now() % 2147483647);
      engine.global.set('__poly_print', (...args: unknown[]) => {
        const line = args.map(formatLuaArg).join('\t');
        self.postMessage({ type: 'STDOUT', runId, line });
      });

      await engine.doString(`
        math.randomseed(${seed})
        print = function(...)
          local n = select('#', ...)
          local out = {}
          for i = 1, n do
            out[i] = tostring(select(i, ...))
          end
          __poly_print(table.concat(out, "\\t"))
        end
      `);

      await engine.doString(code);

      self.postMessage({
        type: 'DONE',
        runId,
        durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
      });
    } finally {
      engine.global.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({
      type: 'ERROR',
      runId,
      message,
      durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
  }
};
