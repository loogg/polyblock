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
  /** Optional source handle name & accent color during multi-handle concurrent runs. */
  handleName?: string;
  handleColor?: string;
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

/** Static + runtime scope classification for tree-structured variable watching. */
export interface ScopedVariableItem {
  name: string;
  /** Safe generated identifier used for runtime snapshot lookup. */
  ident: string;
  kind: 'shared' | 'scope-global' | 'local' | 'param';
  firstBlockId?: string;
  usedInScopes?: string[];
}

export interface VariableScopeNode {
  id: string;
  label: string;
  category: 'shared' | 'lifecycle' | 'timer' | 'button' | 'function' | 'top';
  blockId?: string;
  variables: ScopedVariableItem[];
}

/** Per-handle timer capability config stored under handle.capabilityConfigs['rt-timers']. */
export interface ProjectTimerConfig {
  /** Number of available timer channels for this handle (1..32, default 8 -> IDs 0..7). */
  count: number;
  /** Optional friendly labels keyed by stringified integer ID (e.g. "0": "心跳灯"). */
  aliases: Record<string, string>;
}

/** Target board / execution environment specification (built-in or imported .polyboard.json). */
export interface TargetProfile {
  format: 'polyblock-board';
  version: 1;
  id: string;
  name: string;
  description: string;
  defaultLanguage: ScriptLanguageId;
  maxHandles: number;
  defaultTimerCount: number;
  /** Default enabled capability IDs (runtime capabilities + peripheral/extension packs). */
  capabilities: string[];
  builtin?: boolean;
}

/** Built-in runtime capability metadata (e.g., rt-lifecycle, rt-timers). */
export interface RuntimeCapabilitySpec {
  id: string;
  name: string;
  shortLabel: string;
  color: string;
  scope: 'project' | 'handle';
  description: string;
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

/** Single visual-block script inside a RuntimeHandle (or sharedModules). */
export interface ProjectScript {
  id: string;
  name: string;
  workspace: Record<string, unknown>;
  breakpoints: string[];
  updatedAt: string;
}

/** Isolated runtime VM handle inside a project (maps 1:1 to a C-layer lua_State* / Python VM). */
export interface RuntimeHandle {
  id: string;
  name: string;
  description?: string;
  color: string;
  autoStart: boolean;
  /** Generic per-handle capability config store (e.g., capabilityConfigs['rt-timers']). */
  capabilityConfigs: Record<string, unknown>;
  entryScriptId: string;
  activeScriptId: string;
  scripts: ProjectScript[];
  updatedAt: string;
}

/** v3 Three-tier Capability-Driven Project -> Handle[] -> Script[] model. */
export interface ProjectModel {
  format: 'polyblock-project';
  version: 3;
  id: string;
  name: string;
  description?: string;
  language: ScriptLanguageId;
  /** Bound target environment / board specification ID (e.g. 'generic-script', 'embedded-rt', 'virtual-board-rt'). */
  targetProfileId: string;
  /** Unified list of enabled runtime capabilities & peripheral/extension pack IDs for this project. */
  enabledCapabilities: string[];
  /** Project default timer channel count when rt-timers is enabled (1..32). */
  defaultTimerCount: number;
  /** Forward-compatible reserved pure-script shared libraries (single source, isolated load per handle). */
  sharedModules: ProjectScript[];
  activeHandleId: string;
  handles: RuntimeHandle[];
  createdAt: string;
  updatedAt: string;
}

/** Root workspace store persisted in browser localStorage (v3). */
export interface WorkspaceStoreState {
  version: 3;
  activeProjectId: string;
  projects: ProjectModel[];
}

/** Legacy v2 two-tier project format kept for lossless import & migration. */
export interface LegacyProjectModelV2 {
  format?: 'polyblock-project';
  version: 2;
  id?: string;
  name?: string;
  description?: string;
  language?: ScriptLanguageId;
  enabledExtensions?: string[];
  timerConfig?: Partial<ProjectTimerConfig>;
  entryScriptId?: string;
  activeScriptId?: string;
  scripts: ProjectScript[];
  createdAt?: string;
  updatedAt?: string;
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
