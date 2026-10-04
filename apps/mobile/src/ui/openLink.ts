/**
 * Opens a link that belongs to another app: a wallet (`lightning:`) or a UPI
 * app (`upi:`).
 *
 * On the web, react-native's Linking opens everything except `tel:` in a new
 * tab (window.open). A browser has nothing to show for `lightning:` in a tab,
 * and on an iPhone nothing happens at all: Safari only hands a link to an
 * app when the page itself goes to it. So on the web the page navigates. The
 * page stays where it is when an app takes the link.
 *
 * Rejects on native when no app can open it. The web can't tell.
 */

import { Linking, Platform } from 'react-native';

export async function openAppLink(uri: string): Promise<void> {
  if (Platform.OS !== 'web') {
    await Linking.openURL(uri);
    return;
  }
  window.location.href = uri;
}
