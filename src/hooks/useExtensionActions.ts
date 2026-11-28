import type * as Blockly from 'blockly';
import {
  useCallback,
  useMemo,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { BlocklyWorkbenchHandle } from '../components/BlocklyWorkbench';
import { buildHandleScriptsMeta } from '../core/backends/eventMode';
import { buildHandleSharedModule } from '../core/backends/sharedModule';
import type { GeneratedCodeResult } from '../core/backends/types';
import {
  setActiveChannelPoolConfigs,
  setActiveHandleScripts,
  setActiveHandleSharedFunctions,
  setActiveHandleSharedVariables,
  setActiveModuleConflicts,
  setActiveProjectCapabilities,
  setActiveScriptVarInitials,
} from '../core/blocks/workspaceContextBridge';
import { targetProfileRegistry } from '../core/capabilities/registry';
import { resolveProjectModules } from '../core/extensions/moduleResolver';
import {
  extensionRegistry,
  getAllPackBlocks,
  togglePackOrSectionCapability,
} from '../core/extensions/registry';
import {
  mergeAttachedLibFiles,
  type UploadedScriptLibFile,
} from '../core/extensions/scriptLibScanner';
import type { PolyExtensionPack } from '../core/extensions/types';
import { collectHandleSharedVariableNames } from '../core/projects/handleVariables';
import {
  applyTargetProfileToProject,
  getActiveHandle,
  getActiveProject,
  getAllHandleChannelPoolConfigs,
  updateProjectById,
} from '../core/projects/store';
import type {
  ProjectModel,
  ProjectScript,
  RuntimeHandle,
  ScriptLanguageId,
  TargetProfile,
  WorkspaceStoreState,
} from '../types/project';

export interface UseExtensionActionsOptions {
  activeProject: ProjectModel;
  activeHandle: RuntimeHandle;
  activeScript: ProjectScript;
  language: ScriptLanguageId;
  storeRef: RefObject<WorkspaceStoreState>;
  setStore: Dispatch<SetStateAction<WorkspaceStoreState>>;
  activeProjectIdRef: RefObject<string>;
  languageRef: RefObject<ScriptLanguageId>;
  workbenchRef: RefObject<BlocklyWorkbenchHandle | null>;
  regenerateFromWorkspace: (
    ws: Blockly.WorkspaceSvg,
    lang: ScriptLanguageId,
  ) => GeneratedCodeResult;
  notify: (msg: string) => void;
}

export function useExtensionActions({
  activeProject,
  activeHandle,
  activeScript,
  language,
  storeRef,
  setStore,
  activeProjectIdRef,
  languageRef,
  workbenchRef,
  regenerateFromWorkspace,
  notify,
}: UseExtensionActionsOptions) {
  const [extRevision, setExtRevision] = useState<number>(0);
  const [profileRevision, setProfileRevision] = useState<number>(0);

  const activeChannelPools = useMemo(
    () =>
      extensionRegistry
        .getChannelPools(
          activeProject.enabledCapabilities,
          activeProject.localExtensions,
        )
        .map((entry) => entry.pool),
    [activeProject.enabledCapabilities, activeProject.localExtensions, extRevision],
  );

  const activeChannelPoolConfigs = useMemo(
    () => getAllHandleChannelPoolConfigs(activeHandle, activeChannelPools),
    [activeHandle, activeChannelPools],
  );

  const activeModuleResolution = useMemo(
    () =>
      resolveProjectModules({
        enabledCapabilities: activeProject.enabledCapabilities,
        localExtensions: activeProject.localExtensions,
        handleScripts: activeHandle.scripts.map((s) => ({
          scriptId: s.id,
          scriptName: s.name,
        })),
      }),
    [
      activeProject.enabledCapabilities,
      activeProject.localExtensions,
      activeHandle.scripts,
      extRevision,
    ],
  );

  const activeHandleSharedVarNames = useMemo(
    () => collectHandleSharedVariableNames(activeHandle),
    [activeHandle],
  );
  const activeHandleScriptMetas = useMemo(
    () => buildHandleScriptsMeta(activeHandle),
    [activeHandle],
  );

  // Synchronously sync active project/handle/script context into the Blockly bridge
  // during render so field dropdowns, toolbox builders, and code generators read fresh state.
  setActiveChannelPoolConfigs(activeChannelPoolConfigs);
  setActiveProjectCapabilities(activeProject.enabledCapabilities);
  setActiveHandleSharedVariables(activeHandleSharedVarNames);
  setActiveScriptVarInitials(activeScript.variableInitialValues ?? {});
  setActiveHandleSharedFunctions(activeHandle.sharedFunctions ?? []);
  setActiveHandleScripts(activeHandleScriptMetas, activeScript.id);
  setActiveModuleConflicts(activeModuleResolution.conflicts);
  extensionRegistry.setActiveProjectLocalPacks(activeProject.localExtensions ?? []);

  const activeSharedModule = useMemo(
    () =>
      buildHandleSharedModule(
        activeHandle,
        language,
        activeChannelPoolConfigs,
      ),
    [
      activeHandle,
      language,
      activeChannelPoolConfigs,
      extRevision,
      activeProject.localExtensions,
    ],
  );

  const allExtensionPacks = useMemo(
    () => extensionRegistry.listAll(),
    [extRevision],
  );

  const allTargetProfiles = useMemo(
    () => targetProfileRegistry.listAll(),
    [profileRevision],
  );

  const extraCategories = useMemo(
    () =>
      extensionRegistry.toCategorySpecs(
        activeProject.enabledCapabilities,
        activeProject.localExtensions,
      ),
    [activeProject.enabledCapabilities, activeProject.localExtensions, extRevision],
  );

  const activeSimPacks = useMemo(
    () =>
      extensionRegistry.getActiveSimPacks(
        activeProject.enabledCapabilities,
        activeProject.localExtensions,
      ),
    [activeProject.enabledCapabilities, activeProject.localExtensions, extRevision],
  );

  const runtimeMonitorSummary = useMemo(
    () =>
      extensionRegistry.getRuntimeMonitorSummary(
        activeProject.enabledCapabilities,
        activeProject.localExtensions,
      ),
    [activeProject.enabledCapabilities, activeProject.localExtensions, extRevision],
  );

  const syncModuleConflictsAndRegenerate = useCallback(
    (
      proj: ProjectModel,
      enabledCapabilities: string[],
      localExtensions: PolyExtensionPack[] | undefined,
    ) => {
      const curHandle = getActiveHandle(proj);
      const modRes = resolveProjectModules({
        enabledCapabilities,
        localExtensions,
        handleScripts: curHandle.scripts.map((s) => ({
          scriptId: s.id,
          scriptName: s.name,
        })),
      });
      setActiveModuleConflicts(modRes.conflicts);
      const ws = workbenchRef.current?.getWorkspace();
      if (ws) regenerateFromWorkspace(ws, languageRef.current);
    },
    [languageRef, regenerateFromWorkspace, workbenchRef],
  );

  const handleToggleCapabilityForProject = useCallback(
    (projectId: string, capId: string) => {
      const curProj = storeRef.current.projects.find((p) => p.id === projectId);
      if (!curProj) return;
      const { nextCapabilities, action, displayName } =
        togglePackOrSectionCapability(
          capId,
          curProj.enabledCapabilities,
          curProj.localExtensions,
        );

      setStore((prev) =>
        updateProjectById(prev, projectId, (p) => ({
          ...p,
          enabledCapabilities: nextCapabilities,
          updatedAt: new Date().toISOString(),
        })),
      );

      if (projectId === activeProjectIdRef.current) {
        setActiveProjectCapabilities(nextCapabilities);
        syncModuleConflictsAndRegenerate(
          curProj,
          nextCapabilities,
          curProj.localExtensions,
        );
      }

      notify(
        action === 'disabled'
          ? `已从「${curProj.name}」停用「${displayName}」`
          : `已为「${curProj.name}」启用「${displayName}」`,
      );
    },
    [
      activeProjectIdRef,
      notify,
      setStore,
      storeRef,
      syncModuleConflictsAndRegenerate,
    ],
  );

  const handleImportProjectLocalExtension = useCallback(
    (projectId: string, raw: unknown) => {
      try {
        const pack = extensionRegistry.validateProjectLocalPack(raw);
        const curProj = storeRef.current.projects.find((p) => p.id === projectId);
        if (!curProj) return;

        const existingLocal = curProj.localExtensions ?? [];
        const replaced = existingLocal.some((p) => p.id === pack.id);
        const nextLocal = replaced
          ? existingLocal.map((p) => (p.id === pack.id ? pack : p))
          : [...existingLocal, pack];
        const nextCaps = curProj.enabledCapabilities.includes(pack.id)
          ? curProj.enabledCapabilities
          : [...curProj.enabledCapabilities, pack.id];

        setStore((prev) =>
          updateProjectById(prev, projectId, (p) => ({
            ...p,
            localExtensions: nextLocal,
            enabledCapabilities: nextCaps,
            updatedAt: new Date().toISOString(),
          })),
        );

        if (projectId === activeProjectIdRef.current) {
          extensionRegistry.setActiveProjectLocalPacks(nextLocal);
          setActiveProjectCapabilities(nextCaps);
          syncModuleConflictsAndRegenerate(curProj, nextCaps, nextLocal);
        }

        notify(
          `已将「${pack.name}」添加到项目「${curProj.name}」私有扩展（仅本项目生效，不污染全局扩展库）`,
        );
      } catch (err) {
        notify(
          `项目私有扩展包校验失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [
      activeProjectIdRef,
      notify,
      setStore,
      storeRef,
      syncModuleConflictsAndRegenerate,
    ],
  );

  const handleRemoveProjectLocalExtension = useCallback(
    (projectId: string, packId: string) => {
      const curProj = storeRef.current.projects.find((p) => p.id === projectId);
      if (!curProj) return;
      const nextLocal = (curProj.localExtensions ?? []).filter((p) => p.id !== packId);
      const hasGlobalFallback = Boolean(extensionRegistry.get(packId));
      const nextCaps = hasGlobalFallback
        ? curProj.enabledCapabilities
        : curProj.enabledCapabilities.filter(
            (id) => id !== packId && !id.startsWith(`${packId}.`),
          );

      setStore((prev) =>
        updateProjectById(prev, projectId, (p) => ({
          ...p,
          localExtensions: nextLocal,
          enabledCapabilities: nextCaps,
          updatedAt: new Date().toISOString(),
        })),
      );

      if (projectId === activeProjectIdRef.current) {
        extensionRegistry.setActiveProjectLocalPacks(nextLocal);
        setActiveProjectCapabilities(nextCaps);
        syncModuleConflictsAndRegenerate(curProj, nextCaps, nextLocal);
      }

      notify(
        hasGlobalFallback
          ? '已移出项目锁定扩展包，自动回退使用全局扩展库版本'
          : '已从当前项目移除私有扩展包',
      );
    },
    [
      activeProjectIdRef,
      notify,
      setStore,
      storeRef,
      syncModuleConflictsAndRegenerate,
    ],
  );

  const handlePromoteLocalExtensionToGlobal = useCallback(
    (pack: PolyExtensionPack) => {
      try {
        extensionRegistry.importPack(pack);
        setExtRevision((r) => r + 1);
        notify(`已将「${pack.name}」保存到全局扩展库，其他项目现可直接启用`);
      } catch (err) {
        notify(
          `保存到全局库失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [notify],
  );

  const handleAttachLibsToProjectPack = useCallback(
    (projectId: string, packId: string, files: UploadedScriptLibFile[]) => {
      const curProj = storeRef.current.projects.find((p) => p.id === projectId);
      if (!curProj) return;
      const target = (curProj.localExtensions ?? []).find((p) => p.id === packId);
      if (!target) return;
      try {
        const mergedLibs = mergeAttachedLibFiles(
          target.libs,
          files.map((f) => ({
            moduleName: f.moduleName,
            language: f.language,
            source: f.source,
            role: f.scanForBlocks ? 'entry' : 'helper',
          })),
        );
        const validated = extensionRegistry.validateProjectLocalPack({
          ...target,
          libs: mergedLibs,
        });
        const nextLocal = (curProj.localExtensions ?? []).map((p) =>
          p.id === packId ? validated : p,
        );
        setStore((prev) =>
          updateProjectById(prev, projectId, (p) => ({
            ...p,
            localExtensions: nextLocal,
            updatedAt: new Date().toISOString(),
          })),
        );
        if (projectId === activeProjectIdRef.current) {
          extensionRegistry.setActiveProjectLocalPacks(nextLocal);
          syncModuleConflictsAndRegenerate(
            curProj,
            curProj.enabledCapabilities,
            nextLocal,
          );
        }
        notify(
          `已为项目私有包「${validated.name}」附加 ${files.length} 个源码模块（当前共 ${mergedLibs.length} 个 libs[]）`,
        );
      } catch (err) {
        notify(
          `附加库源码失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [
      activeProjectIdRef,
      notify,
      setStore,
      storeRef,
      syncModuleConflictsAndRegenerate,
    ],
  );

  const handleAttachLibsToGlobalPack = useCallback(
    (packId: string, files: UploadedScriptLibFile[]) => {
      const target = extensionRegistry.get(packId);
      if (!target) return;
      try {
        const mergedLibs = mergeAttachedLibFiles(
          target.libs,
          files.map((f) => ({
            moduleName: f.moduleName,
            language: f.language,
            source: f.source,
            role: f.scanForBlocks ? 'entry' : 'helper',
          })),
        );
        const updated = extensionRegistry.importPack({
          ...target,
          libs: mergedLibs,
        });
        setExtRevision((r) => r + 1);
        const curProj = getActiveProject(storeRef.current);
        syncModuleConflictsAndRegenerate(
          curProj,
          curProj.enabledCapabilities,
          curProj.localExtensions,
        );
        notify(
          `已为全局扩展包「${updated.name}」附加 ${files.length} 个源码模块（当前共 ${mergedLibs.length} 个 libs[]）`,
        );
      } catch (err) {
        notify(
          `附加库源码失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [notify, storeRef, syncModuleConflictsAndRegenerate],
  );

  const handleApplyTargetProfile = useCallback(
    (projectId: string, profileId: string) => {
      const globalMatch = targetProfileRegistry
        .listAll()
        .find((p) => p.id === profileId);
      if (!globalMatch) {
        // Strategy 1 guard: never overwrite a project-locked board absent from global registry with a fallback board
        return;
      }
      const profile = globalMatch;
      const curProj = storeRef.current.projects.find((p) => p.id === projectId);
      if (!curProj) return;

      setStore((prev) =>
        updateProjectById(prev, projectId, (p) =>
          applyTargetProfileToProject(p, profile),
        ),
      );

      if (projectId === activeProjectIdRef.current) {
        const nextPools = extensionRegistry
          .getChannelPools(profile.capabilities, curProj.localExtensions)
          .map((entry) => entry.pool);
        setActiveChannelPoolConfigs(
          getAllHandleChannelPoolConfigs(getActiveHandle(curProj), nextPools),
        );
        setActiveProjectCapabilities(profile.capabilities);
        syncModuleConflictsAndRegenerate(
          curProj,
          profile.capabilities,
          curProj.localExtensions,
        );
      }

      notify(`已为「${curProj.name}」应用板型规格「${profile.name}」`);
    },
    [
      activeProjectIdRef,
      notify,
      setStore,
      storeRef,
      syncModuleConflictsAndRegenerate,
    ],
  );

  const handleImportBoardProfileJson = useCallback(
    (raw: unknown): TargetProfile | null => {
      try {
        const imported = targetProfileRegistry.importProfile(raw);
        setProfileRevision((r) => r + 1);
        notify(`已导入目标板型规格「${imported.name}」`);
        return imported;
      } catch (err) {
        notify(
          `板型规格校验失败：${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    },
    [notify],
  );

  const handleRemoveProfile = useCallback(
    (profileId: string) => {
      const ok = targetProfileRegistry.removeProfile(profileId);
      if (!ok) {
        notify('至少需保留 1 个目标板型规格');
        return;
      }
      const fallbackProfileId = targetProfileRegistry.getDefaultProfileId();
      setProfileRevision((r) => r + 1);
      setStore((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.targetProfileId === profileId &&
          p.localTargetProfile?.id !== profileId
            ? { ...p, targetProfileId: fallbackProfileId }
            : p,
        ),
      }));
      notify('已移除目标板型规格');
    },
    [notify, setStore],
  );

  const handleImportExtensionJson = useCallback(
    (raw: unknown) => {
      try {
        const imported = extensionRegistry.importPack(raw);
        setExtRevision((r) => r + 1);
        const curProj = getActiveProject(storeRef.current);
        const nextCaps = curProj.enabledCapabilities.includes(imported.id)
          ? curProj.enabledCapabilities
          : [...curProj.enabledCapabilities, imported.id];
        setStore((prev) =>
          updateProjectById(prev, curProj.id, (p) => ({
            ...p,
            enabledCapabilities: p.enabledCapabilities.includes(imported.id)
              ? p.enabledCapabilities
              : [...p.enabledCapabilities, imported.id],
            updatedAt: new Date().toISOString(),
          })),
        );
        setActiveProjectCapabilities(nextCaps);
        syncModuleConflictsAndRegenerate(
          curProj,
          nextCaps,
          curProj.localExtensions,
        );
        notify(
          `已导入并启用全局扩展包「${imported.name}」（${getAllPackBlocks(imported).length} 个积木）`,
        );
      } catch (err) {
        notify(
          `扩展包校验失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [notify, setStore, storeRef, syncModuleConflictsAndRegenerate],
  );

  const handleRemoveGlobalPack = useCallback(
    (packId: string) => {
      const ok = extensionRegistry.removePack(packId);
      if (!ok) return;
      setExtRevision((r) => r + 1);
      const curProj = getActiveProject(storeRef.current);
      const curHasLocked = Boolean(
        curProj.localExtensions?.some((lp) => lp.id === packId),
      );
      const nextCaps = curHasLocked
        ? curProj.enabledCapabilities
        : curProj.enabledCapabilities.filter(
            (id) => id !== packId && !id.startsWith(`${packId}.`),
          );
      setStore((prev) => ({
        ...prev,
        projects: prev.projects.map((p) =>
          p.localExtensions?.some((lp) => lp.id === packId)
            ? p
            : {
                ...p,
                enabledCapabilities: p.enabledCapabilities.filter(
                  (id) => id !== packId && !id.startsWith(`${packId}.`),
                ),
              },
        ),
      }));
      setActiveProjectCapabilities(nextCaps);
      syncModuleConflictsAndRegenerate(
        curProj,
        nextCaps,
        curProj.localExtensions,
      );
      notify('已从全局库移除该扩展包');
    },
    [notify, setStore, storeRef, syncModuleConflictsAndRegenerate],
  );

  const handleResetDefaultCatalog = useCallback(() => {
    extensionRegistry.resetToDefaults();
    targetProfileRegistry.resetToDefaults();
    const validGlobalPackIds = new Set(
      extensionRegistry.listAll().map((p) => p.id),
    );
    const validGlobalProfileIds = new Set(
      targetProfileRegistry.listAll().map((p) => p.id),
    );
    const fallbackProfileId = targetProfileRegistry.getDefaultProfileId();

    let nextActiveCaps: string[] = [];
    setStore((prev) => ({
      ...prev,
      projects: prev.projects.map((p) => {
        const localPackIds = new Set((p.localExtensions ?? []).map((lp) => lp.id));
        const prunedCaps = p.enabledCapabilities.filter((c) => {
          const baseId = c.includes('.') ? c.slice(0, c.indexOf('.')) : c;
          return validGlobalPackIds.has(baseId) || localPackIds.has(baseId);
        });
        const hasValidBoard =
          validGlobalProfileIds.has(p.targetProfileId) ||
          p.localTargetProfile?.id === p.targetProfileId;
        const nextBoardId = hasValidBoard ? p.targetProfileId : fallbackProfileId;
        if (p.id === prev.activeProjectId) {
          nextActiveCaps = prunedCaps;
        }
        return {
          ...p,
          targetProfileId: nextBoardId,
          enabledCapabilities: prunedCaps,
        };
      }),
    }));

    setExtRevision((r) => r + 1);
    setProfileRevision((r) => r + 1);
    const curProj = getActiveProject(storeRef.current);
    const effectiveCaps =
      nextActiveCaps.length > 0 || curProj.enabledCapabilities.length === 0
        ? nextActiveCaps
        : curProj.enabledCapabilities;
    setActiveProjectCapabilities(effectiveCaps);
    syncModuleConflictsAndRegenerate(
      curProj,
      effectiveCaps,
      curProj.localExtensions,
    );
    notify('已恢复出厂默认扩展包与目标板型列表');
  }, [notify, setStore, storeRef, syncModuleConflictsAndRegenerate]);

  return {
    extRevision,
    profileRevision,
    allExtensionPacks,
    allTargetProfiles,
    extraCategories,
    activeSimPacks,
    runtimeMonitorSummary,
    activeChannelPools,
    activeChannelPoolConfigs,
    activeModuleResolution,
    activeSharedModule,
    handleToggleCapabilityForProject,
    handleImportProjectLocalExtension,
    handleRemoveProjectLocalExtension,
    handlePromoteLocalExtensionToGlobal,
    handleAttachLibsToProjectPack,
    handleAttachLibsToGlobalPack,
    handleApplyTargetProfile,
    handleImportBoardProfileJson,
    handleRemoveProfile,
    handleImportExtensionJson,
    handleRemoveGlobalPack,
    handleResetDefaultCatalog,
  };
}
