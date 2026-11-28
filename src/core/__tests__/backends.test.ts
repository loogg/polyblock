import * as Blockly from 'blockly';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  backendRegistry,
  formatInitialValueForLanguage,
  formatSupportedExtensionsLabel,
  getLanguageDialect,
  getSupportedLanguageIds,
  getSupportedScriptAcceptAttr,
  isSupportedLanguageId,
  normalizeLanguageId,
  stripScriptExtension,
} from '../backends/registry';
import { BaseScriptBackend } from '../backends/baseBackend';
import {
  formatSharedVarRef,
  resetCodegenPassContext,
} from '../backends/codegenContext';
import { sanitizeLocalIdent } from '../backends/scopeAnalysis';
import type {
  LanguageDialect,
  LanguagePlugin,
  ScriptBackendAdapter,
} from '../backends/types';
import { buildHandleScriptsMeta } from '../backends/eventMode';
import { extractImportedModuleNames } from '../extensions/moduleResolver';
import type { ScriptRunner } from '../runners/types';
import { scanScriptLibraryFile } from '../extensions/scriptLibScanner';
import { validateSharedVariableName } from '../projects/handleVariables';
import { registerPolyBlocks } from '../blocks/definitions';
import { getDemoProjectById } from '../projects/defaultDemos';
import { instantiateProjectFromTemplate } from '../projects/store';
import { highlightCodeLine } from '../highlight';
import { extractErrorLine, parseStdoutLine } from '../runners/logParser';
import {
  PLANNED_RUNNER_SLOTS,
  RunnerManager,
  runnerManager,
} from '../runners/manager';
import { MultiHandleRunnerOrchestrator } from '../runners/multiHandleManager';
import type { ScriptLanguageId } from '../../types/project';
import { WorkerDebugSession } from '../../workers/debugSession';
import { WorkerProtocolHost } from '../../workers/workerProtocolHost';

const starterDemoProject = getDemoProjectById('starter_suite')!.project;
const STARTER_DEMO_LOGGER_WORKSPACE = starterDemoProject.handles[0].scripts[0].workspace;
const STARTER_STEP_DEBUG_WORKSPACE = starterDemoProject.handles[1].scripts[0].workspace;
const STARTER_THRESHOLD_ALARM_WORKSPACE = starterDemoProject.handles[2].scripts[0].workspace;

const LIST_STATS_WORKSPACE: Record<string, unknown> = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'poly_on_start',
        id: 'list_start',
        x: 36,
        y: 28,
        inputs: {
          BODY: {
            block: {
              type: 'variables_set',
              id: 'set_items',
              fields: { VAR: { id: 'var_items' } },
              inputs: {
                VALUE: {
                  block: {
                    type: 'lists_create_with',
                    id: 'mk_list',
                    extraState: { itemCount: 3 },
                    inputs: {
                      ADD0: { block: { type: 'math_number', id: 'li0', fields: { NUM: 10 } } },
                      ADD1: { block: { type: 'math_number', id: 'li1', fields: { NUM: 20 } } },
                      ADD2: { block: { type: 'math_number', id: 'li2', fields: { NUM: 30 } } },
                    },
                  },
                },
              },
              next: {
                block: {
                  type: 'poly_list_append',
                  id: 'append_40',
                  inputs: {
                    LIST: {
                      block: {
                        type: 'variables_get',
                        id: 'get_items_append',
                        fields: { VAR: { id: 'var_items' } },
                      },
                    },
                    ITEM: { block: { type: 'math_number', id: 'li3', fields: { NUM: 40 } } },
                  },
                  next: {
                    block: {
                      type: 'poly_print_kv',
                      id: 'print_len',
                      fields: { LABEL: '列表元素数量' },
                      inputs: {
                        VALUE: {
                          block: {
                            type: 'lists_length',
                            id: 'len_items',
                            inputs: {
                              VALUE: {
                                block: {
                                  type: 'variables_get',
                                  id: 'get_items',
                                  fields: { VAR: { id: 'var_items' } },
                                },
                              },
                            },
                          },
                        },
                      },
                      next: {
                        block: {
                          type: 'poly_log',
                          id: 'log_list_ok',
                          fields: { LEVEL: 'OK' },
                          inputs: {
                            MESSAGE: {
                              block: {
                                type: 'text',
                                id: 'txt_list_ok',
                                fields: { TEXT: '列表统计完成' },
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
          },
        },
      },
    ],
  },
  variables: [{ name: 'items', id: 'var_items' }],
};

function createLoadedWorkspace(json: Record<string, unknown>): Blockly.Workspace {
  const ws = new Blockly.Workspace();
  Blockly.serialization.workspaces.load(json, ws);
  return ws;
}

describe('PolyBlock Backends (Lua 5.4 & Python 3)', () => {
  beforeAll(() => {
    registerPolyBlocks();
  });

  it('generates clean Lua 5.4 code with exact SourceMap for default logger template', () => {
    const ws = createLoadedWorkspace(STARTER_DEMO_LOGGER_WORKSPACE);
    const lua = backendRegistry.get('lua');
    const res = lua.generate(ws);

    expect(res.code).not.toContain('__PB_S:');
    expect(res.code).not.toContain('__PB_E:');
    expect(res.code).toContain('Target: Lua 5.4');
    expect(res.code).toContain('function on_start()');
    expect(res.debugCode).toContain('coroutine.create(on_start)');
    expect(res.debugCode).toContain('__poly_init_scheduler');
    expect(res.code).toContain('print("[INFO] " .. tostring(');
    expect(res.code).toContain('for i = 1, 3 do');
    expect(res.code).toContain('print("最终 total" .. " = " .. tostring(total))');
    expect(res.code).toContain('print("[OK] " .. tostring(');

    // Bidirectional SourceMap verification
    expect(res.sourceMap['loop_main']).toBeDefined();
    expect(res.sourceMap['add_total']).toBeDefined();
    expect(res.sourceMap['log_done']).toBeDefined();
    const addLine = res.sourceMap['add_total'].startLine;
    expect(res.lineToBlock[addLine]).toBe('add_total');
    expect(res.diagnostics).toHaveLength(0);

    ws.dispose();
  });

  it('generates clean Python 3 code with exact SourceMap for default logger template', () => {
    const ws = createLoadedWorkspace(STARTER_DEMO_LOGGER_WORKSPACE);
    const py = backendRegistry.get('python');
    const res = py.generate(ws);

    expect(res.code).not.toContain('__PB_S:');
    expect(res.code).not.toContain('__PB_E:');
    expect(res.code).not.toContain('from numbers import Number');
    expect(res.code).not.toContain('isinstance(');
    expect(res.code).toContain('total += 10');
    expect(res.code).toContain('Target: Python 3');
    expect(res.code).toContain('async def on_start():');
    expect(res.debugCode).toContain('_poly.init_scheduler');
    expect(res.code).toContain('print("[INFO] " + str(');
    expect(res.code).toContain('for i in range(int(1), 4):');
    expect(res.code).toContain('print("最终 total =", total)');
    expect(res.code).toContain('print("[OK] " + str(');

    expect(res.sourceMap['loop_main']).toBeDefined();
    expect(res.sourceMap['print_round']).toBeDefined();
    expect(res.lineToBlock[res.sourceMap['print_round'].startLine]).toBe('print_round');
    expect(res.diagnostics).toHaveLength(0);

    ws.dispose();
  });

  it('generates clean JavaScript (ES2023) code with exact SourceMap and zero hidden magic helpers', () => {
    const ws = createLoadedWorkspace(STARTER_DEMO_LOGGER_WORKSPACE);
    const js = backendRegistry.get('js');
    const res = js.generate(ws);

    expect(res.code).not.toContain('__PB_S:');
    expect(res.code).not.toContain('__PB_E:');
    expect(res.code).not.toContain("typeof total === 'number'");
    expect(res.code).toContain('Target: JavaScript ES2023');
    expect(res.code).toContain('async function on_start()');
    expect(res.code).not.toContain('let i = null;');
    expect(res.code).toContain('total += 10;');
    expect(res.code).toContain('console.log("[INFO] " + String(');
    expect(res.code).toContain('for (let i = 1; i <= 3; i++)');
    expect(res.code).toContain('console.log("最终 total =", total);');
    expect(res.code).toContain('console.log("[OK] " + String(');
    expect(res.debugCode).toContain('_poly.init_scheduler');

    expect(res.sourceMap['loop_main']).toBeDefined();
    expect(res.sourceMap['add_total']).toBeDefined();
    expect(res.lineToBlock[res.sourceMap['add_total'].startLine]).toBe('add_total');
    expect(res.diagnostics).toHaveLength(0);

    ws.dispose();

    // Verify math_random_int emits inline Math.floor(Math.random() ...) with ZERO provideFunction_ helper
    const alarmWs = createLoadedWorkspace(STARTER_THRESHOLD_ALARM_WORKSPACE);
    const alarmJs = js.generate(alarmWs);
    expect(alarmJs.code).toContain('Math.floor(Math.random() *');
    expect(alarmJs.code).not.toContain('function mathRandomInt');
    expect(alarmJs.diagnostics).toHaveLength(0);
    alarmWs.dispose();
  });

  it('generates valid Lua & Python for list primitives (zero hidden helper functions) and random alarm templates', () => {
    for (const workspace of [
      STARTER_STEP_DEBUG_WORKSPACE,
      STARTER_THRESHOLD_ALARM_WORKSPACE,
      LIST_STATS_WORKSPACE,
    ]) {
      const ws = createLoadedWorkspace(workspace);
      const luaRes = backendRegistry.get('lua').generate(ws);
      const pyRes = backendRegistry.get('python').generate(ws);
      const jsRes = backendRegistry.get('js').generate(ws);

      expect(luaRes.code).not.toContain('__PB_S:');
      expect(pyRes.code).not.toContain('__PB_S:');
      expect(jsRes.code).not.toContain('__PB_S:');
      expect(luaRes.blockCount).toBeGreaterThan(3);
      expect(pyRes.blockCount).toBe(luaRes.blockCount);
      expect(jsRes.blockCount).toBe(luaRes.blockCount);
      ws.dispose();
    }

    const listWs = createLoadedWorkspace(LIST_STATS_WORKSPACE);
    const listLua = backendRegistry.get('lua').generate(listWs).code;
    const listPy = backendRegistry.get('python').generate(listWs).code;
    const listJs = backendRegistry.get('js').generate(listWs).code;
    expect(listLua).toContain('table.insert(items, 40)');
    expect(listPy).toContain('items.append(40)');
    expect(listJs).toContain('items.push(40);');
    listWs.dispose();

    // Pure value-slot list primitives (`poly_list_get`/`set`/`remove`) emit direct indexing with ZERO helper functions!
    const opsWs = createLoadedWorkspace({
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'lop_s',
            inputs: {
              BODY: {
                block: {
                  type: 'poly_list_set',
                  id: 'lop_set',
                  inputs: {
                    LIST: { block: { type: 'variables_get', id: 'lop_g1', fields: { VAR: { id: 'v_arr' } } } },
                    INDEX: { shadow: { type: 'math_number', id: 'lop_i1', fields: { NUM: 1 } } },
                    VALUE: { block: { type: 'math_number', id: 'lop_v99', fields: { NUM: 99 } } },
                  },
                  next: {
                    block: {
                      type: 'poly_print',
                      id: 'lop_pr',
                      inputs: {
                        VALUE: {
                          block: {
                            type: 'poly_list_get',
                            id: 'lop_get',
                            inputs: {
                              LIST: { block: { type: 'variables_get', id: 'lop_g2', fields: { VAR: { id: 'v_arr' } } } },
                              INDEX: { shadow: { type: 'math_number', id: 'lop_i2', fields: { NUM: 1 } } },
                            },
                          },
                        },
                      },
                      next: {
                        block: {
                          type: 'poly_list_remove',
                          id: 'lop_rem',
                          inputs: {
                            LIST: { block: { type: 'variables_get', id: 'lop_g3', fields: { VAR: { id: 'v_arr' } } } },
                            INDEX: { shadow: { type: 'math_number', id: 'lop_i3', fields: { NUM: 2 } } },
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
      variables: [{ name: 'arr', id: 'v_arr' }],
    });
    const opsLua = backendRegistry.get('lua').generate(opsWs).code;
    const opsPy = backendRegistry.get('python').generate(opsWs).code;
    const opsJs = backendRegistry.get('js').generate(opsWs).code;
    expect(opsLua).toContain('arr[1] = 99');
    expect(opsLua).toContain('print(arr[1])');
    expect(opsLua).toContain('table.remove(arr, 2)');
    expect(opsLua).not.toContain('first_index');
    expect(opsPy).toContain('arr[0] = 99');
    expect(opsPy).toContain('print(arr[0])');
    expect(opsPy).toContain('arr.pop(1)');
    expect(opsJs).toContain('arr[0] = 99;');
    expect(opsJs).toContain('console.log(arr[0]);');
    expect(opsJs).toContain('arr.splice(1, 1);');
    opsWs.dispose();
  });

  it('generates unified async coroutine delay code and separate debugCode for step_debug_demo', () => {
    const ws = createLoadedWorkspace(STARTER_STEP_DEBUG_WORKSPACE);

    const luaRes = backendRegistry.get('lua').generate(ws);
    expect(luaRes.code).toContain('sleep_ms(350)');
    expect(luaRes.code).not.toContain('poly_wait_ms');
    expect(luaRes.code).not.toContain('__poly_step');
    expect(luaRes.code).not.toContain('__poly_sleep');
    expect(luaRes.debugCode).toContain('__poly_tick(');
    expect(luaRes.debugCode).toContain('sleep_ms(350)');
    expect(luaRes.debugCode).toContain('["sum"] = sum');
    expect(luaRes.sourceMap['dbg_wait'].startLine).toBe(
      luaRes.sourceMap['dbg_wait'].endLine,
    );
    expect(luaRes.sourceMap['dbg_add_sum'].startLine).toBe(
      luaRes.sourceMap['dbg_add_sum'].endLine,
    );
    expect(luaRes.variableNames).toContain('sum');

    const pyRes = backendRegistry.get('python').generate(ws);
    expect(pyRes.code).toContain('async def on_start():');
    expect(pyRes.code).toContain('await sleep_ms(350)');
    expect(pyRes.code).not.toContain('import time');
    expect(pyRes.code).not.toContain('time.sleep');
    expect(pyRes.code).not.toContain('_poly.step');
    expect(pyRes.code).not.toContain('_poly.sleep');
    expect(pyRes.debugCode).toContain('await _poly_tick(');
    expect(pyRes.debugCode).toContain('await sleep_ms(350)');
    expect(pyRes.debugCode).toContain('["sum","sum2"]');
    expect(pyRes.variableNames).toContain('sum');

    const jsRes = backendRegistry.get('js').generate(ws);
    expect(jsRes.code).toContain('async function on_start()');
    expect(jsRes.code).toContain('await sleep_ms(350);');
    expect(jsRes.code).not.toContain('_poly_tick');
    expect(jsRes.debugCode).toContain('await _poly_tick(');
    expect(jsRes.debugCode).toContain('await sleep_ms(350);');
    expect(jsRes.variableNames).toContain('sum');

    ws.dispose();
  });

  it('pauses on breakpoints and advances with stepNext / resume in WorkerDebugSession', async () => {
    const events: Array<Record<string, unknown>> = [];
    const session = new WorkerDebugSession(
      {
        runId: 'test-1',
        breakpoints: ['b2'],
        stepDelayMs: 0,
        startInStepMode: false,
      },
      (msg) => events.push(msg),
    );

    await session.onStep('b1', JSON.stringify({ total: '0' }));
    expect(events[0]).toMatchObject({ type: 'STEP', blockId: 'b1' });

    // b2 hits breakpoint -> suspends promise until stepNext()
    let b2Resolved = false;
    const p2 = session.onStep('b2', JSON.stringify({ total: '10' })).then(() => {
      b2Resolved = true;
    });
    await Promise.resolve();
    expect(b2Resolved).toBe(false);
    expect(events.some((e) => e.type === 'PAUSED' && e.blockId === 'b2' && e.reason === 'breakpoint')).toBe(true);

    session.stepNext();
    await p2;
    expect(b2Resolved).toBe(true);

    // Next block b3 must also pause because we used stepNext()
    let b3Resolved = false;
    const p3 = session.onStep('b3', JSON.stringify({ total: '20' })).then(() => {
      b3Resolved = true;
    });
    await Promise.resolve();
    expect(b3Resolved).toBe(false);
    expect(events.some((e) => e.type === 'PAUSED' && e.blockId === 'b3' && e.reason === 'step')).toBe(true);

    session.resume();
    await p3;
    expect(b3Resolved).toBe(true);
  });

  it('reports static diagnostics for empty start block and floating blocks', () => {
    const ws = createLoadedWorkspace({
      blocks: {
        languageVersion: 0,
        blocks: [
          { type: 'poly_on_start', id: 'empty_start', x: 10, y: 10 },
          {
            type: 'poly_print',
            id: 'loose_print',
            x: 200,
            y: 10,
            inputs: {
              VALUE: { block: { type: 'text', id: 't1', fields: { TEXT: 'hi' } } },
            },
          },
        ],
      },
    });

    const res = backendRegistry.get('lua').generate(ws);
    expect(res.diagnostics.length).toBe(2);
    expect(res.diagnostics.some((d) => d.blockId === 'empty_start')).toBe(true);
    expect(res.diagnostics.some((d) => d.blockId === 'loose_print')).toBe(true);
    ws.dispose();
  });
});

describe('Log parser & syntax highlighter', () => {
  it('parses leveled log tags accurately', () => {
    expect(parseStdoutLine('[INFO] hello')).toEqual({
      level: 'info',
      message: 'hello',
    });
    expect(parseStdoutLine('[WARN] over 70')).toEqual({
      level: 'warn',
      message: 'over 70',
    });
    expect(parseStdoutLine('plain output')).toEqual({
      level: 'print',
      message: 'plain output',
    });
  });

  it('extracts line numbers from Lua, Python, and JavaScript error messages', () => {
    expect(
      extractErrorLine('[string "main"]:8: attempt to index nil value', 'lua'),
    ).toBe(8);
    expect(
      extractErrorLine(
        'Traceback (most recent call last):\n  File "<string>", line 12, in <module>\nZeroDivisionError',
        'python',
      ),
    ).toBe(12);
    expect(
      extractErrorLine('ReferenceError: foo is not defined\n    at eval (<anonymous>:19:5)', 'js'),
    ).toBe(19);
  });

  it('safely escapes HTML and highlights Lua/Python/JS keywords', () => {
    const html = highlightCodeLine('if x < 10 then -- <tag>', 'lua');
    expect(html).toContain('<span class="syn-kw">if</span>');
    expect(html).toContain('&lt; <span class="syn-num">10</span>');
    expect(html).toContain('<span class="syn-cmt">-- &lt;tag&gt;</span>');

    const jsHtml = highlightCodeLine('const v = console.log(42); // ok', 'js');
    expect(jsHtml).toContain('<span class="syn-kw">const</span>');
    expect(jsHtml).toContain('<span class="syn-fn">console</span>');
    expect(jsHtml).toContain('<span class="syn-num">42</span>');
    expect(jsHtml).toContain('<span class="syn-cmt">// ok</span>');
  });
});

describe('Language dialects, BaseScriptBackend, Runner fallback & WorkerProtocolHost', () => {
  it('derives accentGradient and script extension helpers dynamically from backendRegistry', () => {
    const supportedIds = getSupportedLanguageIds();
    expect(supportedIds).toEqual(['lua', 'python', 'js']);
    for (const lang of supportedIds) {
      expect(getLanguageDialect(lang).accentGradient).toMatch(/^linear-gradient\(/);
    }
    expect(getSupportedScriptAcceptAttr()).toBe('.lua,.py,.js');
    expect(formatSupportedExtensionsLabel()).toBe('.lua / .py / .js');
    expect(stripScriptExtension('main.lua')).toBe('main');
    expect(stripScriptExtension('helpers.PY')).toBe('helpers');
    expect(stripScriptExtension('driver.JS')).toBe('driver');
    expect(stripScriptExtension('utils.crc16.lua')).toBe('utils.crc16');
    expect(stripScriptExtension('readme.md')).toBe('readme.md');
  });

  it('propagates a dynamically registered 4th backend across all derived dialect helpers, highlighter, scanner, and validators', () => {
    const mockDialect: LanguageDialect<'dsl'> = {
      id: 'dsl',
      displayName: 'PolyDSL',
      shortLabel: 'DSL',
      compactLabel: 'DSL',
      extension: 'dsl',
      accentGradient: 'linear-gradient(135deg, #ec4899, #db2777)',
      boolTrue: 'true',
      boolFalse: 'false',
      nullLiteral: 'none',
      listLiteral: '[]',
      dictLiteral: '{}',
      notOp: '!',
      commentToken: '//',
      lineCommentPrefix: ' // ',
      keywords: ['rule', 'emit', 'fn', 'none'],
      builtinFuncs: ['trace'],
      explicitAsyncCoroutine: false,
      libBinding: {
        formatImport: (mod) => `use "${mod}"`,
        formatCall: (mod, fn, args) => `${mod}::${fn}(${args.join(', ')})`,
        extractImportedModuleName: (line) => {
          const m = /use\s+["']([^"']+)["']/.exec(line);
          return m?.[1]?.trim() || null;
        },
        scanFunctions: (source) => {
          const out: Array<{
            funcName: string;
            params: string[];
            inferredKind: 'statement' | 'value';
          }> = [];
          const re = /pub\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{([^}]*)\}/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(source)) !== null) {
            out.push({
              funcName: m[1],
              params: m[2]
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
              inferredKind: /\breturn\s+\S/.test(m[3]) ? 'value' : 'statement',
            });
          }
          return out;
        },
      },
      extractErrorLine: (msg) => {
        const m = /\.dsl:(\d+):/.exec(msg);
        return m ? Number(m[1]) : undefined;
      },
      exportToolchain: {
        label: 'PolyDSL Compiler',
        notes: '仅导出型自定义 DSL 演示。',
      },
    };

    const dslLang = 'dsl' as ScriptLanguageId;
    const mockAdapter: ScriptBackendAdapter = {
      id: dslLang,
      name: 'PolyDSL',
      version: '1.0',
      extension: 'dsl',
      fileName: 'main.dsl',
      accentColor: '#ec4899',
      description: 'Mock 4th-language backend for single-entry verification',
      dialect: mockDialect,
      generate: () => ({
        language: dslLang,
        code: '',
        debugCode: '',
        moduleDebugCode: '',
        sourceMap: {},
        lineToBlock: {},
        diagnostics: [],
        blockCount: 0,
        variableNames: [],
        variableScopes: [],
      }),
      formatDispatchRouter: () => ({ autoImports: [], code: '' }),
      registerExtensionBlock: () => {},
      registerExtensionHat: () => {},
      compileSharedProcedure: () => ({
        ident: '',
        imports: [],
        cleanFnCode: '',
        debugFnCode: '',
      }),
      formatSharedModuleDocument: () => ({ source: '', debugSource: '' }),
    };

    backendRegistry.register(mockAdapter);
    try {
      expect(getSupportedLanguageIds()).toContain(dslLang);
      expect(isSupportedLanguageId('dsl')).toBe(true);
      expect(normalizeLanguageId('dsl')).toBe(dslLang);
      expect(getLanguageDialect(dslLang).exportToolchain?.label).toBe(
        'PolyDSL Compiler',
      );
      expect(getSupportedScriptAcceptAttr()).toBe('.lua,.py,.js,.dsl');
      expect(formatSupportedExtensionsLabel()).toBe('.lua / .py / .js / .dsl');
      expect(stripScriptExtension('sensor.DSL')).toBe('sensor');
      expect(formatInitialValueForLanguage({ kind: 'null' }, dslLang)).toBe('none');

      const highlighted = highlightCodeLine('rule v = trace(42) // ok', dslLang);
      expect(highlighted).toContain('<span class="syn-kw">rule</span>');
      expect(highlighted).toContain('<span class="syn-fn">trace</span>');
      expect(highlighted).toContain('<span class="syn-num">42</span>');
      expect(highlighted).toContain('<span class="syn-cmt">// ok</span>');

      // Newly registered language keywords are automatically reserved by variable validator
      const kwCheck = validateSharedVariableName('rule', []);
      expect(kwCheck.valid).toBe(false);

      // Error line parser delegates to dialect.extractErrorLine
      expect(extractErrorLine('SyntaxError at main.dsl:42:5', dslLang)).toBe(42);

      // Native script library scanner auto-detects `.dsl` & scans functions via dialect.libBinding
      const scanned = scanScriptLibraryFile(
        'sensor_drv.dsl',
        'pub fn readTemp(ch) { return ch * 2; }\npub fn reset() { }',
      );
      expect(scanned.language).toBe(dslLang);
      expect(scanned.moduleName).toBe('sensor_drv');
      expect(
        scanned.scannedFunctions.map(
          (f) => `${f.funcName}:${f.inferredKind}:${f.params.join(',')}`,
        ),
      ).toEqual(['readTemp:value:ch', 'reset:statement:']);

      // Module import extractor delegates to dialect.libBinding.extractImportedModuleName
      expect(
        extractImportedModuleNames({
          format: 'polyblock-extension',
          version: 1,
          id: 'mock-dsl-pack',
          name: 'Mock DSL Pack',
          packVersion: '1.0.0',
          iconLabel: 'DSL',
          color: '#ec4899',
          description: '',
          imports: {
            [dslLang]: ['use "sensor_drv"'],
          },
          sections: [],
        }),
      ).toEqual(['sensor_drv']);
    } finally {
      backendRegistry.unregister(dslLang);
    }

    // Cleanly reverted after unregister
    expect(isSupportedLanguageId('dsl')).toBe(false);
    expect(getSupportedScriptAcceptAttr()).toBe('.lua,.py,.js');
    expect(formatSupportedExtensionsLabel()).toBe('.lua / .py / .js');
  });

  it('implements Lua, Python, and JavaScript backends via BaseScriptBackend and unifies formatSharedVarRef', () => {
    expect(backendRegistry.get('lua')).toBeInstanceOf(BaseScriptBackend);
    expect(backendRegistry.get('python')).toBeInstanceOf(BaseScriptBackend);
    expect(backendRegistry.get('js')).toBeInstanceOf(BaseScriptBackend);

    const fakeGen = { getVariableName: (id: string) => `local_${id}` };
    try {
      resetCodegenPassContext({
        debugPass: false,
        compilingSharedModule: false,
        sharedModuleName: 'shared',
        sharedVarIdToAttr: new Map([['v1', 'counter']]),
        sharedVarIdents: new Set(['counter']),
      });
      expect(
        formatSharedVarRef('v1', fakeGen, undefined, { bareAttrInSharedModule: false }),
      ).toBe('shared.counter');
      expect(
        formatSharedVarRef('v2', fakeGen, undefined, { bareAttrInSharedModule: false }),
      ).toBe('local_v2');

      resetCodegenPassContext({
        debugPass: false,
        compilingSharedModule: true,
        sharedModuleName: 'shared',
        sharedVarIdToAttr: new Map([['v1', 'counter']]),
        sharedVarIdents: new Set(['counter']),
      });
      expect(
        formatSharedVarRef('v1', fakeGen, undefined, { bareAttrInSharedModule: false }),
      ).toBe('shared.counter');
      expect(
        formatSharedVarRef('v1', fakeGen, undefined, { bareAttrInSharedModule: true }),
      ).toBe('counter');
    } finally {
      resetCodegenPassContext({ debugPass: false });
    }
  });

  it('supports findForLanguage / hasRunnerForLanguage and graceful multi-handle fallback for export-only languages', async () => {
    const manager = new RunnerManager();
    expect(manager.hasRunnerForLanguage('lua')).toBe(true);
    expect(manager.hasRunnerForLanguage('python')).toBe(true);
    expect(manager.hasRunnerForLanguage('js')).toBe(true);
    expect(manager.findForLanguage('lua')?.id).toBe('browser-lua-wasmoon');
    expect(manager.findForLanguage('python')?.id).toBe('browser-python-micropython');
    expect(manager.findForLanguage('js')?.id).toBe('browser-js-worker');

    const exportOnlyLang = 'c' as ScriptLanguageId;
    expect(manager.findForLanguage(exportOnlyLang)).toBeNull();
    expect(manager.hasRunnerForLanguage(exportOnlyLang)).toBe(false);

    for (const slot of PLANNED_RUNNER_SLOTS) {
      expect(slot.supportedLanguages).toEqual(getSupportedLanguageIds());
    }

    // Verify MultiHandleRunnerOrchestrator returns a structured error instead of throwing
    expect(runnerManager.findForLanguage(exportOnlyLang)).toBeNull();
    const project = {
      ...instantiateProjectFromTemplate('blank_project'),
      language: exportOnlyLang,
    };
    const logs: Array<{ level: string; message: string }> = [];
    const statuses: string[] = [];
    const orchestrator = new MultiHandleRunnerOrchestrator();
    const results = await orchestrator.runAllHandles(
      {
        project,
        timeoutMs: 1000,
        stepDelayMs: 0,
        mockInputs: {},
      },
      {
        onHandleLog: (_hdl, level, message) => logs.push({ level, message }),
        onDeviceEvent: () => {},
        onHandleTelemetry: () => {},
        onStatusChange: (s) => statuses.push(s),
      },
    );

    expect(results).toHaveLength(1);
    expect(results[0].result.ok).toBe(false);
    expect(results[0].result.errorMessage).toContain('未注册浏览器沙箱 Runner');
    expect(logs.some((l) => l.level === 'error' && l.message.includes('仅支持代码导出'))).toBe(
      true,
    );
    expect(statuses).toContain('ready');
  });

  it('supports hot-registering and unregistering a unified LanguagePlugin with RunnerManager auto-sync', () => {
    const mockDialect: LanguageDialect = {
      id: 'mockdsl',
      displayName: 'MockDSL',
      shortLabel: 'DSL',
      compactLabel: 'DSL',
      accentGradient: 'linear-gradient(135deg, #14b8a6, #0d9488)',
      extension: 'dsl',
      commentToken: '//',
      lineCommentPrefix: '// ',
      notOp: '!',
      boolTrue: 'true',
      boolFalse: 'false',
      nullLiteral: 'null',
      listLiteral: '[]',
      dictLiteral: '{}',
      keywords: ['fn', 'dsl_only_kw'],
      libBinding: {
        formatImport: (m) => `use ${m}`,
        formatCall: (m, f, args) => `${m}.${f}(${args.join(', ')})`,
        scanFunctions: () => [],
        extractImportedModuleName: () => null,
      },
      extractErrorLine: () => undefined,
    };
    const mockBackend: ScriptBackendAdapter = {
      id: 'mockdsl',
      name: 'MockDSL',
      extension: 'dsl',
      fileName: 'main.dsl',
      version: '0.1',
      description: 'Test language plugin',
      accentColor: '#14b8a6',
      dialect: mockDialect,
      generate: () => ({
        language: 'mockdsl',
        code: '// mock',
        debugCode: '// mock',
        sourceMap: {},
        lineToBlock: {},
        breakpointableLines: [],
        diagnostics: [],
        blockCount: 0,
        variableNames: [],
      }),
      formatDispatchRouter: () => ({ autoImports: [], code: '' }),
      registerExtensionBlock: () => {},
      registerExtensionHat: () => {},
      compileSharedProcedure: () => ({
        ident: 'mock',
        imports: [],
        cleanFnCode: '',
        debugFnCode: '',
      }),
      formatSharedModuleDocument: () => ({ source: '// shared', debugSource: '// shared' }),
    };
    const mockRunner: ScriptRunner = {
      id: 'mock-dsl-runner',
      name: 'MockDSL Runner',
      shortLabel: 'MockDSL',
      kind: 'browser-wasm',
      availability: 'builtin',
      supportsDebugging: false,
      description: 'Test runner',
      supportedLanguages: ['mockdsl'],
      run: async () => ({ ok: true, durationMs: 0, finalVars: {} }),
      stop: () => {},
      dispose: () => {},
    };
    const plugin: LanguagePlugin = {
      id: 'mockdsl',
      dialect: mockDialect,
      createBackend: () => mockBackend,
      createRunner: () => mockRunner,
    };

    try {
      backendRegistry.registerPlugin(plugin);
      expect(backendRegistry.has('mockdsl')).toBe(true);
      expect(getSupportedLanguageIds()).toContain('mockdsl');
      expect(runnerManager.hasRunnerForLanguage('mockdsl')).toBe(true);
      expect(runnerManager.findForLanguage('mockdsl')?.id).toBe('mock-dsl-runner');
      // Dynamic keyword reservation from registered dialects (including JS & hot plugins)
      expect(validateSharedVariableName('const', []).valid).toBe(false);
      expect(validateSharedVariableName('dsl_only_kw', []).valid).toBe(false);
    } finally {
      backendRegistry.unregister('mockdsl');
    }

    expect(backendRegistry.has('mockdsl')).toBe(false);
    expect(runnerManager.hasRunnerForLanguage('mockdsl')).toBe(false);
  });

  it('fixes JS controls_for shared var double-prefix, floating poly_local_set duplicate let, Lua for-loop shadowing, and emits breakpointableLines across languages', () => {
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        variables: [{ name: 'i', id: 'var_shared_i' }],
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_start',
              id: 'b_start',
              inputs: {
                BODY: {
                  block: {
                    type: 'controls_for',
                    id: 'b_for',
                    fields: { VAR: { id: 'var_shared_i' } },
                    inputs: {
                      FROM: { shadow: { type: 'math_number', id: 'n1', fields: { NUM: 1 } } },
                      TO: { shadow: { type: 'math_number', id: 'n2', fields: { NUM: 3 } } },
                      BY: { shadow: { type: 'math_number', id: 'n3', fields: { NUM: 1 } } },
                      DO: {
                        block: {
                          type: 'poly_print',
                          id: 'b_print',
                          inputs: {
                            VALUE: {
                              block: {
                                type: 'variables_get',
                                id: 'b_get_i',
                                fields: { VAR: { id: 'var_shared_i' } },
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

    const ctx = { sharedVariables: ['i'] };
    const jsRes = backendRegistry.get('js').generate(ws, ctx);
    expect(jsRes.code).not.toContain('shared.shared.');
    expect(jsRes.code).toContain('shared.i');
    expect(() => new Function(jsRes.code)).not.toThrow();
    expect(jsRes.breakpointableLines && jsRes.breakpointableLines.length).toBeGreaterThan(0);

    const luaRes = backendRegistry.get('lua').generate(ws, ctx);
    expect(luaRes.code).toContain('for i = 1, 3, 1 do');
    expect(luaRes.code).toContain('print(i)');
    expect(luaRes.code).not.toContain('print(shared.i)');
    expect(luaRes.breakpointableLines && luaRes.breakpointableLines.length).toBeGreaterThan(0);

    const pyRes = backendRegistry.get('python').generate(ws, ctx);
    expect(pyRes.breakpointableLines && pyRes.breakpointableLines.length).toBeGreaterThan(0);
    ws.dispose();

    // Floating poly_local_set twice outside any hat must emit `let` only once in JS
    const floatWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_local_set',
              id: 'fl_1',
              fields: { NAME: 'tmp' },
              inputs: { VALUE: { shadow: { type: 'math_number', id: 'fn1', fields: { NUM: 1 } } } },
              next: {
                block: {
                  type: 'poly_local_set',
                  id: 'fl_2',
                  fields: { NAME: 'tmp' },
                  inputs: { VALUE: { shadow: { type: 'math_number', id: 'fn2', fields: { NUM: 2 } } } },
                },
              },
            },
          ],
        },
      },
      floatWs,
    );
    const floatJs = backendRegistry.get('js').generate(floatWs);
    expect((floatJs.code.match(/\blet tmp\b/g) ?? []).length).toBe(1);
    expect(() => new Function(floatJs.code)).not.toThrow();
    floatWs.dispose();
  });

  it('propagates transitive usesSleep across shared functions defined in separate scripts of the same handle', () => {
    const project = instantiateProjectFromTemplate('blank_project');
    const handle = project.handles[0];
    handle.sharedFunctions = ['fnA', 'fnB'];
    handle.scripts = [
      {
        id: 'scr_a',
        name: 'main',
        breakpoints: [],
        updatedAt: '2026-01-01T00:00:00.000Z',
        workspace: {
          blocks: {
            languageVersion: 0,
            blocks: [
              {
                type: 'procedures_defnoreturn',
                id: 'def_a',
                fields: { NAME: 'fnA' },
                inputs: {
                  STACK: {
                    block: {
                      type: 'poly_wait_ms',
                      id: 'wait_a',
                      inputs: {
                        MS: { shadow: { type: 'math_number', id: 'ms_a', fields: { NUM: 50 } } },
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      },
      {
        id: 'scr_b',
        name: 'helper',
        breakpoints: [],
        updatedAt: '2026-01-01T00:00:00.000Z',
        workspace: {
          blocks: {
            languageVersion: 0,
            blocks: [
              {
                type: 'procedures_defnoreturn',
                id: 'def_b',
                fields: { NAME: 'fnB' },
                inputs: {
                  STACK: {
                    block: {
                      type: 'poly_call_shared_noreturn',
                      id: 'call_a',
                      extraState: { fnName: 'fnA', params: [] },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    ];

    const metas = buildHandleScriptsMeta(handle);
    const fnAMeta = metas[0].declaredFunctions?.find((f) => f.name === 'fnA');
    const fnBMeta = metas[1].declaredFunctions?.find((f) => f.name === 'fnB');
    expect(fnAMeta?.usesSleep).toBe(true);
    expect(fnBMeta?.calledProcedures).toContain('fnA');
    expect(fnBMeta?.usesSleep).toBe(true);
  });

  it('allows for-loops inside shared functions with strict-mode let in shared.js, escapes Lua poly_str_replace patterns, and maps controls_flow_statements cleanly', () => {
    // 1. Shared function containing poly_for_range must produce 0 false-positive diagnostics and valid strict-mode JS
    const sharedLoopWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        variables: [{ name: 'k', id: 'var_k' }],
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'procedures_defnoreturn',
              id: 'def_sum',
              fields: { NAME: 'sum_loop' },
              inputs: {
                STACK: {
                  block: {
                    type: 'poly_for_range',
                    id: 'loop_k',
                    fields: { VAR: { id: 'var_k' } },
                    inputs: {
                      FROM: { shadow: { type: 'math_number', id: 'f1', fields: { NUM: 1 } } },
                      TO: { shadow: { type: 'math_number', id: 't1', fields: { NUM: 3 } } },
                      BY: { shadow: { type: 'math_number', id: 'b1', fields: { NUM: 1 } } },
                      DO: {
                        block: {
                          type: 'poly_print',
                          id: 'pr_k',
                          inputs: {
                            VALUE: {
                              block: {
                                type: 'variables_get',
                                id: 'get_k',
                                fields: { VAR: { id: 'var_k' } },
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
      sharedLoopWs,
    );
    const diagRes = backendRegistry.get('js').generate(sharedLoopWs, {
      sharedFunctions: ['sum_loop'],
      handleScripts: [
        {
          id: 's1',
          name: 'main',
          isEntry: true,
          declaredEvents: [],
          requiredScripts: [],
          hasExternalKeepAliveHat: false,
        },
      ],
      currentScriptId: 's1',
    });
    expect(
      diagRes.diagnostics.filter((d) => d.id.startsWith('shared-fn-private-var')),
    ).toHaveLength(0);
    const compiledSharedFn = backendRegistry.get('js').compileSharedProcedure({
      name: 'sum_loop',
      params: [],
      hasReturn: false,
      usesSleep: false,
      blockJson: (Blockly.serialization.workspaces.save(sharedLoopWs) as {
        blocks: { blocks: Array<Record<string, unknown>> };
      }).blocks.blocks[0],
      scriptVariables: [{ id: 'var_k', name: 'k' }],
      moduleName: 'shared',
      sharedAttrByName: new Map(),
      allAsyncSharedFnNames: new Set(),
    });
    expect(compiledSharedFn.cleanFnCode).toContain('for (let k =');
    expect(
      () => new Function(`"use strict";\n${compiledSharedFn.cleanFnCode}`),
    ).not.toThrow();
    sharedLoopWs.dispose();

    // 2. Lua poly_str_replace escapes pattern metacharacters & % safely + controls_flow_statements maps sourceMap cleanly
    const flowWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_start',
              id: 's_flow',
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_print',
                    id: 'p_rep',
                    inputs: {
                      VALUE: {
                        block: {
                          type: 'poly_str_replace',
                          id: 'rep_1',
                          inputs: {
                            SRC: { shadow: { type: 'text', id: 'tx1', fields: { TEXT: 'a-b 50%' } } },
                            OLD: { shadow: { type: 'text', id: 'tx2', fields: { TEXT: 'a-b' } } },
                            NEW: { shadow: { type: 'text', id: 'tx3', fields: { TEXT: '100%' } } },
                          },
                        },
                      },
                    },
                    next: {
                      block: {
                        type: 'poly_repeat_times',
                        id: 'rep_loop',
                        inputs: {
                          TIMES: { shadow: { type: 'math_number', id: 'rn1', fields: { NUM: 3 } } },
                          DO: {
                            block: {
                              type: 'controls_flow_statements',
                              id: 'brk_1',
                              fields: { FLOW: 'BREAK' },
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
      flowWs,
    );
    const luaFlow = backendRegistry.get('lua').generate(flowWs);
    expect(luaFlow.code).toContain('([%(%)%.%%%+%-%*%?%[%]%^%$])');
    expect(luaFlow.sourceMap['brk_1']).toBeDefined();
    expect(luaFlow.breakpointableLines).toContain(luaFlow.sourceMap['brk_1'].startLine);
    const pyFlow = backendRegistry.get('python').generate(flowWs);
    expect(pyFlow.sourceMap['brk_1']).toBeDefined();
    expect(pyFlow.breakpointableLines).toContain(pyFlow.sourceMap['brk_1'].startLine);
    const jsFlow = backendRegistry.get('js').generate(flowWs);
    expect(jsFlow.sourceMap['brk_1']).toBeDefined();
    expect(jsFlow.breakpointableLines).toContain(jsFlow.sourceMap['brk_1'].startLine);
    flowWs.dispose();
  });

  it('enforces cross-language scope guarantees: C1 shared fn ident stability, C2 loop-local counter isolation, C3 Lua mutual recursion, C5 mixed Chinese disambiguation, and Lua text_join safety', () => {
    // C5: Mixed non-ASCII + ASCII local names never silently alias
    expect(sanitizeLocalIdent('温度1')).not.toBe(sanitizeLocalIdent('湿度1'));
    expect(sanitizeLocalIdent('tmp')).toBe('tmp');

    // C1: Caller with variable `step` calling shared `step()` still emits `shared.step()` (never `shared.step2()`) across Lua/Python/JS
    const callerWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        variables: [{ name: 'step', id: 'var_step' }],
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_start',
              id: 'c1_start',
              inputs: {
                BODY: {
                  block: {
                    type: 'variables_set',
                    id: 'c1_set',
                    fields: { VAR: { id: 'var_step' } },
                    inputs: { VALUE: { shadow: { type: 'math_number', id: 'c1_n', fields: { NUM: 1 } } } },
                    next: {
                      block: {
                        type: 'poly_call_shared_noreturn',
                        id: 'c1_call',
                        extraState: { scriptName: 'utils', fnName: 'step', params: [] },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      },
      callerWs,
    );
    const c1Ctx = { sharedFunctions: ['step'] };
    expect(backendRegistry.get('lua').generate(callerWs, c1Ctx).code).toContain('shared.step()');
    expect(backendRegistry.get('python').generate(callerWs, c1Ctx).code).toContain('shared.step()');
    expect(backendRegistry.get('js').generate(callerWs, c1Ctx).code).toContain('shared.step()');
    callerWs.dispose();

    // C2: Pure loop-only counter `i` stays function/block-local in Python & JS (no top-level `i = None`/`let i` or `global i`)
    const loopWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        variables: [{ name: 'i', id: 'var_loop_i' }],
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'poly_on_start',
              id: 'c2_start',
              inputs: {
                BODY: {
                  block: {
                    type: 'poly_for_range',
                    id: 'c2_for',
                    fields: { VAR: { id: 'var_loop_i' } },
                    inputs: {
                      FROM: { shadow: { type: 'math_number', id: 'c2_f', fields: { NUM: 1 } } },
                      TO: { shadow: { type: 'math_number', id: 'c2_t', fields: { NUM: 3 } } },
                      BY: { shadow: { type: 'math_number', id: 'c2_b', fields: { NUM: 1 } } },
                      DO: {
                        block: {
                          type: 'poly_print',
                          id: 'c2_p',
                          inputs: {
                            VALUE: {
                              block: {
                                type: 'variables_get',
                                id: 'c2_g',
                                fields: { VAR: { id: 'var_loop_i' } },
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
      loopWs,
    );
    const pyLoop = backendRegistry.get('python').generate(loopWs);
    expect(pyLoop.code).not.toMatch(/^i = /m);
    expect(pyLoop.code).not.toContain('global i');
    const jsLoop = backendRegistry.get('js').generate(loopWs);
    expect(jsLoop.code).not.toMatch(/^let i = /m);
    expect(jsLoop.code).toContain('for (let i = 1; i <= 3; i++)');
    loopWs.dispose();

    // C3: Lua 5.4 hoists `local fn_a, fn_b` when 2+ private functions exist (supports forward calls & mutual recursion)
    // + Lua `text_join` wraps boolean operand with `tostring(...)`
    const recWs = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(
      {
        blocks: {
          languageVersion: 0,
          blocks: [
            {
              type: 'procedures_defnoreturn',
              id: 'rec_a',
              x: 10,
              y: 10,
              fields: { NAME: 'fn_a' },
              inputs: {
                STACK: {
                  block: {
                    type: 'procedures_callnoreturn',
                    id: 'call_b',
                    extraState: { name: 'fn_b' },
                  },
                },
              },
            },
            {
              type: 'procedures_defnoreturn',
              id: 'rec_b',
              x: 10,
              y: 150,
              fields: { NAME: 'fn_b' },
              inputs: {
                STACK: {
                  block: {
                    type: 'poly_print',
                    id: 'pr_join',
                    inputs: {
                      VALUE: {
                        block: {
                          type: 'text_join',
                          id: 'tj_1',
                          extraState: { itemCount: 2 },
                          inputs: {
                            ADD0: { shadow: { type: 'text', id: 'tj_s', fields: { TEXT: 'ok=' } } },
                            ADD1: { block: { type: 'logic_boolean', id: 'tj_b', fields: { BOOL: 'TRUE' } } },
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
      recWs,
    );
    const luaRec = backendRegistry.get('lua').generate(recWs);
    expect(luaRec.code).toContain('local fn_a, fn_b');
    expect(luaRec.code).toContain('tostring(true)');
    recWs.dispose();
  });

  it('routes worker control messages, pack-scoped sim state, and DONE/ERROR lifecycle in WorkerProtocolHost', async () => {
    const posted: Array<Record<string, unknown>> = [];
    const host = new WorkerProtocolHost((payload) => posted.push(payload));

    await host.handleMessage(
      {
        type: 'RUN',
        runId: 'run-1',
        code: '',
        wasmUrl: 'mock.wasm',
        breakpoints: [],
        stepDelayMs: 0,
        mockInputs: { 'pack-a::temp': 26 },
      },
      async (ctx) => {
        expect(ctx.getScopedState('pack-a', 'temp')).toBe(26);
        ctx.emitScopedState('pack-a', 'oled:append', 'Line 1');
        ctx.emitScopedState('pack-a', 'oled:append', 'Line 2');
        expect(ctx.getScopedState('pack-a', 'oled')).toEqual(['Line 1', 'Line 2']);
        ctx.emitScopedState('pack-a', 'oled:clear', true);
        expect(ctx.getScopedState('pack-a', 'oled')).toEqual([]);
        ctx.emitScopedState('pack-a', 'global:vbus', 24);
        expect(ctx.getScopedState('pack-b', 'global:vbus')).toBe(24);
        ctx.emitCustomEvent('on_button', ['A', true]);
        ctx.session.setFinalVars(JSON.stringify({ x: '42' }));
      },
    );

    expect(host.getActiveSession()).toBeNull();
    expect(host.getActiveScheduler()).toBeNull();
    expect(posted.some((m) => m.type === 'CUSTOM_EVENT' && m.eventName === 'on_button')).toBe(
      true,
    );
    expect(
      posted.some(
        (m) =>
          m.type === 'DONE' &&
          m.runId === 'run-1' &&
          (m.vars as Record<string, string>)?.x === '42',
      ),
    ).toBe(true);

    posted.length = 0;
    await host.handleMessage(
      {
        type: 'RUN',
        runId: 'run-2',
        code: '',
        wasmUrl: 'mock.wasm',
        breakpoints: [],
        stepDelayMs: 0,
      },
      async () => {
        throw new Error('boom');
      },
    );
    expect(
      posted.some((m) => m.type === 'ERROR' && m.runId === 'run-2' && m.message === 'boom'),
    ).toBe(true);
  });
});
