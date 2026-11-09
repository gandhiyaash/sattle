/**
 * The UPI apps on the phone, and what each can do with a pay link.
 *
 * NPCI told every payer app to refuse a upi://pay link that another app
 * opens when the payee is a person rather than a merchant (circular OC/76A,
 * in force since 1 April 2024). Apps that do say something about a limit
 * when they refuse. A debt here is always owed to a person, so an app that
 * refuses is never sent the link: the UPI ID is copied, the app is opened
 * plain, and the payer pastes it in and types the amount. Apps that still
 * take the link open with everything filled in, and on Android some hand
 * back what happened.
 *
 * Which apps refuse differs by phone. On Android, Google Pay and PhonePe do.
 * On an iPhone every app tried so far does except CRED.
 */

/** A UPI app on the phone, as Android's native module lists it (modules/upi-apps), or as an iPhone finds it (IPHONE_UPI_APPS). */
export interface UpiApp {
  /** Android's name for it, which is what Android opens it by. On an iPhone, the same app's Android name. */
  packageName: string;
  /** The name under its icon. */
  name: string;
  /**
   * Its icon: on Android a data: URL of the phone's own, on an iPhone the address of its App
   * Store icon, which is the most an iPhone can have of another app's. Null when there is none.
   */
  icon: string | null;
  /** Whether it takes a pay link from another app. One that doesn't is opened plain, with the UPI ID copied for it. */
  takesLink: boolean;
}

const REFUSE_LINKS: ReadonlySet<string> = new Set([
  'com.google.android.apps.nbu.paisa.user', // Google Pay
  'com.phonepe.app', // PhonePe
]);
// Known to take the link on a real phone, and so not above: CRED (com.dreamplug.androidapp),
// seen in October 2026; Paytm, by developer reports. An app found refusing goes in the set.

/** Whether `app` refuses a pay link from another app on Android, so it is paid in by hand instead. */
export function refusesLinks(app: Pick<UpiApp, 'packageName'>): boolean {
  return REFUSE_LINKS.has(app.packageName);
}

/**
 * A UPI app an iPhone can look for. iOS lists no apps. All Sattle can do is ask whether a URL
 * scheme opens something, and only for the schemes app.json names under
 * LSApplicationQueriesSchemes. So an iPhone's list is whichever of these apps are on it.
 *
 * Each is opened on its own scheme. A `upi://pay` link goes to whichever UPI app iOS picks,
 * and nobody can choose which, so it's only for a phone with none of these.
 */
export interface IphoneUpiApp {
  /** The same app's Android package. */
  packageName: string;
  name: string;
  /** Its App Store id, which its icon is looked up by. */
  appStoreId: number;
  /** Its URL schemes. Any one of them opening shows it's on the phone; the first that does opens it. */
  schemes: readonly string[];
  /** Where its pay link goes after `<scheme>://`, in place of upi://pay. Null for an app that refuses the link. */
  payPath: string | null;
}

/**
 * The schemes are from payment providers' iOS guides; none is Apple's or the apps' own word.
 * Google Pay is `tez` in most and `gpay` in some, YONO `sbiyono` or `yono`, and Navi `navipay`
 * or `navi`, so both are tried. Every scheme here has to be in app.json too, or iOS answers no for it whether the app
 * is there or not.
 *
 * Which take the link was tried on Om's iPhone in November 2026: only CRED did. Google Pay,
 * PhonePe and BHIM refused it. Paytm, YONO and Navi aren't known to take it, so they're opened
 * plain until one is seen to; then its payPath goes here (Paytm's would be `pay`).
 */
export const IPHONE_UPI_APPS: readonly IphoneUpiApp[] = [
  { packageName: 'com.google.android.apps.nbu.paisa.user', name: 'Google Pay', appStoreId: 1193357041, schemes: ['tez', 'gpay'], payPath: null },
  { packageName: 'com.phonepe.app', name: 'PhonePe', appStoreId: 1170055821, schemes: ['phonepe'], payPath: null },
  { packageName: 'net.one97.paytm', name: 'Paytm', appStoreId: 473941634, schemes: ['paytmmp'], payPath: null },
  { packageName: 'com.dreamplug.androidapp', name: 'CRED', appStoreId: 1428580080, schemes: ['credpay'], payPath: 'upi/pay' },
  { packageName: 'in.org.npci.upiapp', name: 'BHIM', appStoreId: 1200315258, schemes: ['bhim'], payPath: null },
  { packageName: 'com.sbi.lotusintouch', name: 'YONO SBI', appStoreId: 1231393474, schemes: ['sbiyono', 'yono'], payPath: null },
  { packageName: 'com.naviapp', name: 'Navi', appStoreId: 1541152485, schemes: ['navipay', 'navi'], payPath: null },
];

/** An iPhone app found on the phone, with the scheme that opened. */
export interface FoundIphoneApp {
  app: IphoneUpiApp;
  scheme: string;
}

/**
 * Which of `apps` are on this iPhone, in their order. `canOpen` is iOS's question (Linking.canOpenURL),
 * and an app it can't answer for counts as not there.
 */
export async function findIphoneApps(
  canOpen: (url: string) => Promise<boolean>,
  apps: readonly IphoneUpiApp[] = IPHONE_UPI_APPS
): Promise<FoundIphoneApp[]> {
  const found = await Promise.all(
    apps.map(async (app) => {
      for (const scheme of app.schemes) {
        if (await canOpen(`${scheme}://`).catch(() => false)) return { app, scheme };
      }
      return null;
    })
  );
  return found.filter((f): f is FoundIphoneApp => f !== null);
}

/** `uri`, a upi://pay link, as the link that opens it on `scheme`'s `payPath`, with the same payee, amount and note. */
export function iphonePayLink(uri: string, scheme: string, payPath: string): string {
  return uri.replace(/^upi:\/\/pay(?=\?|$)/, `${scheme}://${payPath}`);
}

/**
 * Apple's public lookup of these apps' App Store listings, which carry their icons. One request
 * names every app on the list, whichever are on the phone, so it tells Apple nothing about them.
 */
export function iconLookupUrl(apps: readonly IphoneUpiApp[] = IPHONE_UPI_APPS): string {
  return `https://itunes.apple.com/lookup?id=${apps.map((a) => a.appStoreId).join(',')}&country=in`;
}

/** Each app's icon in a lookup answer, by App Store id. Only https addresses, which is all Apple gives. */
export function parseIcons(body: unknown): Map<number, string> {
  const icons = new Map<number, string>();
  const results: unknown = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return icons;
  for (const r of results as Record<string, unknown>[]) {
    const url = r?.artworkUrl512 ?? r?.artworkUrl100;
    if (typeof r?.trackId === 'number' && typeof url === 'string' && url.startsWith('https://')) icons.set(r.trackId, url);
  }
  return icons;
}
