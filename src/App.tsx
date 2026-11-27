import * as Blockly from 'blockly';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityRail } from './components/ActivityRail';
import {
  BlocklyDialogModal,
  type BlocklyDialogRequest,
} from './components/BlocklyDialogModal';
import {
  BlocklyWorkbench,
  type BlocklyWorkbenchHandle,
} from './components/BlocklyWorkbench';
import { ChannelAliasModal } from './components/ChannelAliasModal';
import { CodeInspector } from './components/CodeInspector';
import { LogConsole } from './components/LogConsole';
import { DevicesPage } from './components/pages/DevicesPage';
import { ExtensionsPage } from './components/pages/ExtensionsPage';
import { ProjectsPage } from './components/pages/ProjectsPage';
import { SettingsPage } from './components/pages/SettingsPage';
import { ProjectExplorer } from './components/ProjectExplorer';
import {
  ProjectSettingsModal,
  type ProjectSettingsTab,
} from './components/ProjectSettingsModal';
import { ScriptLibImportModal } from './components/ScriptLibImportModal';
import { ScriptTabBar } from './components/ScriptTabBar';
import { SharedVarsView } from './components/SharedVarsView';
import { StatusBar } from './components/StatusBar';
import { TopBar } from './components/TopBar';
import type { ChannelAliasPromptRequest } from './core/blocks/workspaceContextBridge';
import { targetProfileRegistry } from './core/capabilities/registry';
import { extensionRegistry } from './core/extensions/registry';
import { useExecutionController } from './hooks/useExecutionController';
import { useExtensionActions } from './hooks/useExtensionActions';
import {
  useProjectStore,
  type ProjectStoreExecutionBridge,
} from './hooks/useProjectStore';
import type { AppSettings, PageId } from './types/project';

const STORAGE_SETTINGS_KEY = 'polyblock.settings.v1';

const VALID_PAGES: PageId[] = [
  'blocks',
  'projects',
  'devices',
  'extensions',
  'settings',
];

function readPageFromHash(): PageId {
  const raw = window.location.hash.replace(/^#\/?/, '').trim() as PageId;
  return VALID_PAGES.includes(raw) ? raw : 'blocks';
}

function loadSavedSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      const speed =
        parsed.executionSpeed === 'fast' ||
        parsed.executionSpeed === 'normal' ||
        parsed.executionSpeed === 'slow'
          ? parsed.executionSpeed
          : 'normal';
      return {
        theme: parsed.theme === 'dark' ? 'dark' : 'light',
        timeoutMs:
          typeof parsed.timeoutMs === 'number' && parsed.timeoutMs >= 1000
            ? parsed.timeoutMs
            : 5000,
        timeSliceMs:
          typeof parsed.timeSliceMs === 'number' &&
          parsed.timeSliceMs >= 5 &&
          parsed.timeSliceMs <= 500
            ? parsed.timeSliceMs
            : 20,
        autoOpenConsoleOnRun: parsed.autoOpenConsoleOnRun ?? true,
        executionSpeed: speed,
      };
    }
  } catch {
    // ignore storage errors
  }
  return {
    theme: 'light',
    timeoutMs: 5000,
    timeSliceMs: 20,
    autoOpenConsoleOnRun: true,
    executionSpeed: 'normal',
  };
}

const NOOP_EXECUTION_BRIDGE: ProjectStoreExecutionBridge = {
  stopIfRunning: () => {},
  isExecutionActive: () => false,
  clearErrorLine: () => {},
  resetExecutionForSwitch: () => {},
  deleteProjectSimState: () => {},
  resetAllSimStates: () => {},
  syncActiveBreakpoints: () => {},
  reportErrorLogs: () => {},
};

export function App() {
  extensionRegistry.ensureInitialized();
  targetProfileRegistry.ensureInitialized();

  const workbenchRef = useRef<BlocklyWorkbenchHandle | null>(null);
  const executionBridgeRef = useRef<ProjectStoreExecutionBridge>(
    NOOP_EXECUTION_BRIDGE,
  );

  const [settings, setSettings] = useState<AppSettings>(loadSavedSettings);
  const [activePage, setActivePage] = useState<PageId>(readPageFromHash);
  const [showCode, setShowCode] = useState<boolean>(true);
  const [showConsole, setShowConsole] = useState<boolean>(true);
  const [showExplorer, setShowExplorer] = useState<boolean>(false);

  const [settingsModal, setSettingsModal] = useState<{
    projectId: string;
    initialTab: ProjectSettingsTab;
    initialHandleId?: string;
  } | null>(null);
  const [scriptLibModal, setScriptLibModal] = useState<{
    targetScope: 'project' | 'global';
    projectId?: string;
  } | null>(null);
  const [aliasModalReq, setAliasModalReq] =
    useState<ChannelAliasPromptRequest | null>(null);
  const [blocklyDialogReq, setBlocklyDialogReq] =
    useState<BlocklyDialogRequest | null>(null);

  const [toastMsg, setToastMsg] = useState<string>('');
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(''), 2400);
  }, []);

  const navigateTo = useCallback((page: PageId) => {
    setActivePage(page);
    const targetHash = `#/${page}`;
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    }
  }, []);

  const projectStore = useProjectStore({
    workbenchRef,
    executionBridgeRef,
    openBlocklyDialog: setBlocklyDialogReq,
    setShowConsole,
    setShowExplorer,
    navigateTo,
    notify,
    dialogRefreshKey: blocklyDialogReq,
  });

  const {
    store,
    setStore,
    storeRef,
    isDirty,
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
    initialScriptWorkspace,
    activeHandleSharedVarNames,
    currentScriptVarNames,
    allHandleVarNames,
    currentScriptFunctionNames,
    allHandleFunctionNames,
    regenerateFromWorkspace,
    flushActiveCanvasIntoStore,
  } = projectStore;

  const extActions = useExtensionActions({
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
  });

  const execution = useExecutionController({
    activePage,
    navigateTo,
    settings,
    setSettings,
    setShowConsole,
    storeRef,
    setStore,
    activeProject,
    activeHandle,
    activeScript,
    language,
    activeProjectIdRef,
    activeHandleIdRef,
    activeScriptIdRef,
    activeChannelPoolConfigs: extActions.activeChannelPoolConfigs,
    activeChannelCounts: extActions.activeChannelCounts,
    activeSimPacks: extActions.activeSimPacks,
    generated,
    setGenerated,
    workbenchRef,
    flushActiveCanvasIntoStore,
    regenerateFromWorkspace,
    notify,
  });

  executionBridgeRef.current = {
    stopIfRunning: execution.stopIfRunning,
    isExecutionActive: execution.isExecutionActive,
    clearErrorLine: execution.clearErrorLine,
    resetExecutionForSwitch: execution.resetExecutionForSwitch,
    deleteProjectSimState: execution.deleteProjectSimState,
    resetAllSimStates: execution.resetAllSimStates,
    syncActiveBreakpoints: execution.syncActiveBreakpoints,
    reportErrorLogs: execution.reportErrorLogs,
  };

  useEffect(() => {
    if (!extActions.activeSharedModule && viewingSharedModule) {
      setViewingSharedModule(false);
    }
  }, [extActions.activeSharedModule, viewingSharedModule, setViewingSharedModule]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
    try {
      localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // ignore storage errors
    }
  }, [settings]);

  // Replace Blockly v12's unstyled default dialog/prompt/confirm/alert with PolyBlock's modal UI
  useEffect(() => {
    Blockly.dialog.setPrompt((message, defaultValue, callback) => {
      setBlocklyDialogReq({
        kind: 'prompt',
        message,
        defaultValue: defaultValue ?? '',
        callback,
      });
    });
    Blockly.dialog.setConfirm((message, callback) => {
      setBlocklyDialogReq({
        kind: 'confirm',
        message,
        callback,
      });
    });
    Blockly.dialog.setAlert((message, callback) => {
      setBlocklyDialogReq({
        kind: 'alert',
        message,
        callback,
      });
    });
  }, []);

  useEffect(() => {
    const onHashChange = () => setActivePage(readPageFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => workbenchRef.current?.resize());
    return () => cancelAnimationFrame(id);
  }, [showCode, showConsole, showExplorer, activePage]);

  const handleCopyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(generated.code);
      notify(`已复制 ${activeScript.name}.${activeBackend.extension} 到剪贴板`);
    } catch {
      notify('复制失败，请手动选中代码复制');
    }
  }, [generated.code, activeScript.name, activeBackend.extension, notify]);

  const handleFocusBlock = useCallback((blockId: string) => {
    workbenchRef.current?.focusBlock(blockId);
  }, []);

  const isRunningOrPaused =
    execution.runnerStatus === 'running' || execution.runnerStatus === 'paused';

  const settingsModalProject = settingsModal
    ? store.projects.find((p) => p.id === settingsModal.projectId) ?? null
    : null;

  return (
    <div className="app-shell">
      <TopBar
        projects={store.projects}
        activeProject={activeProject}
        activeHandleName={activeHandle.name}
        activeScriptName={activeScript.name}
        isDirty={isDirty}
        activePage={activePage}
        theme={settings.theme}
        runnerStatus={execution.runnerStatus}
        multiHandleRunning={execution.multiHandleRunning}
        executionSpeed={settings.executionSpeed}
        showCode={showCode}
        showConsole={showConsole}
        onSelectProject={projectStore.handleSelectProject}
        onCreateBlankProject={projectStore.handleCreateBlankProject}
        onRenameCurrentProject={(name) =>
          projectStore.handleRenameProject(activeProject.id, name)
        }
        onOpenProjectSettings={() =>
          setSettingsModal({
            projectId: activeProject.id,
            initialTab: 'general',
            initialHandleId: activeHandle.id,
          })
        }
        onSaveProjectFile={() => projectStore.handleSaveProjectFile(activeProject.id)}
        onOpenProjectsPage={() => navigateTo('projects')}
        onSelectLanguage={projectStore.handleSelectLanguage}
        onSelectSpeed={execution.handleSelectSpeed}
        onRun={() => execution.launchSingleHandleExecution(false)}
        onRunAllHandles={execution.launchMultiHandleSimulation}
        onStartStepMode={() => execution.launchSingleHandleExecution(true)}
        onResume={execution.handleResume}
        onStepNext={execution.handleStepNext}
        onPause={execution.handlePause}
        onStop={execution.handleStop}
        onExportActiveScript={projectStore.handleExportActiveScript}
        onExportHandleBundle={projectStore.handleExportHandleBundle}
        onExportProjectBundle={projectStore.handleExportProjectBundle}
        onToggleCode={() => setShowCode((v) => !v)}
        onToggleConsole={() => setShowConsole((v) => !v)}
        onToggleTheme={() =>
          setSettings((prev) => ({
            ...prev,
            theme: prev.theme === 'light' ? 'dark' : 'light',
          }))
        }
      />

      <div className="app-body">
        <ActivityRail activePage={activePage} onSelectPage={navigateTo} />

        <main className="workspace-host">
          <div
            className={`workbench-center-col ${
              activePage !== 'blocks' ? 'hidden-pane' : ''
            }`}
          >
            <div className="workbench-split-row">
              {showExplorer && (
                <ProjectExplorer
                  project={activeProject}
                  activeHandleId={activeHandle.id}
                  activeScriptId={activeScript.id}
                  language={language}
                  extension={activeBackend.extension}
                  viewingSharedModule={viewingSharedModule}
                  channelPools={extActions.activeChannelPools}
                  disabled={isRunningOrPaused}
                  onSelectHandleScript={(hdlId, scrId) => {
                    setViewingSharedModule(false);
                    projectStore.handleSelectHandleAndScript(hdlId, scrId);
                  }}
                  onSelectHandleSharedModule={(hdlId) => {
                    if (hdlId !== activeHandle.id) {
                      projectStore.handleSelectHandleAndScript(hdlId);
                    }
                    setViewingSharedModule(true);
                  }}
                  onAddHandle={() => projectStore.handleAddHandle(activeProject.id)}
                  onAddScriptInHandle={(hdlId) =>
                    projectStore.handleAddScriptInHandle(hdlId)
                  }
                  onOpenHandleSettings={(hdlId) =>
                    setSettingsModal({
                      projectId: activeProject.id,
                      initialTab: 'handles',
                      initialHandleId: hdlId,
                    })
                  }
                  onClose={() => setShowExplorer(false)}
                />
              )}

              <div className="blocks-main-col">
                <ScriptTabBar
                  handles={activeProject.handles}
                  activeHandle={activeHandle}
                  scripts={activeHandle.scripts}
                  activeScriptId={activeScript.id}
                  entryScriptId={activeHandle.entryScriptId}
                  extension={activeBackend.extension}
                  channelPools={extActions.activeChannelPools}
                  showExplorer={showExplorer}
                  disabled={isRunningOrPaused}
                  sharedModuleTab={
                    extActions.activeSharedModule
                      ? {
                          fileName: extActions.activeSharedModule.fileName,
                          moduleName: extActions.activeSharedModule.moduleName,
                          itemCount:
                            extActions.activeSharedModule.variables.length +
                            extActions.activeSharedModule.functions.length,
                          varCount: extActions.activeSharedModule.variables.length,
                          fnCount: extActions.activeSharedModule.functions.length,
                        }
                      : null
                  }
                  viewingSharedModule={viewingSharedModule}
                  onSelectSharedModule={() => setViewingSharedModule(true)}
                  onToggleExplorer={() => setShowExplorer((v) => !v)}
                  onSelectHandle={(hdlId) => {
                    setViewingSharedModule(false);
                    projectStore.handleSelectHandleAndScript(hdlId);
                  }}
                  onAddHandle={() => projectStore.handleAddHandle(activeProject.id)}
                  onOpenHandleSettings={(hdlId) =>
                    setSettingsModal({
                      projectId: activeProject.id,
                      initialTab: 'handles',
                      initialHandleId: hdlId,
                    })
                  }
                  onSelectScript={(scrId) => {
                    setViewingSharedModule(false);
                    projectStore.handleSelectHandleAndScript(activeHandle.id, scrId);
                  }}
                  onAddScript={() =>
                    projectStore.handleAddScriptInHandle(activeHandle.id)
                  }
                  onRenameScript={projectStore.handleRenameScript}
                  onDuplicateScript={projectStore.handleDuplicateScript}
                  onSetEntryScript={projectStore.handleSetEntryScript}
                  onDeleteScript={projectStore.handleDeleteScript}
                />

                {viewingSharedModule && extActions.activeSharedModule && (
                  <SharedVarsView
                    handleName={activeHandle.name}
                    handleColor={activeHandle.color}
                    language={language}
                    fileName={extActions.activeSharedModule.fileName}
                    moduleName={extActions.activeSharedModule.moduleName}
                    source={extActions.activeSharedModule.source}
                    variables={extActions.activeSharedModule.variables}
                    functions={extActions.activeSharedModule.functions}
                    disabled={isRunningOrPaused}
                    onCreateSharedVariable={() =>
                      projectStore.handleRequestCreateVariable('shared')
                    }
                    onCreateSharedFunction={() =>
                      projectStore.handleRequestCreateFunction('shared')
                    }
                    onUpdateVarInitialValue={(varName, nextInit) =>
                      projectStore.handleHandleVariableEvent({
                        kind: 'set-initial',
                        name: varName,
                        scope: 'shared',
                        initialValue: nextInit,
                      })
                    }
                    onJumpToFunction={projectStore.handleJumpToSharedFunction}
                    onCopySource={async () => {
                      if (!extActions.activeSharedModule) return;
                      try {
                        await navigator.clipboard.writeText(
                          extActions.activeSharedModule.source,
                        );
                        notify(
                          `已复制 ${extActions.activeSharedModule.fileName} 到剪贴板`,
                        );
                      } catch {
                        notify('复制失败，请手动选中代码复制');
                      }
                    }}
                    onBackToCanvas={() => setViewingSharedModule(false)}
                  />
                )}

                <div
                  className={
                    viewingSharedModule && extActions.activeSharedModule
                      ? 'hidden-pane'
                      : 'blocks-canvas-host'
                  }
                >
                  <BlocklyWorkbench
                    ref={workbenchRef}
                    theme={settings.theme}
                    initialWorkspace={initialScriptWorkspace}
                    visible={
                      activePage === 'blocks' &&
                      !(viewingSharedModule && extActions.activeSharedModule)
                    }
                    executingBlockId={execution.executingBlockId}
                    isPaused={execution.runnerStatus === 'paused'}
                    breakpoints={breakpoints}
                    enabledCapabilities={activeProject.enabledCapabilities}
                    extraCategories={extActions.extraCategories}
                    channelPoolConfigs={extActions.activeChannelPoolConfigs}
                    onWorkspaceChange={projectStore.handleWorkspaceChange}
                    onHandleVariableEvent={projectStore.handleHandleVariableEvent}
                    onRequestCreateVariable={projectStore.handleRequestCreateVariable}
                    onRequestCreateFunction={projectStore.handleRequestCreateFunction}
                    onToggleSharedFunction={projectStore.handleToggleSharedFunction}
                    onHandleFunctionEvent={projectStore.handleHandleFunctionEvent}
                    onSelectBlock={execution.setSelectedBlockId}
                    onToggleBreakpoint={execution.handleToggleBreakpoint}
                    onEditChannelAlias={(req) => setAliasModalReq(req)}
                    onOpenHandleTimerSettings={() =>
                      setSettingsModal({
                        projectId: activeProject.id,
                        initialTab: 'handles',
                        initialHandleId: activeHandle.id,
                      })
                    }
                    onOpenExtensionsPage={() => navigateTo('extensions')}
                  />
                </div>
              </div>

              {showCode && (
                <CodeInspector
                  language={language}
                  scriptName={activeScript.name}
                  generated={generated}
                  selectedBlockId={execution.selectedBlockId}
                  executingBlockId={execution.executingBlockId}
                  isPaused={execution.runnerStatus === 'paused'}
                  runnerStatus={execution.runnerStatus}
                  multiHandleRunning={execution.multiHandleRunning}
                  breakpoints={breakpoints}
                  variables={execution.liveVariables}
                  errorLine={execution.errorLine}
                  enabledCapabilities={activeProject.enabledCapabilities}
                  channelPools={extActions.activeChannelPools}
                  simPacks={extActions.activeSimPacks}
                  simState={execution.simState}
                  projectHandles={activeProject.handles}
                  activeHandle={activeHandle}
                  handleTelemetries={execution.handleTelemetries}
                  onUpdateSimValues={execution.handleUpdateSimValues}
                  onEmitWidgetEvent={(ename, args) =>
                    execution.handleEmitSimEvent(ename, args)
                  }
                  onResetSimPack={execution.handleResetSimPack}
                  onOpenHandleTimerSettings={(hdlId) =>
                    setSettingsModal({
                      projectId: activeProject.id,
                      initialTab: 'handles',
                      initialHandleId: hdlId,
                    })
                  }
                  onSelectBlockFromLine={handleFocusBlock}
                  onToggleBreakpoint={execution.handleToggleBreakpoint}
                  onClearBreakpoints={execution.handleClearBreakpoints}
                  onCopyCode={handleCopyCode}
                />
              )}
            </div>

            {showConsole && (
              <LogConsole
                logs={execution.logs}
                lastDurationMs={execution.lastDurationMs}
                onClear={execution.clearLogs}
                onCollapse={() => setShowConsole(false)}
                onJumpToBlock={handleFocusBlock}
              />
            )}
          </div>

          {activePage === 'projects' && (
            <ProjectsPage
              projects={store.projects}
              activeProjectId={activeProject.id}
              onSelectProject={projectStore.handleSelectProject}
              onCreateBlankProject={projectStore.handleCreateBlankProject}
              onCreateFromTemplate={projectStore.handleCreateFromTemplate}
              onRenameProject={projectStore.handleRenameProject}
              onDuplicateProject={projectStore.handleDuplicateProject}
              onDeleteProject={projectStore.handleDeleteProject}
              onSaveProjectFile={projectStore.handleSaveProjectFile}
              onImportProject={projectStore.handleImportProject}
              onOpenProjectSettings={(pid) =>
                setSettingsModal({ projectId: pid, initialTab: 'general' })
              }
              onReturnToBlocks={() => navigateTo('blocks')}
              onNotify={notify}
            />
          )}

          {activePage === 'devices' && (
            <DevicesPage
              onReturnToBlocks={() => navigateTo('blocks')}
              onNotify={notify}
            />
          )}

          {activePage === 'extensions' && (
            <ExtensionsPage
              activeProjectName={activeProject.name}
              activeProjectLanguage={activeProject.language}
              activeProfileId={activeProject.targetProfileId}
              allPacks={extActions.allExtensionPacks}
              allTargetProfiles={extActions.allTargetProfiles}
              enabledCapabilityIds={activeProject.enabledCapabilities}
              onToggleCapability={(capId) =>
                extActions.handleToggleCapabilityForProject(activeProject.id, capId)
              }
              onApplyTargetProfile={(profileId) =>
                extActions.handleApplyTargetProfile(activeProject.id, profileId)
              }
              onImportExtensionJson={extActions.handleImportExtensionJson}
              onOpenScriptLibImportModal={() =>
                setScriptLibModal({ targetScope: 'global' })
              }
              onAttachLibsToGlobalPack={extActions.handleAttachLibsToGlobalPack}
              onRemoveCustomPack={extActions.handleRemoveCustomPack}
              onImportBoardProfileJson={extActions.handleImportBoardProfileJson}
              onRemoveCustomProfile={extActions.handleRemoveCustomProfile}
              onReturnToBlocks={() => navigateTo('blocks')}
              onNotify={notify}
            />
          )}

          {activePage === 'settings' && (
            <SettingsPage
              settings={settings}
              onUpdateSettings={(patch) => {
                setSettings((prev) => ({ ...prev, ...patch }));
                if (typeof patch.timeSliceMs === 'number') {
                  execution.updateTimeSlice(patch.timeSliceMs);
                }
              }}
              onResetWorkspace={projectStore.handleResetWorkspace}
              onReturnToBlocks={() => navigateTo('blocks')}
            />
          )}
        </main>
      </div>

      <StatusBar
        projectName={activeProject.name}
        handleCount={activeProject.handles.length}
        activeHandleName={activeHandle.name}
        activeScriptName={activeScript.name}
        activeFileLabel={
          viewingSharedModule && extActions.activeSharedModule
            ? `${extActions.activeSharedModule.fileName} (只读)`
            : undefined
        }
        language={language}
        runnerStatus={execution.runnerStatus}
        multiHandleRunning={execution.multiHandleRunning}
        blockCount={generated.blockCount}
        diagnosticCount={generated.diagnostics.length}
        diagnosticErrorCount={
          generated.diagnostics.filter((d) => d.severity === 'error').length
        }
        breakpointCount={breakpoints.length}
        selectedBlockId={execution.selectedBlockId}
      />

      {settingsModalProject && settingsModal && (
        <ProjectSettingsModal
          project={settingsModalProject}
          initialTab={settingsModal.initialTab}
          initialHandleId={settingsModal.initialHandleId}
          allExtensionPacks={extActions.allExtensionPacks}
          allTargetProfiles={extActions.allTargetProfiles}
          disableLanguageSwitch={
            settingsModalProject.id === activeProject.id && isRunningOrPaused
          }
          onClose={() => setSettingsModal(null)}
          onUpdateProjectMeta={projectStore.handleUpdateProjectMeta}
          onApplyTargetProfile={extActions.handleApplyTargetProfile}
          onImportBoardProfileJson={extActions.handleImportBoardProfileJson}
          onAddHandle={projectStore.handleAddHandle}
          onRenameHandle={projectStore.handleRenameHandle}
          onDuplicateHandle={projectStore.handleDuplicateHandle}
          onDeleteHandle={projectStore.handleDeleteHandle}
          onUpdateHandleConfig={projectStore.handleUpdateHandleConfig}
          onToggleCapabilityForProject={extActions.handleToggleCapabilityForProject}
          onImportLocalExtensionJson={extActions.handleImportProjectLocalExtension}
          onOpenScriptLibImportModal={(pid) =>
            setScriptLibModal({ targetScope: 'project', projectId: pid })
          }
          onAttachLibsToLocalPack={extActions.handleAttachLibsToProjectPack}
          onRemoveLocalExtension={extActions.handleRemoveProjectLocalExtension}
          onPromoteLocalExtensionToGlobal={
            extActions.handlePromoteLocalExtensionToGlobal
          }
          onOpenExtensionsPage={() => navigateTo('extensions')}
          onNotify={notify}
        />
      )}

      {scriptLibModal && (
        <ScriptLibImportModal
          targetScope={scriptLibModal.targetScope}
          projectName={
            (scriptLibModal.projectId
              ? store.projects.find((p) => p.id === scriptLibModal.projectId)?.name
              : activeProject.name) ?? activeProject.name
          }
          defaultLanguage={
            (scriptLibModal.projectId
              ? store.projects.find((p) => p.id === scriptLibModal.projectId)?.language
              : activeProject.language) ?? activeProject.language
          }
          onConfirmPack={(pack) => {
            if (scriptLibModal.targetScope === 'project') {
              extActions.handleImportProjectLocalExtension(
                scriptLibModal.projectId ?? activeProject.id,
                pack,
              );
            } else {
              extActions.handleImportExtensionJson(pack);
            }
          }}
          onClose={() => setScriptLibModal(null)}
        />
      )}

      {aliasModalReq !== null && (
        <ChannelAliasModal
          handleName={activeHandle.name}
          handleColor={activeHandle.color}
          channelId={aliasModalReq.channelId}
          prefix={aliasModalReq.prefix}
          poolLabel={aliasModalReq.label}
          currentAlias={
            extActions.activeChannelPoolConfigs[aliasModalReq.configKey]?.aliases[
              String(aliasModalReq.channelId)
            ] ?? ''
          }
          onSave={(alias) =>
            projectStore.handleSaveInlineChannelAlias(aliasModalReq, alias)
          }
          onClose={() => setAliasModalReq(null)}
        />
      )}

      {blocklyDialogReq !== null && (
        <BlocklyDialogModal
          request={blocklyDialogReq}
          language={language}
          handleName={activeHandle.name}
          handleColor={activeHandle.color}
          activeScriptLabel={`${activeScript.name}.${activeBackend.extension}`}
          handleSharedVars={activeHandleSharedVarNames}
          currentScriptVars={currentScriptVarNames}
          allHandleVars={allHandleVarNames}
          handleSharedFunctions={activeHandle.sharedFunctions ?? []}
          currentScriptFunctions={currentScriptFunctionNames}
          allHandleFunctions={allHandleFunctionNames}
          onClose={() => setBlocklyDialogReq(null)}
        />
      )}

      <div className={`toast ${toastMsg ? 'show' : ''}`} role="status">
        {toastMsg}
      </div>
    </div>
  );
}
