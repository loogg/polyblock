export type ScriptLanguageId = 'lua' | 'python';

export type PageId = 'blocks' | 'projects' | 'devices' | 'extensions' | 'settings';

export type ThemeMode = 'light' | 'dark';

export type LogLevel = 'print' | 'info' | 'warn' | 'error' | 'ok' | 'system';

export type ExecutionSpeedId = 'fast' | 'normal' | 'slow';

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

export interface VariableSnapshotItem {
  name: string;
  value: string;
}

/** Project-scoped hardware/software timer capability config (integer IDs 0..count-1). */
export interface ProjectTimerConfig {
  /** Number of available timer channels (1..32, default 8 -> IDs 0..7). */
  count: number;
  /** Optional friendly labels keyed by stringified integer ID (e.g. "0": "心跳灯"). */
  aliases: Record<string, string>;
}

/** Live runtime telemetry emitted by the cooperative WASM event-loop scheduler. */
export interface RuntimeTimerTelemetry {
  id: number;
  periodMs: number;
  repeat: number;
  firedCount: number;
  elapsedMs: number;
  running: boolean;
}

export interface RuntimeTelemetry {
  eventLoopActive: boolean;
  hasOnRun: boolean;
  runActive: boolean;
  runPeriodMs: number;
  runCount: number;
  hasOnButton: boolean;
  timers: RuntimeTimerTelemetry[];
}

/** Single visual-block script inside a PolyBlock project. */
export interface ProjectScript {
  id: string;
  name: string;
  workspace: Record<string, unknown>;
  breakpoints: string[];
  updatedAt: string;
}

/** v2 Project-rooted multi-script model (unified project language + 1..N scripts). */
export interface ProjectModel {
  format: 'polyblock-project';
  version: 2;
  id: string;
  name: string;
  description?: string;
  language: ScriptLanguageId;
  enabledExtensions: string[];
  /** Optional per-project timer channel capability & aliases (defaults to 8 channels, 0..7). */
  timerConfig?: ProjectTimerConfig;
  entryScriptId: string;
  activeScriptId: string;
  scripts: ProjectScript[];
  createdAt: string;
  updatedAt: string;
}

/** Root workspace store persisted in browser localStorage. */
export interface WorkspaceStoreState {
  version: 2;
  activeProjectId: string;
  projects: ProjectModel[];
}

/** Legacy v1 single-canvas file format kept for seamless import & migration. */
export interface LegacyProjectFileV1 {
  format?: 'polyblock-project';
  version?: 1;
  name?: string;
  language?: ScriptLanguageId;
  updatedAt?: string;
  workspace: Record<string, unknown>;
}

export interface AppSettings {
  theme: ThemeMode;
  timeoutMs: number;
  autoOpenConsoleOnRun: boolean;
  executionSpeed: ExecutionSpeedId;
}
