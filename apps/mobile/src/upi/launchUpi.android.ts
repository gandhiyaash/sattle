/**
 * Android's half of launchUpi.ts, over the native module in modules/upi-apps.
 * A link is opened as an activity that returns a result, aimed at the app the
 * payer picked, and that app hands back what happened when it closes.
 *
 * What comes back is that app's word, on the payer's own phone. It fills in
 * the claim; it is never proof (see parseUpiResponse).
 */

import { requireOptionalNativeModule } from 'expo';

import { parseUpiResponse } from '@sattle/core';

import type { UpiLauncher } from './launchUpi';
import type { UpiApp } from './upiApps';

interface UpiAppsModule {
  list(uri: string): Promise<UpiApp[]>;
  pay(uri: string, packageName: string | null): Promise<{ resultCode: number; extra?: Record<string, unknown> }>;
  open(packageName: string): void;
}

/** Any pay link does: Android lists the apps by what the link starts with. */
const PROBE = 'upi://pay?pa=sattle@upi';

// Null in a binary built before the module existed (Expo Go, an old dev build). The phone then
// does what an iPhone does: the link is opened, and nothing is heard back.
const native = requireOptionalNativeModule<UpiAppsModule>('SattleUpiApps');

export const upiLauncher: UpiLauncher | null = native && {
  apps: () => native.list(PROBE),
  pay: async (uri, app) => parseUpiResponse((await native.pay(uri, app?.packageName ?? null)).extra),
  open: (app) => native.open(app.packageName),
};
