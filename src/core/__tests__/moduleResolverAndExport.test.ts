// @vitest-environment node
import * as Blockly from 'blockly';
import { loadMicroPython } from '@micropython/micropython-webassembly-pyscript';
import { LuaFactory } from 'wasmoon';
import { beforeEach, describe, expect, it } from 'vitest';
import { analyzeWorkspaceDiagnostics } from '../backends/sourceMap';
import { registerPolyBlocks } from '../blocks/definitions';
import {
  setActiveHandleScripts,
  setActiveModuleConflicts,
  setActiveProjectCapabilities,
} from '../blocks/workspaceContextBridge';
import {
  buildProjectTargetBundle,
  buildSingleHandleTargetBundle,
  ModuleConflictExportError,
  moduleNameToRelativeFile,
} from '../export/bundleExporter';
import { computeCrc32 } from '../export/zipWriter';
import {
  extractImportedModuleNames,
  inspectPackImportSourceMatch,
  resolveProjectModules,
} from '../extensions/moduleResolver';
import {
  derivePackBadges,
  extensionRegistry,
  getPackSupportedLanguages,
  validateExtensionPack,
} from '../extensions/registry';
import { backendRegistry } from '../backends/registry';
import {
  buildExtensionPackFromScriptLibs,
  mergeAttachedLibFiles,
  scanLibraryFunctionsForLanguage,
  scanScriptLibraryFile,
} from '../extensions/scriptLibScanner';
import type { PolyExtensionPack } from '../extensions/types';
import {
  addHandleToProject,
  addScriptToHandle,
  instantiateProjectFromTemplate,
} from '../projects/store';

function makeTestPack(
  id: string,
  opts: {
    name?: string;
    libs?: PolyExtensionPack['libs'];
    sandboxMock?: PolyExtensionPack['sandboxMock'];
    imports?: PolyExtensionPack['imports'];
  } = {},
): PolyExtensionPack {
  return {
    format: 'polyblock-extension',
    version: 1,
    id,
    name: opts.name ?? id,
    packVersion: '1.0.0',
    iconLabel: id.slice(0, 4).toUpperCase(),
    color: '#10b981',
    description: `test pack ${id}`,
    imports: opts.imports,
    sections: [
      {
        id: 'main',
        label: id.slice(0, 6),
        blocks: [
          {
            type: `ext_${id.replace(/[^a-zA-Z0-9_]/g, '_')}_ping`,
            kind: 'value',
            outputType: 'Number',
            message0: `${id} ping`,
            code: {
              lua: { template: '1' },
              python: { template: '1' },
            },
          },
        ],
      },
    ],
    libs: opts.libs,
    sandboxMock: opts.sandboxMock,
  };
}

/** Parses entry file paths & verifies PKZIP signatures + CRC-32 checksums in a ZIP buffer. */
function inspectZipEntries(zipBytes: Uint8Array): Map<string, string> {
  const view = new DataView(
    zipBytes.buffer,
    zipBytes.byteOffset,
    zipBytes.byteLength,
  );
  const decoder = new TextDecoder();
  const files = new Map<string, string>();
  let offset = 0;

  while (offset + 4 <= zipBytes.length) {
    const sig = view.getUint32(offset, true);
    if (sig === 0x04034b50) {
      const crc = view.getUint32(offset + 14, true);
      const compSize = view.getUint32(offset + 18, true);
      const uncompSize = view.getUint32(offset + 22, true);
      const nameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      expect(compSize).toBe(uncompSize);
      const nameStart = offset + 30;
      const name = decoder.decode(
        zipBytes.subarray(nameStart, nameStart + nameLen),
      );
      const dataStart = nameStart + nameLen + extraLen;
      const dataBytes = zipBytes.subarray(dataStart, dataStart + compSize);
      expect(computeCrc32(dataBytes)).toBe(crc);
      files.set(name, decoder.decode(dataBytes));
      offset = dataStart + compSize;
    } else if (sig === 0x02014b50 || sig === 0x06054b50) {
      break;
    } else {
      throw new Error(`Unexpected ZIP signature 0x${sig.toString(16)} at ${offset}`);
    }
  }

  // Verify End-of-Central-Directory signature exists at tail
  const eocdOffset = zipBytes.length - 22;
  expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);
  return files;
}

describe('3-tier pure-scope ModuleResolver, Conflict Detection, Scanner & Target ZIP Export', () => {
  beforeEach(() => {
    registerPolyBlocks();
    extensionRegistry.ensureInitialized();
    extensionRegistry.setActiveProjectLocalPacks([]);
    setActiveModuleConflicts([]);
    setActiveProjectCapabilities(null);
    setActiveHandleScripts([], null);
  });

  it('enforces pure 3-tier scope priority (handle > project > global) even when project uses sandboxMock over global libs', () => {
    const globalCrcLib = makeTestPack('global-crc', {
      name: '全局纯 Lua CRC16',
      libs: [
        {
          moduleName: 'crc16',
          role: 'entry',
          sources: { lua: 'return { calc = function() return 111 end }' },
        },
      ],
    });
    const projectHwCrcMock = makeTestPack('proj-hw-crc', {
      name: '本项目硬件 C 版 CRC16',
      sandboxMock: {
        moduleName: 'crc16',
        sources: { lua: 'return { calc = function() return 222 end }' },
      },
    });

    const res = resolveProjectModules({
      enabledCapabilities: ['global-crc', 'proj-hw-crc'],
      globalExtensions: [globalCrcLib],
      localExtensions: [projectHwCrcMock],
    });

    expect(res.conflicts).toHaveLength(0);
    // Project ALWAYS beats Global!
    const winner = res.resolvedByName.get('crc16');
    expect(winner?.tier).toBe('project');
    expect(winner?.delivery).toBe('sandbox-mock');
    expect(winner?.ownerId).toBe('local:proj-hw-crc');

    // Sandbox mounts the winning Project mock (not the shadowed Global lib)
    expect(res.sandboxMountOrder.map((m) => m.sources.lua)).toEqual([
      'return { calc = function() return 222 end }',
    ]);

    // Target export strips winning sandboxMock AND suppresses shadowed global crc16.lua!
    expect(res.exportLibs).toHaveLength(0);
    expect(res.overrides).toHaveLength(1);
    expect(res.overrides[0].moduleName).toBe('crc16');
    expect(res.overrides[0].winner.tier).toBe('project');
  });

  it('allows project-local packs to override preinstalled rt and board (by moduleName OR by same pack id)', () => {
    const localRtOverride = extensionRegistry.validateProjectLocalPack(
      makeTestPack('rt', {
        name: '定制项目版 RT 调度库',
        libs: [
          {
            moduleName: 'rt',
            role: 'entry',
            sources: { lua: 'return { tick = function() return 99999 end }' },
          },
        ],
      }),
    );

    const res = resolveProjectModules({
      enabledCapabilities: ['rt', 'virtual-board'],
      localExtensions: [localRtOverride],
    });

    expect(res.conflicts).toHaveLength(0);
    const rtWinner = res.resolvedByName.get('rt');
    expect(rtWinner?.tier).toBe('project');
    expect(rtWinner?.delivery).toBe('lib');
    expect(rtWinner?.ownerId).toBe('local:rt');
    expect(res.exportLibs.map((l) => l.moduleName)).toEqual(['rt']);

    // Handle sibling script beats even Project lib (Tier 1 > Tier 2)
    const resWithHandle = resolveProjectModules({
      enabledCapabilities: ['rt'],
      localExtensions: [localRtOverride],
      handleScripts: [
        {
          scriptId: 'scr_rt',
          scriptName: 'rt',
          sources: { lua: 'return { tick = function() return 777 end }' },
        },
      ],
    });
    expect(resWithHandle.conflicts).toHaveLength(0);
    expect(resWithHandle.resolvedByName.get('rt')?.tier).toBe('handle');
    expect(resWithHandle.overrides).toHaveLength(1);
  });

  it('standardizes rt.sandboxMock identically to all other packs (zero worker/resolver special cases) and runs cleanly in Lua 5.4 & MicroPython', async () => {
    const rtPack = extensionRegistry.get('rt')!;
    expect(rtPack.sandboxMock?.moduleName).toBe('rt');
    expect(rtPack.sandboxMock?.sources.lua).toContain('__poly_rt_tick');
    expect(rtPack.sandboxMock?.sources.python).toContain('_poly.rt_tick');

    // When `rt` is NOT enabled, resolver does NOT mount `rt` at all
    const withoutRt = resolveProjectModules({ enabledCapabilities: [] });
    expect(withoutRt.resolvedByName.has('rt')).toBe(false);
    expect(withoutRt.sandboxMountOrder.some((m) => m.moduleName === 'rt')).toBe(
      false,
    );

    // When `rt` IS enabled, resolver mounts RT_PACK.sandboxMock through standard pipeline
    const withRt = resolveProjectModules({ enabledCapabilities: ['rt'] });
    expect(withRt.resolvedByName.get('rt')?.tier).toBe('global');
    expect(withRt.resolvedByName.get('rt')?.delivery).toBe('sandbox-mock');
    expect(withRt.exportLibs).toHaveLength(0);
    const rtMod = withRt.sandboxMountOrder.find((m) => m.moduleName === 'rt');
    expect(rtMod?.sources.lua).toBeTruthy();
    expect(rtMod?.sources.python).toBeTruthy();

    // Execute RT_PACK.sandboxMock.sources.lua directly in Wasmoon Lua 5.4
    const lua = await new LuaFactory().createEngine();
    try {
      lua.global.set('__poly_rt_tick', () => 1234);
      lua.global.set('__poly_rt_ms_to_tick', (ms: number) => Math.ceil(ms));
      lua.global.set('__poly_rt_is_expired', (s: number, t: number) => 1234 - s >= t);
      await lua.doString(
        `package.preload["rt"] = load(${JSON.stringify(rtMod!.sources.lua!)})`,
      );
      expect(await lua.doString('local rt = require("rt"); return rt.tick()')).toBe(
        1234,
      );
      expect(
        await lua.doString('local rt = require("rt"); return rt.is_expired(1000, 200)'),
      ).toBe(true);
    } finally {
      lua.global.close();
    }

    // Execute RT_PACK.sandboxMock.sources.python via the EXACT same scoped-proxy mount as python.worker.ts!
    const pyLines: string[] = [];
    const mp = await loadMicroPython({
      linebuffer: true,
      stdout: (line: string) => pyLines.push(line),
    });
    mp.registerJsModule('_poly', {
      rt_set_run_period: () => {},
      rt_start_run: () => {},
      rt_stop_run: () => {},
      rt_start_timer: () => {},
      rt_stop_timer: () => {},
      rt_get_timer_value: () => 0,
      rt_is_timer_running: () => false,
      rt_tick: () => 5678,
      rt_ms_to_tick: (ms: number) => Math.ceil(ms),
      rt_is_expired: (s: number, t: number) => 5678 - s >= t,
    });
    const rewrittenPy = rtMod!.sources.python!.replace(
      /\bimport\s+_poly\b/g,
      'import _poly__rt as _poly',
    );
    mp.runPython(`
import sys, _poly as _poly_base
class _PolyScopedProxy:
  def rt_tick(self): return _poly_base.rt_tick()
  def rt_ms_to_tick(self, ms): return _poly_base.rt_ms_to_tick(ms)
  def rt_is_expired(self, s, t): return _poly_base.rt_is_expired(s, t)
  def rt_set_run_period(self, ms): return _poly_base.rt_set_run_period(ms)
  def rt_start_run(self): return _poly_base.rt_start_run()
  def rt_stop_run(self): return _poly_base.rt_stop_run()
  def rt_start_timer(self, tid, p, r=0): return _poly_base.rt_start_timer(tid, p, r)
  def rt_stop_timer(self, tid): return _poly_base.rt_stop_timer(tid)
  def rt_get_timer_value(self, tid): return _poly_base.rt_get_timer_value(tid)
  def rt_is_timer_running(self, tid): return _poly_base.rt_is_timer_running(tid)
sys.modules["_poly__rt"] = _PolyScopedProxy()
_ns = {'_poly': sys.modules["_poly__rt"]}
exec(${JSON.stringify(rewrittenPy)}, _ns)
class _M: pass
_m = _M()
for _k, _v in _ns.items():
  if not _k.startswith("__"):
    setattr(_m, _k, _v)
sys.modules["rt"] = _m
import rt
print(rt.tick(), rt.is_expired(5000, 500))
`);
    expect(pyLines.join('\n')).toContain('5678 True');
  });

  it('detects same-tier moduleName conflicts across project and global scopes and surfaces them in workspace diagnostics', () => {
    const localA = makeTestPack('local-a', {
      libs: [{ moduleName: 'crypto', sources: { lua: 'return { v = 1 }' } }],
    });
    const localB = makeTestPack('local-b', {
      sandboxMock: { moduleName: 'crypto', sources: { lua: 'return { v = 2 }' } },
    });

    const projectConflictRes = resolveProjectModules({
      enabledCapabilities: ['local-a', 'local-b'],
      globalExtensions: [],
      localExtensions: [localA, localB],
    });
    expect(projectConflictRes.conflicts).toHaveLength(1);
    expect(projectConflictRes.conflicts[0].tier).toBe('project');
    expect(projectConflictRes.conflicts[0].moduleName).toBe('crypto');

    // Global conflict against preinstalled `rt` when another global pack also declares `rt`
    const rougeGlobalRt = makeTestPack('rogue-rt', {
      libs: [{ moduleName: 'rt', sources: { lua: 'return {}' } }],
    });
    const globalConflictRes = resolveProjectModules({
      enabledCapabilities: ['rt', 'rogue-rt'],
      globalExtensions: [...extensionRegistry.listAll(), rougeGlobalRt],
      localExtensions: [],
    });
    expect(
      globalConflictRes.conflicts.some(
        (c) => c.tier === 'global' && c.moduleName === 'rt',
      ),
    ).toBe(true);

    // Surface conflict via diagnostics bridge even on an empty workspace
    setActiveModuleConflicts(projectConflictRes.conflicts);
    const ws = new Blockly.Workspace();
    const diags = analyzeWorkspaceDiagnostics(ws);
    ws.dispose();
    expect(diags.some((d) => d.severity === 'error' && d.message.includes('crypto'))).toBe(
      true,
    );
  });

  it('enforces Option A intra-pack validation: forbids same moduleName in libs[] & sandboxMock, allows distinct moduleNames', () => {
    // Allowed: dht22 (real lib) + i2c (browser sandboxMock)
    const validDual = validateExtensionPack(
      makeTestPack('dht22-sensor', {
        libs: [{ moduleName: 'dht22', sources: { lua: 'return { read = function() return 25 end }' } }],
        sandboxMock: { moduleName: 'i2c', sources: { lua: 'return { read = function() return 1 end }' } },
      }),
    );
    expect(validDual.libs).toHaveLength(1);
    expect(validDual.sandboxMock?.moduleName).toBe('i2c');

    // Forbidden: same moduleName in both libs[] and sandboxMock
    expect(() =>
      validateExtensionPack(
        makeTestPack('bad-dup-mock-lib', {
          libs: [{ moduleName: 'foo', sources: { lua: 'return {}' } }],
          sandboxMock: { moduleName: 'foo', sources: { lua: 'return {}' } },
        }),
      ),
    ).toThrow(/同时写入 libs\[\] 与 sandboxMock/);

    // Forbidden: duplicate moduleName inside libs[]
    expect(() =>
      validateExtensionPack(
        makeTestPack('bad-dup-libs', {
          libs: [
            { moduleName: 'foo', sources: { lua: 'return {}' } },
            { moduleName: 'foo', sources: { lua: 'return {}' } },
          ],
        }),
      ),
    ).toThrow(/重复的 moduleName/);
  });

  it('scans Lua & Python native libraries, builds multi-file CRC16 pack, and executes real CRC16-Modbus in Wasmoon Lua 5.4', async () => {
    const crcTableLua = `
local T = {}
for i = 0, 255 do
  local crc = i
  for _ = 1, 8 do
    if (crc & 1) ~= 0 then
      crc = (crc >> 1) ~ 0xA001
    else
      crc = crc >> 1
    end
  end
  T[i + 1] = crc & 0xFFFF
end
return T
`;
    const crcEntryLua = `
local tbl = require("crc16_table")
local M = {}

local function _private_step(crc, b)
  return ((crc >> 8) ~ tbl[((crc ~ b) & 0xFF) + 1]) & 0xFFFF
end

function M.calc(data)
  local crc = 0xFFFF
  for i = 1, #data do
    crc = _private_step(crc, string.byte(data, i))
  end
  return crc
end

function M.reset_stats()
  M._count = 0
end

return M
`;

    const scannedFns = scanLibraryFunctionsForLanguage('lua', 'crc16', crcEntryLua);
    expect(scannedFns.map((f) => `${f.funcName}:${f.inferredKind}`)).toEqual([
      'calc:value',
      'reset_stats:statement',
    ]);
    // Private local function skipped
    expect(scannedFns.some((f) => f.funcName.includes('private'))).toBe(false);

    // Python scanner check
    const pyFns = scanLibraryFunctionsForLanguage(
      'python',
      'crc16',
      `
def _helper(x):
    return x

def calc(data: str, init: int = 0xFFFF) -> int:
    return init ^ len(data)

def reset():
    pass
`,
    );
    expect(pyFns.map((f) => `${f.funcName}:${f.inferredKind}:${f.params.join(',')}`)).toEqual([
      'calc:value:data,init',
      'reset:statement:',
    ]);

    // JavaScript scanner check
    const jsFns = scanLibraryFunctionsForLanguage(
      'js',
      'crc16',
      `
function _private_step(x) { return x ^ 1; }
exports.calc = function(data, init = 0xFFFF) {
  return _private_step(init ^ data.length);
};
exports.reset = () => {
  // no return
};
`,
    );
    expect(jsFns.map((f) => `${f.funcName}:${f.inferredKind}:${f.params.join(',')}`)).toEqual([
      'calc:value:data,init',
      'reset:statement:',
    ]);

    const fEntry = scanScriptLibraryFile('crc16.lua', crcEntryLua);
    const fTable = scanScriptLibraryFile('crc16_table.lua', crcTableLua);
    fTable.scanForBlocks = false; // helper table file

    const generatedPack = buildExtensionPackFromScriptLibs({
      packId: 'crc16-modbus',
      packName: 'CRC16 校验库',
      iconLabel: 'CRC',
      color: '#10b981',
      toolboxOrder: 130,
      files: [fEntry, fTable],
      functions: fEntry.scannedFunctions,
    });

    // Generated pack validates cleanly & matches imports -> libs (Lua-only upload produces Lua-only templates!)
    const validated = validateExtensionPack(generatedPack);
    expect(validated.imports?.lua).toEqual(['local crc16 = require("crc16")']);
    expect(validated.imports?.python).toBeUndefined();
    expect(validated.sections[0].blocks[0].code?.lua?.template).toBe('crc16.calc({{ARG1}})');
    expect(validated.sections[0].blocks[0].code?.python).toBeUndefined();
    expect(getPackSupportedLanguages(validated)).toEqual({
      supported: ['lua'],
      label: '仅 Lua 5.4',
    });
    expect(derivePackBadges(validated).map((b) => b.label)).toContain('仅 Lua');
    expect(validated.libs?.map((l) => `${l.moduleName}:${l.role}`)).toEqual([
      'crc16:entry',
      'crc16_table:helper',
    ]);
    expect(extractImportedModuleNames(validated)).toEqual(['crc16']);
    expect(inspectPackImportSourceMatch(validated).unmatchedImports).toEqual([]);

    // Resolve and execute in real Wasmoon Lua 5.4!
    const resolution = resolveProjectModules({
      enabledCapabilities: ['crc16-modbus'],
      globalExtensions: [],
      localExtensions: [validated],
    });
    expect(resolution.conflicts).toHaveLength(0);
    // Helper mounts before entry
    expect(resolution.sandboxMountOrder.map((m) => m.moduleName)).toEqual([
      'crc16_table',
      'crc16',
    ]);

    const factory = new LuaFactory();
    const lua = await factory.createEngine();
    try {
      for (const mod of resolution.sandboxMountOrder) {
        const safeName = JSON.stringify(mod.moduleName);
        const safeSrc = JSON.stringify(mod.sources.lua ?? '');
        await lua.doString(`
          package.preload[${safeName}] = function()
            local chunk, err = load(${safeSrc}, "@" .. ${safeName})
            if not chunk then error(err) end
            return chunk()
          end
        `);
      }
      // Standard CRC-16/MODBUS check value for "123456789" is 0x4B37 (19255)
      const result = await lua.doString(
        'local crc16 = require("crc16"); return crc16.calc("123456789")',
      );
      expect(result).toBe(0x4b37);

      // Verify project-local `rt` pack cleanly overrides default preinstalled `rt` at runtime!
      await lua.doString('package.preload["rt"] = function() return { tick = function() return 1 end } end');
      const rtOverridePack = makeTestPack('rt', {
        libs: [{ moduleName: 'rt', sources: { lua: 'return { tick = function() return 99999 end }' } }],
      });
      const rtRes = resolveProjectModules({
        enabledCapabilities: ['rt'],
        localExtensions: [rtOverridePack],
      });
      for (const mod of rtRes.sandboxMountOrder) {
        await lua.doString(`package.preload[${JSON.stringify(mod.moduleName)}] = load(${JSON.stringify(mod.sources.lua ?? '')})`);
      }
      const rtTick = await lua.doString('return require("rt").tick()');
      expect(rtTick).toBe(99999);
    } finally {
      lua.global.close();
    }

    // Verify mergeAttachedLibFiles updates/merges cleanly
    const merged = mergeAttachedLibFiles(validated.libs, [
      {
        moduleName: 'crc16',
        language: 'python',
        source: 'def calc(s): return 0x4B37\n',
        role: 'entry',
      },
    ]);
    expect(merged.find((m) => m.moduleName === 'crc16')?.sources.lua).toBeTruthy();
    expect(merged.find((m) => m.moduleName === 'crc16')?.sources.python).toContain(
      '0x4B37',
    );
  });

  it('builds valid single-handle flat ZIP and multi-handle project ZIP, stripping sandboxMock and blocking on conflicts', () => {
    expect(moduleNameToRelativeFile('utils.crc16', 'lua')).toBe('utils/crc16.lua');

    const crcPack = makeTestPack('crc16-pack', {
      name: 'CRC16 库',
      libs: [
        { moduleName: 'utils.crc16', role: 'entry', sources: { lua: 'return { calc = function() return 42 end }\n' } },
        { moduleName: 'crc16_table', role: 'helper', sources: { lua: 'return { 1, 2, 3 }\n' } },
      ],
    });

    let proj = instantiateProjectFromTemplate('blank_project');
    proj = {
      ...proj,
      name: 'DemoTarget',
      enabledCapabilities: ['rt', 'virtual-board', 'crc16-pack'],
      localExtensions: [crcPack],
    };
    // Add a sibling script to handle 1 + a second handle
    proj = {
      ...proj,
      handles: proj.handles.map((h, idx) =>
        idx === 0 ? addScriptToHandle(h, 'timers') : h,
      ),
    };
    proj = addHandleToProject(proj, 'worker_hdl');

    // 1. Single-handle flat ZIP
    const singleBundle = buildSingleHandleTargetBundle(proj, proj.handles[0]);
    const singleFiles = inspectZipEntries(singleBundle.zipBytes);
    expect(singleFiles.has('main.lua')).toBe(true);
    expect(singleFiles.has('timers.lua')).toBe(true);
    expect(singleFiles.has('utils/crc16.lua')).toBe(true);
    expect(singleFiles.has('crc16_table.lua')).toBe(true);
    expect(singleFiles.has('manifest.json')).toBe(true);
    // sandboxMock modules (`board`, `rt`, `poly_clock`) MUST be stripped!
    expect(singleFiles.has('board.lua')).toBe(false);
    expect(singleFiles.has('rt.lua')).toBe(false);
    expect(singleBundle.strippedSandboxMocks).toContain('board');
    expect(singleBundle.strippedSandboxMocks).toContain('rt');

    // 2. Whole-project ZIP
    const projectBundle = buildProjectTargetBundle(proj);
    const projectFiles = inspectZipEntries(projectBundle.zipBytes);
    expect(projectFiles.has(`${proj.handles[0].name}/main.lua`)).toBe(true);
    expect(projectFiles.has(`${proj.handles[0].name}/timers.lua`)).toBe(true);
    expect(projectFiles.has('worker_hdl/main.lua')).toBe(true);
    expect(projectFiles.has('libs/utils/crc16.lua')).toBe(true);
    expect(projectFiles.has('libs/crc16_table.lua')).toBe(true);
    expect(projectFiles.has('libs/board.lua')).toBe(false);
    expect(projectFiles.has('manifest.json')).toBe(true);

    // 3. Same-tier conflict MUST block both single-handle and project ZIP export!
    const conflictingPack = makeTestPack('crc16-conflict', {
      libs: [{ moduleName: 'utils.crc16', sources: { lua: 'return {}\n' } }],
    });
    const badProj = {
      ...proj,
      enabledCapabilities: [...proj.enabledCapabilities, 'crc16-conflict'],
      localExtensions: [crcPack, conflictingPack],
    };
    expect(() =>
      buildSingleHandleTargetBundle(badProj, badProj.handles[0]),
    ).toThrow(ModuleConflictExportError);
    expect(() => buildProjectTargetBundle(badProj)).toThrow(
      ModuleConflictExportError,
    );
  });

  it('supports single-language extension packs (Lua-only or Python-only), rejects blocks with neither template, and emits static Error on unsupported target language', () => {
    const luaOnlyPack = extensionRegistry.validateProjectLocalPack({
      format: 'polyblock-extension',
      version: 1,
      id: 'lua-only-math',
      name: '仅 Lua 扩展数学',
      packVersion: '1.0.0',
      iconLabel: '数学',
      color: '#10b981',
      description: '单语言纯模板测试包',
      sections: [
        {
          id: 'main',
          label: '数学',
          blocks: [
            {
              type: 'ext_luaonly_abs',
              kind: 'value',
              outputType: 'Number',
              message0: '%1 的绝对值',
              args0: [{ type: 'input_value', name: 'X', check: 'Number' }],
              code: {
                lua: { template: 'math.abs({{X}})' },
              },
            },
          ],
        },
      ],
    });
    expect(getPackSupportedLanguages(luaOnlyPack)).toEqual({
      supported: ['lua'],
      label: '仅 Lua 5.4',
    });
    expect(derivePackBadges(luaOnlyPack).map((b) => b.label)).toContain('仅 Lua');

    // Block with NO code templates must fail validation
    expect(() =>
      validateExtensionPack({
        format: 'polyblock-extension',
        version: 1,
        id: 'bad-no-tpl',
        name: '缺模板包',
        sections: [
          {
            id: 'main',
            label: '缺模板',
            blocks: [
              {
                type: 'ext_bad_notpl',
                kind: 'statement',
                message0: '空操作',
              },
            ],
          },
        ],
      }),
    ).toThrow(/缺少 code 对象/);

    // Mount Lua-only pack & verify Lua codegen succeeds (0 diagnostics) while Python codegen emits clear Error without crashing
    extensionRegistry.setActiveProjectLocalPacks([luaOnlyPack]);
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_start',
              id: 's_lang',
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_print',
                    id: 'p_lang',
                    inputs: {
                      VALUE: {
                        block: {
                          type: 'ext_luaonly_abs',
                          id: 'abs_lang',
                          inputs: {
                            X: {
                              block: {
                                type: 'math_number',
                                id: 'n_lang',
                                fields: { NUM: -9 },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      },
      ws,
    );

    const luaRes = backendRegistry.get('lua').generate(ws);
    expect(luaRes.code).toContain('print(math.abs(-9))');
    expect(luaRes.code).not.toContain('require("math")');
    expect(luaRes.diagnostics).toHaveLength(0);

    const pyRes = backendRegistry.get('python').generate(ws);
    expect(pyRes.code).toContain('print(None)');
    expect(
      pyRes.diagnostics.some(
        (d) =>
          d.severity === 'error' &&
          d.blockId === 'abs_lang' &&
          d.message.includes('code.python.template'),
      ),
    ).toBe(true);

    ws.dispose();
    extensionRegistry.setActiveProjectLocalPacks([]);
  });

  it('auto-bundles Style A1 shared.lua & shared.py whenever a handle has cross-file variables or functions (even single-script handles)', () => {
    const pyProj = instantiateProjectFromTemplate('event_timer_demo');
    pyProj.language = 'python';
    const boardVm = pyProj.handles.find((h) => h.name === 'board_vm')!;
    const oneshotVm = pyProj.handles.find((h) => h.name === 'oneshot_vm')!;

    // 1. Single-handle Python export for `board_vm` includes `shared.py` with explicit initial values
    const pyBoardBundle = buildSingleHandleTargetBundle(pyProj, boardVm);
    const pyBoardPaths = pyBoardBundle.entries.map((e) => e.path);
    expect(pyBoardPaths).toContain('shared.py');
    expect(pyBoardPaths).toContain('main.py');
    expect(pyBoardPaths).toContain('timers.py');
    const sharedPyEntry = pyBoardBundle.entries.find((e) => e.path === 'shared.py')!;
    expect(sharedPyEntry.content).toContain('led_on = False');
    expect(sharedPyEntry.content).toContain('ticks = 0');

    // 2. Single-handle export for `oneshot_vm` (no shared vars/fns) has NO `shared.py`
    const pyOneshotBundle = buildSingleHandleTargetBundle(pyProj, oneshotVm);
    expect(pyOneshotBundle.entries.map((e) => e.path)).not.toContain('shared.py');

    // 3. Full-project Python ZIP places `board_vm/shared.py` ONLY under `board_vm/`
    const pyFullBundle = buildProjectTargetBundle(pyProj);
    const pyFullPaths = pyFullBundle.entries.map((e) => e.path);
    expect(pyFullPaths).toContain('board_vm/shared.py');
    expect(pyFullPaths).not.toContain('oneshot_vm/shared.py');

    // 4. Lua bundle ALSO emits Style A1 `shared.lua` for `board_vm` (and omits it for `oneshot_vm`)!
    const luaProj = instantiateProjectFromTemplate('event_timer_demo');
    luaProj.language = 'lua';
    const luaBoardBundle = buildSingleHandleTargetBundle(luaProj, luaProj.handles[0]);
    const luaPaths = luaBoardBundle.entries.map((e) => e.path);
    expect(luaPaths).toContain('shared.lua');
    expect(luaPaths).not.toContain('shared.py');
    const sharedLuaEntry = luaBoardBundle.entries.find((e) => e.path === 'shared.lua')!;
    expect(sharedLuaEntry.content).toContain('local shared = {}');
    expect(sharedLuaEntry.content).toContain('shared.led_on = false');
    expect(sharedLuaEntry.content).toContain('shared.ticks = 0');
    expect(sharedLuaEntry.content).toContain('return shared');

    const luaOneshotBundle = buildSingleHandleTargetBundle(luaProj, luaProj.handles[1]);
    expect(luaOneshotBundle.entries.map((e) => e.path)).not.toContain('shared.lua');

    // 5. Even a single-script handle WITH a shared variable generates `shared.lua`!
    const singleWithShared = {
      ...luaProj.handles[1],
      sharedVariables: ['count'],
      variableInitialValues: { count: { kind: 'number' as const, value: 0 } },
    };
    const singleSharedBundle = buildSingleHandleTargetBundle(luaProj, singleWithShared);
    expect(singleSharedBundle.entries.map((e) => e.path)).toContain('shared.lua');
  });

  it('builds language-agnostic dual-language packs from script libs and extracts imports across all registered languages', () => {
    const pyFile = scanScriptLibraryFile(
      'checksum.PY',
      'def calc(buf):\n    return len(buf)\n',
    );
    const luaFile = scanScriptLibraryFile(
      'checksum.LUA',
      'local M = {}\nfunction M.calc(buf)\n  return #buf\nend\nreturn M\n',
    );
    expect(pyFile.moduleName).toBe('checksum');
    expect(pyFile.language).toBe('python');
    expect(luaFile.moduleName).toBe('checksum');
    expect(luaFile.language).toBe('lua');

    const dualPack = buildExtensionPackFromScriptLibs({
      packId: 'checksum-dual',
      packName: '双语校验库',
      iconLabel: '校验',
      color: '#0ea5e9',
      toolboxOrder: 135,
      files: [luaFile, pyFile],
      functions: luaFile.scannedFunctions,
    });
    const validated = validateExtensionPack(dualPack);
    expect(validated.imports).toEqual({
      lua: ['local checksum = require("checksum")'],
      python: ['import checksum'],
    });
    expect(validated.sections[0].blocks[0].code).toEqual({
      lua: { template: 'checksum.calc({{ARG1}})' },
      python: { template: 'checksum.calc({{ARG1}})' },
    });
    expect(getPackSupportedLanguages(validated)).toEqual({
      supported: ['lua', 'python'],
      label: 'Lua 5.4 / Python 3',
    });
    expect(extractImportedModuleNames(validated)).toEqual(['checksum']);
    expect(
      extractImportedModuleNames({
        ...validated,
        imports: {
          lua: ['local foo = require("pkg.foo")'],
          python: ['from pkg.bar import helper', 'import baz'],
        },
      }),
    ).toEqual(['pkg.foo', 'pkg.bar', 'baz']);
  });
});
