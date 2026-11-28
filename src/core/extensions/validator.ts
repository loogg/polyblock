import type { ScriptLanguageId } from '../../types/project';
import type {
  CategoryTargetSpec,
  CoreCategoryTarget,
  ExtensionBlockDef,
  ExtensionCodeTemplate,
  ExtensionModuleSource,
  ExtensionPackImports,
  ExtensionSectionSpec,
  HandleConfigSpec,
  PolyExtensionPack,
  RuntimeMonitorKind,
  SimWidgetEventTrigger,
  SimWidgetKind,
  SimWidgetSpec,
} from './types';

export const CORE_CATEGORY_LABELS: Record<CoreCategoryTarget, string> = {
  event: '事件',
  print: '打印',
  control: '控制',
  variables: '变量',
  math: '运算',
  logic: '逻辑',
  text: '文本',
  lists: '列表',
  dicts: '字典',
  functions: '函数',
};

const VALID_CORE_CATEGORY_TARGETS = new Set<string>(
  Object.keys(CORE_CATEGORY_LABELS),
);

const VALID_SIM_WIDGET_KINDS = new Set<SimWidgetKind>([
  'led',
  'tricolor',
  'rgb',
  'bar',
  'screen',
  'slider',
  'toggle',
  'button',
]);

function parseCategoryTarget(raw: unknown): CategoryTargetSpec {
  if (typeof raw === 'string' && VALID_CORE_CATEGORY_TARGETS.has(raw)) {
    return raw as CoreCategoryTarget;
  }
  return 'own';
}

function validateEmitEvent(raw: unknown): SimWidgetEventTrigger | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') {
    throw new Error('emitEvent 必须是对象');
  }
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.eventName !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(obj.eventName)
  ) {
    throw new Error(
      'emitEvent.eventName 必须是合法的函数名标识符（如 on_button / on_can_rx）',
    );
  }
  return {
    eventName: obj.eventName,
    ...(Array.isArray(obj.args)
      ? {
          args: obj.args.filter(
            (a): a is string | number | boolean =>
              typeof a === 'string' ||
              typeof a === 'number' ||
              typeof a === 'boolean',
          ),
        }
      : {}),
    ...(obj.trigger === 'rising' || obj.trigger === 'change'
      ? { trigger: obj.trigger }
      : {}),
  };
}

function validateSimWidgets(raw: unknown): SimWidgetSpec[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('simWidgets 必须是数组');
  }
  const out: SimWidgetSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      throw new Error('simWidgets 中的每一项必须是对象');
    }
    const w = item as Record<string, unknown>;
    if (
      typeof w.kind !== 'string' ||
      !VALID_SIM_WIDGET_KINDS.has(w.kind as SimWidgetKind)
    ) {
      throw new Error(
        `无效的模拟控件类型 "${String(w.kind)}"，支持：led / tricolor / rgb / bar / screen / slider / toggle / button`,
      );
    }
    if (typeof w.key !== 'string' || !w.key.trim()) {
      throw new Error(`模拟控件 (${w.kind}) 缺少非空 key 字段`);
    }
    if (typeof w.label !== 'string' || !w.label.trim()) {
      throw new Error(`模拟控件 (${w.key}) 缺少非空 label 字段`);
    }
    const emitEvent = validateEmitEvent(w.emitEvent);
    out.push({
      kind: w.kind as SimWidgetKind,
      key: w.key.trim(),
      label: w.label.trim(),
      ...(w.default !== undefined
        ? { default: w.default as SimWidgetSpec['default'] }
        : {}),
      ...(typeof w.color === 'string' && w.color.trim()
        ? { color: w.color.trim() }
        : {}),
      ...(typeof w.min === 'number' && Number.isFinite(w.min) ? { min: w.min } : {}),
      ...(typeof w.max === 'number' && Number.isFinite(w.max) ? { max: w.max } : {}),
      ...(typeof w.step === 'number' && Number.isFinite(w.step) && w.step > 0
        ? { step: w.step }
        : {}),
      ...(typeof w.unit === 'string' ? { unit: w.unit } : {}),
      ...(typeof w.maxLines === 'number' &&
      Number.isFinite(w.maxLines) &&
      w.maxLines >= 1
        ? { maxLines: Math.min(12, Math.trunc(w.maxLines)) }
        : {}),
      ...(typeof w.hint === 'string' ? { hint: w.hint } : {}),
      ...(Array.isArray(w.marks)
        ? { marks: w.marks.filter((m): m is string => typeof m === 'string') }
        : {}),
      ...(typeof w.activeLabel === 'string' ? { activeLabel: w.activeLabel } : {}),
      ...(typeof w.idleLabel === 'string' ? { idleLabel: w.idleLabel } : {}),
      ...(emitEvent ? { emitEvent } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function validateHandleConfigs(raw: unknown): HandleConfigSpec[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error('handleConfigs 必须是数组');
  const out: HandleConfigSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      throw new Error('handleConfigs 中的每一项必须是对象');
    }
    const obj = item as Record<string, unknown>;
    if (obj.kind !== 'channel-pool') {
      throw new Error(
        `暂不支持的 handleConfigs.kind "${String(obj.kind)}"（当前支持：channel-pool）`,
      );
    }
    const min = Number.isFinite(Number(obj.min))
      ? Math.max(1, Math.trunc(Number(obj.min)))
      : 1;
    const max = Number.isFinite(Number(obj.max))
      ? Math.max(min, Math.min(64, Math.trunc(Number(obj.max))))
      : 32;
    const defaultCount = Number.isFinite(Number(obj.defaultCount))
      ? Math.max(min, Math.min(max, Math.trunc(Number(obj.defaultCount))))
      : Math.min(max, 8);
    out.push({
      kind: 'channel-pool',
      ...(typeof obj.configKey === 'string' && obj.configKey.trim()
        ? { configKey: obj.configKey.trim() }
        : {}),
      label:
        typeof obj.label === 'string' && obj.label.trim() ? obj.label.trim() : '通道',
      ...(typeof obj.prefix === 'string' && obj.prefix.trim()
        ? { prefix: obj.prefix.trim() }
        : {}),
      min,
      max,
      defaultCount,
      ...(Array.isArray(obj.presets)
        ? {
            presets: obj.presets.filter(
              (n): n is number => typeof n === 'number' && Number.isFinite(n),
            ),
          }
        : {}),
      ...(typeof obj.hint === 'string' ? { hint: obj.hint } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function validateImports(raw: unknown): ExtensionPackImports | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('imports 必须是按语言 ID 映射的对象（如 { lua: [...], python: [...], js: [...] }）');
  }
  const obj = raw as Record<string, unknown>;
  const out: ExtensionPackImports = {};
  let count = 0;
  for (const [langKey, arr] of Object.entries(obj)) {
    if (!/^[a-z][a-z0-9_-]{0,23}$/i.test(langKey)) continue;
    if (Array.isArray(arr)) {
      const cleaned = arr.filter(
        (s): s is string => typeof s === 'string' && s.trim().length > 0,
      );
      if (cleaned.length > 0) {
        out[langKey as ScriptLanguageId] = cleaned;
        count += 1;
      }
    }
  }
  return count > 0 ? out : undefined;
}

function validateModuleSource(
  raw: unknown,
  fieldLabel: string,
): ExtensionModuleSource | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${fieldLabel} 必须是对象`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.moduleName !== 'string' || !obj.moduleName.trim()) {
    throw new Error(`${fieldLabel}.moduleName 必填`);
  }
  if (!obj.sources || typeof obj.sources !== 'object' || Array.isArray(obj.sources)) {
    throw new Error(
      `${fieldLabel}.sources 必填，且须为按语言 ID 映射的源码对象（如 { lua: "...", python: "...", js: "..." }）`,
    );
  }
  const rawSources = obj.sources as Record<string, unknown>;
  const sources: Partial<Record<ScriptLanguageId, string>> = {};
  let sourceCount = 0;
  for (const [langKey, val] of Object.entries(rawSources)) {
    if (typeof val === 'string') {
      sources[langKey as ScriptLanguageId] = val;
      sourceCount += 1;
    } else if (val !== undefined) {
      throw new Error(`${fieldLabel}.sources.${langKey} 必须是字符串`);
    }
  }
  if (sourceCount === 0) {
    throw new Error(`${fieldLabel}.sources 至少需要提供一种语言的模块源码`);
  }
  return {
    moduleName: obj.moduleName.trim(),
    sources,
    ...(obj.role === 'entry' || obj.role === 'helper' ? { role: obj.role } : {}),
  };
}

function validateLibs(raw: unknown): ExtensionModuleSource[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('libs 必须是数组');
  }
  const out: ExtensionModuleSource[] = [];
  const seen = new Set<string>();
  for (const [idx, item] of raw.entries()) {
    const mod = validateModuleSource(item, `libs[${idx}]`);
    if (!mod) continue;
    if (seen.has(mod.moduleName)) {
      throw new Error(`扩展包 libs[] 中存在重复的 moduleName "${mod.moduleName}"`);
    }
    seen.add(mod.moduleName);
    out.push(mod);
  }
  return out.length > 0 ? out : undefined;
}

function validateBlockDef(
  raw: unknown,
  seenBlockTypes: Set<string>,
): ExtensionBlockDef {
  if (!raw || typeof raw !== 'object') {
    throw new Error('每个积木定义必须是对象');
  }
  const blk = raw as Record<string, unknown>;
  if (typeof blk.type !== 'string' || !blk.type.trim()) {
    throw new Error('每个积木必须包含非空 type 字段');
  }
  if (seenBlockTypes.has(blk.type)) {
    throw new Error(`扩展包内存在重复积木类型 "${blk.type}"`);
  }
  seenBlockTypes.add(blk.type);

  if (blk.kind !== 'statement' && blk.kind !== 'value' && blk.kind !== 'hat') {
    throw new Error(
      `积木 ${blk.type} 的 kind 必须为 "statement"、"value" 或 "hat"`,
    );
  }
  if (typeof blk.message0 !== 'string' || !blk.message0.trim()) {
    throw new Error(`积木 ${blk.type} 缺少 message0`);
  }
  if (blk.kind === 'hat') {
    const hatObj = blk.hat as Record<string, unknown> | undefined;
    if (
      !hatObj ||
      typeof hatObj.eventName !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(hatObj.eventName)
    ) {
      throw new Error(`事件帽块 ${blk.type} 缺少合法的 hat.eventName`);
    }
    if (hatObj.mode !== 'singleton' && hatObj.mode !== 'dispatch') {
      throw new Error(
        `事件帽块 ${blk.type} 的 hat.mode 必须为 "singleton" 或 "dispatch"`,
      );
    }
  } else {
    const rawCode = blk.code as Record<string, unknown> | undefined;
    if (!rawCode || typeof rawCode !== 'object' || Array.isArray(rawCode)) {
      throw new Error(
        `积木 ${blk.type} 缺少 code 对象（需按语言映射至少提供一个 template，如 { lua: { template: "..." }, python: { template: "..." }, js: { template: "..." } }）`,
      );
    }
    let validLangCount = 0;
    for (const [langKey, entry] of Object.entries(rawCode)) {
      if (entry === undefined) continue;
      const spec = entry as Partial<ExtensionCodeTemplate> | null;
      if (!spec || typeof spec !== 'object' || typeof spec.template !== 'string') {
        throw new Error(
          `积木 ${blk.type} 的 code.${langKey} 对象缺少字符串字段 template`,
        );
      }
      validLangCount += 1;
    }
    if (validLangCount === 0) {
      throw new Error(
        `积木 ${blk.type} 的 code 对象至少需要提供一种语言的 template`,
      );
    }
  }
  return blk as unknown as ExtensionBlockDef;
}

function validateSections(raw: unknown): ExtensionSectionSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('扩展包必须至少包含 1 个 sections 组件定义');
  }

  const out: ExtensionSectionSpec[] = [];
  const seenIds = new Set<string>();
  const seenBlockTypes = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      throw new Error('sections 中的每一项必须是对象');
    }
    const s = item as Record<string, unknown>;
    if (typeof s.id !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(s.id)) {
      throw new Error(
        '每个 section 的 id 必填，且只能包含字母、数字、横线或下划线（1~32 字符）',
      );
    }
    if (seenIds.has(s.id)) {
      throw new Error(`扩展包内存在重复的 section id "${s.id}"`);
    }
    seenIds.add(s.id);
    if (typeof s.label !== 'string' || !s.label.trim()) {
      throw new Error(`section "${s.id}" 缺少非空 label`);
    }
    if (!Array.isArray(s.blocks) || s.blocks.length === 0) {
      throw new Error(`section "${s.id}" 必须至少包含 1 个 blocks 积木定义`);
    }
    const blocks = s.blocks.map((b) => validateBlockDef(b, seenBlockTypes));
    const rawOrder = Number(s.toolboxOrder);
    const handleConfigs = validateHandleConfigs(s.handleConfigs);
    let runtimeMonitor: RuntimeMonitorKind | undefined;
    if (s.runtimeMonitor !== undefined && s.runtimeMonitor !== null) {
      if (s.runtimeMonitor !== 'scheduler' && s.runtimeMonitor !== 'timers') {
        throw new Error(
          `section "${s.id}" 的 runtimeMonitor 必须为 "scheduler" 或 "timers"`,
        );
      }
      runtimeMonitor = s.runtimeMonitor;
    }

    out.push({
      id: s.id,
      label: s.label.trim().slice(0, 12),
      ...(typeof s.description === 'string' ? { description: s.description } : {}),
      visible: s.visible !== false,
      categoryTarget: parseCategoryTarget(s.categoryTarget),
      ...(Number.isFinite(rawOrder)
        ? { toolboxOrder: Math.max(0, Math.min(9999, Math.round(rawOrder))) }
        : {}),
      ...(typeof s.color === 'string' && s.color.startsWith('#')
        ? { color: s.color }
        : {}),
      ...(runtimeMonitor ? { runtimeMonitor } : {}),
      ...(handleConfigs ? { handleConfigs } : {}),
      blocks,
    });
  }
  return out;
}

export function validateExtensionPack(raw: unknown): PolyExtensionPack {
  if (!raw || typeof raw !== 'object') {
    throw new Error('扩展包 JSON 必须是对象');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !/^[a-zA-Z0-9_-]{2,48}$/.test(obj.id)) {
    throw new Error(
      '扩展包 id 必填，且只能包含字母、数字、横线或下划线（2~48 字符）',
    );
  }
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    throw new Error('扩展包 name 必填');
  }
  const sections = validateSections(obj.sections);
  const iconLabelRaw =
    typeof obj.iconLabel === 'string' && obj.iconLabel.trim()
      ? obj.iconLabel.trim()
      : sections[0].label;

  const imports = validateImports(obj.imports);
  const simWidgets = validateSimWidgets(obj.simWidgets);
  const sandboxMock = validateModuleSource(obj.sandboxMock, 'sandboxMock');
  const libs = validateLibs(obj.libs);
  if (
    sandboxMock &&
    libs?.some((lib) => lib.moduleName === sandboxMock.moduleName)
  ) {
    throw new Error(
      `单包内禁止将同一 moduleName="${sandboxMock.moduleName}" 同时写入 libs[] 与 sandboxMock（同一模块名在单包内只能二选一：真实库放 libs[]，仅沙箱假桩放 sandboxMock）`,
    );
  }
  const tags = Array.isArray(obj.tags)
    ? obj.tags
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((t) => t.trim().slice(0, 12))
        .slice(0, 6)
    : undefined;

  return {
    ...(typeof obj.$schema === 'string' ? { $schema: obj.$schema } : {}),
    format: 'polyblock-extension',
    version: 1,
    id: obj.id,
    name: obj.name.trim(),
    packVersion: typeof obj.packVersion === 'string' ? obj.packVersion : '1.0.0',
    iconLabel: iconLabelRaw.slice(0, 6),
    color:
      typeof obj.color === 'string' && obj.color.startsWith('#')
        ? obj.color
        : '#6366f1',
    description:
      typeof obj.description === 'string'
        ? obj.description
        : '用户自定义扩展积木包',
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(imports ? { imports } : {}),
    sections,
    ...(simWidgets ? { simWidgets } : {}),
    ...(sandboxMock ? { sandboxMock } : {}),
    ...(libs ? { libs } : {}),
  };
}
