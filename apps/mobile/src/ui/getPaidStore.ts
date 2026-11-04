/**
 * Whether this device is done with asking where its owner is paid
 * (GetPaidSheet): it asked, or found the account had somewhere already. Web:
 * localStorage, guarded the same way as the account token; losing it just
 * means looking once more.
 *
 * Native uses getPaidStore.native.ts instead; Metro picks that file on iOS
 * and Android.
 */

const KEY = 'sattle.getPaidDone';

export async function readGetPaidDone(): Promise<boolean> {
  try {
    return globalThis.localStorage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export async function writeGetPaidDone(): Promise<void> {
  try {
    globalThis.localStorage?.setItem(KEY, '1');
  } catch {
    // Storage blocked: it looks again at the next launch.
  }
}
