// @vitest-environment node
import * as Blockly from 'blockly';
import { loadMicroPython } from '@micropython/micropython-webassembly-pyscript';
import { LuaFactory } from 'wasmoon';
import { beforeEach, describe, expect, it } from 'vitest';
import '../backends/luaBackend';
import '../backends/pythonBackend';
import { analyzeWorkspaceDiagnostics } from '../backends/sourceMap';
import { registerPolyBlocks } from '../blocks/definitions';
import { setActiveModuleConflicts } from '../blocks/timerConfigBridge';
import {
  buildProjectTargetBundle,
  buildSingleHandleTargetBundle,
  ModuleConflictExportError,
  moduleNameToRelativeFile,
} from '../export/bundleExporter';
import { computeCrc32 } from '../export/zipWriter';
import { RT_PACK } from '../extensions/builtinPacks';
import {
  extractImportedModuleNames,
  inspectPackImportSourceMatch,
  resolveProjectModules,
} from '../extensions/moduleResolver';
import {
  extensionRegistry,
  validateExtensionPack,
} from '../extensions/registry';
import {
  buildExtensionPackFromScriptLibs,
  mergeAttachedLibFiles,
  scanLuaLibraryFunctions,
  scanPythonLibraryFunctions,
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
            lua: { template: '1' },
            python: { template: '1' },
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
  });

  it('enforces pure 3-tier scope priority (handle > project > global) even when project uses sandboxMock over global libs', () => {
    const globalCrcLib = makeTestPack('global-crc', {
      name: '全局纯 Lua CRC16',
      libs: [
        {
          moduleName: 'crc16',
          role: 'entry',
          luaSource: 'return { calc = function() return 111 end }',
        },
      ],
    });
    const projectHwCrcMock = makeTestPack('proj-hw-crc', {
      name: '本项目硬件 C 版 CRC16',
      sandboxMock: {
        moduleName: 'crc16',
        luaSource: 'return { calc = function() return 222 end }',
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
    expect(res.sandboxMountOrder.map((m) => m.luaSource)).toEqual([
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
            luaSource: 'return { tick = function() return 99999 end }',
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
          luaSource: 'return { tick = function() return 777 end }',
        },
      ],
    });
    expect(resWithHandle.conflicts).toHaveLength(0);
    expect(resWithHandle.resolvedByName.get('rt')?.tier).toBe('handle');
    expect(resWithHandle.overrides).toHaveLength(1);
  });

  it('standardizes RT_PACK.sandboxMock identically to all other packs (zero worker/resolver special cases) and runs cleanly in Lua 5.4 & MicroPython', async () => {
    expect(RT_PACK.sandboxMock?.moduleName).toBe('rt');
    expect(RT_PACK.sandboxMock?.luaSource).toContain('__poly_rt_tick');
    expect(RT_PACK.sandboxMock?.pythonSource).toContain('_poly.rt_tick');

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
    expect(rtMod?.luaSource).toBeTruthy();
    expect(rtMod?.pythonSource).toBeTruthy();

    // Execute RT_PACK.sandboxMock.luaSource directly in Wasmoon Lua 5.4
    const lua = await new LuaFactory().createEngine();
    try {
      lua.global.set('__poly_rt_tick', () => 1234);
      lua.global.set('__poly_rt_ms_to_tick', (ms: number) => Math.ceil(ms));
      lua.global.set('__poly_rt_is_expired', (s: number, t: number) => 1234 - s >= t);
      await lua.doString(
        `package.preload["rt"] = load(${JSON.stringify(rtMod!.luaSource!)})`,
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

    // Execute RT_PACK.sandboxMock.pythonSource via the EXACT same scoped-proxy mount as python.worker.ts!
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
    const rewrittenPy = rtMod!.pythonSource!.replace(
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
      libs: [{ moduleName: 'crypto', luaSource: 'return { v = 1 }' }],
    });
    const localB = makeTestPack('local-b', {
      sandboxMock: { moduleName: 'crypto', luaSource: 'return { v = 2 }' },
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
      libs: [{ moduleName: 'rt', luaSource: 'return {}' }],
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
        libs: [{ moduleName: 'dht22', luaSource: 'return { read = function() return 25 end }' }],
        sandboxMock: { moduleName: 'i2c', luaSource: 'return { read = function() return 1 end }' },
      }),
    );
    expect(validDual.libs).toHaveLength(1);
    expect(validDual.sandboxMock?.moduleName).toBe('i2c');

    // Forbidden: same moduleName in both libs[] and sandboxMock
    expect(() =>
      validateExtensionPack(
        makeTestPack('bad-dup-mock-lib', {
          libs: [{ moduleName: 'foo', luaSource: 'return {}' }],
          sandboxMock: { moduleName: 'foo', luaSource: 'return {}' },
        }),
      ),
    ).toThrow(/同时写入 libs\[\] 与 sandboxMock/);

    // Forbidden: duplicate moduleName inside libs[]
    expect(() =>
      validateExtensionPack(
        makeTestPack('bad-dup-libs', {
          libs: [
            { moduleName: 'foo', luaSource: 'return {}' },
            { moduleName: 'foo', luaSource: 'return {}' },
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

    const scannedFns = scanLuaLibraryFunctions('crc16', crcEntryLua);
    expect(scannedFns.map((f) => `${f.funcName}:${f.inferredKind}`)).toEqual([
      'calc:value',
      'reset_stats:statement',
    ]);
    // Private local function skipped
    expect(scannedFns.some((f) => f.funcName.includes('private'))).toBe(false);

    // Python scanner check
    const pyFns = scanPythonLibraryFunctions(
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

    // Generated pack validates cleanly & matches imports -> libs
    const validated = validateExtensionPack(generatedPack);
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
        const safeSrc = JSON.stringify(mod.luaSource ?? '');
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
        libs: [{ moduleName: 'rt', luaSource: 'return { tick = function() return 99999 end }' }],
      });
      const rtRes = resolveProjectModules({
        enabledCapabilities: ['rt'],
        localExtensions: [rtOverridePack],
      });
      for (const mod of rtRes.sandboxMountOrder) {
        await lua.doString(`package.preload[${JSON.stringify(mod.moduleName)}] = load(${JSON.stringify(mod.luaSource ?? '')})`);
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
    expect(merged.find((m) => m.moduleName === 'crc16')?.luaSource).toBeTruthy();
    expect(merged.find((m) => m.moduleName === 'crc16')?.pythonSource).toContain(
      '0x4B37',
    );
  });

  it('builds valid single-handle flat ZIP and multi-handle project ZIP, stripping sandboxMock and blocking on conflicts', () => {
    expect(moduleNameToRelativeFile('utils.crc16', 'lua')).toBe('utils/crc16.lua');

    const crcPack = makeTestPack('crc16-pack', {
      name: 'CRC16 库',
      libs: [
        { moduleName: 'utils.crc16', role: 'entry', luaSource: 'return { calc = function() return 42 end }\n' },
        { moduleName: 'crc16_table', role: 'helper', luaSource: 'return { 1, 2, 3 }\n' },
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
      libs: [{ moduleName: 'utils.crc16', luaSource: 'return {}\n' }],
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
});
