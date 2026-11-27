import type { WorkerControlMessage } from './debugSession';
import { runJsInSandbox } from './jsSandboxCore';
import { WorkerProtocolHost } from './workerProtocolHost';

const host = new WorkerProtocolHost((payload) => self.postMessage(payload));

self.onmessage = (event: MessageEvent<WorkerControlMessage>) => {
  void host.handleMessage(event.data, async ({ msg, session, scheduler }) => {
    await runJsInSandbox({
      code: msg.code,
      mockModules: msg.mockModules,
      scheduler,
      session,
      postStdout: (line) => {
        self.postMessage({
          type: 'STDOUT',
          runId: host.getActiveRunId(),
          line,
        });
      },
      emitScopedState: (packId, kind, value) =>
        host.emitScopedState(packId, kind, value),
      getScopedState: (packId, key) => host.getScopedState(packId, key),
      emitCustomEvent: (eventName, args) =>
        host.emitCustomEvent(eventName, args),
    });
  });
};
