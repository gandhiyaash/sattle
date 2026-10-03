/**
 * In-app updates come from Google Play, so only Android has them: Metro picks
 * nativeUpdates.android.ts there. iOS and the web get nothing. The App Store
 * updates on its own schedule, and the web app is always the newest build.
 */

import type { NativeUpdates } from './updater';

export const nativeUpdates: NativeUpdates | null = null;
