import type * as Blockly from 'blockly';
import type { DiagnosticItem, SourceLineRange } from '../../types/project';
import {
  getActiveChannelPoolConfig,
  getActiveHandleScriptId,
  getActiveHandleScripts,
  getActiveProjectCapabilities,
} from '../blocks/timerConfigBridge';
import { hasCapability } from '../capabilities/registry';
import { extensionRegistry } from '../extensions/registry';
import { isValidTopHatType } from './eventMode';

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
 * Collects unified static diagnostics directly from the Blockly workspace:
 * - Duplicate singleton hats (core `poly_on_start` + any declarative singleton hat)
 * - Duplicate dispatch hat branches (timers, buttons, or any custom `.polyext.json` dispatch hat)
 * - Floating blocks, empty `on_start`
 * - Disabled / removed extension & runtime pack blocks
 * - Out-of-range channel pool IDs for any pack declaring `handleChannelPool`
 */
export function analyzeWorkspaceDiagnostics(
  workspace: Blockly.Workspace,
): DiagnosticItem[] {
  const diagnostics: DiagnosticItem[] = [];
  const topBlocks = workspace.getTopBlocks(true);

  if (topBlocks.length === 0) {
    return diagnostics;
  }

  const enabledTopBlocks = topBlocks.filter((b) => !b.isShadow() && b.isEnabled());

  // 1. Check duplicate `poly_on_start` + any declarative singleton hat
  const seenSingletons = new Map<string, number>();
  const startBlocks: Blockly.Block[] = [];
  for (const blk of enabledTopBlocks) {
    if (blk.type === 'poly_on_start') {
      startBlocks.push(blk);
      const count = (seenSingletons.get(blk.type) ?? 0) + 1;
      seenSingletons.set(blk.type, count);
      if (count > 1) {
        diagnostics.push({
          id: `multi-poly_on_start-${blk.id}`,
          severity: 'warning',
          message: '检测到多个“当程序启动”入口块，建议合并为一个入口以保证执行顺序明确。',
          blockId: blk.id,
        });
      }
      continue;
    }

    const hatDef = extensionRegistry.getHatBlockDef(blk.type);
    if (hatDef && hatDef.hat.mode === 'singleton') {
      const count = (seenSingletons.get(blk.type) ?? 0) + 1;
      seenSingletons.set(blk.type, count);
      if (count > 1) {
        diagnostics.push({
          id: `multi-${blk.type}-${blk.id}`,
          severity: 'warning',
          message: `检测到多个“${hatDef.hat.eventName}”回调块，建议合并为一个以保证执行顺序明确。`,
          blockId: blk.id,
        });
      }
    }
  }

  // 2. Check duplicate dispatch hat branches generically across ALL declarative dispatch hats
  const seenDispatchByType = new Map<string, Set<string>>();
  for (const blk of enabledTopBlocks) {
    const hatDef = extensionRegistry.getHatBlockDef(blk.type);
    if (!hatDef || hatDef.hat.mode !== 'dispatch') continue;
    const dupKey = extensionRegistry.renderHatDuplicateKey(blk);
    if (dupKey === null) continue;

    let seen = seenDispatchByType.get(blk.type);
    if (!seen) {
      seen = new Set<string>();
      seenDispatchByType.set(blk.type, seen);
    }
    if (seen.has(dupKey)) {
      const isTimer = blk.type === 'poly_on_timer';
      diagnostics.push({
        id: isTimer
          ? `dup-timer-hat-${dupKey}-${blk.id}`
          : `dup-hat-${blk.type}-${dupKey}-${blk.id}`,
        severity: 'warning',
        message: isTimer
          ? `定时器通道 T${dupKey} 绑定了多个“当定时器触发”回调块，建议合并为一个。`
          : `回调 ${hatDef.hat.eventName}（条件 ${dupKey}）绑定了多个重复分支，建议合并。`,
        blockId: blk.id,
      });
    } else {
      seen.add(dupKey);
    }
  }

  // 3. Floating top-level statements & empty on_start
  for (const block of enabledTopBlocks) {
    if (!isValidTopHatType(block.type)) {
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

  // 4. Unified pack/capability gating + channel pool OOB diagnostics across ALL blocks
  const activeCaps = getActiveProjectCapabilities();

  for (const blk of workspace.getAllBlocks(false)) {
    if (blk.isShadow() || !blk.isEnabled()) continue;

    // Option A strict board alignment: `sleep_ms` / wait block cannot block inside synchronous event callbacks
    if (blk.type === 'poly_wait_ms') {
      const rootBlk = blk.getRootBlock();
      const rootHat = rootBlk ? extensionRegistry.getHatBlockDef(rootBlk.type) : undefined;
      if (rootHat) {
        diagnostics.push({
          id: `wait-in-callback-${rootHat.hat.eventName}-${blk.id}`,
          severity: 'error',
          message: `禁止在事件回调「${rootHat.hat.eventName}」内使用「等待 ms」（sleep_ms）；实板同步回调不可阻塞，请移至「当程序启动」协程或改用定时器。`,
          blockId: blk.id,
        });
      }
    }

    const owner = extensionRegistry.findOwnerForBlockType(blk.type);

    if (activeCaps !== null) {
      if (owner && !hasCapability(activeCaps, owner.section.capId)) {
        const displayName = owner.section.isMultiSection
          ? `${owner.pack.name} · ${owner.section.label}`
          : owner.pack.name;
        diagnostics.push({
          id: `cap-missing-${owner.section.capId}-${blk.id}`,
          severity: 'error',
          message: `当前项目未启用「${displayName}」，请在项目配置的「能力与外设」中启用后再运行或导出。`,
          blockId: blk.id,
        });
        continue;
      }
      if (!owner && blk.type.startsWith('ext_')) {
        diagnostics.push({
          id: `cap-missing-ext-unknown-${blk.id}`,
          severity: 'error',
          message: `积木「${blk.type}」所属的自定义外设包已移除或未导入，请重新导入对应 .polyext.json。`,
          blockId: blk.id,
        });
        continue;
      }
    }

    // Channel pool range check (strictly isolated per section pool.configKey!)
    const pool = owner?.section.handleChannelPool;
    if (pool) {
      const fieldName = pool.fieldName || 'TIMER_ID';
      if (blk.getField(fieldName)) {
        const poolCfg = getActiveChannelPoolConfig(pool.configKey, pool.defaultCount);
        const cid = Math.trunc(Number(blk.getFieldValue(fieldName) ?? 0));
        if (!Number.isInteger(cid) || cid < 0 || cid >= poolCfg.count) {
          diagnostics.push({
            id: `pool-${pool.configKey}-oob-${cid}-${blk.id}`,
            severity: 'error',
            message: `${pool.label} ${pool.prefix}${cid} 超出当前句柄配置范围（0~${poolCfg.count - 1}），请更换通道或在句柄配置中调大通道数。`,
            blockId: blk.id,
          });
        }
      }
    }
  }

  // 5. Cross-file global callback collision & missing `require` script checks within the active handle
  const handleScripts = getActiveHandleScripts();
  const currentScriptId = getActiveHandleScriptId();
  if (handleScripts.length > 0) {
    const currentScript = handleScripts.find((s) => s.id === currentScriptId);
    const siblings = handleScripts.filter((s) => s.id !== currentScriptId);
    const siblingByName = new Map(siblings.map((s) => [s.name, s]));

    // Map declared eventName -> first top blockId in current workspace
    const currentEventToBlock = new Map<string, string>();
    for (const blk of enabledTopBlocks) {
      if (blk.type === 'poly_on_start') {
        if (!currentEventToBlock.has('on_start')) currentEventToBlock.set('on_start', blk.id);
      } else {
        const hatDef = extensionRegistry.getHatBlockDef(blk.type);
        if (hatDef && !currentEventToBlock.has(hatDef.hat.eventName)) {
          currentEventToBlock.set(hatDef.hat.eventName, blk.id);
        }
      }
    }

    const linkedSiblings = new Map<string, (typeof siblings)[number]>();
    for (const blk of workspace.getAllBlocks(false)) {
      if (blk.isShadow() || !blk.isEnabled() || blk.type !== 'poly_require_script') continue;
      const targetName = String(blk.getFieldValue('SCRIPT') || '').trim();
      if (!targetName) continue;
      const found = siblingByName.get(targetName);
      if (!found) {
        diagnostics.push({
          id: `require-missing-${targetName}-${blk.id}`,
          severity: 'warning',
          message: `当前句柄内未找到脚本「${targetName}」，请先在脚本标签栏新建该脚本。`,
          blockId: blk.id,
        });
      } else {
        linkedSiblings.set(found.id, found);
      }
    }

    // Also include siblings that explicitly require the current script (reverse direction check)
    if (currentScript) {
      for (const sib of siblings) {
        if (sib.requiredScripts.includes(currentScript.name)) {
          linkedSiblings.set(sib.id, sib);
        }
      }
    }

    // Flag overlapping global callback definitions between linked scripts in the same handle
    for (const sib of linkedSiblings.values()) {
      for (const evName of sib.declaredEvents) {
        const localBlkId = currentEventToBlock.get(evName);
        if (localBlkId) {
          diagnostics.push({
            id: `cross-file-cb-conflict-${evName}-${sib.name}-${localBlkId}`,
            severity: 'error',
            message: `回调「${evName}」与同句柄联动脚本「${sib.name}」冲突：两者都会写入全局 _G.${evName}，后加载会覆盖前者，请将同类事件合并到同一脚本中。`,
            blockId: localBlkId,
          });
        }
      }
    }
  }

  return diagnostics;
}
