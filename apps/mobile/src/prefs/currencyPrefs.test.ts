import { describe, expect, it } from 'vitest';

import {
  EVERY_CURRENCY,
  parseCurrencyPrefs,
  serializeCurrencyPrefs,
  startNewGroupsIn,
  toggleCurrency,
  type CurrencyPrefs,
} from './currencyPrefs';

const rupees: CurrencyPrefs = { uses: ['INR'], newGroups: 'INR' };
const bitcoin: CurrencyPrefs = { uses: ['BTC'], newGroups: 'BTC' };

describe('EVERY_CURRENCY', () => {
  it('is where everyone starts: both, with new groups in rupees', () => {
    expect(EVERY_CURRENCY).toEqual({ uses: ['INR', 'BTC'], newGroups: 'INR' });
  });
});

describe('toggleCurrency', () => {
  it('turns one off, leaving new groups in the other', () => {
    expect(toggleCurrency(EVERY_CURRENCY, 'BTC')).toEqual(rupees);
    expect(toggleCurrency(EVERY_CURRENCY, 'INR')).toEqual(bitcoin);
  });

  it('keeps what new groups start in when a second currency is added', () => {
    expect(toggleCurrency(bitcoin, 'INR')).toEqual({ uses: ['INR', 'BTC'], newGroups: 'BTC' });
    expect(toggleCurrency(rupees, 'BTC')).toEqual({ uses: ['INR', 'BTC'], newGroups: 'INR' });
  });

  it('moves new groups off a currency that was turned off', () => {
    expect(toggleCurrency({ uses: ['INR', 'BTC'], newGroups: 'BTC' }, 'BTC')).toEqual(rupees);
    expect(toggleCurrency({ uses: ['INR', 'BTC'], newGroups: 'BTC' }, 'INR')).toEqual(bitcoin);
  });

  it('won’t turn off the last one: a group has to be kept in something', () => {
    expect(toggleCurrency(rupees, 'INR')).toEqual(rupees);
    expect(toggleCurrency(bitcoin, 'BTC')).toEqual(bitcoin);
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

  it('is nothing when nothing usable was saved, which leaves them with both', () => {
    expect(parseCurrencyPrefs(null)).toBeNull();
    expect(parseCurrencyPrefs('')).toBeNull();
    expect(parseCurrencyPrefs('not json')).toBeNull();
    expect(parseCurrencyPrefs('"INR"')).toBeNull();
    expect(parseCurrencyPrefs('{"uses":"INR"}')).toBeNull();
    expect(parseCurrencyPrefs('{"uses":[],"newGroups":"INR"}')).toBeNull();
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
