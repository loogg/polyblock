import type * as Blockly from 'blockly';
import type {
  DiagnosticItem,
  ScriptLanguageId,
  SourceLineRange,
} from '../../types/project';
import { isCoreBlockType } from '../blocks/catalog';
import {
  getActiveChannelPoolConfig,
  getActiveHandleScriptId,
  getActiveHandleScripts,
  getActiveHandleSharedFunctions,
  getActiveHandleSharedVariables,
  getActiveModuleConflicts,
  getActiveProjectCapabilities,
  isCurrentHandleScriptEntry,
} from '../blocks/workspaceContextBridge';
import { hasCapability } from '../capabilities/matching';
import {
  extensionRegistry,
  formatExtensionBlockLabel,
} from '../extensions/registry';
import { computeAsyncFunctionNames } from './codegenContext';
import { getUnifiedHatSpec, isValidTopHatType } from './eventMode';
import { getLanguageDialect } from './registry';
import { getBlockVariableFieldIds, sanitizeLocalIdent } from './scopeAnalysis';

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
 * - Out-of-range channel pool IDs for any section declaring `handleConfigs` (`channel-pool`)
 */
export function analyzeWorkspaceDiagnostics(
  workspace: Blockly.Workspace,
  targetLanguage?: ScriptLanguageId,
): DiagnosticItem[] {
  const diagnostics: DiagnosticItem[] = [];

  // 0. Project-wide same-tier moduleName conflict checks (always surface even on empty scripts)
  for (const conflict of getActiveModuleConflicts()) {
    diagnostics.push({
      id: conflict.id,
      severity: 'error',
      message: conflict.message,
    });
  }

  const topBlocks = workspace.getTopBlocks(true);

  if (topBlocks.length === 0) {
    return diagnostics;
  }

  const enabledTopBlocks = topBlocks.filter((b) => !b.isShadow() && b.isEnabled());

  // 1. Unified `hat.mode === 'singleton'` check across ALL hats (including core `poly_on_start`):
  //    - Singleton hats are ONLY allowed in the handle's entry script (`main`)
  //    - Duplicate singleton hats in the same script are `error`
  const isEntryScript = isCurrentHandleScriptEntry();
  const handleScriptsAll = getActiveHandleScripts();
  const entryScriptName =
    handleScriptsAll.find((s) => s.isEntry)?.name ?? 'main';
  const seenSingletons = new Map<string, number>();
  const startBlocks: Blockly.Block[] = [];
  for (const blk of enabledTopBlocks) {
    if (blk.type === 'poly_on_start') startBlocks.push(blk);
    const hatSpec = getUnifiedHatSpec(blk.type);
    if (!hatSpec || hatSpec.mode !== 'singleton') continue;

    if (!isEntryScript) {
      diagnostics.push({
        id: `non-entry-singleton-${hatSpec.eventName}-${blk.id}`,
        severity: 'error',
        message: `单例/生命周期回调「${hatSpec.eventName}」只能在句柄入口脚本（${entryScriptName}）中定义，请移至入口脚本。`,
        blockId: blk.id,
      });
    }
    const count = (seenSingletons.get(hatSpec.eventName) ?? 0) + 1;
    seenSingletons.set(hatSpec.eventName, count);
    if (count > 1) {
      diagnostics.push({
        id: `multi-${blk.type}-${blk.id}`,
        severity: 'error',
        message: `同一个脚本内检测到多个「${hatSpec.eventName}」回调块（后者会覆盖前者），请合并为一个。`,
        blockId: blk.id,
      });
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
      const scopeLabel = extensionRegistry.renderHatScopeInfo(blk)?.label;
      diagnostics.push({
        id: `dup-hat-${blk.type}-${dupKey}-${blk.id}`,
        severity: 'warning',
        message: `回调「${scopeLabel ?? `${hatDef.hat.eventName} (${dupKey})`}」绑定了多个重复分支，建议合并为一个。`,
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

  // 4. Unified pack/capability gating, non-blocking callback checks & channel pool OOB diagnostics
  const activeCaps = getActiveProjectCapabilities();
  const activeSharedFnSet = new Set(getActiveHandleSharedFunctions() ?? []);
  const externalAsyncSharedFns = new Set<string>();
  for (const s of handleScriptsAll) {
    for (const fn of s.declaredFunctions ?? []) {
      if (fn.usesSleep && activeSharedFnSet.has(fn.name)) {
        externalAsyncSharedFns.add(fn.name);
      }
    }
  }
  const asyncFnNames = computeAsyncFunctionNames(workspace, externalAsyncSharedFns);

  for (const blk of workspace.getAllBlocks(false)) {
    if (blk.isShadow() || !blk.isEnabled()) continue;

    // Strict board alignment: `sleep_ms` (direct or via async helper) cannot block inside non-coroutine callbacks or top-level floating stacks
    const rootBlk = blk.getRootBlock();
    const rootHatSpec = rootBlk ? getUnifiedHatSpec(rootBlk.type) : undefined;
    const rootIsProc =
      rootBlk?.type === 'procedures_defnoreturn' ||
      rootBlk?.type === 'procedures_defreturn';
    const rootDisallowsWait =
      (rootHatSpec && !rootHatSpec.isCoroutine) || (!rootHatSpec && !rootIsProc);
    const contextLabel = rootHatSpec
      ? `事件回调「${rootHatSpec.eventName}」`
      : '顶层游离积木';
    if (rootDisallowsWait) {
      if (blk.type === 'poly_wait_ms') {
        diagnostics.push({
          id: `wait-in-callback-${rootHatSpec?.eventName ?? 'floating'}-${blk.id}`,
          severity: 'error',
          message: `禁止在${contextLabel}内使用「等待 ms」（sleep_ms）；请移至「当程序启动」协程或自定义函数内。`,
          blockId: blk.id,
        });
      } else if (
        blk.type === 'procedures_callnoreturn' ||
        blk.type === 'procedures_callreturn'
      ) {
        const call = blk as Blockly.Block & { getProcedureCall?: () => string };
        const fnName = call.getProcedureCall?.()?.trim();
        if (fnName && asyncFnNames.has(fnName)) {
          diagnostics.push({
            id: `async-call-in-callback-${rootHatSpec?.eventName ?? 'floating'}-${fnName}-${blk.id}`,
            severity: 'error',
            message: `${contextLabel}不可阻塞，禁止调用包含等待 (sleep_ms) 的函数「${fnName}」。`,
            blockId: blk.id,
          });
        }
      } else if (
        blk.type === 'poly_call_shared_noreturn' ||
        blk.type === 'poly_call_shared_return'
      ) {
        const meta = (
          blk as Blockly.Block & { sharedFnMeta_?: { fnName: string } }
        ).sharedFnMeta_;
        if (meta?.fnName && asyncFnNames.has(meta.fnName)) {
          diagnostics.push({
            id: `async-shared-call-in-callback-${rootHatSpec?.eventName ?? 'floating'}-${meta.fnName}-${blk.id}`,
            severity: 'error',
            message: `${contextLabel}不可阻塞，禁止调用包含等待 (sleep_ms) 的跨文件函数「shared.${meta.fnName}」。`,
            blockId: blk.id,
          });
        }
      }
    }

    // Check `poly_local_set` colliding with enclosing procedure formal parameter (prevents JS SyntaxError & Python/Lua ambiguity)
    if (blk.type === 'poly_local_set' && rootIsProc && rootBlk) {
      const proc = rootBlk as Blockly.Block & {
        getProcedureDef?: () => [string, string[], boolean];
      };
      const params = proc.getProcedureDef?.()?.[1] ?? [];
      const localIdent = sanitizeLocalIdent(String(blk.getFieldValue('NAME') || 'tmp'));
      const collidesParam = params.find((p) => sanitizeLocalIdent(p) === localIdent);
      if (collidesParam) {
        diagnostics.push({
          id: `local-param-collision-${localIdent}-${blk.id}`,
          severity: 'error',
          message: `局部变量「${String(blk.getFieldValue('NAME') || 'tmp')}」与当前函数参数「${collidesParam}」重名，请更换局部变量名称。`,
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
      if (!owner && !isCoreBlockType(blk.type)) {
        diagnostics.push({
          id: `cap-missing-ext-unknown-${blk.id}`,
          severity: 'error',
          message: `积木「${blk.type}」所属的自定义外设包已移除或未导入，请重新导入对应 .polyext.json。`,
          blockId: blk.id,
        });
        continue;
      }
    }

    // Single-language extension block & dispatch-hat compatibility check (universal across all registered languages)
    if (owner && targetLanguage) {
      const targetLabel = getLanguageDialect(targetLanguage).displayName;
      if (owner.block.kind !== 'hat') {
        if (!owner.block.code?.[targetLanguage]?.template) {
          diagnostics.push({
            id: `lang-unsupported-${targetLanguage}-${blk.id}`,
            severity: 'error',
            message: `积木「${formatExtensionBlockLabel(owner.block, owner.section)}」（所属「${owner.pack.name}」）未提供 ${targetLabel} 代码模板（code.${targetLanguage}.template），请切换项目语言或补全该语言模板。`,
            blockId: blk.id,
          });
        }
      } else if (
        owner.block.hat?.mode === 'dispatch' &&
        owner.block.hat.condition &&
        !owner.block.hat.condition[targetLanguage]
      ) {
        diagnostics.push({
          id: `hat-lang-unsupported-${targetLanguage}-${blk.id}`,
          severity: 'error',
          message: `事件帽块「${formatExtensionBlockLabel(owner.block, owner.section)}」（所属「${owner.pack.name}」）未提供 ${targetLabel} 分发条件模板（hat.condition.${targetLanguage}），请切换项目语言或补全该语言模板。`,
          blockId: blk.id,
        });
      }
    }

    // Channel pool range check (automatically detects all `field_channel_id` args — zero manual fieldName!)
    const pool = owner?.section.channelPool;
    if (pool && owner) {
      const channelArgNames = (owner.block.args0 ?? [])
        .filter(
          (a) => a.type === 'field_channel_id' && typeof a.name === 'string',
        )
        .map((a) => String(a.name));
      for (const fieldName of channelArgNames) {
        if (blk.getField(fieldName)) {
          const poolCfg = getActiveChannelPoolConfig(
            pool.configKey,
            pool.defaultCount,
          );
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
  }

  // 5. Handle-wide uniqueness & cross-file checks across ALL scripts in the active handle
  //    1 Handle = 1 isolated runtime VM (`lua_State*`), so all `.lua` files in a handle run together:
  //    - Globally unique lifecycle hats (`on_start`, `on_stop`, `on_run`, and any singleton hat) across ALL sibling scripts
  //    - Global callback collision check (`on_timer`, `on_button`, etc.) across ALL sibling scripts
  //    - Missing sibling script check for `poly_require_script`
  const handleScripts = getActiveHandleScripts();
  const currentScriptId = getActiveHandleScriptId();
  if (handleScripts.length > 0) {
    const siblings = handleScripts.filter((s) => s.id !== currentScriptId);
    const siblingByName = new Map(siblings.map((s) => [s.name, s]));

    // Map declared eventName -> { blockId, isSingleton, isExtractedDispatch } in current workspace
    const currentEvents = new Map<
      string,
      { blockId: string; isSingleton: boolean; isExtractedDispatch: boolean }
    >();
    const currentExtractedBranches: Array<{
      blockId: string;
      eventName: string;
      dupKey: string;
      blockType: string;
    }> = [];
    for (const blk of enabledTopBlocks) {
      const hatSpec = getUnifiedHatSpec(blk.type);
      if (!hatSpec) continue;
      const isDispatch = hatSpec.mode === 'dispatch';
      if (!currentEvents.has(hatSpec.eventName)) {
        currentEvents.set(hatSpec.eventName, {
          blockId: blk.id,
          isSingleton: hatSpec.mode === 'singleton',
          isExtractedDispatch: isDispatch,
        });
      }
      if (isDispatch) {
        const dupKey = extensionRegistry.renderHatDuplicateKey(blk);
        if (dupKey !== null) {
          currentExtractedBranches.push({
            blockId: blk.id,
            eventName: hatSpec.eventName,
            dupKey,
            blockType: blk.type,
          });
        }
      }
    }

    const explicitRequiredNames = new Set<string>();
    for (const blk of workspace.getAllBlocks(false)) {
      if (blk.isShadow() || !blk.isEnabled() || blk.type !== 'poly_require_script')
        continue;
      const targetName = String(blk.getFieldValue('SCRIPT') || '').trim();
      if (!targetName) continue;
      explicitRequiredNames.add(targetName);
      if (!siblingByName.has(targetName)) {
        diagnostics.push({
          id: `require-missing-${targetName}-${blk.id}`,
          severity: 'warning',
          message: `当前句柄内未找到脚本「${targetName}」，请先在脚本标签栏新建该脚本。`,
          blockId: blk.id,
        });
      }
    }

    // Explicit companion loading check: companion scripts defining dispatch callbacks
    // MUST be explicitly loaded by the entry script via `poly_require_script` (no silent auto-import!).
    if (isEntryScript) {
      for (const sib of siblings) {
        const branches = sib.dispatchBranches ?? [];
        if (branches.length === 0) continue;
        if (!explicitRequiredNames.has(sib.name)) {
          const evNames = Array.from(new Set(branches.map((b) => b.eventName))).join(' / ');
          diagnostics.push({
            id: `companion-not-loaded-${sib.name}`,
            severity: 'error',
            message: `伴生脚本「${sib.name}」定义了事件回调（${evNames}），但入口脚本尚未加载它；请在「当程序启动」中拖入「加载脚本 ${sib.name}」积木。`,
            blockId: startBlocks[0]?.id,
          });
        }
      }
    }

    // Check EVERY sibling script in this handle for:
    // - Duplicate singleton lifecycle callbacks (`on_start`, `on_stop`, `on_run`) -> Error
    // - Extracted dispatch hats (`on_timer` with `extractBranchFnPrefix`): ALLOWED across multiple files!
    //   ONLY flag Error when two scripts bind the EXACT SAME channel/dupKey (e.g. both bind T0)!
    // - Non-extracted dispatch hats -> Error (would overwrite global callback)
    for (const sib of siblings) {
      for (const evName of sib.declaredEvents) {
        const localEntry = currentEvents.get(evName);
        if (!localEntry) continue;
        if (localEntry.isSingleton) {
          diagnostics.push({
            id: `handle-dup-lifecycle-${evName}-${sib.name}-${localEntry.blockId}`,
            severity: 'error',
            message: `每个句柄全局只允许 1 个「${evName}」：当前脚本与同句柄脚本「${sib.name}」重复定义了 ${evName}，请仅在入口脚本保留一个。`,
            blockId: localEntry.blockId,
          });
        } else if (!localEntry.isExtractedDispatch) {
          diagnostics.push({
            id: `cross-file-cb-conflict-${evName}-${sib.name}-${localEntry.blockId}`,
            severity: 'error',
            message: `回调「${evName}」与同句柄脚本「${sib.name}」冲突：同句柄内所有脚本共享全局回调 ${evName}，请将同类事件合并到同一脚本中。`,
            blockId: localEntry.blockId,
          });
        }
      }

      for (const localBr of currentExtractedBranches) {
        const colliding = (sib.dispatchBranches ?? []).find(
          (sb) => sb.eventName === localBr.eventName && sb.dupKey === localBr.dupKey,
        );
        if (colliding) {
          diagnostics.push({
            id: `cross-file-branch-dup-${localBr.eventName}-${localBr.dupKey}-${sib.name}-${localBr.blockId}`,
            severity: 'error',
            message: `事件回调 ${localBr.eventName}（条件 ${localBr.dupKey}）与同句柄脚本「${sib.name}」重复绑定，请修改条件或合并到同一脚本。`,
            blockId: localBr.blockId,
          });
        }
      }
    }

    // 6. Cross-file shared custom function collision, isolation & dangling call checks
    const sharedFnSet = new Set(getActiveHandleSharedFunctions() ?? []);
    const sharedVarSet = new Set(getActiveHandleSharedVariables() ?? []);
    const varMap = workspace.getVariableMap();
    if (sharedFnSet.size > 0) {
      for (const top of enabledTopBlocks) {
        if (
          top.type !== 'procedures_defnoreturn' &&
          top.type !== 'procedures_defreturn'
        ) {
          continue;
        }
        const fnName = String(top.getFieldValue('NAME') || '').trim();
        if (!fnName || !sharedFnSet.has(fnName)) continue;

        // 6a. Duplicate shared function name across sibling scripts
        for (const sib of siblings) {
          if ((sib.declaredFunctions ?? []).some((f) => f.name === fnName)) {
            diagnostics.push({
              id: `cross-file-shared-fn-dup-${fnName}-${sib.name}-${top.id}`,
              severity: 'error',
              message: `跨文件公共函数「${fnName}」与同句柄脚本「${sib.name}」重名，请重命名其中一个或将其转为本文件私有函数。`,
              blockId: top.id,
            });
          }
        }

        // 6b. Shared function isolation: exported inside `shared`, so it CANNOT reference single-file private variables or call private functions!
        const proc = top as Blockly.Block & {
          getProcedureDef?: () => [string, string[], boolean];
        };
        const paramSet = new Set(proc.getProcedureDef?.()?.[1] ?? []);
        const flaggedPrivVars = new Set<string>();
        const flaggedPrivFns = new Set<string>();
        const isEnclosingLoopVar = (desc: Blockly.Block, varName: string): boolean => {
          let prev: Blockly.Block = desc;
          let cur = desc.getParent();
          while (cur && cur !== top) {
            if (
              (cur.type === 'poly_for_range' ||
                cur.type === 'controls_for' ||
                cur.type === 'controls_forEach') &&
              cur.getField('VAR') &&
              cur.getInputWithBlock(prev)?.name === 'DO'
            ) {
              const loopVarId = String(cur.getFieldValue('VAR') || '');
              const loopVarName = loopVarId
                ? varMap.getVariableById(loopVarId)?.getName()
                : undefined;
              if (loopVarName === varName) return true;
            }
            prev = cur;
            cur = cur.getParent();
          }
          return false;
        };
        for (const desc of top.getDescendants(false)) {
          if (desc.isShadow() || !desc.isEnabled() || desc === top) continue;

          if (
            desc.type === 'procedures_callnoreturn' ||
            desc.type === 'procedures_callreturn'
          ) {
            const callee = String(desc.getFieldValue('NAME') || '').trim();
            if (callee && !sharedFnSet.has(callee) && !flaggedPrivFns.has(callee)) {
              flaggedPrivFns.add(callee);
              diagnostics.push({
                id: `shared-fn-private-fn-${fnName}-${callee}-${desc.id}`,
                severity: 'error',
                message: `跨文件公共函数「shared.${fnName}」导出在 shared 模块中，不能调用本文件私有函数「${callee}」；请将「${callee}」提升为跨文件公共函数。`,
                blockId: desc.id,
              });
            }
            continue;
          }

          if (
            desc.type === 'poly_for_range' ||
            desc.type === 'controls_for' ||
            desc.type === 'controls_forEach'
          ) {
            continue;
          }
          for (const vId of getBlockVariableFieldIds(desc)) {
            const vModel = vId ? varMap.getVariableById(vId) : null;
            const vName = vModel?.getName();
            if (
              vName &&
              !paramSet.has(vName) &&
              !sharedVarSet.has(vName) &&
              !isEnclosingLoopVar(desc, vName) &&
              !flaggedPrivVars.has(vName)
            ) {
              flaggedPrivVars.add(vName);
              diagnostics.push({
                id: `shared-fn-private-var-${fnName}-${vName}-${desc.id}`,
                severity: 'error',
                message: `跨文件公共函数「shared.${fnName}」导出在 shared 模块中，不能引用单文件私有变量「${vName}」；请改用跨文件变量、函数参数或局部临时变量。`,
                blockId: desc.id,
              });
            }
          }
        }
      }
    }

    for (const blk of workspace.getAllBlocks(false)) {
      if (
        blk.isShadow() ||
        !blk.isEnabled() ||
        (blk.type !== 'poly_call_shared_noreturn' &&
          blk.type !== 'poly_call_shared_return')
      ) {
        continue;
      }
      const meta = (
        blk as Blockly.Block & {
          sharedFnMeta_?: { scriptName: string; fnName: string; params: string[] };
        }
      ).sharedFnMeta_;
      if (!meta) continue;
      const existsInHandle =
        enabledTopBlocks.some(
          (t) =>
            (t.type === 'procedures_defnoreturn' ||
              t.type === 'procedures_defreturn') &&
            String(t.getFieldValue('NAME') || '').trim() === meta.fnName,
        ) ||
        siblings.some((sib) =>
          (sib.declaredFunctions ?? []).some((f) => f.name === meta.fnName),
        );
      if (!existsInHandle || !sharedFnSet.has(meta.fnName)) {
        diagnostics.push({
          id: `dangling-shared-fn-${meta.fnName}-${blk.id}`,
          severity: 'error',
          message: `跨文件函数「shared.${meta.fnName}」不存在或已被转为本文件私有，请检查对应函数定义。`,
          blockId: blk.id,
        });
      }
    }
  }

  return diagnostics;
}
