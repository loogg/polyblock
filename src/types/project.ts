export type ScriptLanguageId = 'lua' | 'python';

export type PageId = 'blocks' | 'projects' | 'devices' | 'extensions' | 'settings';

export type ThemeMode = 'light' | 'dark';

export type LogLevel = 'print' | 'info' | 'warn' | 'error' | 'ok' | 'system';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  line?: number;
  blockId?: string;
}

export interface DiagnosticItem {
  id: string;
  severity: 'warning' | 'error';
  message: string;
  blockId?: string;
  line?: number;
}

export interface SourceLineRange {
  startLine: number;
  endLine: number;
}

export interface ProjectFileData {
  format: 'polyblock-project';
  version: 1;
  name: string;
  language: ScriptLanguageId;
  updatedAt: string;
  workspace: Record<string, unknown>;
}

export type ExecutionSpeedId = 'fast' | 'normal' | 'slow';

export interface VariableSnapshotItem {
  name: string;
  value: string;
}

export interface AppSettings {
  theme: ThemeMode;
  timeoutMs: number;
  autoOpenConsoleOnRun: boolean;
  executionSpeed: ExecutionSpeedId;
}
