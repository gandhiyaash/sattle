/**
 * Remembering, through a reload, that this tab handed the payer to a UPI app.
 *
 * A browser hears nothing back from a UPI app, so all a page can know is
 * that the payer left for one and has come back, and then it asks them what
 * happened (useBackFromUpi). Android Chrome often reloads a tab that sat
 * behind another app. Without this the page would come back looking
 * untouched, with nothing to say the payer had just paid and the button for
 * saying so shut away. So it is kept for the tab, in sessionStorage, and
 * read again when the page loads.
 *
 * Only on the web. In the installed app the screen is still there when the
 * payer comes back, so nothing needs keeping, and there is no
 * sessionStorage: every call here does nothing.
 */

const KEY = 'sattle.upi-left';

/** Long enough to pay and come back. Past it, a reload doesn't ask about a payment from some other time. */
export const UPI_LEFT_FRESH_MS = 30 * 60_000;

/**
 * What `raw` says the payer left `scope` to pay, if that was recent. `scope`
 * is the page, and what comes back names the debt on it. Null for anything
 * else: nothing kept, another page's, too old, or not ours.
 */
export function readLeftForUpi(raw: string | null | undefined, scope: string, now: number): string | null {
  if (!raw) return null;
  try {
    const left = JSON.parse(raw) as { scope?: unknown; what?: unknown; at?: unknown };
    if (left.scope !== scope || typeof left.what !== 'string' || typeof left.at !== 'number') return null;
    return now - left.at <= UPI_LEFT_FRESH_MS ? left.what : null;
  } catch {
    return null;
  }
}

export function noteLeftForUpi(scope: string, what: string, now = Date.now()): void {
  try {
    globalThis.sessionStorage?.setItem(KEY, JSON.stringify({ scope, what, at: now }));
  } catch {
    // Storage blocked: a reload while they're away loses it, and the page is as it was before this existed.
  }
}

export function leftForUpi(scope: string, now = Date.now()): string | null {
  try {
    return readLeftForUpi(globalThis.sessionStorage?.getItem(KEY), scope, now);
  } catch {
    return null;
  }
}

export function forgetLeftForUpi(): void {
  try {
    globalThis.sessionStorage?.removeItem(KEY);
  } catch {
    // Nothing was kept.
  }
}
