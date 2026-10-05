/**
 * Whether this device has been shown the first-launch tour. Web:
 * localStorage, guarded the same way as the account token; losing it just
 * means the tour is shown once more.
 *
 * Native uses tourStore.native.ts instead; Metro picks that file on iOS and
 * Android.
 */

const KEY = 'sattle.toured';

export async function readToured(): Promise<boolean> {
  try {
    return globalThis.localStorage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export async function writeToured(): Promise<void> {
  try {
    globalThis.localStorage?.setItem(KEY, '1');
  } catch {
    // Storage blocked: the tour is over until the tab closes.
  }
}
