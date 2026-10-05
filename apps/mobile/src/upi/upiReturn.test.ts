import { describe, expect, it } from 'vitest';

import { UPI_LEFT_FRESH_MS, readLeftForUpi } from './upiReturn';

const NOW = 1_800_000_000_000;
const kept = (over: Record<string, unknown> = {}) => JSON.stringify({ scope: 'g/abc', what: 'debt-1', at: NOW - 60_000, ...over });

describe('readLeftForUpi', () => {
  it('gives back the debt the payer left this page to pay', () => {
    expect(readLeftForUpi(kept(), 'g/abc', NOW)).toBe('debt-1');
    // A screen with one debt keeps an empty name for it, which is still an answer.
    expect(readLeftForUpi(kept({ what: '' }), 'g/abc', NOW)).toBe('');
  });

  it('says nothing for another page, or once it is too old to be this payment', () => {
    expect(readLeftForUpi(kept(), 'g/other', NOW)).toBeNull();
    expect(readLeftForUpi(kept({ at: NOW - UPI_LEFT_FRESH_MS }), 'g/abc', NOW)).toBe('debt-1');
    expect(readLeftForUpi(kept({ at: NOW - UPI_LEFT_FRESH_MS - 1 }), 'g/abc', NOW)).toBeNull();
  });

  it('says nothing when nothing was kept, or what was kept isn’t ours', () => {
    for (const raw of [null, undefined, '', 'not json', '{}', '[]', 'null', kept({ what: 7 }), kept({ at: 'yesterday' })]) {
      expect([raw, readLeftForUpi(raw, 'g/abc', NOW)]).toEqual([raw, null]);
    }
  });
});
