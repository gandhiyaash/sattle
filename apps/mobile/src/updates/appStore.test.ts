import { describe, expect, it } from 'vitest';

import {
  LOOKUP_EVERY_MS,
  createAppStoreUpdater,
  isNewer,
  lookupUrl,
  parseListing,
  type Fetch,
  type Install,
  type NativeAppStore,
} from './appStore';

const install = (over: Partial<Install> = {}): Install => ({
  bundleId: 'tech.sattle.app',
  version: '1.2.0',
  osVersion: '18.2.0',
  region: 'IN',
  fromAppStore: true,
  ...over,
});

const answer = (over: Record<string, unknown> = {}) => ({
  resultCount: 1,
  results: [
    {
      bundleId: 'tech.sattle.app',
      version: '1.3.0',
      trackId: 6700000001,
      trackViewUrl: 'https://apps.apple.com/in/app/sattle/id6700000001?uo=4',
      minimumOsVersion: '16.4',
      ...over,
    },
  ],
});

/** The phone and Apple, scripted: `install` is what the phone says, `body` what the lookup answers. */
function fakeStore(initial: Install = install(), body: unknown = answer()) {
  const store = {
    install: initial,
    body,
    status: 200,
    failLookup: false,
    failShow: false,
    clock: 1_000_000,
    asked: [] as string[],
    shown: [] as [number, string][],
    native: null as unknown as NativeAppStore,
    fetch: null as unknown as Fetch,
  };
  store.native = {
    install: async () => store.install,
    show: async (appId, url) => {
      store.shown.push([appId, url]);
      if (store.failShow) throw new Error('no App Store');
    },
  };
  store.fetch = async (url) => {
    store.asked.push(url);
    if (store.failLookup) throw new Error('offline');
    return { ok: store.status === 200, status: store.status, json: async () => store.body };
  };
  const updater = createAppStoreUpdater(store.native, { fetch: store.fetch, now: () => store.clock });
  return { store, updater };
}

describe('isNewer', () => {
  it('compares dotted versions part by part, not as text', () => {
    expect(isNewer('1.10.0', '1.9.0')).toBe(true);
    expect(isNewer('2.0.0', '1.99.99')).toBe(true);
    expect(isNewer('1.9.0', '1.10.0')).toBe(false);
  });

  it('counts a missing part as 0, so equal versions are never newer', () => {
    expect(isNewer('1.2', '1.2.0')).toBe(false);
    expect(isNewer('1.2.0', '1.2')).toBe(false);
    expect(isNewer('1.2.1', '1.2')).toBe(true);
  });

  it('never calls something that is not a version newer', () => {
    expect(isNewer('1.3.0', '')).toBe(false);
    expect(isNewer('', '1.2.0')).toBe(false);
    expect(isNewer('1.3.0-beta', '1.2.0')).toBe(false);
  });
});

describe('lookupUrl', () => {
  it("asks the storefront of the phone's region for this bundle ID", () => {
    expect(lookupUrl(install())).toBe('https://itunes.apple.com/lookup?bundleId=tech.sattle.app&country=in');
  });

  it('leaves the country out when the region is not two letters', () => {
    expect(lookupUrl(install({ region: '' }))).toBe('https://itunes.apple.com/lookup?bundleId=tech.sattle.app');
    expect(lookupUrl(install({ region: '419' }))).toBe('https://itunes.apple.com/lookup?bundleId=tech.sattle.app');
  });
});

describe('parseListing', () => {
  it('reads the version, the id, the page and the oldest iOS it runs on', () => {
    expect(parseListing(answer(), 'tech.sattle.app')).toEqual({
      version: '1.3.0',
      appId: 6700000001,
      url: 'https://apps.apple.com/in/app/sattle/id6700000001?uo=4',
      minimumOsVersion: '16.4',
    });
  });

  it('finds nothing when the app is not sold in that storefront', () => {
    expect(parseListing({ resultCount: 0, results: [] }, 'tech.sattle.app')).toBeNull();
  });

  it('finds nothing in an answer about another app, or one it cannot read', () => {
    expect(parseListing(answer({ bundleId: 'com.example.other' }), 'tech.sattle.app')).toBeNull();
    expect(parseListing(answer({ trackId: '6700000001' }), 'tech.sattle.app')).toBeNull();
    expect(parseListing({ errorMessage: 'Invalid value(s) for key(s): [country]' }, 'tech.sattle.app')).toBeNull();
    expect(parseListing(null, 'tech.sattle.app')).toBeNull();
  });
});

describe('createAppStoreUpdater', () => {
  it('offers a newer version on the App Store', async () => {
    const { store, updater } = fakeStore();
    await updater.check();
    expect(store.asked).toEqual(['https://itunes.apple.com/lookup?bundleId=tech.sattle.app&country=in']);
    expect(updater.getState()).toEqual({ phase: 'available', progress: null });
  });

  it('offers nothing while this is the newest version', async () => {
    const { updater } = fakeStore(install({ version: '1.3.0' }));
    await updater.check();
    expect(updater.getState().phase).toBe('idle');
  });

  it('offers nothing to a build that is newer than the App Store', async () => {
    const { updater } = fakeStore(install({ version: '1.4.0' }));
    await updater.check();
    expect(updater.getState().phase).toBe('idle');
  });

  it('never asks Apple from TestFlight or a development build', async () => {
    const { store, updater } = fakeStore(install({ fromAppStore: false }));
    await updater.check();
    expect(store.asked).toEqual([]);
    expect(updater.getState().phase).toBe('idle');
  });

  it('offers nothing this iOS cannot run', async () => {
    const { updater } = fakeStore(install({ osVersion: '16.7.10' }), answer({ minimumOsVersion: '17.0' }));
    await updater.check();
    expect(updater.getState().phase).toBe('idle');
  });

  it('offers nothing when the app is not sold in that storefront', async () => {
    const { updater } = fakeStore(install(), { resultCount: 0, results: [] });
    await updater.check();
    expect(updater.getState().phase).toBe('idle');
  });

  it('keeps the banner when Apple cannot be reached, and asks again on the next foreground', async () => {
    const { store, updater } = fakeStore();
    await updater.check();
    store.failLookup = true;
    store.clock += LOOKUP_EVERY_MS;
    await updater.check();
    expect(updater.getState().phase).toBe('available');

    store.failLookup = false;
    store.body = answer({ version: '1.2.0' });
    await updater.check();
    expect(store.asked).toHaveLength(3);
    expect(updater.getState().phase).toBe('idle');
  });

  it('treats an error answer like being offline', async () => {
    const { store, updater } = fakeStore();
    store.status = 503;
    await updater.check();
    expect(updater.getState().phase).toBe('idle');
    store.status = 200;
    await updater.check();
    expect(updater.getState().phase).toBe('available');
  });

  it('asks Apple at most once an hour', async () => {
    const { store, updater } = fakeStore();
    await updater.check();
    store.clock += LOOKUP_EVERY_MS - 1;
    await updater.check();
    expect(store.asked).toHaveLength(1);
    store.clock += 1;
    await updater.check();
    expect(store.asked).toHaveLength(2);
  });

  it('asks once for checks that overlap', async () => {
    const { store, updater } = fakeStore();
    await Promise.all([updater.check(), updater.check()]);
    expect(store.asked).toHaveLength(1);
  });

  it('drops the offer when a later lookup has nothing newer', async () => {
    const { store, updater } = fakeStore();
    await updater.check();
    store.body = answer({ version: '1.2.0' });
    store.clock += LOOKUP_EVERY_MS;
    await updater.check();
    expect(updater.getState().phase).toBe('idle');
    await updater.update();
    expect(store.shown).toEqual([]);
  });

  it('tells subscribers when the banner changes', async () => {
    const { updater } = fakeStore();
    let calls = 0;
    const off = updater.subscribe(() => calls++);
    await updater.check();
    expect(calls).toBe(1);
    off();
  });

  it("shows the listing's App Store page on Update", async () => {
    const { store, updater } = fakeStore();
    await updater.check();
    await updater.update();
    expect(store.shown).toEqual([[6700000001, 'https://apps.apple.com/in/app/sattle/id6700000001?uo=4']]);
    expect(updater.getState().phase).toBe('available');
  });

  it('shows nothing before there is an update', async () => {
    const { store, updater } = fakeStore();
    await updater.update();
    expect(store.shown).toEqual([]);
  });

  it('opens the page once for taps that overlap', async () => {
    const { store, updater } = fakeStore();
    await updater.check();
    await Promise.all([updater.update(), updater.update()]);
    expect(store.shown).toHaveLength(1);
  });

  it('keeps the banner when the App Store does not open', async () => {
    const { store, updater } = fakeStore();
    store.failShow = true;
    await updater.check();
    await expect(updater.update()).resolves.toBeUndefined();
    expect(updater.getState().phase).toBe('available');
  });

  it('does nothing at all without an App Store', async () => {
    const updater = createAppStoreUpdater(null);
    await updater.check();
    await updater.update();
    expect(updater.getState().phase).toBe('idle');
  });
});
