import * as Blockly from 'blockly';
import { beforeAll, describe, expect, it } from 'vitest';
import { backendRegistry } from '../backends/registry';
import { BaseScriptBackend } from '../backends/baseBackend';
import {
  formatSharedVarRef,
  resetCodegenPassContext,
} from '../backends/codegenContext';
import {
  formatSupportedExtensionsLabel,
  getSupportedScriptAcceptAttr,
  LANGUAGE_DIALECTS,
  stripScriptExtension,
  SUPPORTED_LANGUAGE_IDS,
} from '../backends/types';
import { registerPolyBlocks } from '../blocks/definitions';
import { getDemoProjectById } from '../projects/builtinDemos';
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

  it('generates valid Lua & Python for list primitives (zero hidden helper functions) and random alarm templates', () => {
    for (const workspace of [
      STARTER_STEP_DEBUG_WORKSPACE,
      STARTER_THRESHOLD_ALARM_WORKSPACE,
      LIST_STATS_WORKSPACE,
    ]) {
      const ws = createLoadedWorkspace(workspace);
      const luaRes = backendRegistry.get('lua').generate(ws);
      const pyRes = backendRegistry.get('python').generate(ws);

      expect(luaRes.code).not.toContain('__PB_S:');
      expect(pyRes.code).not.toContain('__PB_S:');
      expect(luaRes.blockCount).toBeGreaterThan(3);
      expect(pyRes.blockCount).toBe(luaRes.blockCount);
      ws.dispose();
    }

    const listWs = createLoadedWorkspace(LIST_STATS_WORKSPACE);
    const listLua = backendRegistry.get('lua').generate(listWs).code;
    const listPy = backendRegistry.get('python').generate(listWs).code;
    expect(listLua).toContain('table.insert(items, 40)');
    expect(listPy).toContain('items.append(40)');
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
    expect(opsLua).toContain('arr[1] = 99');
    expect(opsLua).toContain('print(arr[1])');
    expect(opsLua).toContain('table.remove(arr, 2)');
    expect(opsLua).not.toContain('first_index');
    expect(opsPy).toContain('arr[0] = 99');
    expect(opsPy).toContain('print(arr[0])');
    expect(opsPy).toContain('arr.pop(1)');
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

  it('extracts line numbers from Lua and Python error messages', () => {
    expect(
      extractErrorLine('[string "main"]:8: attempt to index nil value', 'lua'),
    ).toBe(8);
    expect(
      extractErrorLine(
        'Traceback (most recent call last):\n  File "<string>", line 12, in <module>\nZeroDivisionError',
        'python',
      ),
    ).toBe(12);
  });

  it('safely escapes HTML and highlights Lua/Python keywords', () => {
    const html = highlightCodeLine('if x < 10 then -- <tag>', 'lua');
    expect(html).toContain('<span class="syn-kw">if</span>');
    expect(html).toContain('&lt; <span class="syn-num">10</span>');
    expect(html).toContain('<span class="syn-cmt">-- &lt;tag&gt;</span>');
  });
});

describe('Language dialects, BaseScriptBackend, Runner fallback & WorkerProtocolHost', () => {
  it('exposes accentGradient and dynamic script extension helpers from LANGUAGE_DIALECTS', () => {
    for (const lang of SUPPORTED_LANGUAGE_IDS) {
      expect(LANGUAGE_DIALECTS[lang].accentGradient).toMatch(/^linear-gradient\(/);
    }
    expect(getSupportedScriptAcceptAttr()).toBe('.lua,.py');
    expect(formatSupportedExtensionsLabel()).toBe('.lua / .py');
    expect(stripScriptExtension('main.lua')).toBe('main');
    expect(stripScriptExtension('helpers.PY')).toBe('helpers');
    expect(stripScriptExtension('utils.crc16.lua')).toBe('utils.crc16');
    expect(stripScriptExtension('readme.md')).toBe('readme.md');
  });

  it('implements Lua and Python backends via BaseScriptBackend and unifies formatSharedVarRef', () => {
    expect(backendRegistry.get('lua')).toBeInstanceOf(BaseScriptBackend);
    expect(backendRegistry.get('python')).toBeInstanceOf(BaseScriptBackend);

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
    expect(manager.findForLanguage('lua')?.id).toBe('browser-lua-wasmoon');
    expect(manager.findForLanguage('python')?.id).toBe('browser-python-micropython');

    const exportOnlyLang = 'c' as ScriptLanguageId;
    expect(manager.findForLanguage(exportOnlyLang)).toBeNull();
    expect(manager.hasRunnerForLanguage(exportOnlyLang)).toBe(false);
    expect(() => manager.getForLanguage(exportOnlyLang)).toThrow(
      /No runner registered for language/,
    );

    for (const slot of PLANNED_RUNNER_SLOTS) {
      expect(slot.supportedLanguages).toEqual([...SUPPORTED_LANGUAGE_IDS]);
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

    expect(orchestrator.isRunning()).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0].result.ok).toBe(false);
    expect(results[0].result.errorMessage).toContain('未注册浏览器沙箱 Runner');
    expect(logs.some((l) => l.level === 'error' && l.message.includes('仅支持代码导出'))).toBe(
      true,
    );
    expect(statuses).toContain('ready');
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
