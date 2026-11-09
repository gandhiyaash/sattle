/**
 * Only iPhones are updated from the App Store: Metro picks nativeAppStore.ios.ts
 * there. Android has Play's in-app updates instead (nativeUpdates.android.ts),
 * and the web app is always the newest build.
 */

import type { NativeAppStore } from './appStore';

export const nativeAppStore: NativeAppStore | null = null;
