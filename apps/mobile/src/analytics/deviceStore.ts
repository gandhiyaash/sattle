/**
 * This install's id for what it reports of itself (analytics.ts): made once
 * and kept, so a guest who later makes an account reads as one person. Web:
 * localStorage, guarded like the account token; losing it just makes a new
 * install. It identifies nothing but this copy of the app.
 *
 * Native uses deviceStore.native.ts instead; Metro picks that file on iOS
 * and Android.
 */

import { newDeviceId } from './tracker';

const KEY = 'sattle.device';

export async function readDeviceId(): Promise<string> {
  try {
    const kept = globalThis.localStorage?.getItem(KEY);
    if (kept) return kept;
    const made = newDeviceId();
    globalThis.localStorage?.setItem(KEY, made);
    return made;
  } catch {
    // Storage blocked: this id lasts until the tab closes.
    return newDeviceId();
  }
}
