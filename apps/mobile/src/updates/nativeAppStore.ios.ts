/** The App Store, through the native module in modules/app-store-updates. */

import { requireOptionalNativeModule } from 'expo';
import { Linking } from 'react-native';

import type { Install, NativeAppStore } from './appStore';

interface AppStoreUpdatesModule {
  install(): Promise<Install>;
  show(appId: number): Promise<void>;
}

// Null in a binary built before the module existed (Expo Go, an old dev build),
// which then runs without the update banner instead of crashing on launch.
const native = requireOptionalNativeModule<AppStoreUpdatesModule>('SattleAppStoreUpdates');

export const nativeAppStore: NativeAppStore | null = native && {
  install: () => native.install(),
  async show(appId, url) {
    try {
      await native.show(appId);
    } catch {
      // The page didn't load in the sheet. The App Store app opens on the same one.
      await Linking.openURL(url);
    }
  },
};
