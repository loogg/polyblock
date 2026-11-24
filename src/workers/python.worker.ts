import {
  loadMicroPython,
  type MicroPythonInstance,
} from '@micropython/micropython-webassembly-pyscript';
import {
  WorkerDebugSession,
  type WorkerControlMessage,
} from './debugSession';

let activeRunId = '';
let activeSession: WorkerDebugSession | null = null;
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

  mpInstance.registerJsModule('_poly', {
    step: (blockId: string, varsJson: string) => {
      if (!activeSession) return Promise.resolve();
      return activeSession.onStep(String(blockId), varsJson);
    },
    sleep: (ms: number) => {
      if (!activeSession) return Promise.resolve();
      return activeSession.onSleep(ms);
    },
    final_snap: (varsJson: string) => {
      activeSession?.setFinalVars(varsJson);
    },
  });

  cachedWasmUrl = wasmUrl;
  return mpInstance;
}

const RESET_GLOBALS_SNIPPET = `
for _k in list(globals().keys()):
  if _k not in ('__name__', '__file__', '__builtins__'):
    del globals()[_k]
`;

self.onmessage = async (event: MessageEvent<WorkerControlMessage>) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'RESUME') {
    if (activeSession?.runId === msg.runId) activeSession.resume();
    return;
  }
  if (msg.type === 'STEP_NEXT') {
    if (activeSession?.runId === msg.runId) activeSession.stepNext();
    return;
  }
  if (msg.type === 'PAUSE') {
    if (activeSession?.runId === msg.runId) activeSession.pause();
    return;
  }
  if (msg.type === 'SET_BREAKPOINTS') {
    if (activeSession?.runId === msg.runId) {
      activeSession.setBreakpoints(msg.breakpoints);
    }
    return;
  }
  if (msg.type === 'SET_SPEED') {
    if (activeSession?.runId === msg.runId) {
      activeSession.setStepDelay(msg.stepDelayMs);
    }
    return;
  }

  if (msg.type !== 'RUN') return;

  const { runId, code, wasmUrl, breakpoints, stepDelayMs, startInStepMode } = msg;
  activeRunId = runId;
  stderrLines = [];
  const startedAt = performance.now();

  const session = new WorkerDebugSession(
    { runId, breakpoints, stepDelayMs, startInStepMode },
    (payload) => self.postMessage(payload),
  );
  activeSession = session;

  try {
    const mp = await ensureMicroPython(wasmUrl);
    mp.runPython(RESET_GLOBALS_SNIPPET);
    await mp.runPythonAsync(code);

    self.postMessage({
      type: 'DONE',
      runId,
      durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
      vars: session.getLastVars(),
    });
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const combined = stderrLines.length > 0 ? stderrLines.join('\n') : rawMsg;
    self.postMessage({
      type: 'ERROR',
      runId,
      message: combined,
      durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
  } finally {
    if (activeSession === session) activeSession = null;
  }
};
