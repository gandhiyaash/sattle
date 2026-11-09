import { describe, expect, it } from 'vitest';

import type { Expense, GroupLogEntry, GroupSnapshot, Member, Settlement, SyncView } from '@sattle/core';

import { activityOf } from './views';

const USER = 'u-riya';

const member = (id: string, groupId: string, displayName: string, userId?: string): Member => ({
  id,
  groupId,
  displayName,
  status: userId ? 'joined' : 'ghost',
  ...(userId ? { claimedByUserId: userId } : {}),
});

const expense = (id: string, groupId: string, amount: number, by: string, between: string[], at: string): Expense => ({
  id,
  groupId,
  description: id,
  amount,
  paidByMemberId: by,
  splitMode: 'equal',
  parts: between.map((memberId) => ({ memberId, amount: amount / between.length })),
  createdAt: at,
});

const settlement = (id: string, groupId: string, from: string, to: string, amount: number, at: string, extra: Partial<Settlement> = {}): Settlement => ({
  id,
  groupId,
  fromMemberId: from,
  toMemberId: to,
  amount,
  currency: 'INR',
  rail: 'upi',
  status: 'confirmed',
  createdAt: at,
  updatedAt: at,
  ...extra,
});

function snapshot(
  id: string,
  name: string,
  members: Member[],
  expenses: Expense[],
  settlements: Settlement[] = [],
  log: GroupLogEntry[] = []
): GroupSnapshot {
  return {
    group: {
      id,
      name,
      currency: 'INR',
      memberIds: members.map((m) => m.id),
      approveJoins: false,
      createdAt: '2026-11-01T00:00:00.000Z',
      simplifyDebts: false,
    },
    members,
    expenses,
    settlements,
    upiClaims: [],
    pendingJoins: [],
    log,
  };
}

const view = (groups: GroupSnapshot[]): SyncView => ({
  user: { id: USER, displayName: 'Riya' },
  groups,
  joinRequests: [],
  upiProfile: { upiId: null, onGroupLinks: true },
});

const goaMembers = [member('m-riya', 'g-goa', 'Riya', USER), member('m-om', 'g-goa', 'Om'), member('m-kabir', 'g-goa', 'Kabir')];
const flatMembers = [member('m-riya2', 'g-flat', 'Riya', USER), member('m-yash', 'g-flat', 'Yash')];

describe('activityOf', () => {
  it('puts every group’s expenses and payments in one list, newest first', () => {
    const items = activityOf(
      view([
        snapshot('g-goa', 'Goa', goaMembers, [expense('Dinner', 'g-goa', 300, 'm-riya', ['m-riya', 'm-om', 'm-kabir'], '2026-11-02T10:00:00.000Z')], [
          settlement('s1', 'g-goa', 'm-om', 'm-riya', 100, '2026-11-04T10:00:00.000Z'),
        ]),
        snapshot('g-flat', 'Flat', flatMembers, [expense('Rent', 'g-flat', 2000, 'm-yash', ['m-riya2', 'm-yash'], '2026-11-03T10:00:00.000Z')]),
      ])
    );
    expect(items.map((i) => [i.groupName, i.title])).toEqual([
      ['Goa', 'Om paid you'],
      ['Flat', 'Rent'],
      ['Goa', 'Dinner'],
    ]);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
  });

  it('says what each did for the user: lent, borrowed, paid, received, or nothing', () => {
    const items = activityOf(
      view([
        snapshot(
          'g-goa',
          'Goa',
          goaMembers,
          [
            expense('Dinner', 'g-goa', 300, 'm-riya', ['m-riya', 'm-om', 'm-kabir'], '2026-11-02T10:00:00.000Z'),
            expense('Cab', 'g-goa', 200, 'm-om', ['m-riya', 'm-om'], '2026-11-02T11:00:00.000Z'),
            expense('Beer', 'g-goa', 100, 'm-om', ['m-om', 'm-kabir'], '2026-11-02T12:00:00.000Z'),
          ],
          [
            settlement('s1', 'g-goa', 'm-riya', 'm-om', 100, '2026-11-03T10:00:00.000Z'),
            settlement('s2', 'g-goa', 'm-kabir', 'm-riya', 100, '2026-11-03T11:00:00.000Z', { rail: 'manual' }),
            settlement('s3', 'g-goa', 'm-kabir', 'm-om', 50, '2026-11-03T12:00:00.000Z'),
          ]
        ),
      ])
    );
    const by = (title: string) => items.find((i) => i.title === title)!;
    expect(by('Dinner')).toMatchObject({ kind: 'expense', detail: 'You paid', mine: 200 });
    expect(by('Cab')).toMatchObject({ detail: 'Om paid', mine: -100 });
    expect(by('Beer').mine).toBeNull();
    expect(by('You paid Om')).toMatchObject({ kind: 'payment', detail: 'UPI', mine: -100 });
    expect(by('Kabir settled with you')).toMatchObject({ detail: 'Marked as settled', mine: 100 });
    expect(by('Kabir paid Om').mine).toBeNull();
  });

  it('says who did each thing: added an expense, settled a debt, changed the group', () => {
    const items = activityOf(
      view([
        snapshot(
          'g-goa',
          'Goa',
          goaMembers,
          [
            { ...expense('Dinner', 'g-goa', 300, 'm-riya', ['m-riya', 'm-om'], '2026-11-02T10:00:00.000Z'), addedByMemberId: 'm-om' },
            { ...expense('Cab', 'g-goa', 200, 'm-riya', ['m-riya', 'm-om'], '2026-11-02T11:00:00.000Z'), addedByMemberId: 'm-riya' },
          ],
          [
            settlement('s1', 'g-goa', 'm-kabir', 'm-riya', 100, '2026-11-03T10:00:00.000Z', { rail: 'manual', recordedByMemberId: 'm-riya' }),
            settlement('s2', 'g-goa', 'm-om', 'm-kabir', 100, '2026-11-03T11:00:00.000Z', { recordedByMemberId: 'm-kabir' }),
          ],
          [
            { id: '1', groupId: 'g-goa', at: '2026-11-04T10:00:00.000Z', byMemberId: 'm-om', change: { kind: 'simplify_debts', on: true } },
            { id: '2', groupId: 'g-goa', at: '2026-11-04T11:00:00.000Z', byMemberId: 'm-riya', change: { kind: 'renamed', from: 'Goa', to: 'Goa 2026' } },
          ]
        ),
      ])
    );
    const by = (title: string) => items.find((i) => i.title === title)!;
    expect(by('Dinner').detail).toBe('Added by Om · You paid');
    expect(by('Cab').detail).toBe('Added by you');
    expect(by('Kabir settled with you').detail).toBe('Marked as settled by you');
    expect(by('Om paid Kabir').detail).toBe('UPI, confirmed by Kabir');
    expect(items.slice(0, 2)).toMatchObject([
      { kind: 'change', title: 'You renamed the group to “Goa 2026”', detail: '', amount: 0, mine: null, groupName: 'Goa' },
      { kind: 'change', title: 'Om turned on Simplify debts', mine: null },
    ]);
  });

  it('reads a group with no log, from a server that keeps none, as one with nothing changed', () => {
    const { log: _none, ...old } = snapshot('g-flat', 'Flat', flatMembers, [
      expense('Rent', 'g-flat', 2000, 'm-yash', ['m-riya2', 'm-yash'], '2026-11-03T10:00:00.000Z'),
    ]);
    const items = activityOf(view([old as GroupSnapshot]));
    expect(items.map((i) => i.title)).toEqual(['Rent']);
  });

  it('leaves out payments that didn’t go through, and keeps to the limit', () => {
    const items = activityOf(
      view([
        snapshot('g-flat', 'Flat', flatMembers, [], [
          settlement('s1', 'g-flat', 'm-yash', 'm-riya2', 500, '2026-11-03T10:00:00.000Z', { status: 'failed', rail: 'invoice' }),
          settlement('s2', 'g-flat', 'm-yash', 'm-riya2', 500, '2026-11-03T11:00:00.000Z', { rail: 'invoice' }),
          settlement('s3', 'g-flat', 'm-yash', 'm-riya2', 500, '2026-11-03T12:00:00.000Z', { rail: 'invoice' }),
        ]),
      ]),
      1
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'g-flat:settled-s3', title: 'Yash paid you', detail: 'Lightning' });
  });
});
