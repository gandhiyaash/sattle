import { describe, expect, it } from 'vitest';

import { canReceive, onlyRail, resolveSettlementOptions } from './settlementOptions';
import type { Member } from './types';

const member = (over: Partial<Member>): Member => ({
  id: 'm-1',
  groupId: 'g-1',
  displayName: 'Aman',
  status: 'ghost',
  ...over,
});

const ghost = member({});
const ghostWithAddress = member({ lightningAddress: 'aman@walletofsatoshi.com' });
const joined = member({ status: 'joined', claimedByUserId: 'u-aman' });
const linked = member({ status: 'nwc_linked', claimedByUserId: 'u-aman' });
/** Joined with no wallet, but the server can pay them: their own Lightning address. */
const joinedWithAddress = member({ status: 'joined', claimedByUserId: 'u-aman', receivable: true });

const rails = (recipient: Member, mode: 'real' | 'simulated') =>
  resolveSettlementOptions({ recipient, walletAvailable: false, mode }).rails.map((r) => r.rail);

describe('canReceive', () => {
  it('takes anyone who joined or has an address when payments are simulated', () => {
    expect(canReceive(joined)).toBe(true);
    expect(canReceive(linked)).toBe(true);
    expect(canReceive(ghostWithAddress)).toBe(true);
    expect(canReceive(ghost)).toBe(false);
  });

  it('takes the server’s word when payments are real, else only a connected wallet', () => {
    expect(canReceive(joinedWithAddress, 'real')).toBe(true);
    expect(canReceive({ ...linked, receivable: false }, 'real')).toBe(false);
    expect(canReceive(linked, 'real')).toBe(true);
    expect(canReceive(joined, 'real')).toBe(false);
    expect(canReceive(ghostWithAddress, 'real')).toBe(false);
    expect(canReceive(ghost, 'real')).toBe(false);
  });
});

describe('resolveSettlementOptions with real payments', () => {
  it('offers an invoice to someone with a connected wallet', () => {
    const options = resolveSettlementOptions({ recipient: linked, walletAvailable: false, mode: 'real' });
    expect(options.blocked).toBeUndefined();
    expect(options.rails[0]).toMatchObject({ rail: 'invoice', availability: { available: true } });
  });

  it('offers an invoice to someone the server can pay at their own address', () => {
    const options = resolveSettlementOptions({ recipient: joinedWithAddress, walletAvailable: false, mode: 'real' });
    expect(options.blocked).toBeUndefined();
    expect(options.rails[0]).toMatchObject({ rail: 'invoice', availability: { available: true } });
  });

  it('asks a member who joined to set up receiving, and offers nothing they would have to confirm', () => {
    const options = resolveSettlementOptions({ recipient: joined, walletAvailable: false, mode: 'real' });
    expect(options.blocked?.remedies).toEqual(['remind']);
    expect(options.blocked?.message).toContain('set up a way to get paid');
    expect(rails(joined, 'real')).not.toContain('invoice');
  });

  it('never offers a Lightning address, which it could not confirm', () => {
    expect(rails(ghostWithAddress, 'real')).not.toContain('lightning_address');
    const options = resolveSettlementOptions({ recipient: ghostWithAddress, walletAvailable: true, mode: 'real' });
    expect(options.blocked?.remedies).toEqual(['invite', 'mark_settled']);
  });

  it('still lets the payer settle a ghost by hand', () => {
    const manual = resolveSettlementOptions({ recipient: ghost, walletAvailable: false, mode: 'real' }).rails.find(
      (r) => r.rail === 'manual'
    );
    expect(manual?.availability.available).toBe(true);
  });
});

describe('resolveSettlementOptions and UPI', () => {
  const takesUpi = member({ status: 'joined', claimedByUserId: 'u-aman', upi: true });
  const options = (recipient: Member, mode: 'real' | 'simulated', currency?: string) =>
    resolveSettlementOptions({ recipient, walletAvailable: false, mode, currency });

  it('offers UPI for a rupee debt to someone who gave a UPI ID, after Lightning and before by hand', () => {
    const linkedUpi = member({ status: 'nwc_linked', claimedByUserId: 'u-aman', upi: true, receivable: true });
    expect(options(linkedUpi, 'real', 'INR').rails.map((r) => r.rail)).toEqual(['invoice', 'upi', 'manual']);
    expect(options(linkedUpi, 'real', 'INR').rails.find((r) => r.rail === 'upi')?.availability.available).toBe(true);
  });

  it('doesn’t block someone who can only be paid by UPI: it is the first thing offered', () => {
    const o = options(takesUpi, 'real', 'INR');
    expect(o.blocked).toBeUndefined();
    expect(o.rails[0]).toMatchObject({ rail: 'upi', rank: 1 });
  });

  it('leaves it out for another currency, for no currency, and for someone with no UPI ID', () => {
    expect(options(takesUpi, 'real', 'USD').rails.map((r) => r.rail)).not.toContain('upi');
    expect(options(takesUpi, 'real').rails.map((r) => r.rail)).not.toContain('upi');
    expect(options(takesUpi, 'real', 'USD').blocked?.remedies).toEqual(['remind']);
    expect(options(joined, 'simulated', 'INR').rails.map((r) => r.rail)).not.toContain('upi');
  });

  it('never offers it for a ghost: there is nobody to confirm it arrived', () => {
    expect(options(member({ upi: true }), 'simulated', 'INR').rails.map((r) => r.rail)).not.toContain('upi');
  });
});

describe('onlyRail', () => {
  const only = (recipient: Member, mode: 'real' | 'simulated', walletAvailable = false) =>
    onlyRail(resolveSettlementOptions({ recipient, walletAvailable, mode, currency: 'INR' }));

  it('is Lightning for someone who gave no UPI ID: there is nothing to choose', () => {
    expect(only(linked, 'real')).toBe('invoice');
    expect(only(joinedWithAddress, 'real')).toBe('invoice');
  });

  it('is UPI for someone who can only be paid that way', () => {
    expect(only(member({ status: 'joined', claimedByUserId: 'u-aman', upi: true }), 'real')).toBe('upi');
  });

  it('is nothing when the payer has a choice', () => {
    // Lightning or UPI.
    expect(only(member({ status: 'nwc_linked', claimedByUserId: 'u-aman', upi: true }), 'real')).toBeNull();
    // The balance or an invoice.
    expect(only(joined, 'simulated', true)).toBeNull();
  });

  it('is nothing for someone who can’t be paid', () => {
    expect(only(joined, 'real')).toBeNull();
    expect(only(ghost, 'real')).toBeNull();
  });

  it('never marks a debt settled: by hand is a choice even when it is the only one', () => {
    const o = resolveSettlementOptions({ recipient: ghostWithAddress, walletAvailable: false, mode: 'simulated' });
    expect(o.rails.filter((r) => r.availability.available).map((r) => r.rail)).toEqual(['manual']);
    expect(onlyRail(o)).toBeNull();
  });
});

describe('resolveSettlementOptions with simulated payments', () => {
  it('keeps the address and in-app routes', () => {
    expect(rails(ghostWithAddress, 'simulated')).toContain('lightning_address');
    expect(rails(joined, 'simulated')).toEqual(expect.arrayContaining(['in_app', 'invoice']));
    const options = resolveSettlementOptions({ recipient: ghost, walletAvailable: false });
    expect(options.blocked?.remedies).toEqual(['add_address', 'invite', 'mark_settled']);
  });
});
