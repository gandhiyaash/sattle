/**
 * An iPhone's half of launchUpi.ts. iOS can't list the phone's apps, so this
 * looks for the UPI apps it knows (IPHONE_UPI_APPS) by their URL schemes, and
 * opens the one picked on its own scheme. A plain upi://pay link would go to
 * whichever UPI app iOS chose, and the payer can't change that.
 *
 * An iPhone can't read another app's icon either, so each app's is its App
 * Store icon, from Apple's public lookup. Without an answer in time, the
 * sheet shows initials.
 *
 * Nothing comes back from the app. The flow asks the payer once they return.
 */

import { Linking } from 'react-native';

import type { UpiLauncher } from './launchUpi';
import {
  findIphoneApps,
  iconLookupUrl,
  iphonePayLink,
  IPHONE_UPI_APPS,
  parseIcons,
  type FoundIphoneApp,
  type UpiApp,
} from './upiApps';

const canOpen = (url: string) => Linking.canOpenURL(url);

/** How long the sheet waits for the icons. The payee is fetched alongside, so this rarely adds anything. */
const ICONS_WAIT_MS = 3000;

// Asked of Apple once a launch, and again after a failure.
let icons: Promise<Map<number, string>> | null = null;

function appIcons(): Promise<Map<number, string>> {
  if (!icons) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), ICONS_WAIT_MS);
    icons = fetch(iconLookupUrl(), { signal: abort.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Apple's lookup answered ${res.status}`))))
      .then(parseIcons)
      .catch(() => {
        icons = null;
        return new Map<number, string>();
      })
      .finally(() => clearTimeout(timer));
  }
  return icons;
}

/** `app` as it is on this phone now: asked again each time, since it may have gone since the list was made. */
async function onPhone(app: UpiApp): Promise<FoundIphoneApp> {
  const known = IPHONE_UPI_APPS.filter((a) => a.packageName === app.packageName);
  const [found] = await findIphoneApps(canOpen, known);
  if (!found) throw new Error(`${app.name} isn’t on this iPhone`);
  return found;
}

export const upiLauncher: UpiLauncher = {
  hearsBack: false,
  async apps() {
    const [found, icon] = await Promise.all([findIphoneApps(canOpen), appIcons()]);
    if (!found.length) return null;
    return found.map(({ app }) => ({
      packageName: app.packageName,
      name: app.name,
      icon: icon.get(app.appStoreId) ?? null,
      takesLink: app.payPath !== null,
    }));
  },
  async pay(uri, app) {
    if (!app) {
      await Linking.openURL(uri);
      return null;
    }
    const { app: known, scheme } = await onPhone(app);
    if (!known.payPath) throw new Error(`${app.name} doesn’t take a pay link`);
    await Linking.openURL(iphonePayLink(uri, scheme, known.payPath));
    return null;
  },
  async open(app) {
    await Linking.openURL(`${(await onPhone(app)).scheme}://`);
  },
};
