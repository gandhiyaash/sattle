/**
 * Which of the app's one-time tips this device has seen (tips.ts), as the
 * text it is kept as. Web: localStorage, guarded the same way as the account
 * token; losing it just means the tips are shown once more.
 *
 * Native uses tipsStore.native.ts instead; Metro picks that file on iOS and
 * Android.
 */

const KEY = 'sattle.tips';

export async function readTips(): Promise<string | null> {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export async function writeTips(value: string): Promise<void> {
  try {
    globalThis.localStorage?.setItem(KEY, value);
  } catch {
    // Storage blocked: a tip seen stays seen until the tab closes.
  }
}
