/**
 * Where this device keeps its account token. Web: localStorage, which a
 * private window or cleared site data can empty, so every access is guarded
 * and a missing token just means "make a new account".
 *
 * Native uses tokenStore.native.ts (the OS keychain/keystore) instead; Metro
 * picks that file on iOS and Android.
 */

const KEY = 'sattle.token';

export async function readToken(): Promise<string | null> {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export async function writeToken(token: string): Promise<void> {
  try {
    globalThis.localStorage?.setItem(KEY, token);
  } catch {
    // Storage blocked: the account works until the tab closes.
  }
}

export async function clearToken(): Promise<void> {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Nothing stored, then.
  }
}
