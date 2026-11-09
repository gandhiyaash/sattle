/**
 * The app's one updater, and the two ways React touches it: App.tsx keeps it
 * checking, UpdateBanner shows where it's at. See updates/updater.ts for
 * Play and updates/appStore.ts for the App Store.
 */

import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { createAppStoreUpdater } from '../updates/appStore';
import { nativeAppStore } from '../updates/nativeAppStore';
import { nativeUpdates } from '../updates/nativeUpdates';
import { createUpdater, type UpdateState } from '../updates/updater';

// The App Store on an iPhone, Play on Android. The web has neither, and nothing happens.
const updater = nativeAppStore ? createAppStoreUpdater(nativeAppStore) : createUpdater(nativeUpdates);

/**
 * Checks for an update now and each time the app comes back to the
 * foreground. Returns the cleanup, so it drops straight into an effect.
 */
export function watchForUpdates(): () => void {
  if (!nativeUpdates && !nativeAppStore) return () => {};
  updater.check();
  const sub = AppState.addEventListener('change', (next) => {
    if (next === 'active') updater.check();
  });
  return () => sub.remove();
}

export interface AppUpdate extends UpdateState {
  update: () => Promise<void>;
  restart: () => Promise<void>;
}

export function useAppUpdate(): AppUpdate {
  const state = useSyncExternalStore(updater.subscribe, updater.getState, updater.getState);
  return { ...state, update: updater.update, restart: updater.restart };
}
