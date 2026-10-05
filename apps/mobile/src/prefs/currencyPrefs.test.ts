import { describe, expect, it } from 'vitest';

import {
  EVERY_CURRENCY,
  NO_CURRENCY_YET,
  isChosen,
  parseCurrencyPrefs,
  serializeCurrencyPrefs,
  startNewGroupsIn,
  toggleCurrency,
  type CurrencyPrefs,
} from './currencyPrefs';

const rupees: CurrencyPrefs = { uses: ['INR'], newGroups: 'INR' };
const bitcoin: CurrencyPrefs = { uses: ['BTC'], newGroups: 'BTC' };

describe('toggleCurrency', () => {
  it('starts new groups in the one currency picked', () => {
    expect(toggleCurrency(NO_CURRENCY_YET, 'BTC')).toEqual(bitcoin);
    expect(toggleCurrency(NO_CURRENCY_YET, 'INR')).toEqual(rupees);
  });

  it('keeps what new groups start in when a second currency is added', () => {
    expect(toggleCurrency(bitcoin, 'INR')).toEqual({ uses: ['INR', 'BTC'], newGroups: 'BTC' });
    expect(toggleCurrency(rupees, 'BTC')).toEqual({ uses: ['INR', 'BTC'], newGroups: 'INR' });
  });

  it('moves new groups off a currency that was turned off', () => {
    expect(toggleCurrency({ uses: ['INR', 'BTC'], newGroups: 'BTC' }, 'BTC')).toEqual(rupees);
    expect(toggleCurrency({ uses: ['INR', 'BTC'], newGroups: 'BTC' }, 'INR')).toEqual(bitcoin);
  });

  it('can untick the last one, which leaves nothing chosen', () => {
    const none = toggleCurrency(rupees, 'INR');
    expect(none.uses).toEqual([]);
    expect(isChosen(none)).toBe(false);
    expect(isChosen(rupees)).toBe(true);
  });
});

describe('startNewGroupsIn', () => {
  it('picks between the currencies they use', () => {
    expect(startNewGroupsIn(EVERY_CURRENCY, 'BTC')).toEqual({ uses: ['INR', 'BTC'], newGroups: 'BTC' });
  });

  it('won’t start groups in a currency they don’t use', () => {
    expect(startNewGroupsIn(rupees, 'BTC')).toEqual(rupees);
  });
});

describe('parseCurrencyPrefs', () => {
  it('reads back what was saved', () => {
    for (const prefs of [rupees, bitcoin, EVERY_CURRENCY, { uses: ['INR', 'BTC'], newGroups: 'BTC' }] as CurrencyPrefs[]) {
      expect(parseCurrencyPrefs(serializeCurrencyPrefs(prefs))).toEqual(prefs);
    }
  });

  it('is nothing when nothing usable was saved, so the tour asks again', () => {
    expect(parseCurrencyPrefs(null)).toBeNull();
    expect(parseCurrencyPrefs('')).toBeNull();
    expect(parseCurrencyPrefs('not json')).toBeNull();
    expect(parseCurrencyPrefs('"INR"')).toBeNull();
    expect(parseCurrencyPrefs('{"uses":"INR"}')).toBeNull();
    expect(parseCurrencyPrefs(serializeCurrencyPrefs(NO_CURRENCY_YET))).toBeNull();
    expect(parseCurrencyPrefs('{"uses":["USD"],"newGroups":"USD"}')).toBeNull();
  });

  it('drops a currency the app doesn’t offer and keeps the rest in the app’s order', () => {
    expect(parseCurrencyPrefs('{"uses":["BTC","USD","INR","BTC"],"newGroups":"USD"}')).toEqual({
      uses: ['INR', 'BTC'],
      newGroups: 'INR',
    });
  });

  it('starts new groups in a currency they use when the saved one isn’t', () => {
    expect(parseCurrencyPrefs('{"uses":["BTC"],"newGroups":"INR"}')).toEqual(bitcoin);
    expect(parseCurrencyPrefs('{"uses":["BTC"]}')).toEqual(bitcoin);
  });
});
