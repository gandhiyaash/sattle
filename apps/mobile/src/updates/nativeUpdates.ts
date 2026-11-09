/**
 * In-app updates come from Google Play, so only Android has them: Metro picks
 * nativeUpdates.android.ts there. An iPhone asks the App Store instead
 * (nativeAppStore.ios.ts), and the web app is always the newest build.
 */

import type { NativeUpdates } from './updater';

export const nativeUpdates: NativeUpdates | null = null;
