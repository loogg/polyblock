import { useSyncExternalStore } from 'react';
import { backendRegistry } from '../core/backends/registry';
import { runnerManager } from '../core/runners/manager';

function subscribe(onStoreChange: () => void): () => void {
  const unsubPlugins = backendRegistry.onPluginChange(onStoreChange);
  const unsubRunners = runnerManager.onChange(onStoreChange);
  return () => {
    unsubPlugins();
    unsubRunners();
  };
}

function getSnapshot(): string {
  return `${backendRegistry.getRevision()}:${runnerManager.getRevision()}`;
}

/**
 * Subscribes a React component to runtime `LanguagePlugin` & `ScriptRunner` registrations,
 * ensuring hot-registered/unregistered languages or hardware runners immediately refresh the UI.
 */
export function useLanguagePluginsRevision(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
