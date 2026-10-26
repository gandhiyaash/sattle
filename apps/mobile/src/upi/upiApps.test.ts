import { describe, expect, it } from 'vitest';

import { refusesLinks } from './upiApps';

describe('refusesLinks', () => {
  it('names Google Pay and PhonePe, which refuse a link to a person from another app', () => {
    expect(refusesLinks({ packageName: 'com.google.android.apps.nbu.paisa.user' })).toBe(true);
    expect(refusesLinks({ packageName: 'com.phonepe.app' })).toBe(true);
  });

  it('lets every other app have the link, and hear back from it', () => {
    for (const packageName of ['net.one97.paytm', 'in.org.npci.upiapp', 'com.dreamplug.androidapp', '']) {
      expect([packageName, refusesLinks({ packageName })]).toEqual([packageName, false]);
    }
  });
});
