import type { ScriptLanguageId } from '../../types/project';
import {
  backendRegistry,
  stripScriptExtension,
} from '../backends/registry';
import type {
  ExtensionBlockDef,
  ExtensionModuleSource,
  ExtensionPackImports,
  PolyExtensionPack,
} from './types';

export interface ScannedLibFunction {
  id: string;
  moduleName: string;
  funcName: string;
  params: string[];
  inferredKind: 'statement' | 'value';
  /** Editable fields presented in the import preview modal */
  selected: boolean;
  kind: 'statement' | 'value';
  label: string;
}

export interface UploadedScriptLibFile {
  fileName: string;
  moduleName: string;
  language: ScriptLanguageId;
  source: string;
  /** Whether to scan this file's exported functions into blocks (entry lib) vs keep as helper dependency. */
  scanForBlocks: boolean;
  scannedFunctions: ScannedLibFunction[];
}

export function deriveModuleNameFromFileName(fileName: string): string {
  const base = stripScriptExtension(fileName.trim())
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return base || 'custom_lib';
}

/**
 * Statically scans a script library source using the target language backend's
 * declared `dialect.libBinding.scanFunctions` hook (zero per-language hardcoding).
 */
export function scanLibraryFunctionsForLanguage(
  language: ScriptLanguageId,
  moduleName: string,
  source: string,
): ScannedLibFunction[] {
  const scanner = backendRegistry.tryGetDialect(language)?.libBinding?.scanFunctions;
  if (!scanner) return [];
  return scanner(source).map((meta) => ({
    id: `${moduleName}.${meta.funcName}`,
    moduleName,
    funcName: meta.funcName,
    params: meta.params,
    inferredKind: meta.inferredKind,
    selected: true,
    kind: meta.inferredKind,
    label: `${moduleName}.${meta.funcName}`,
  }));
}

export function scanScriptLibraryFile(
  fileName: string,
  source: string,
  fallbackLang: ScriptLanguageId = backendRegistry.getDefaultId(),
): UploadedScriptLibFile {
  const lower = fileName.toLowerCase();
  const matchedDialect = backendRegistry
    .listDialects()
    .find((d) => lower.endsWith(`.${d.extension.toLowerCase()}`));
  const language: ScriptLanguageId =
    (matchedDialect?.id as ScriptLanguageId | undefined) ?? fallbackLang;
  const moduleName = deriveModuleNameFromFileName(fileName);
  const scannedFunctions = scanLibraryFunctionsForLanguage(
    language,
    moduleName,
    source,
  );

  return {
    fileName,
    moduleName,
    language,
    source,
    scanForBlocks: scannedFunctions.length > 0,
    scannedFunctions,
  };
}

export interface BuildPackFromLibsOptions {
  packId: string;
  packName: string;
  iconLabel: string;
  color: string;
  toolboxOrder: number;
  description?: string;
  files: UploadedScriptLibFile[];
  functions: ScannedLibFunction[];
}

/**
 * Generates a clean, valid single-track `.polyext.json` (`PolyExtensionPack`) from uploaded
 * script library files and user-reviewed candidate functions across all registered languages.
 */
export function buildExtensionPackFromScriptLibs(
  opts: BuildPackFromLibsOptions,
): PolyExtensionPack {
  const safeId =
    opts.packId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'custom-lib';

  const scanEnabledModules = new Set(
    opts.files.filter((f) => f.scanForBlocks).map((f) => f.moduleName),
  );
  const selectedFns = opts.functions.filter(
    (f) => f.selected && scanEnabledModules.has(f.moduleName),
  );
  if (selectedFns.length === 0) {
    throw new Error('请至少勾选 1 个已启用扫描的函数以生成积木');
  }

  // Merge uploaded files by moduleName (supports pairing multi-language sources under one moduleName)
  const libMap = new Map<string, ExtensionModuleSource>();
  for (const f of opts.files) {
    const existing = libMap.get(f.moduleName) ?? {
      moduleName: f.moduleName,
      sources: {},
      role: f.scanForBlocks ? 'entry' : 'helper',
    };
    existing.sources[f.language] = f.source;
    if (f.scanForBlocks) existing.role = 'entry';
    libMap.set(f.moduleName, existing);
  }
  const libs = Array.from(libMap.values());

  const supportedIds = backendRegistry.listIds();

  // Determine which modules & languages are actually provided by uploaded files
  const usedModuleNames = Array.from(new Set(selectedFns.map((f) => f.moduleName)));
  const importsMap: ExtensionPackImports = {};
  let hasAnyImports = false;
  for (const lang of supportedIds) {
    const binding = backendRegistry.getDialect(lang).libBinding;
    const langModules = usedModuleNames.filter((mn) =>
      Boolean(libMap.get(mn)?.sources[lang]),
    );
    if (langModules.length > 0 && binding) {
      importsMap[lang] = langModules.map((mn) => binding.formatImport(mn));
      hasAnyImports = true;
    }
  }

  const blocks: ExtensionBlockDef[] = selectedFns.map((fn) => {
    const blockType = `ext_${safeId.replace(/-/g, '_')}_${fn.moduleName.replace(/[^A-Za-z0-9_]/g, '_')}_${fn.funcName}`;
    const args0: Array<Record<string, unknown>> = [];
    const shadows: Record<
      string,
      { type: 'math_number' | 'text'; value: number | string }
    > = {};
    const paramParts: string[] = [];
    const callPlaceholders: string[] = [];

    fn.params.forEach((p, idx) => {
      const argName = `ARG${idx + 1}`;
      args0.push({ type: 'input_value', name: argName });
      shadows[argName] = { type: 'text', value: '' };
      paramParts.push(`${p} %${idx + 1}`);
      callPlaceholders.push(`{{${argName}}}`);
    });

    const msgBase = fn.label.trim() || `${fn.moduleName}.${fn.funcName}`;
    const message0 =
      paramParts.length > 0 ? `${msgBase} ${paramParts.join(' ')}` : msgBase;
    const modEntry = libMap.get(fn.moduleName);
    const code: NonNullable<ExtensionBlockDef['code']> = {};
    for (const lang of supportedIds) {
      const binding = backendRegistry.getDialect(lang).libBinding;
      if (modEntry?.sources[lang] && binding) {
        code[lang] = {
          template: binding.formatCall(
            fn.moduleName,
            fn.funcName,
            callPlaceholders,
          ),
        };
      }
    }

    return {
      type: blockType,
      kind: fn.kind,
      ...(fn.kind === 'value' ? { outputType: null } : {}),
      message0,
      ...(args0.length > 0 ? { args0 } : {}),
      inputsInline: true,
      ...(Object.keys(shadows).length > 0 ? { shadows } : {}),
      tooltip: `调用库模块 ${fn.moduleName}.${fn.funcName}(${fn.params.join(', ')})`,
      keywords: `${opts.packName} ${fn.moduleName} ${fn.funcName} ${msgBase}`,
      code,
    };
  });

  const importsObj: PolyExtensionPack['imports'] = hasAnyImports
    ? importsMap
    : undefined;

  return {
    $schema: './schemas/polyext.schema.json',
    format: 'polyblock-extension',
    version: 1,
    id: safeId,
    name: opts.packName.trim() || safeId,
    packVersion: '1.0.0',
    iconLabel: (opts.iconLabel.trim() || '库').slice(0, 4),
    color: opts.color || '#0ea5e9',
    description:
      opts.description?.trim() ||
      `由原生脚本库（${usedModuleNames.join(', ')}）自动扫描生成的积木扩展包，支持浏览器 WASM 沙箱运行与真机 .zip 随行导出。`,
    tags: ['脚本库'],
    ...(importsObj ? { imports: importsObj } : {}),
    libs,
    sections: [
      {
        id: 'main',
        label: (opts.iconLabel.trim() || safeId).slice(0, 6),
        toolboxOrder: Math.max(0, Math.min(9999, Math.round(opts.toolboxOrder))),
        blocks,
      },
    ],
  };
}

/**
 * Merges newly attached script library files into an existing pack's `libs[]` array by `moduleName`.
 * Existing modules with the same `moduleName` get their language source updated in place.
 */
export function mergeAttachedLibFiles(
  existingLibs: ExtensionModuleSource[] | undefined,
  files: Array<{
    moduleName: string;
    language: ScriptLanguageId;
    source: string;
    role?: 'entry' | 'helper';
  }>,
): ExtensionModuleSource[] {
  const map = new Map<string, ExtensionModuleSource>();
  for (const lib of existingLibs ?? []) {
    map.set(lib.moduleName, { ...lib, sources: { ...(lib.sources ?? {}) } });
  }
  for (const f of files) {
    const cleanName = f.moduleName.trim();
    if (!cleanName) continue;
    const prev = map.get(cleanName) ?? {
      moduleName: cleanName,
      sources: {},
      role: f.role ?? 'helper',
    };
    prev.sources[f.language] = f.source;
    if (f.role) prev.role = f.role;
    map.set(cleanName, prev);
  }
  return Array.from(map.values());
}
