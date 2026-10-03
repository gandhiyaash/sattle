/**
 * Hands a message with a link in it to the share sheet. On web without
 * navigator.share it copies instead. Returns a line saying what happened, for
 * under the button; callers keep the link on screen either way, so it can be
 * copied by hand if both are blocked.
 */

import { Platform, Share } from 'react-native';

export async function share(message: string, sentNote: string): Promise<string> {
  if (Platform.OS !== 'web') {
    const r = await Share.share({ message }).catch(() => null);
    return r?.action === Share.sharedAction ? sentNote : 'Not sent. Here’s the link:';
  }
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  if (nav?.share) {
    try {
      await nav.share({ text: message });
      return sentNote;
    } catch {
      // Cancelled or refused: fall through to copying.
    }
  }
  try {
    await nav!.clipboard.writeText(message);
    return 'Copied. Paste it in a chat.';
  } catch {
    return 'Copy this link and send it:';
  }
}
