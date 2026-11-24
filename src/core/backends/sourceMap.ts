import type * as Blockly from 'blockly';
import type { DiagnosticItem, SourceLineRange } from '../../types/project';

export const SENTINEL_START_PREFIX = '__PB_S:';
export const SENTINEL_END_PREFIX = '__PB_E:';

const START_RE = /^__PB_S:['"]?([^'"]+)['"]?__$/;
const END_RE = /^__PB_E:['"]?([^'"]+)['"]?__$/;

export interface StrippedCodeResult {
  code: string;
  sourceMap: Record<string, SourceLineRange>;
  lineToBlock: Record<number, string>;
}

/**
 * Strips internal block-boundary sentinel lines produced during codegen,
 * returning clean runnable code plus exact 1-based line ranges per blockId.
 */
export function extractSourceMap(rawCode: string): StrippedCodeResult {
  const rawLines = rawCode.replace(/\r\n/g, '\n').split('\n');
  const cleanLines: string[] = [];
  const openStack: string[] = [];
  const sourceMap: Record<string, SourceLineRange> = {};
  const lineToBlock: Record<number, string> = {};

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();

    const startMatch = START_RE.exec(trimmed);
    if (startMatch) {
      openStack.push(startMatch[1]);
      continue;
    }

    const endMatch = END_RE.exec(trimmed);
    if (endMatch) {
      const targetId = endMatch[1];
      const idx = openStack.lastIndexOf(targetId);
      if (idx !== -1) {
        openStack.splice(idx, 1);
      }
      continue;
    }

    cleanLines.push(rawLine);
    const lineNum = cleanLines.length;

    if (trimmed.length > 0 && openStack.length > 0) {
      lineToBlock[lineNum] = openStack[openStack.length - 1];
      for (const blockId of openStack) {
        const existing = sourceMap[blockId];
        if (!existing) {
          sourceMap[blockId] = { startLine: lineNum, endLine: lineNum };
        } else {
          existing.endLine = Math.max(existing.endLine, lineNum);
        }
      }
    }
  }

  // Remove trailing blank lines while keeping single trailing newline clean
  while (cleanLines.length > 0 && cleanLines[cleanLines.length - 1].trim() === '') {
    cleanLines.pop();
  }

  return {
    code: cleanLines.join('\n'),
    sourceMap,
    lineToBlock,
  };
}

/**
 * Collects lightweight static diagnostics directly from the Blockly workspace.
 */
export function analyzeWorkspaceDiagnostics(
  workspace: Blockly.Workspace,
): DiagnosticItem[] {
  const diagnostics: DiagnosticItem[] = [];
  const topBlocks = workspace.getTopBlocks(true);

  if (topBlocks.length === 0) {
    return diagnostics;
  }

  const startBlocks = topBlocks.filter((b) => b.type === 'poly_on_start');
  if (startBlocks.length > 1) {
    for (let i = 1; i < startBlocks.length; i++) {
      diagnostics.push({
        id: `multi-start-${startBlocks[i].id}`,
        severity: 'warning',
        message: '检测到多个“当程序启动”入口块，建议合并为一个入口以保证执行顺序明确。',
        blockId: startBlocks[i].id,
      });
    }
  }

  for (const block of topBlocks) {
    if (
      block.type !== 'poly_on_start' &&
      block.type !== 'procedures_defnoreturn' &&
      block.type !== 'procedures_defreturn' &&
      !block.isShadow() &&
      block.isEnabled()
    ) {
      diagnostics.push({
        id: `floating-${block.id}`,
        severity: 'warning',
        message: '存在未挂载到“当程序启动”或函数内的独立积木块（仍会按顶层脚本顺序生成）。',
        blockId: block.id,
      });
    }
  }

  for (const startBlk of startBlocks) {
    const body = startBlk.getInputTargetBlock('BODY');
    if (!body) {
      diagnostics.push({
        id: `empty-start-${startBlk.id}`,
        severity: 'warning',
        message: '“当程序启动”内部为空，请拖入打印或控制积木后再运行。',
        blockId: startBlk.id,
      });
    }
  }

  return diagnostics;
}
