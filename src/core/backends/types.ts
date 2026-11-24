import type * as Blockly from 'blockly';
import type {
  DiagnosticItem,
  ScriptLanguageId,
  SourceLineRange,
} from '../../types/project';

export interface GeneratedCodeResult {
  language: ScriptLanguageId;
  code: string;
  sourceMap: Record<string, SourceLineRange>;
  lineToBlock: Record<number, string>;
  diagnostics: DiagnosticItem[];
  blockCount: number;
}

/**
 * Unified contract for any target script backend (Lua, Python, future JS/Shell/DSL...).
 * Implementing this interface lets PolyBlock generate code, map lines back to blocks,
 * and surface static diagnostics without touching UI components.
 */
export interface ScriptBackendAdapter {
  readonly id: ScriptLanguageId;
  readonly name: string;
  readonly version: string;
  readonly extension: string;
  readonly fileName: string;
  readonly accentColor: string;
  readonly description: string;
  generate(workspace: Blockly.Workspace): GeneratedCodeResult;
}
