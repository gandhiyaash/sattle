/**
 * Android's half of launchUpi.ts. The link is opened as an activity that
 * returns a result, so Android shows its own chooser of the UPI apps on the
 * phone, and whichever one is picked hands back what happened when it closes.
 *
 * What comes back is that app's word, on the payer's own phone. It fills in
 * the claim; it is never proof (see parseUpiResponse).
 */

import { startActivityAsync } from 'expo-intent-launcher';

import { parseUpiResponse } from '@sattle/core';

import type { LaunchUpi } from './launchUpi';

export const launchUpi: LaunchUpi | null = async (uri) => {
  const result = await startActivityAsync('android.intent.action.VIEW', { data: uri });
  return parseUpiResponse(result.extra as Record<string, unknown> | undefined);
};
