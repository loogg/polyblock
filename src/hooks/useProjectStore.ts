import * as Blockly from 'blockly';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { BlocklyDialogRequest } from '../components/BlocklyDialogModal';
import type {
  BlocklyWorkbenchHandle,
  HandleFunctionMutation,
} from '../components/BlocklyWorkbench';
import { buildHandleScriptsMeta } from '../core/backends/eventMode';
import { backendRegistry } from '../core/backends/registry';
import type { GeneratedCodeResult } from '../core/backends/types';
import {
  DEFAULT_CHANNEL_COUNT,
  normalizeChannelPoolConfig,
  setActiveChannelPoolConfig,
  setActiveChannelPoolConfigs,
  setActiveHandleScripts,
  setActiveHandleSharedFunctions,
  setActiveHandleSharedVariables,
  setActiveHandleSharedVarInitials,
  setActiveModuleConflicts,
  setActiveProjectCapabilities,
  setActiveScriptVarInitials,
  type ChannelAliasPromptRequest,
} from '../core/blocks/workspaceContextBridge';
import {
  buildProjectTargetBundle,
  buildSingleHandleTargetBundle,
  ModuleConflictExportError,
} from '../core/export/bundleExporter';
import { resolveProjectModules } from '../core/extensions/moduleResolver';
import { extensionRegistry } from '../core/extensions/registry';
import {
  applyHandleVariableMutation,
  collectAllVariableNamesInHandle,
  collectHandleSharedVariableNames,
  collectScriptVariableNames,
  syncHandleVariablesIntoWorkspaceJson,
  type HandleVariableMutation,
  type VariableScopeKind,
} from '../core/projects/handleVariables';
import {
  addHandleToProject,
  addScriptToHandle,
  buildExportableProjectJson,
  countProjectScripts,
  createDefaultWorkspaceStore,
  deleteHandleFromProject,
  deleteProjectFromStore,
  deleteScriptFromHandle,
  duplicateHandleInProject,
  duplicateProjectInStore,
  duplicateScriptInHandle,
  getActiveHandle,
  getActiveProject,
  getActiveScript,
  getAllHandleChannelPoolConfigs,
  getHandleChannelPoolConfig,
  instantiateProjectFromTemplate,
  loadWorkspaceStore,
  makeUniqueProjectName,
  renameHandleInProject,
  renameScriptInHandle,
  saveWorkspaceStore,
  setHandleChannelPoolConfig,
  STORAGE_STORE_V9_KEY,
  updateHandleById,
  updateProjectById,
} from '../core/projects/store';
import type {
  ChannelPoolConfig,
  PageId,
  ProjectModel,
  RuntimeHandle,
  ScriptLanguageId,
  WorkspaceStoreState,
} from '../types/project';
import { triggerBinaryDownload, triggerFileDownload } from './fileDownload';

export function collectHandleAllBreakpoints(handle: RuntimeHandle): string[] {
  const seen = new Set<string>();
  for (const s of handle.scripts) {
    for (const bp of s.breakpoints) {
      if (bp) seen.add(bp);
    }
  }
  return Array.from(seen);
}

/**
 * Callback bridge allowing `useProjectStore` event handlers to coordinate with
 * `useExecutionController` without circular hook dependencies.
 */
export interface ProjectStoreExecutionBridge {
  stopIfRunning: () => void;
  isExecutionActive: () => boolean;
  clearErrorLine: () => void;
  resetExecutionForSwitch: () => void;
  deleteProjectSimState: (projectId: string) => void;
  resetAllSimStates: () => void;
  syncActiveBreakpoints: (breakpoints: string[]) => void;
  reportErrorLogs: (messages: string[], idPrefix: string) => void;
}

export interface HandleConfigPatch {
  autoStart?: boolean;
  description?: string;
  channelPoolUpdate?: {
    configKey: string;
    config: ChannelPoolConfig;
    min?: number;
    max?: number;
  };
}

export interface UseProjectStoreOptions {
  workbenchRef: RefObject<BlocklyWorkbenchHandle | null>;
  executionBridgeRef: RefObject<ProjectStoreExecutionBridge>;
  openBlocklyDialog: (req: BlocklyDialogRequest) => void;
  setShowConsole: (show: boolean) => void;
  setShowExplorer: (show: boolean) => void;
  navigateTo: (page: PageId) => void;
  notify: (msg: string) => void;
  /** Changing value (e.g. active dialog request) refreshes live Blockly var/fn lists. */
  dialogRefreshKey: unknown;
}

export function useProjectStore({
  workbenchRef,
  executionBridgeRef,
  openBlocklyDialog,
  setShowConsole,
  setShowExplorer,
  navigateTo,
  notify,
  dialogRefreshKey,
}: UseProjectStoreOptions) {
  const initialStoreRef = useRef<WorkspaceStoreState>(loadWorkspaceStore());
  const [store, setStore] = useState<WorkspaceStoreState>(initialStoreRef.current);
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [viewingSharedModule, setViewingSharedModule] = useState<boolean>(false);

  const activeProject = getActiveProject(store);
  const activeHandle = getActiveHandle(activeProject);
  const activeScript = getActiveScript(activeHandle);
  const language = activeProject.language;
  const breakpoints = activeScript.breakpoints;
  const activeBackend = backendRegistry.get(language);

  const [generated, setGenerated] = useState<GeneratedCodeResult>({
    language,
    code: '',
    debugCode: '',
    sourceMap: {},
    lineToBlock: {},
    diagnostics: [],
    blockCount: 0,
    variableNames: [],
    variableScopes: [],
  });

  const storeRef = useRef<WorkspaceStoreState>(store);
  const activeProjectIdRef = useRef<string>(activeProject.id);
  const activeHandleIdRef = useRef<string>(activeHandle.id);
  const activeScriptIdRef = useRef<string>(activeScript.id);
  const languageRef = useRef<ScriptLanguageId>(language);
  const breakpointsRef = useRef<string[]>(breakpoints);

  storeRef.current = store;
  activeProjectIdRef.current = activeProject.id;
  activeHandleIdRef.current = activeHandle.id;
  activeScriptIdRef.current = activeScript.id;
  languageRef.current = language;
  breakpointsRef.current = breakpoints;

  useEffect(() => {
    saveWorkspaceStore(store);
  }, [store]);

  const regenerateFromWorkspace = useCallback(
    (ws: Blockly.WorkspaceSvg, lang: ScriptLanguageId) => {
      const adapter = backendRegistry.get(lang);
      const result = adapter.generate(ws);
      setGenerated(result);
      executionBridgeRef.current.clearErrorLine();
      return result;
    },
    [executionBridgeRef],
  );

  const flushActiveCanvasIntoStore = useCallback(
    (baseStore: WorkspaceStoreState): WorkspaceStoreState => {
      const ws = workbenchRef.current?.getWorkspace();
      if (!ws) return baseStore;
      const snapshot = workbenchRef.current?.saveWorkspaceJson();
      if (!snapshot) return baseStore;
      const projId = activeProjectIdRef.current;
      const hdlId = activeHandleIdRef.current;
      const scrId = activeScriptIdRef.current;
      const now = new Date().toISOString();

      return updateProjectById(baseStore, projId, (proj) =>
        updateHandleById(proj, hdlId, (hdl) => ({
          ...hdl,
          scripts: hdl.scripts.map((s) =>
            s.id === scrId
              ? {
                  ...s,
                  workspace: snapshot,
                  breakpoints: s.breakpoints.filter((bid) =>
                    Boolean(ws.getBlockById(bid)),
                  ),
                  updatedAt: now,
                }
              : s,
          ),
          updatedAt: now,
        })),
      );
    },
    [workbenchRef],
  );

  const mountScriptIntoCanvas = useCallback(
    (nextStore: WorkspaceStoreState) => {
      const nextProj = getActiveProject(nextStore);
      const nextHandle = getActiveHandle(nextProj);
      const nextScript = getActiveScript(nextHandle);
      extensionRegistry.setActiveProjectLocalPacks(nextProj.localExtensions ?? []);
      const nextPools = extensionRegistry
        .getChannelPools(nextProj.enabledCapabilities, nextProj.localExtensions)
        .map((entry) => entry.pool);
      setActiveChannelPoolConfigs(
        getAllHandleChannelPoolConfigs(nextHandle, nextPools),
      );
      setActiveProjectCapabilities(nextProj.enabledCapabilities);
      const sharedVarNames = collectHandleSharedVariableNames(nextHandle);
      setActiveHandleSharedVariables(sharedVarNames);
      setActiveHandleSharedVarInitials(nextHandle.variableInitialValues ?? {});
      setActiveScriptVarInitials(nextScript.variableInitialValues ?? {});
      setActiveHandleSharedFunctions(nextHandle.sharedFunctions ?? []);
      setActiveHandleScripts(buildHandleScriptsMeta(nextHandle), nextScript.id);
      const nextModRes = resolveProjectModules({
        enabledCapabilities: nextProj.enabledCapabilities,
        localExtensions: nextProj.localExtensions,
        handleScripts: nextHandle.scripts.map((s) => ({
          scriptId: s.id,
          scriptName: s.name,
        })),
      });
      setActiveModuleConflicts(nextModRes.conflicts);

      activeProjectIdRef.current = nextProj.id;
      activeHandleIdRef.current = nextHandle.id;
      activeScriptIdRef.current = nextScript.id;
      languageRef.current = nextProj.language;
      breakpointsRef.current = nextScript.breakpoints;

      executionBridgeRef.current.resetExecutionForSwitch();
      setViewingSharedModule(false);

      const syncedWorkspace = syncHandleVariablesIntoWorkspaceJson(
        nextScript.workspace,
        sharedVarNames,
      );
      workbenchRef.current?.loadWorkspaceJson(syncedWorkspace);
      const ws = workbenchRef.current?.getWorkspace();
      if (ws) {
        regenerateFromWorkspace(ws, nextProj.language);
      }
    },
    [executionBridgeRef, regenerateFromWorkspace, workbenchRef],
  );

  /* ========================================================================
     Variable & Function Scope Mutations + Workspace Change Sync
     ======================================================================== */
  const handleHandleVariableEvent = useCallback(
    (mutation: HandleVariableMutation) => {
      const projId = activeProjectIdRef.current;
      const hdlId = activeHandleIdRef.current;
      const scrId = activeScriptIdRef.current;
      const now = new Date().toISOString();

      // Compute updated sharedVariables & sibling notice synchronously from current storeRef
      // (React 18+ may batch setStore updaters asynchronously, so never read side-effects out of them!)
      const curProj = storeRef.current.projects.find((p) => p.id === projId);
      const curHdl = curProj?.handles.find((h) => h.id === hdlId);
      const previewRes = curHdl
        ? applyHandleVariableMutation(curHdl, scrId, mutation)
        : null;
      const nextSharedNames = previewRes
        ? collectHandleSharedVariableNames(previewRes.handle)
        : null;
      const keptNotice = previewRes?.keptInSiblings ?? [];

      if (nextSharedNames !== null && previewRes) {
        setActiveHandleSharedVariables(nextSharedNames);
        setActiveHandleSharedVarInitials(
          previewRes.handle.variableInitialValues ?? {},
        );
        const nextActiveScr = previewRes.handle.scripts.find((s) => s.id === scrId);
        if (nextActiveScr) {
          setActiveScriptVarInitials(nextActiveScr.variableInitialValues ?? {});
        }
      }

      setStore((prev) =>
        updateProjectById(prev, projId, (proj) =>
          updateHandleById(proj, hdlId, (hdl) => {
            const { handle: updatedHdl } = applyHandleVariableMutation(
              hdl,
              scrId,
              mutation,
            );
            return { ...updatedHdl, updatedAt: now };
          }),
        ),
      );

      const ws = workbenchRef.current?.getWorkspace();
      if (ws) regenerateFromWorkspace(ws, languageRef.current);
      workbenchRef.current?.refreshToolbox();

      if (mutation.kind === 'delete' && keptNotice.length > 0) {
        notify(
          `跨文件变量「${mutation.name}」仍在 ${keptNotice.join('、')} 中被积木引用，已保留这些脚本中的定义`,
        );
      }
    },
    [notify, regenerateFromWorkspace, workbenchRef],
  );

  const handleRequestCreateVariable = useCallback(
    (initialScope: VariableScopeKind) => {
      openBlocklyDialog({
        kind: 'create-variable',
        initialScope,
        onConfirm: (name, scope, initialValue) => {
          handleHandleVariableEvent({
            kind: 'create',
            name,
            scope,
            initialValue,
          });
          workbenchRef.current?.createVariable(name, scope);
          const ws = workbenchRef.current?.getWorkspace();
          if (ws) regenerateFromWorkspace(ws, languageRef.current);
        },
      });
    },
    [handleHandleVariableEvent, openBlocklyDialog, regenerateFromWorkspace, workbenchRef],
  );

  const handleToggleSharedFunction = useCallback(
    (fnName: string) => {
      const trimmed = fnName.trim();
      if (!trimmed) return;
      const projId = activeProjectIdRef.current;
      const hdlId = activeHandleIdRef.current;
      const now = new Date().toISOString();
      const curProj = storeRef.current.projects.find((p) => p.id === projId);
      const curHdl = curProj?.handles.find((h) => h.id === hdlId);
      const prevFns = curHdl?.sharedFunctions ?? [];
      const wasShared = prevFns.includes(trimmed);
      const nextFns = wasShared
        ? prevFns.filter((n) => n !== trimmed)
        : [...prevFns, trimmed];

      setActiveHandleSharedFunctions(nextFns);
      setStore((prev) =>
        updateProjectById(prev, projId, (proj) =>
          updateHandleById(proj, hdlId, (hdl) => ({
            ...hdl,
            sharedFunctions: nextFns,
            updatedAt: now,
          })),
        ),
      );
      const ws = workbenchRef.current?.getWorkspace();
      if (ws) regenerateFromWorkspace(ws, languageRef.current);
      workbenchRef.current?.refreshToolbox();
      notify(
        wasShared
          ? `已将函数「${trimmed}」转为本文件私有函数（仅本脚本可用）`
          : `已将函数「${trimmed}」设为跨文件公共函数（自动归入只读 shared 模块）`,
      );
    },
    [notify, regenerateFromWorkspace, workbenchRef],
  );

  const handleRequestCreateFunction = useCallback(
    (initialScope: VariableScopeKind) => {
      openBlocklyDialog({
        kind: 'create-function',
        initialScope,
        onConfirm: (name, scope, hasReturn) => {
          const trimmed = name.trim();
          if (!trimmed) return;
          if (scope === 'shared') {
            const projId = activeProjectIdRef.current;
            const hdlId = activeHandleIdRef.current;
            const now = new Date().toISOString();
            const curProj = storeRef.current.projects.find((p) => p.id === projId);
            const curHdl = curProj?.handles.find((h) => h.id === hdlId);
            const prevFns = curHdl?.sharedFunctions ?? [];
            const nextFns = prevFns.includes(trimmed)
              ? prevFns
              : [...prevFns, trimmed];

            setActiveHandleSharedFunctions(nextFns);
            setStore((prev) =>
              updateProjectById(prev, projId, (proj) =>
                updateHandleById(proj, hdlId, (hdl) => ({
                  ...hdl,
                  sharedFunctions: nextFns,
                  updatedAt: now,
                })),
              ),
            );
          }
          setViewingSharedModule(false);
          workbenchRef.current?.createProcedure(trimmed, hasReturn);
          const ws = workbenchRef.current?.getWorkspace();
          if (ws) regenerateFromWorkspace(ws, languageRef.current);
          notify(
            scope === 'shared'
              ? `已创建跨文件公共函数「${trimmed}」，将自动归入 shared 模块供同句柄所有脚本调用`
              : `已创建本文件私有函数「${trimmed}」（仅当前脚本内可见）`,
          );
        },
      });
    },
    [notify, openBlocklyDialog, regenerateFromWorkspace, workbenchRef],
  );

  const handleHandleFunctionEvent = useCallback(
    (mutation: HandleFunctionMutation) => {
      const projId = activeProjectIdRef.current;
      const hdlId = activeHandleIdRef.current;
      const now = new Date().toISOString();
      const curProj = storeRef.current.projects.find((p) => p.id === projId);
      const curHdl = curProj?.handles.find((h) => h.id === hdlId);
      if (!curHdl) return;
      const prevFns = curHdl.sharedFunctions ?? [];
      if (prevFns.length === 0) return;

      let nextFns = prevFns;
      if (mutation.kind === 'rename') {
        if (!prevFns.includes(mutation.oldName)) return;
        nextFns = Array.from(
          new Set(
            prevFns.map((n) => (n === mutation.oldName ? mutation.newName : n)),
          ),
        );
      } else if (mutation.kind === 'delete') {
        if (!prevFns.includes(mutation.name)) return;
        const scrId = activeScriptIdRef.current;
        const stillInOtherScript = curHdl.scripts.some(
          (s) =>
            s.id !== scrId &&
            (buildHandleScriptsMeta({ ...curHdl, scripts: [s] })[0]
              ?.declaredFunctions ?? []
            ).some((f) => f.name === mutation.name),
        );
        if (stillInOtherScript) return;
        nextFns = prevFns.filter((n) => n !== mutation.name);
      }

      setActiveHandleSharedFunctions(nextFns);
      setStore((prev) =>
        updateProjectById(prev, projId, (proj) =>
          updateHandleById(proj, hdlId, (hdl) => ({
            ...hdl,
            sharedFunctions: nextFns,
            updatedAt: now,
          })),
        ),
      );
      const ws = workbenchRef.current?.getWorkspace();
      if (ws) regenerateFromWorkspace(ws, languageRef.current);
      workbenchRef.current?.refreshToolbox();
    },
    [regenerateFromWorkspace, workbenchRef],
  );

  const handleWorkspaceChange = useCallback(
    (ws: Blockly.WorkspaceSvg) => {
      regenerateFromWorkspace(ws, languageRef.current);
      setIsDirty(true);

      const snapshot = workbenchRef.current?.saveWorkspaceJson();
      if (!snapshot) return;
      const projId = activeProjectIdRef.current;
      const hdlId = activeHandleIdRef.current;
      const scrId = activeScriptIdRef.current;
      const now = new Date().toISOString();

      setStore((prev) =>
        updateProjectById(prev, projId, (proj) =>
          updateHandleById(proj, hdlId, (hdl) => {
            let prunedAny = false;
            const nextScripts = hdl.scripts.map((s) => {
              if (s.id !== scrId) return s;
              const pruned = s.breakpoints.filter((bid) =>
                Boolean(ws.getBlockById(bid)),
              );
              if (pruned.length !== s.breakpoints.length) {
                prunedAny = true;
              }
              return {
                ...s,
                workspace: snapshot,
                breakpoints: pruned,
                updatedAt: now,
              };
            });
            const nextHdl = { ...hdl, scripts: nextScripts, updatedAt: now };
            if (prunedAny) {
              executionBridgeRef.current.syncActiveBreakpoints(
                collectHandleAllBreakpoints(nextHdl),
              );
            }
            return nextHdl;
          }),
        ),
      );
    },
    [executionBridgeRef, regenerateFromWorkspace, workbenchRef],
  );

  /* ========================================================================
     Three-Tier Handle & Script CRUD + Channel Pool Config Mutations
     ======================================================================== */
  const handleSelectHandleAndScript = useCallback(
    (handleId: string, scriptId?: string) => {
      const curProj = getActiveProject(storeRef.current);
      const targetHandle = curProj.handles.find((h) => h.id === handleId);
      if (!targetHandle) return;
      const targetScriptId = scriptId ?? targetHandle.activeScriptId;
      if (
        handleId === activeHandleIdRef.current &&
        targetScriptId === activeScriptIdRef.current
      ) {
        return;
      }
      executionBridgeRef.current.stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const nextStore = updateProjectById(flushed, curProj.id, (p) => ({
        ...p,
        activeHandleId: handleId,
        handles: p.handles.map((h) =>
          h.id === handleId ? { ...h, activeScriptId: targetScriptId } : h,
        ),
      }));
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
    },
    [executionBridgeRef, flushActiveCanvasIntoStore, mountScriptIntoCanvas],
  );

  const handleAddHandle = useCallback(
    (projectId?: string) => {
      const targetProjId = projectId ?? activeProjectIdRef.current;
      const isTargetActive = targetProjId === activeProjectIdRef.current;
      if (isTargetActive) executionBridgeRef.current.stopIfRunning();
      const base = isTargetActive
        ? flushActiveCanvasIntoStore(storeRef.current)
        : storeRef.current;
      const nextStore = updateProjectById(base, targetProjId, (p) =>
        addHandleToProject(p),
      );
      setStore(nextStore);
      if (isTargetActive) {
        mountScriptIntoCanvas(nextStore);
      }
      const createdH = getActiveHandle(
        nextStore.projects.find((p) => p.id === targetProjId)!,
      );
      notify(`已新建独立隔离句柄：${createdH.name}`);
    },
    [executionBridgeRef, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  const handleRenameHandle = useCallback(
    (projectId: string, handleId: string, nextName: string) => {
      setStore((prev) =>
        updateProjectById(prev, projectId, (p) =>
          renameHandleInProject(p, handleId, nextName),
        ),
      );
    },
    [],
  );

  const handleDuplicateHandle = useCallback(
    (projectId: string, handleId: string) => {
      const isTargetActive = projectId === activeProjectIdRef.current;
      if (isTargetActive) executionBridgeRef.current.stopIfRunning();
      const base = isTargetActive
        ? flushActiveCanvasIntoStore(storeRef.current)
        : storeRef.current;
      const nextStore = updateProjectById(base, projectId, (p) =>
        duplicateHandleInProject(p, handleId),
      );
      setStore(nextStore);
      if (isTargetActive) mountScriptIntoCanvas(nextStore);
      notify('已复制隔离句柄');
    },
    [executionBridgeRef, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  const handleDeleteHandle = useCallback(
    (projectId: string, handleId: string) => {
      const targetProj = storeRef.current.projects.find((p) => p.id === projectId);
      if (!targetProj || targetProj.handles.length <= 1) {
        notify('项目内至少需要保留 1 个运行句柄');
        return;
      }
      const isTargetActive = projectId === activeProjectIdRef.current;
      const wasActiveHandle =
        isTargetActive && handleId === activeHandleIdRef.current;
      if (wasActiveHandle) executionBridgeRef.current.stopIfRunning();
      const base = isTargetActive
        ? flushActiveCanvasIntoStore(storeRef.current)
        : storeRef.current;
      const nextStore = updateProjectById(base, projectId, (p) =>
        deleteHandleFromProject(p, handleId),
      );
      setStore(nextStore);
      if (wasActiveHandle) mountScriptIntoCanvas(nextStore);
      notify('已删除运行句柄');
    },
    [executionBridgeRef, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  const handleUpdateHandleConfig = useCallback(
    (projectId: string, handleId: string, patch: HandleConfigPatch) => {
      const poolUpd = patch.channelPoolUpdate
        ? {
            configKey: patch.channelPoolUpdate.configKey,
            min: patch.channelPoolUpdate.min,
            max: patch.channelPoolUpdate.max,
            config: normalizeChannelPoolConfig(
              patch.channelPoolUpdate.config,
              patch.channelPoolUpdate.config.count,
              patch.channelPoolUpdate.min,
              patch.channelPoolUpdate.max,
            ),
          }
        : undefined;

      setStore((prev) =>
        updateProjectById(prev, projectId, (p) =>
          updateHandleById(p, handleId, (h) => {
            const base = poolUpd
              ? setHandleChannelPoolConfig(
                  h,
                  poolUpd.configKey,
                  poolUpd.config,
                  poolUpd.min,
                  poolUpd.max,
                )
              : h;
            return {
              ...base,
              ...(patch.autoStart !== undefined ? { autoStart: patch.autoStart } : {}),
              ...(patch.description !== undefined
                ? { description: patch.description }
                : {}),
              updatedAt: new Date().toISOString(),
            };
          }),
        ),
      );
      if (
        poolUpd &&
        projectId === activeProjectIdRef.current &&
        handleId === activeHandleIdRef.current
      ) {
        setActiveChannelPoolConfig(
          poolUpd.configKey,
          poolUpd.config,
          poolUpd.config.count,
          poolUpd.min,
          poolUpd.max,
        );
        const ws = workbenchRef.current?.getWorkspace();
        if (ws) regenerateFromWorkspace(ws, languageRef.current);
      }
    },
    [regenerateFromWorkspace, workbenchRef],
  );

  const handleSaveInlineChannelAlias = useCallback(
    (req: ChannelAliasPromptRequest, alias: string) => {
      const proj = getActiveProject(storeRef.current);
      const hdl = getActiveHandle(proj);
      const poolSpec = extensionRegistry
        .getChannelPools(proj.enabledCapabilities, proj.localExtensions)
        .find((entry) => entry.pool.configKey === req.configKey)?.pool;
      const curCfg = getHandleChannelPoolConfig(
        hdl,
        req.configKey,
        poolSpec?.defaultCount ?? DEFAULT_CHANNEL_COUNT,
        poolSpec?.min,
        poolSpec?.max,
      );
      const nextAliases = { ...curCfg.aliases };
      if (alias.trim()) {
        nextAliases[String(req.channelId)] = alias.trim().slice(0, 16);
      } else {
        delete nextAliases[String(req.channelId)];
      }
      handleUpdateHandleConfig(proj.id, hdl.id, {
        channelPoolUpdate: {
          configKey: req.configKey,
          config: { ...curCfg, aliases: nextAliases },
          min: poolSpec?.min,
          max: poolSpec?.max,
        },
      });
      notify(
        alias.trim()
          ? `已将 [${hdl.name}] 的 ${req.prefix}${req.channelId} 标注为「${alias.trim()}」`
          : `已清除 [${hdl.name}] 的 ${req.prefix}${req.channelId} 别名`,
      );
    },
    [handleUpdateHandleConfig, notify],
  );

  const handleAddScriptInHandle = useCallback(
    (handleId?: string) => {
      const targetHdlId = handleId ?? activeHandleIdRef.current;
      executionBridgeRef.current.stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const nextStore = updateProjectById(
        flushed,
        activeProjectIdRef.current,
        (p) => {
          const updatedProj = updateHandleById(p, targetHdlId, (h) =>
            addScriptToHandle(h),
          );
          return { ...updatedProj, activeHandleId: targetHdlId };
        },
      );
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
      const added = getActiveScript(getActiveHandle(getActiveProject(nextStore)));
      notify(
        `已新建脚本 ${added.name}.${backendRegistry.get(languageRef.current).extension}`,
      );
    },
    [executionBridgeRef, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  const handleRenameScript = useCallback((scriptId: string, nextName: string) => {
    setStore((prev) =>
      updateProjectById(prev, activeProjectIdRef.current, (p) =>
        updateHandleById(p, activeHandleIdRef.current, (h) =>
          renameScriptInHandle(h, scriptId, nextName),
        ),
      ),
    );
  }, []);

  const handleDuplicateScript = useCallback(
    (scriptId: string) => {
      executionBridgeRef.current.stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const nextStore = updateProjectById(
        flushed,
        activeProjectIdRef.current,
        (p) =>
          updateHandleById(p, activeHandleIdRef.current, (h) =>
            duplicateScriptInHandle(h, scriptId),
          ),
      );
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
      const copied = getActiveScript(getActiveHandle(getActiveProject(nextStore)));
      notify(`已复制脚本为 ${copied.name}`);
    },
    [executionBridgeRef, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  const handleSetEntryScript = useCallback(
    (scriptId: string) => {
      setStore((prev) =>
        updateProjectById(prev, activeProjectIdRef.current, (p) =>
          updateHandleById(p, activeHandleIdRef.current, (h) => ({
            ...h,
            entryScriptId: scriptId,
            updatedAt: new Date().toISOString(),
          })),
        ),
      );
      notify('已设为当前句柄入口脚本 (★)');
    },
    [notify],
  );

  const handleDeleteScript = useCallback(
    (scriptId: string) => {
      const currentHdl = getActiveHandle(getActiveProject(storeRef.current));
      if (currentHdl.scripts.length <= 1) {
        notify('句柄内至少需要保留 1 个脚本');
        return;
      }
      executionBridgeRef.current.stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const wasActive = scriptId === activeScriptIdRef.current;
      const nextStore = updateProjectById(
        flushed,
        activeProjectIdRef.current,
        (p) =>
          updateHandleById(p, activeHandleIdRef.current, (h) =>
            deleteScriptFromHandle(h, scriptId),
          ),
      );
      setStore(nextStore);
      if (wasActive) mountScriptIntoCanvas(nextStore);
      notify('已删除脚本');
    },
    [executionBridgeRef, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  /* ========================================================================
     Multi-Project CRUD, Template Instantiation & JSON/Bundle Export
     ======================================================================== */
  const handleSelectProject = useCallback(
    (projectId: string) => {
      if (projectId === activeProjectIdRef.current) return;
      executionBridgeRef.current.stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const nextStore: WorkspaceStoreState = {
        ...flushed,
        activeProjectId: projectId,
      };
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
      const nextProj = getActiveProject(nextStore);
      if (nextProj.handles.length > 1 && window.innerWidth >= 1280) {
        setShowExplorer(true);
      }
      notify(`已切换至项目：${nextProj.name}`);
    },
    [
      executionBridgeRef,
      flushActiveCanvasIntoStore,
      mountScriptIntoCanvas,
      notify,
      setShowExplorer,
    ],
  );

  const handleCreateFromTemplate = useCallback(
    (templateId: string) => {
      executionBridgeRef.current.stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const created = instantiateProjectFromTemplate(
        templateId,
        flushed.projects.map((p) => p.name),
      );
      const nextStore: WorkspaceStoreState = {
        version: 3,
        activeProjectId: created.id,
        projects: [created, ...flushed.projects],
      };
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
      setShowExplorer(created.handles.length > 1 && window.innerWidth >= 1280);
      setIsDirty(false);
      navigateTo('blocks');
      notify(`已创建项目：${created.name}`);
    },
    [
      executionBridgeRef,
      flushActiveCanvasIntoStore,
      mountScriptIntoCanvas,
      navigateTo,
      notify,
      setShowExplorer,
    ],
  );

  const handleCreateBlankProject = useCallback(() => {
    handleCreateFromTemplate('blank_project');
  }, [handleCreateFromTemplate]);

  const handleUpdateProjectMeta = useCallback(
    (
      projectId: string,
      patch: {
        name?: string;
        description?: string;
        language?: ScriptLanguageId;
      },
    ) => {
      setStore((prev) => {
        const target = prev.projects.find((p) => p.id === projectId);
        if (!target) return prev;
        const nextName = patch.name
          ? makeUniqueProjectName(
              patch.name,
              prev.projects.map((p) => p.name),
              target.name,
            )
          : target.name;
        return updateProjectById(prev, projectId, (p) => ({
          ...p,
          name: nextName,
          ...(patch.description !== undefined
            ? { description: patch.description }
            : {}),
          ...(patch.language ? { language: patch.language } : {}),
          updatedAt: new Date().toISOString(),
        }));
      });
      if (patch.language && projectId === activeProjectIdRef.current) {
        languageRef.current = patch.language;
        const ws = workbenchRef.current?.getWorkspace();
        if (ws) regenerateFromWorkspace(ws, patch.language);
      }
      notify('已更新项目配置');
    },
    [notify, regenerateFromWorkspace, workbenchRef],
  );

  const handleRenameProject = useCallback(
    (projectId: string, nextName: string) => {
      handleUpdateProjectMeta(projectId, { name: nextName });
    },
    [handleUpdateProjectMeta],
  );

  const handleDuplicateProject = useCallback(
    (projectId: string) => {
      executionBridgeRef.current.stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const nextStore = duplicateProjectInStore(flushed, projectId);
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
      notify(`已复制项目：${getActiveProject(nextStore).name}`);
    },
    [executionBridgeRef, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  const handleDeleteProject = useCallback(
    (projectId: string) => {
      if (storeRef.current.projects.length <= 1) {
        notify('至少需要保留 1 个项目');
        return;
      }
      executionBridgeRef.current.stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const wasActive = projectId === activeProjectIdRef.current;
      const nextStore = deleteProjectFromStore(flushed, projectId);
      setStore(nextStore);
      executionBridgeRef.current.deleteProjectSimState(projectId);
      if (wasActive) mountScriptIntoCanvas(nextStore);
      notify('已删除项目');
    },
    [executionBridgeRef, flushActiveCanvasIntoStore, mountScriptIntoCanvas, notify],
  );

  const handleSaveProjectFile = useCallback(
    (projectId?: string) => {
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      setStore(flushed);
      const target =
        flushed.projects.find(
          (p) => p.id === (projectId ?? activeProjectIdRef.current),
        ) ?? getActiveProject(flushed);
      const safeName = target.name.replace(/[\\/:*?"<>|]+/g, '_');
      const fileName = `${safeName || 'project'}.polyblock.json`;
      const exportPayload = buildExportableProjectJson(
        target,
        extensionRegistry.listAll(),
      );
      triggerFileDownload(
        fileName,
        JSON.stringify(exportPayload, null, 2),
        'application/json;charset=utf-8',
      );
      setIsDirty(false);
      const bundledCount = exportPayload.bundledExtensions?.length ?? 0;
      const localCount = exportPayload.localExtensions?.length ?? 0;
      const packHint =
        bundledCount > 0 || localCount > 0
          ? ` · 含 ${localCount + bundledCount} 个随工程打包外设（开箱即用）`
          : '';
      notify(
        `已保存整项目工程 ${fileName}（${target.handles.length} 句柄 · ${countProjectScripts(target)} 脚本${packHint}）`,
      );
    },
    [flushActiveCanvasIntoStore, notify],
  );

  const handleImportProject = useCallback(
    (imported: ProjectModel, absorbedPackNames: string[] = []) => {
      executionBridgeRef.current.stopIfRunning();
      const flushed = flushActiveCanvasIntoStore(storeRef.current);
      const nextStore: WorkspaceStoreState = {
        version: 3,
        activeProjectId: imported.id,
        projects: [imported, ...flushed.projects],
      };
      setStore(nextStore);
      mountScriptIntoCanvas(nextStore);
      setShowExplorer(imported.handles.length > 1 && window.innerWidth >= 1280);
      setIsDirty(false);
      navigateTo('blocks');
      notify(
        absorbedPackNames.length > 0
          ? `已导入项目「${imported.name}」，并将随工程附带的外设快照（${absorbedPackNames.join('、')}）直接加载为项目内嵌包（优先覆盖全局、不污染全局库）`
          : `已导入项目：${imported.name}（${imported.handles.length} 句柄 · ${countProjectScripts(imported)} 脚本）`,
      );
    },
    [
      executionBridgeRef,
      flushActiveCanvasIntoStore,
      mountScriptIntoCanvas,
      navigateTo,
      notify,
      setShowExplorer,
    ],
  );

  const handleResetWorkspace = useCallback(() => {
    executionBridgeRef.current.stopIfRunning();
    localStorage.removeItem(STORAGE_STORE_V9_KEY);
    const freshStore = createDefaultWorkspaceStore();
    setStore(freshStore);
    mountScriptIntoCanvas(freshStore);
    executionBridgeRef.current.resetAllSimStates();
    setIsDirty(false);
    navigateTo('blocks');
    notify(`已恢复 ${freshStore.projects.length} 个内置演示项目`);
  }, [executionBridgeRef, mountScriptIntoCanvas, navigateTo, notify]);

  const handleSelectLanguage = useCallback(
    (nextLang: ScriptLanguageId) => {
      if (executionBridgeRef.current.isExecutionActive()) return;
      handleUpdateProjectMeta(activeProjectIdRef.current, { language: nextLang });
    },
    [executionBridgeRef, handleUpdateProjectMeta],
  );

  const handleExportActiveScript = useCallback(() => {
    const adapter = backendRegistry.get(language);
    const outFile = `${activeHandle.name}_${activeScript.name}.${adapter.extension}`;
    triggerFileDownload(
      outFile,
      generated.code + '\n',
      'text/plain;charset=utf-8',
    );
    setIsDirty(false);
    notify(`已导出干净脚本 ${outFile}`);
  }, [language, activeHandle.name, activeScript.name, generated.code, notify]);

  const restoreBridgeAfterBundleExport = useCallback((hdl: RuntimeHandle) => {
    setActiveHandleSharedVariables(collectHandleSharedVariableNames(hdl));
    setActiveHandleSharedVarInitials(hdl.variableInitialValues ?? {});
    setActiveScriptVarInitials(getActiveScript(hdl).variableInitialValues ?? {});
    setActiveHandleSharedFunctions(hdl.sharedFunctions ?? []);
    setActiveHandleScripts(buildHandleScriptsMeta(hdl), getActiveScript(hdl).id);
  }, []);

  const handleExportHandleBundle = useCallback(() => {
    const flushed = flushActiveCanvasIntoStore(storeRef.current);
    setStore(flushed);
    const proj = getActiveProject(flushed);
    const hdl = getActiveHandle(proj);
    try {
      const bundle = buildSingleHandleTargetBundle(proj, hdl);
      triggerBinaryDownload(bundle.fileName, bundle.zipBytes, 'application/zip');
      setIsDirty(false);
      notify(
        `已打包导出当前句柄真机包 ${bundle.fileName}（共 ${bundle.entries.length} 个文件，已剥离 ${bundle.strippedSandboxMocks.length} 个沙箱假桩）`,
      );
    } catch (err) {
      if (err instanceof ModuleConflictExportError) {
        setShowConsole(true);
        executionBridgeRef.current.reportErrorLogs(
          err.conflicts.map((c) => c.message),
          'export-conflict',
        );
        notify(`存在 ${err.conflicts.length} 处同层级模块名冲突，已阻止导出（请查看日志）`);
      } else {
        notify(`打包导出失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      restoreBridgeAfterBundleExport(hdl);
    }
  }, [
    executionBridgeRef,
    flushActiveCanvasIntoStore,
    notify,
    restoreBridgeAfterBundleExport,
    setShowConsole,
  ]);

  const handleExportProjectBundle = useCallback(() => {
    const flushed = flushActiveCanvasIntoStore(storeRef.current);
    setStore(flushed);
    const proj = getActiveProject(flushed);
    const hdl = getActiveHandle(proj);
    try {
      const bundle = buildProjectTargetBundle(proj);
      triggerBinaryDownload(bundle.fileName, bundle.zipBytes, 'application/zip');
      setIsDirty(false);
      notify(
        `已打包导出整工程真机包 ${bundle.fileName}（${proj.handles.length} 句柄 · 共 ${bundle.entries.length} 个文件，已剥离沙箱假桩）`,
      );
    } catch (err) {
      if (err instanceof ModuleConflictExportError) {
        setShowConsole(true);
        executionBridgeRef.current.reportErrorLogs(
          err.conflicts.map((c) => c.message),
          'export-proj-conflict',
        );
        notify(`存在 ${err.conflicts.length} 处同层级模块名冲突，已阻止导出（请查看日志）`);
      } else {
        notify(`整工程打包导出失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      restoreBridgeAfterBundleExport(hdl);
    }
  }, [
    executionBridgeRef,
    flushActiveCanvasIntoStore,
    notify,
    restoreBridgeAfterBundleExport,
    setShowConsole,
  ]);

  const handleJumpToSharedFunction = useCallback(
    (scriptId: string, blockId?: string) => {
      setViewingSharedModule(false);
      if (scriptId !== activeScriptIdRef.current) {
        handleSelectHandleAndScript(activeHandleIdRef.current, scriptId);
      }
      if (blockId) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            workbenchRef.current?.focusBlock(blockId);
          });
        });
      }
    },
    [handleSelectHandleAndScript, workbenchRef],
  );

  /* ========================================================================
     Derived Initial Workspace & Live Variable/Function Name Lists
     ======================================================================== */
  const initialScriptWorkspace = useMemo(() => {
    const initialHandle = getActiveHandle(getActiveProject(initialStoreRef.current));
    return syncHandleVariablesIntoWorkspaceJson(
      getActiveScript(initialHandle).workspace,
      collectHandleSharedVariableNames(initialHandle),
    );
  }, []);

  const activeHandleSharedVarNames = useMemo(
    () => collectHandleSharedVariableNames(activeHandle),
    [activeHandle, dialogRefreshKey],
  );

  const currentScriptVarNames = useMemo(() => {
    const fromStore = collectScriptVariableNames(activeScript.workspace);
    const liveVars =
      workbenchRef.current
        ?.getWorkspace()
        ?.getVariableMap()
        .getAllVariables()
        .map((v) => v.getName()) ?? [];
    return Array.from(new Set([...fromStore, ...liveVars]));
  }, [activeScript.workspace, dialogRefreshKey, workbenchRef]);

  const allHandleVarNames = useMemo(
    () =>
      Array.from(
        new Set([
          ...collectAllVariableNamesInHandle(activeHandle),
          ...currentScriptVarNames,
        ]),
      ),
    [activeHandle, currentScriptVarNames],
  );

  const currentScriptFunctionNames = useMemo(() => {
    const names = new Set<string>();
    const activeMeta = buildHandleScriptsMeta(activeHandle).find(
      (m) => m.id === activeScript.id,
    );
    for (const fn of activeMeta?.declaredFunctions ?? []) {
      names.add(fn.name);
    }
    const liveWs = workbenchRef.current?.getWorkspace();
    if (liveWs) {
      const [noRet, withRet] = Blockly.Procedures.allProcedures(liveWs);
      for (const [name] of [...noRet, ...withRet]) names.add(name);
    }
    return Array.from(names);
  }, [activeHandle, activeScript.id, dialogRefreshKey, workbenchRef]);

  const allHandleFunctionNames = useMemo(() => {
    const names = new Set<string>(activeHandle.sharedFunctions ?? []);
    for (const meta of buildHandleScriptsMeta(activeHandle)) {
      for (const fn of meta.declaredFunctions ?? []) {
        names.add(fn.name);
      }
    }
    for (const n of currentScriptFunctionNames) names.add(n);
    return Array.from(names);
  }, [activeHandle, currentScriptFunctionNames]);

  return {
    store,
    setStore,
    storeRef,
    isDirty,
    setIsDirty,
    viewingSharedModule,
    setViewingSharedModule,
    generated,
    setGenerated,
    activeProject,
    activeHandle,
    activeScript,
    language,
    breakpoints,
    activeBackend,
    activeProjectIdRef,
    activeHandleIdRef,
    activeScriptIdRef,
    languageRef,
    breakpointsRef,
    initialScriptWorkspace,
    activeHandleSharedVarNames,
    currentScriptVarNames,
    allHandleVarNames,
    currentScriptFunctionNames,
    allHandleFunctionNames,
    regenerateFromWorkspace,
    flushActiveCanvasIntoStore,
    mountScriptIntoCanvas,
    handleHandleVariableEvent,
    handleRequestCreateVariable,
    handleToggleSharedFunction,
    handleRequestCreateFunction,
    handleHandleFunctionEvent,
    handleWorkspaceChange,
    handleSelectHandleAndScript,
    handleAddHandle,
    handleRenameHandle,
    handleDuplicateHandle,
    handleDeleteHandle,
    handleUpdateHandleConfig,
    handleSaveInlineChannelAlias,
    handleAddScriptInHandle,
    handleRenameScript,
    handleDuplicateScript,
    handleSetEntryScript,
    handleDeleteScript,
    handleSelectProject,
    handleCreateFromTemplate,
    handleCreateBlankProject,
    handleUpdateProjectMeta,
    handleRenameProject,
    handleDuplicateProject,
    handleDeleteProject,
    handleSaveProjectFile,
    handleImportProject,
    handleResetWorkspace,
    handleSelectLanguage,
    handleExportActiveScript,
    handleExportHandleBundle,
    handleExportProjectBundle,
    handleJumpToSharedFunction,
  };
}
