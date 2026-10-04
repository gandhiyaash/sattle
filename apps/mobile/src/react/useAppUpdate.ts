/**
 * The app's one updater, and the two ways React touches it: App.tsx keeps it
 * checking, UpdateBanner shows where it's at. See updates/updater.ts.
 */

import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { nativeUpdates } from '../updates/nativeUpdates';
import { createUpdater, type UpdateState } from '../updates/updater';

const updater = createUpdater(nativeUpdates);

/**
 * Checks for an update now and each time the app comes back to the
 * foreground. Returns the cleanup, so it drops straight into an effect.
 */
export function watchForUpdates(): () => void {
  if (!nativeUpdates) return () => {};
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
