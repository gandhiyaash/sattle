/**
 * Updates on an iPhone. iOS has no way for an app to download its own update,
 * so this does the App Store's share of what updater.ts does with Play: it
 * asks Apple's public lookup for the newest version on the App Store, and
 * while that is newer than this one, the banner offers Update. Update shows
 * the App Store's page for the app in a sheet, where one tap updates it.
 *
 *   idle ──newer version on the App Store──▶ available ──update()──▶ App Store sheet
 *
 * Nothing opens by itself. iPhones install updates on their own by default,
 * overnight while charging, so the banner covers the time until then, and
 * the people who have turned that off.
 *
 * This file decides; the native module (modules/app-store-updates) only
 * reports and shows. Nothing here imports React Native, so it runs under
 * vitest against a fake.
 */

import type { UpdateState, Updater } from './updater';

/** What the native module says about this install. */
export interface Install {
  bundleId: string;
  /** CFBundleShortVersionString. */
  version: string;
  osVersion: string;
  /** The phone's region, two letters. Empty when it has none. */
  region: string;
  /** False in TestFlight, an Xcode build or the simulator, which the App Store can't update. */
  fromAppStore: boolean;
}

/** The native seam. See nativeAppStore.ios.ts. */
export interface NativeAppStore {
  install(): Promise<Install>;
  /** Shows the App Store page for `appId` in a sheet, or failing that opens `url` in the App Store app. */
  show(appId: number, url: string): Promise<void>;
}

/** The app's App Store listing, as Apple's lookup reports it. */
export interface Listing {
  version: string;
  appId: number;
  url: string;
  minimumOsVersion: string;
}

/** The part of fetch the lookup uses, so tests can stand in for Apple. */
export type Fetch = (
  url: string,
  init: { cache: 'no-store'; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Apple's lookup is asked at most this often. It is checked on every foreground, and a listing changes rarely. */
export const LOOKUP_EVERY_MS = 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 15_000;

/**
 * A storefront Sattle is sold in: India, where UPI is. A listing's version and id are the same
 * in every storefront, so any one the app is sold in will do.
 */
export const HOME_STOREFRONT = 'in';

/** The storefront to ask first: the phone's region, or the home one when the region isn't a country. */
export function storefront(install: Install): string {
  const region = install.region.toLowerCase();
  return /^[a-z]{2}$/.test(region) ? region : HOME_STOREFRONT;
}

export function lookupUrl(bundleId: string, country: string): string {
  return `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}&country=${country}`;
}

/** The listing in a lookup answer, or null if the app isn't on sale there. */
export function parseListing(body: unknown, bundleId: string): Listing | null {
  const results: unknown = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return null;
  const hit = results.find((r) => (r as { bundleId?: unknown } | null)?.bundleId === bundleId) as
    | Record<string, unknown>
    | undefined;
  if (!hit || typeof hit.version !== 'string' || typeof hit.trackId !== 'number' || typeof hit.trackViewUrl !== 'string') {
    return null;
  }
  return {
    version: hit.version,
    appId: hit.trackId,
    url: hit.trackViewUrl,
    minimumOsVersion: typeof hit.minimumOsVersion === 'string' ? hit.minimumOsVersion : '0',
  };
}

/** Whether version `a` comes after `b`. Dotted numbers, a missing part counting as 0; anything else is never newer. */
export function isNewer(a: string, b: string): boolean {
  const shape = /^\d+(\.\d+)*$/;
  if (!shape.test(a) || !shape.test(b)) return false;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

const IDLE: UpdateState = { phase: 'idle', progress: null };
const AVAILABLE: UpdateState = { phase: 'available', progress: null };

export interface AppStoreOptions {
  fetch?: Fetch;
  now?: () => number;
}

/** `native` is null wherever there is no App Store; then nothing ever happens. */
export function createAppStoreUpdater(
  native: NativeAppStore | null,
  { fetch: get = fetch, now = Date.now }: AppStoreOptions = {},
): Updater {
  let state = IDLE;
  const listeners = new Set<() => void>();

  let checking = false;
  let showing = false;
  let lookedUp = -Infinity;
  // The listing the banner is offering.
  let offer: Listing | null = null;

  const set = (next: UpdateState) => {
    state = next;
    listeners.forEach((l) => l());
  };

  const ask = async (bundleId: string, country: string): Promise<Listing | null> => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), LOOKUP_TIMEOUT_MS);
    try {
      // Apple marks an answer cacheable for hours. no-store makes fetch add `_=<time>`
      // to the address, so the phone's cache can't answer with an old listing.
      const res = await get(lookupUrl(bundleId, country), { cache: 'no-store', signal: abort.signal });
      if (!res.ok) throw new Error(`Apple's lookup answered ${res.status}`);
      return parseListing(await res.json(), bundleId);
    } finally {
      clearTimeout(timer);
    }
  };

  const lookUp = async (install: Install): Promise<Listing | null> => {
    const country = storefront(install);
    const listing = await ask(install.bundleId, country);
    // The phone's region needn't be a storefront Sattle is sold in: someone travelling, or with
    // their region set elsewhere. The version is the same in every storefront, so the home one
    // answers for them.
    if (listing === null && country !== HOME_STOREFRONT) return ask(install.bundleId, HOME_STOREFRONT);
    return listing;
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async check() {
      if (!native || checking || now() - lookedUp < LOOKUP_EVERY_MS) return;
      checking = true;
      try {
        const install = await native.install();
        if (!install.fromAppStore) return;
        const listing = await lookUp(install);
        lookedUp = now();
        // A version this iOS can't run is no use offering: the App Store would only refuse it.
        const newer =
          listing !== null &&
          isNewer(listing.version, install.version) &&
          !isNewer(listing.minimumOsVersion, install.osVersion);
        offer = newer ? listing : null;
        set(newer ? AVAILABLE : IDLE);
      } catch {
        // Offline, or Apple didn't answer. The banner stays as it was, and the next foreground asks again.
      } finally {
        checking = false;
      }
    },

    async update() {
      if (!native || !offer || showing) return;
      showing = true;
      try {
        await native.show(offer.appId, offer.url);
      } catch {
        // Neither the sheet nor the App Store app opened. The banner stays, to try again.
      } finally {
        showing = false;
      }
    },

    // The App Store installs the update and restarts the app itself, so the banner never offers Restart.
    restart: async () => {},
  };
}
