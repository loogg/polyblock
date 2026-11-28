import type { PolyExtensionPack } from '../core/extensions/types';

/** Open extensible target language identifier registered by a `LanguagePlugin`. */
export type ScriptLanguageId = string;

export type PageId = 'blocks' | 'projects' | 'devices' | 'extensions' | 'settings';

export type ThemeMode = 'light' | 'dark';

export type LogLevel = 'print' | 'info' | 'warn' | 'error' | 'ok' | 'system';

export type ExecutionSpeedId = 'realtime' | 'animate' | 'slow';

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
  category: 'shared' | 'lifecycle' | 'event' | 'function' | 'top';
  blockId?: string;
  variables: ScopedVariableItem[];
}

/** Per-handle declarative channel-pool config stored under handle.capabilityConfigs[configKey]. */
export interface ChannelPoolConfig {
  /** Number of available channels for this handle (e.g. 1..32 -> IDs 0..count-1). */
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
  /** Optional per-channel-pool default count overrides keyed by pool configKey (e.g. `{ "rt.timers": 16 }`). */
  defaultChannelCounts?: Record<string, number>;
  /** Default enabled capability IDs (pack IDs like `"rt"` or section IDs like `"rt.timers"`). */
  capabilities: string[];
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

export type StartCoroutineState = 'idle' | 'running' | 'sleeping' | 'ready' | 'dead';

export interface RuntimeTelemetry {
  eventLoopActive: boolean;
  hasOnRun: boolean;
  runActive: boolean;
  runPeriodMs: number;
  runCount: number;
  hasExternalEvents: boolean;
  startCoState?: StartCoroutineState;
  timeSliceMs?: number;
  timers: RuntimeTimerTelemetry[];
}

/** Explicit initial value for handle-shared or file-scoped variables (language-agnostic). */
export type VariableInitialValue =
  | { kind: 'null' }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'list' }
  | { kind: 'dict' };

/** Single visual-block script inside a RuntimeHandle. */
export interface ProjectScript {
  id: string;
  name: string;
  workspace: Record<string, unknown>;
  /** Explicit initial values for single-file global variables in this script. */
  variableInitialValues?: Record<string, VariableInitialValue>;
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
  /** Generic per-handle capability config store (e.g., capabilityConfigs['rt.timers']). */
  capabilityConfigs: Record<string, unknown>;
  /**
   * Explicit handle-wide cross-file shared variable names.
   * Every language backend auto-generates a read-only `shared.<ext>` module
   * accessed uniformly as `shared.<var>`.
   */
  sharedVariables?: string[];
  /** Explicit initial values for cross-file shared variables in `shared.<ext>`. */
  variableInitialValues?: Record<string, VariableInitialValue>;
  /**
   * Explicit handle-wide cross-file shared custom function names.
   * Exported centrally into read-only `shared.<ext>` and called uniformly as `shared.<fn>(...)`.
   */
  sharedFunctions?: string[];
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
  /**
   * Project-scoped / version-locked extension packs (in-workspace mirror of `<project>/extensions/*.polyext.json`).
   * Strictly excluded from pure `project.polyblock.json` files and packaged as standalone
   * `extensions/<id>.polyext.json` files inside `.polyblock.zip` archives.
   */
  localExtensions?: PolyExtensionPack[];
  /**
   * Project-scoped / version-locked target board profile (in-workspace mirror of `<project>/boards/<id>.polyboard.json`).
   * Strictly excluded from pure `project.polyblock.json` files and packaged as a standalone
   * `boards/<id>.polyboard.json` file inside `.polyblock.zip` archives.
   */
  localTargetProfile?: TargetProfile;
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

export interface AppSettings {
  theme: ThemeMode;
  /** Single event callback / blocking computation timeout (ms). Does NOT cap long-running event loops. */
  timeoutMs: number;
  /** Cooperative time-slice budget (ms) for `on_start` coroutine preemption. */
  timeSliceMs: number;
  autoOpenConsoleOnRun: boolean;
  executionSpeed: ExecutionSpeedId;
}
