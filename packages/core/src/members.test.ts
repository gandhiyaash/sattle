import { describe, expect, it } from 'vitest';

import { accountsOf, isHeldBy } from './members';

describe('accountsOf and isHeldBy', () => {
  it('has no account for a ghost', () => {
    expect(accountsOf({})).toEqual([]);
    expect(isHeldBy({}, 'u-1')).toBe(false);
    expect(isHeldBy(undefined, 'u-1')).toBe(false);
  });

  it('is the first account to join, then the ones that joined as them since', () => {
    const member = { claimedByUserId: 'u-phone', alsoHeldBy: ['u-laptop', 'u-tablet'] };
    expect(accountsOf(member)).toEqual(['u-phone', 'u-laptop', 'u-tablet']);
    for (const id of ['u-phone', 'u-laptop', 'u-tablet']) expect(isHeldBy(member, id)).toBe(true);
    expect(isHeldBy(member, 'u-someone-else')).toBe(false);
  });
});
