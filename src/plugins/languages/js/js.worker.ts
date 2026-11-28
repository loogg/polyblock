import type { WorkerControlMessage } from '../../../workers/debugSession';
import { runJsInSandbox } from './jsSandboxCore';
import { WorkerProtocolHost } from '../../../workers/workerProtocolHost';

const host = new WorkerProtocolHost((payload) => self.postMessage(payload));

self.onmessage = (event: MessageEvent<WorkerControlMessage>) => {
  void host.handleMessage(
    event.data,
    async ({
      msg,
      runId,
      session,
      scheduler,
      emitScopedState,
      getScopedState,
      emitCustomEvent,
    }) => {
      await runJsInSandbox({
        code: msg.code,
        mockModules: msg.mockModules,
        scheduler,
        session,
        postStdout: (line) => {
          self.postMessage({
            type: 'STDOUT',
            runId,
            line,
          });
        },
        emitScopedState,
        getScopedState,
        emitCustomEvent,
      });
    },
  );
};
