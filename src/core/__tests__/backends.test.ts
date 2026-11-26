import * as Blockly from 'blockly';
import { beforeAll, describe, expect, it } from 'vitest';
import { backendRegistry } from '../backends/registry';
import { registerPolyBlocks } from '../blocks/definitions';
import { PROJECT_TEMPLATES } from '../blocks/templates';
import { highlightCodeLine } from '../highlight';
import { extractErrorLine, parseStdoutLine } from '../runners/logParser';
import { WorkerDebugSession } from '../../workers/debugSession';

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
    const ws = createLoadedWorkspace(PROJECT_TEMPLATES[0].workspace);
    const lua = backendRegistry.get('lua');
    const res = lua.generate(ws);

    expect(res.code).not.toContain('__PB_S:');
    expect(res.code).not.toContain('__PB_E:');
    expect(res.code).toContain('Target: Lua 5.4');
    expect(res.code).toContain('function on_start()');
    expect(res.debugCode).toContain('if type(on_start) == "function" then');
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
    const ws = createLoadedWorkspace(PROJECT_TEMPLATES[0].workspace);
    const py = backendRegistry.get('python');
    const res = py.generate(ws);

    expect(res.code).not.toContain('__PB_S:');
    expect(res.code).not.toContain('__PB_E:');
    expect(res.code).not.toContain('from numbers import Number');
    expect(res.code).toContain('isinstance(total, (int, float))');
    expect(res.code).toContain('Target: Python 3');
    expect(res.code).toContain('def on_start():');
    expect(res.debugCode).toContain('await on_start()');
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

  it('generates valid Lua & Python for list append and random alarm templates', () => {
    for (const tpl of PROJECT_TEMPLATES.slice(1)) {
      const ws = createLoadedWorkspace(tpl.workspace);
      const luaRes = backendRegistry.get('lua').generate(ws);
      const pyRes = backendRegistry.get('python').generate(ws);

      expect(luaRes.code).not.toContain('__PB_S:');
      expect(pyRes.code).not.toContain('__PB_S:');
      expect(luaRes.blockCount).toBeGreaterThan(3);
      expect(pyRes.blockCount).toBe(luaRes.blockCount);
      ws.dispose();
    }

    const listWs = createLoadedWorkspace(PROJECT_TEMPLATES[3].workspace);
    expect(backendRegistry.get('lua').generate(listWs).code).toContain(
      'table.insert(items, 40)',
    );
    expect(backendRegistry.get('python').generate(listWs).code).toContain(
      'items.append(40)',
    );
    listWs.dispose();
  });

  it('generates clean delay code and separate async debugCode for step_debug_demo', () => {
    const stepTpl = PROJECT_TEMPLATES.find((t) => t.id === 'step_debug_demo')!;
    const ws = createLoadedWorkspace(stepTpl.workspace);

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
    expect(pyRes.code).toContain('sleep_ms(350)');
    expect(pyRes.code).not.toContain('import time');
    expect(pyRes.code).not.toContain('time.sleep');
    expect(pyRes.code).not.toContain('_poly.step');
    expect(pyRes.code).not.toContain('_poly.sleep');
    expect(pyRes.debugCode).toContain('await _poly_tick(');
    expect(pyRes.debugCode).toContain('await _poly_sleep_ms(350)');
    expect(pyRes.debugCode).toContain('["sum","sum2"]');
    expect(pyRes.variableNames).toContain('sum');

    ws.dispose();

    // poly_clear_log emits a clean comment for hardware export, keeping sentinel ONLY in sandbox debugCode
    const clearWs = createLoadedWorkspace({
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: 'poly_on_start',
            id: 'clr_s',
            inputs: {
              BODY: { block: { type: 'poly_clear_log', id: 'clr_b' } },
            },
          },
        ],
      },
    });
    const clearLua = backendRegistry.get('lua').generate(clearWs);
    expect(clearLua.code).not.toContain('__POLYBLOCK_CLEAR__');
    expect(clearLua.code).toContain('-- 清空控制台');
    expect(clearLua.debugCode).toContain('print("__POLYBLOCK_CLEAR__")');
    const clearPy = backendRegistry.get('python').generate(clearWs);
    expect(clearPy.code).not.toContain('__POLYBLOCK_CLEAR__');
    expect(clearPy.code).toContain('# 清空控制台');
    expect(clearPy.debugCode).toContain('print("__POLYBLOCK_CLEAR__")');
    clearWs.dispose();
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
  it('parses leveled log tags and clear sentinel accurately', () => {
    expect(parseStdoutLine('__POLYBLOCK_CLEAR__').isClear).toBe(true);
    expect(parseStdoutLine('[INFO] hello')).toEqual({
      isClear: false,
      level: 'info',
      message: 'hello',
    });
    expect(parseStdoutLine('[WARN] over 70')).toEqual({
      isClear: false,
      level: 'warn',
      message: 'over 70',
    });
    expect(parseStdoutLine('plain output')).toEqual({
      isClear: false,
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
