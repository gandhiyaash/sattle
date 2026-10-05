/**
 * Hands a message with a link in it to the share sheet. On web without
 * navigator.share it copies instead. `share` returns a line saying what
 * happened, for under a button, where the caller keeps the link on screen so
 * it can be copied by hand if both are blocked. `sendOrCopy` returns only
 * which it was, for a caller with no room for a line.
 */

import { Platform, Share } from 'react-native';

/**
 * Copies text, for pasting into another app. Returns a line saying what
 * happened, for under the button.
 *
 * Native has no clipboard without another module, so there it opens the
 * share sheet, which has Copy in it. On the web the clipboard API is tried
 * first; the browsers inside chat apps often lack it, so a selected,
 * off-screen field and the old copy command are the fallback.
 */
export async function copyText(text: string): Promise<string> {
  if (Platform.OS !== 'web') {
    const r = await Share.share({ message: text }).catch(() => null);
    return r?.action === Share.sharedAction ? 'Done.' : 'Not copied.';
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'Copied.';
  } catch {
    // No clipboard API, or it refused: fall through.
  }
  try {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    field.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(field);
    if (ok) return 'Copied.';
  } catch {
    // Nothing left to try.
  }
  return 'Couldn’t copy it here. Select the text above and copy it by hand.';
}

/**
 * What became of a message: the share sheet took it, the share sheet was
 * closed without sending, it was copied because there is no share sheet
 * here, or neither could be done.
 */
export type ShareOutcome = 'sent' | 'not-sent' | 'copied' | 'blocked';

export async function sendOrCopy(message: string): Promise<ShareOutcome> {
  if (Platform.OS !== 'web') {
    const r = await Share.share({ message }).catch(() => null);
    return r?.action === Share.sharedAction ? 'sent' : 'not-sent';
  }
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  if (nav?.share) {
    try {
      await nav.share({ text: message });
      return 'sent';
    } catch {
      // Cancelled or refused: fall through to copying.
    }
  }
  try {
    await nav!.clipboard.writeText(message);
    return 'copied';
  } catch {
    return 'blocked';
  }
}

export async function share(message: string, sentNote: string): Promise<string> {
  switch (await sendOrCopy(message)) {
    case 'sent':
      return sentNote;
    case 'not-sent':
      return 'Not sent. Here’s the link:';
    case 'copied':
      return 'Copied. Paste it in a chat.';
    case 'blocked':
      return 'Copy this link and send it:';
  }
}
