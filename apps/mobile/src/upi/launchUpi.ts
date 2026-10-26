/**
 * Opening the payer's UPI app and hearing what it says. Only Android can do
 * that: Metro picks launchUpi.android.ts there. On iOS and the web nothing
 * comes back from a UPI app, so there is no launcher here, and the screen
 * shows what to pay and asks the payer to say when they have.
 */

import type { UpiOutcome } from '@sattle/core';

import type { UpiApp } from './upiApps';

export interface UpiLauncher {
  /** The UPI apps on this phone, each able to open a upi://pay link. Empty when there are none. */
  apps(): Promise<UpiApp[]>;
  /**
   * Opens `uri` in `app`, or without one in whichever app the phone picks, and resolves with what
   * that app reported when it closed. Throws when no app can open it.
   */
  pay(uri: string, app?: UpiApp): Promise<UpiOutcome>;
  /** Opens `app` on its home screen, for a payment the payer makes by hand. Throws when it's gone. */
  open(app: UpiApp): void;
}

export const upiLauncher: UpiLauncher | null = null;
