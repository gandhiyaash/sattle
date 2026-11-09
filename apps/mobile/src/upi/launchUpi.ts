/**
 * Opening the payer's UPI app of choice. Metro picks launchUpi.android.ts on
 * Android and launchUpi.ios.ts on an iPhone. Only Android hears back from
 * the app; an iPhone opens it, and the payer is asked on their return
 * (useBackFromUpi). The web has no launcher: the screen shows what to pay,
 * and a phone's browser opens whatever UPI app takes the link.
 */

import type { UpiOutcome } from '@sattle/core';

import type { UpiApp } from './upiApps';

export interface UpiLauncher {
  /** Whether the app opened says what happened when it closes. False on an iPhone, which then asks the payer once they're back. */
  hearsBack: boolean;
  /**
   * The UPI apps on this phone, each able to take a pay link. Empty when there are none. Null
   * when the phone can't say: an iPhone with none of the apps it knows how to look for, where
   * one it doesn't know may still take the link.
   */
  apps(): Promise<UpiApp[] | null>;
  /**
   * Opens `uri` in `app`, or without one in whichever app the phone picks. Resolves with what that
   * app reported when it closed, or with null at once when it won't report (`hearsBack` false).
   * Throws when no app can open it.
   */
  pay(uri: string, app?: UpiApp): Promise<UpiOutcome | null>;
  /** Opens `app` on its home screen, for a payment the payer makes by hand. Throws when it's gone. */
  open(app: UpiApp): Promise<void>;
}

export const upiLauncher: UpiLauncher | null = null;
