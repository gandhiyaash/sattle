import { describe, expect, it } from 'vitest';

import appJson from '../../app.json';
import { findIphoneApps, iconLookupUrl, iphonePayLink, IPHONE_UPI_APPS, parseIcons, refusesLinks } from './upiApps';

const LINK = 'upi://pay?pa=priya%40okaxis&pn=Priya&am=450.00&cu=INR&tn=Sattle%20Goa';
const app = (name: string) => IPHONE_UPI_APPS.find((a) => a.name === name)!;

/** An iPhone with these schemes' apps on it. */
const phoneWith =
  (...schemes: string[]) =>
  async (url: string) =>
    schemes.some((s) => url === `${s}://`);

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

describe('an iPhone’s UPI apps', () => {
  it('finds the apps whose schemes open, in the list’s order', async () => {
    const found = await findIphoneApps(phoneWith('bhim', 'phonepe', 'credpay'));
    expect(found.map(({ app, scheme }) => [app.name, scheme])).toEqual([
      ['PhonePe', 'phonepe'],
      ['CRED', 'credpay'],
      ['BHIM', 'bhim'],
    ]);
  });

  it('finds Google Pay by either of its schemes', async () => {
    expect((await findIphoneApps(phoneWith('gpay'))).map((f) => f.scheme)).toEqual(['gpay']);
    expect((await findIphoneApps(phoneWith('tez', 'gpay'))).map((f) => f.scheme)).toEqual(['tez']);
  });

  it('counts an app iOS can’t answer for as not there', async () => {
    const found = await findIphoneApps(async (url) => {
      if (url === 'paytmmp://') throw new Error('not allowed');
      return url === 'credpay://';
    });
    expect(found.map((f) => f.app.name)).toEqual(['CRED']);
  });

  it('finds YONO SBI and Navi by their schemes', async () => {
    const found = await findIphoneApps(phoneWith('yono', 'navipay'));
    expect(found.map(({ app, scheme }) => [app.name, scheme])).toEqual([
      ['YONO SBI', 'yono'],
      ['Navi', 'navipay'],
    ]);
  });

  it('opens an app on its own scheme, with the same payee, amount and note', () => {
    const query = LINK.slice('upi://pay'.length);
    expect(iphonePayLink(LINK, 'credpay', 'upi/pay')).toBe(`credpay://upi/pay${query}`);
    expect(iphonePayLink(LINK, 'paytmmp', 'pay')).toBe(`paytmmp://pay${query}`);
  });

  it('sends the link only to CRED, the one app seen taking it on an iPhone; the rest get the UPI ID copied', () => {
    expect(IPHONE_UPI_APPS.filter((a) => a.payPath !== null).map((a) => a.name)).toEqual(['CRED']);
    expect(app('CRED').payPath).toBe('upi/pay');
  });

  it('has every scheme it looks for named in app.json, without which iOS always answers no', () => {
    const declared: string[] = appJson.expo.ios.infoPlist.LSApplicationQueriesSchemes;
    expect(declared).toEqual(expect.arrayContaining(IPHONE_UPI_APPS.flatMap((a) => a.schemes)));
  });
});

describe('an iPhone’s UPI app icons', () => {
  it('asks Apple about every app on the list in one request, whichever are on the phone', () => {
    const url = new URL(iconLookupUrl());
    expect(url.origin + url.pathname).toBe('https://itunes.apple.com/lookup');
    expect(url.searchParams.get('id')?.split(',').map(Number)).toEqual(IPHONE_UPI_APPS.map((a) => a.appStoreId));
    expect(url.searchParams.get('country')).toBe('in');
  });

  it('reads each icon by App Store id, the large one first', () => {
    const icons = parseIcons({
      resultCount: 2,
      results: [
        { trackId: 1428580080, artworkUrl100: 'https://is1-ssl.mzstatic.com/cred/100x100bb.jpg', artworkUrl512: 'https://is1-ssl.mzstatic.com/cred/512x512bb.jpg' },
        { trackId: 1193357041, artworkUrl100: 'https://is1-ssl.mzstatic.com/gpay/100x100bb.jpg' },
      ],
    });
    expect(icons.get(1428580080)).toBe('https://is1-ssl.mzstatic.com/cred/512x512bb.jpg');
    expect(icons.get(1193357041)).toBe('https://is1-ssl.mzstatic.com/gpay/100x100bb.jpg');
  });

  it('skips what it can’t use, and reads nothing from an answer it can’t read', () => {
    const icons = parseIcons({ results: [{ trackId: 1, artworkUrl512: 'http://example.com/a.jpg' }, { trackId: '2', artworkUrl512: 'https://x/b.jpg' }, null] });
    expect(icons.size).toBe(0);
    expect(parseIcons(null).size).toBe(0);
    expect(parseIcons({ errorMessage: 'Invalid' }).size).toBe(0);
  });
});
