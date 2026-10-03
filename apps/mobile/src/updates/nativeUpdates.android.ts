/** Google Play in-app updates, through the native module in modules/in-app-updates. */

import { requireOptionalNativeModule } from 'expo';

import type { FlowResult, InstallProgress, NativeUpdates, UpdateInfo } from './updater';

interface InAppUpdatesModule {
  check(): Promise<UpdateInfo>;
  start(immediate: boolean): Promise<FlowResult>;
  install(): Promise<void>;
  addListener(event: 'onInstallState', listener: (progress: InstallProgress) => void): { remove(): void };
}

// Null in a binary built before the module existed (Expo Go, an old dev build),
// which then runs without update prompts instead of crashing on launch.
const native = requireOptionalNativeModule<InAppUpdatesModule>('SattleInAppUpdates');

export const nativeUpdates: NativeUpdates | null = native && {
  check: () => native.check(),
  start: (immediate) => native.start(immediate),
  install: () => native.install(),
  onProgress: (listener) => {
    const sub = native.addListener('onInstallState', listener);
    return () => sub.remove();
  },
};
