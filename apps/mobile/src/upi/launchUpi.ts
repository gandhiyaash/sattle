/**
 * Opening the payer's UPI app and hearing what it says. Only Android can do
 * that: Metro picks launchUpi.android.ts there. On iOS and the web nothing
 * comes back from a UPI app, so there is no launcher here, and the screen
 * shows what to pay and asks the payer to say when they have.
 */

import type { UpiOutcome } from '@sattle/core';

/** Opens a UPI app on a `upi://pay` link and resolves with what it reported. Throws when no app can open it. */
export type LaunchUpi = (uri: string) => Promise<UpiOutcome>;

export const launchUpi: LaunchUpi | null = null;
