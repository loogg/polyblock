import {
  loadMicroPython,
  type MicroPythonInstance,
} from '@micropython/micropython-webassembly-pyscript';

interface WorkerRunMessage {
  type: 'RUN';
  runId: string;
  code: string;
  wasmUrl: string;
}

let activeRunId = '';
let mpInstance: MicroPythonInstance | null = null;
let cachedWasmUrl: string | null = null;
let stderrLines: string[] = [];

async function ensureMicroPython(wasmUrl: string): Promise<MicroPythonInstance> {
  if (mpInstance && cachedWasmUrl === wasmUrl) {
    return mpInstance;
  }

  mpInstance = await loadMicroPython({
    url: wasmUrl,
    linebuffer: true,
    stdout: (line: string) => {
      self.postMessage({ type: 'STDOUT', runId: activeRunId, line });
    },
    stderr: (line: string) => {
      stderrLines.push(line);
      self.postMessage({ type: 'STDERR', runId: activeRunId, line });
    },
  });
  cachedWasmUrl = wasmUrl;
  return mpInstance;
}

self.onmessage = async (event: MessageEvent<WorkerRunMessage>) => {
  const msg = event.data;
  if (!msg || msg.type !== 'RUN') return;

  const { runId, code, wasmUrl } = msg;
  activeRunId = runId;
  stderrLines = [];
  const startedAt = performance.now();

  try {
    const mp = await ensureMicroPython(wasmUrl);
    // Execute inside an isolated namespace per run so stale variables do not leak
    const wrapped = `
__poly_ns = {"__name__": "__main__"}
exec(${JSON.stringify(code)}, __poly_ns)
`;
    await mp.runPythonAsync(wrapped);

    self.postMessage({
      type: 'DONE',
      runId,
      durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const combined =
      stderrLines.length > 0 ? stderrLines.join('\n') : rawMsg;
    self.postMessage({
      type: 'ERROR',
      runId,
      message: combined,
      durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
  }
};
