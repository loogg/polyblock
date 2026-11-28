import type { LanguagePlugin } from '../../../core/backends/types';
import { PYTHON_DIALECT, PythonBackendAdapter } from './pythonBackend';
import { MicroPythonWasmRunner } from './pythonRunner';

export { PYTHON_DIALECT, PythonBackendAdapter, MicroPythonWasmRunner };

export function createPythonLanguagePlugin(): LanguagePlugin {
  return {
    id: PYTHON_DIALECT.id,
    dialect: PYTHON_DIALECT,
    createBackend: () => new PythonBackendAdapter(),
    createRunner: () => new MicroPythonWasmRunner(),
  };
}
