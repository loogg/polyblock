import type {
  ChannelPoolConfig,
  ScriptLanguageId,
  VariableInitialValue,
} from '../../../types/project';
import type { PolyExtensionPack } from '../../extensions/types';

export interface HandleTemplateSpec {
  name: string;
  description?: string;
  color?: string;
  autoStart?: boolean;
  /** Declarative per-handle channel pool configs keyed by pool configKey (e.g. `rt.timers`, `pwm-servo`). */
  capabilityConfigs?: Record<string, Partial<ChannelPoolConfig>>;
  /** Explicit cross-file shared variables for this handle (Lua `shared.lua` / Python `shared.py`). */
  sharedVariables?: string[];
  /** Explicit cross-file shared functions exported into `shared.lua` / `shared.py`. */
  sharedFunctions?: string[];
  /** Optional explicit initial values for cross-file shared variables. */
  variableInitialValues?: Record<string, VariableInitialValue>;
  scripts: Array<{
    name: string;
    isEntry?: boolean;
    workspace: Record<string, unknown>;
    variableInitialValues?: Record<string, VariableInitialValue>;
  }>;
}

export interface ProjectDifficultyMeta {
  level: 'L1' | 'L2' | 'L3' | 'L4';
  label: string;
  highlights: string[];
}

export interface MultiHandleProjectTemplate {
  id: string;
  name: string;
  description: string;
  language: ScriptLanguageId;
  targetProfileId: string;
  enabledCapabilities: string[];
  /** Optional project-embedded custom .polyext.json packs shipped with this template. */
  localExtensions?: PolyExtensionPack[];
  /** Progressive difficulty tier badge & feature highlights displayed in ProjectsPage. */
  difficulty?: ProjectDifficultyMeta;
  /** Internal templates (like blank_project) that have dedicated UI buttons instead of demo cards. */
  hiddenFromDemoList?: boolean;
  handles: HandleTemplateSpec[];
}

/** Blank workspace containing a single empty `on_start` entry hat. */
export function createBlankWorkspace(): Record<string, unknown> {
  return {
    blocks: {
      languageVersion: 0,
      blocks: [
        {
          type: 'poly_on_start',
          id: `start_${Date.now().toString(36)}`,
          x: 40,
          y: 36,
        },
      ],
    },
  };
}
