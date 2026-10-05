import { describe, expect, it } from 'vitest';

import { fixtures } from '@sattle/core';

import { MockClient } from './MockClient';

/** Payments finish at once, so a test doesn't wait on the simulated wallet. */
const client = () => new MockClient({ latencyMs: 0, settleDelayMs: 0 });

const equally = (ids: string[]) => ({ splitMode: 'equal' as const, parts: ids.map((memberId) => ({ memberId })) });
const tea = { groupId: 'g-goa', description: 'Tea', amount: 400, paidByMemberId: 'm-goa-yash', ...equally(['m-goa-yash', 'm-goa-om']) };

describe('MockClient: history', () => {
  it('starts with the seeded expenses as added, newest first, and none of the payments still open', async () => {
    const history = await client().getHistory('g-flat');
    // Flat 4B's one settlement is the demo invoice, which nobody has paid.
    expect(history).toMatchObject([{ kind: 'expense_added', expense: { id: 'e-power' } }]);

    const goa = await client().getHistory('g-goa');
    expect(goa.map((e) => e.kind)).toEqual(fixtures.expenses.filter((e) => e.groupId === 'g-goa').map(() => 'expense_added'));
    expect(goa.map((e) => e.at)).toEqual([...goa.map((e) => e.at)].sort().reverse());
  });

  it('follows an expense through being added, changed and removed, and says the user did each', async () => {
    const c = client();
    const added = await c.addExpense(tea);
    const edited = await c.updateExpense(added.id, { ...tea, description: 'Tea and toast', amount: 600 });
    await c.deleteExpense('g-goa', added.id);

    const [removed, changed, first] = await c.getHistory('g-goa');
    expect(removed).toMatchObject({ kind: 'expense_removed', byMemberId: 'm-goa-yash', before: edited });
    expect(changed).toMatchObject({ kind: 'expense_changed', byMemberId: 'm-goa-yash', before: added, expense: edited });
    // As it was put in, not as it read when it was removed.
    expect(first).toMatchObject({ kind: 'expense_added', byMemberId: 'm-goa-yash', expense: added });
    expect(added).toMatchObject({ amount: 400, addedByMemberId: 'm-goa-yash' });
  });

  it('notes nothing when an expense is saved as it already stood', async () => {
    const c = client();
    const added = await c.addExpense(tea);
    const before = (await c.getHistory('g-goa')).length;

    expect(await c.updateExpense(added.id, tea)).toEqual(added);
    expect(await c.getHistory('g-goa')).toHaveLength(before);
  });

  it('shows a Lightning payment with its proof, once it has been paid', async () => {
    const c = client();
    const debt = (await c.getDebts('g-goa')).find((d) => d.fromMemberId === 'm-goa-yash' && d.toMemberId === 'm-goa-om')!;
    const { groupId, fromMemberId, toMemberId, amount } = debt;
    const started = await c.createSettlement({ groupId, fromMemberId, toMemberId, amount, rail: 'in_app' });
    // Not yet paid, so not yet in the history.
    expect((await c.getHistory('g-goa')).some((e) => e.kind === 'settled')).toBe(false);

    await new Promise<void>((done) => c.onSettlementUpdate(started.id, (s) => s.status === 'confirmed' && done()));
    const [settled] = await c.getHistory('g-goa');
    expect(settled).toMatchObject({ kind: 'settled', settlement: { id: started.id, status: 'confirmed', amount } });
    if (settled.kind !== 'settled') throw new Error('expected the payment');
    expect(settled.settlement.preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(settled.at).toBe(settled.settlement.updatedAt);
    expect(settled.byMemberId).toBeUndefined();
  });

  it('shows a debt marked as settled on the user’s word, with no proof', async () => {
    const c = client();
    const debt = (await c.getDebts('g-flat')).find((d) => d.fromMemberId === 'm-flat-priya' && d.toMemberId === 'm-flat-yash')!;
    const { groupId, fromMemberId, toMemberId, amount } = debt;
    const marked = await c.markSettledManually({ groupId, fromMemberId, toMemberId, amount, note: 'Settled outside the app' });

    expect((await c.getHistory('g-flat'))[0]).toEqual({
      kind: 'settled',
      id: `settled-${marked.id}`,
      at: marked.updatedAt,
      byMemberId: 'm-flat-yash',
      settlement: marked,
    });
    expect(marked.preimage).toBeUndefined();
  });

  it('keeps each group’s history to itself, and has none for a group that isn’t there', async () => {
    const c = client();
    await c.addExpense(tea);
    expect(await c.getHistory('g-flat')).toHaveLength(1);
    await expect(c.getHistory('g-nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});
