import { describe, expect, it } from 'vitest';

import { toGuestSettlement, toGuestSettlementFromElsewhere } from './payLinks';
import type { Settlement } from './types';

const paid: Settlement = {
  id: 's-1',
  groupId: 'g-1',
  fromMemberId: 'm-priya',
  toMemberId: 'm-yash',
  amount: 120000,
  currency: 'INR',
  rail: 'invoice',
  status: 'confirmed',
  destination: 'lnbc1example',
  preimage: 'ab'.repeat(32),
  createdAt: '2026-10-27T05:00:00.000Z',
  updatedAt: '2026-10-27T05:01:00.000Z',
};

describe('toGuestSettlementFromElsewhere', () => {
  it('shows what settled the debt, without the other link’s invoice or proof', () => {
    const own = toGuestSettlement(paid);
    expect(own).toMatchObject({ destination: 'lnbc1example', preimage: paid.preimage });

    const shown = toGuestSettlementFromElsewhere(paid);
    expect(shown).toMatchObject({ id: 's-1', amount: 120000, currency: 'INR', status: 'confirmed' });
    expect(shown.destination).toBeUndefined();
    expect(shown.preimage).toBeUndefined();
  });
});
