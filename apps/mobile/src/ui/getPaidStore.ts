/**
 * Whether this device has asked its owner where to be paid (GetPaidSheet).
 * Web: localStorage, guarded the same way as the account token; losing it
 * just means being asked once more.
 *
 * Native uses getPaidStore.native.ts instead; Metro picks that file on iOS
 * and Android.
 */

const KEY = 'sattle.getPaidAsked';

export async function readGetPaidAsked(): Promise<boolean> {
  try {
    return globalThis.localStorage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export async function writeGetPaidAsked(): Promise<void> {
  try {
    globalThis.localStorage?.setItem(KEY, '1');
  } catch {
    // Storage blocked: it's asked again at the next launch.
  }
}
