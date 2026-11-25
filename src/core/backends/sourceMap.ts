import type * as Blockly from 'blockly';
import type { DiagnosticItem, SourceLineRange } from '../../types/project';
import { getActiveTimerConfig } from '../blocks/timerConfigBridge';
import {
  ALL_VALID_TOP_HAT_TYPES,
  TIMER_ID_BLOCK_TYPES,
} from './eventMode';

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
      const ownerId = openStack[openStack.length - 1];
      lineToBlock[lineNum] = ownerId;
      const existing = sourceMap[ownerId];
      if (!existing) {
        sourceMap[ownerId] = { startLine: lineNum, endLine: lineNum };
      } else {
        existing.endLine = Math.max(existing.endLine, lineNum);
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
 * Collects lightweight static diagnostics directly from the Blockly workspace,
 * including Phase 5 duplicate event-hat and out-of-range timer channel checks.
 */
export function analyzeWorkspaceDiagnostics(
  workspace: Blockly.Workspace,
): DiagnosticItem[] {
  const diagnostics: DiagnosticItem[] = [];
  const topBlocks = workspace.getTopBlocks(true);

  if (topBlocks.length === 0) {
    return diagnostics;
  }

  const checkSingletonHat = (type: string, label: string) => {
    const matching = topBlocks.filter(
      (b) => b.type === type && !b.isShadow() && b.isEnabled(),
    );
    if (matching.length > 1) {
      for (let i = 1; i < matching.length; i++) {
        diagnostics.push({
          id: `multi-${type}-${matching[i].id}`,
          severity: 'warning',
          message: `检测到多个“${label}”入口块，建议合并为一个入口以保证执行顺序明确。`,
          blockId: matching[i].id,
        });
      }
    }
    return matching;
  };

  const startBlocks = checkSingletonHat('poly_on_start', '当程序启动');
  checkSingletonHat('poly_on_run', '当周期运行 on_run');
  checkSingletonHat('poly_on_stop', '当程序停止 on_stop');

  // Check duplicate timer ID hats
  const seenTimerHats = new Set<number>();
  for (const blk of topBlocks) {
    if (blk.type !== 'poly_on_timer' || blk.isShadow() || !blk.isEnabled()) continue;
    const tid = Math.trunc(Number(blk.getFieldValue('TIMER_ID') ?? 0));
    if (seenTimerHats.has(tid)) {
      diagnostics.push({
        id: `dup-timer-hat-${tid}-${blk.id}`,
        severity: 'warning',
        message: `定时器通道 T${tid} 绑定了多个“当定时器触发”回调块，建议合并为一个。`,
        blockId: blk.id,
      });
    } else {
      seenTimerHats.add(tid);
    }
  }

  // Check duplicate button (KEY, EDGE) hats
  const seenButtonHats = new Set<string>();
  for (const blk of topBlocks) {
    if (blk.type !== 'poly_on_button' || blk.isShadow() || !blk.isEnabled()) continue;
    const key = String(blk.getFieldValue('KEY') || 'A');
    const edge = String(blk.getFieldValue('EDGE') || 'press');
    const sig = `${key}:${edge}`;
    if (seenButtonHats.has(sig)) {
      diagnostics.push({
        id: `dup-btn-hat-${sig}-${blk.id}`,
        severity: 'warning',
        message: `按键 ${key}（${edge === 'press' ? '按下' : '释放'}）绑定了多个回调块，建议合并。`,
        blockId: blk.id,
      });
    } else {
      seenButtonHats.add(sig);
    }
  }

  for (const block of topBlocks) {
    if (
      !ALL_VALID_TOP_HAT_TYPES.has(block.type) &&
      !block.isShadow() &&
      block.isEnabled()
    ) {
      diagnostics.push({
        id: `floating-${block.id}`,
        severity: 'warning',
        message: '存在未挂载到事件回调或函数内的独立积木块（仍会按顶层脚本顺序生成）。',
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

  // Check out-of-range timer channel IDs across ALL blocks in workspace
  const timerCfg = getActiveTimerConfig();
  for (const blk of workspace.getAllBlocks(false)) {
    if (blk.isShadow() || !blk.isEnabled()) continue;
    if (!TIMER_ID_BLOCK_TYPES.has(blk.type)) continue;
    const tid = Math.trunc(Number(blk.getFieldValue('TIMER_ID') ?? 0));
    if (!Number.isInteger(tid) || tid < 0 || tid >= timerCfg.count) {
      diagnostics.push({
        id: `timer-oob-${tid}-${blk.id}`,
        severity: 'error',
        message: `定时器通道 T${tid} 超出当前项目配置范围（0~${timerCfg.count - 1}），请更换通道或在项目管理中调大定时器通道数。`,
        blockId: blk.id,
      });
    }
  }

  return diagnostics;
}
