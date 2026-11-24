/// <reference types="vite/client" />

declare module '*.wasm?url' {
  const url: string;
  export default url;
}

declare module '@micropython/micropython-webassembly-pyscript' {
  export interface LoadMicroPythonOptions {
    url?: string;
    pystack?: number;
    heapsize?: number;
    linebuffer?: boolean;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  }

  export interface MicroPythonInstance {
    runPython(code: string): unknown;
    runPythonAsync(code: string): Promise<unknown>;
    registerJsModule(name: string, mod: Record<string, unknown>): void;
  }

  export function loadMicroPython(
    options?: LoadMicroPythonOptions,
  ): Promise<MicroPythonInstance>;
}

declare module 'blockly/msg/zh-hans' {
  const locale: Record<string, string>;
  export default locale;
}
