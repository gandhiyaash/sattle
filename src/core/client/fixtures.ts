/**
 * Seed data covering all three member states, arranged so the demo hits
 * both settle paths from the first screen:
 *
 *   Goa trip  — you owe Om (joined → Pay) and Aman (ghost, no address → blocked)
 *   Flat 4B   — Om and Priya owe you
 *
 * Amounts are paise.
 */

import { resolveParts } from '../domain/ledger';
import type { Expense, ExpenseInput, Group, Member, Settlement, User } from '../domain/types';

export const currentUser: User = { id: 'u-yash', displayName: 'Yash' };

const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

export const groups: Group[] = [
  {
    id: 'g-goa',
    name: 'Goa trip',
    currency: 'INR',
    memberIds: ['m-goa-yash', 'm-goa-om', 'm-goa-aman', 'm-goa-priya'],
    createdAt: at(12),
  },
  {
    id: 'g-flat',
    name: 'Flat 4B',
    currency: 'INR',
    memberIds: ['m-flat-yash', 'm-flat-om', 'm-flat-priya'],
    createdAt: at(40),
  },
];

export const members: Member[] = [
  { id: 'm-goa-yash', groupId: 'g-goa', displayName: 'Yash', status: 'joined', claimedByUserId: 'u-yash' },
  { id: 'm-goa-om', groupId: 'g-goa', displayName: 'Om', status: 'joined', claimedByUserId: 'u-om' },
  { id: 'm-goa-aman', groupId: 'g-goa', displayName: 'Aman', status: 'ghost' },
  { id: 'm-goa-priya', groupId: 'g-goa', displayName: 'Priya', status: 'nwc_linked', claimedByUserId: 'u-priya' },

  { id: 'm-flat-yash', groupId: 'g-flat', displayName: 'Yash', status: 'joined', claimedByUserId: 'u-yash' },
  { id: 'm-flat-om', groupId: 'g-flat', displayName: 'Om', status: 'joined', claimedByUserId: 'u-om' },
  { id: 'm-flat-priya', groupId: 'g-flat', displayName: 'Priya', status: 'ghost', lightningAddress: 'priya@walletofsatoshi.com' },
];

function expense(id: string, daysAgo: number, input: Omit<ExpenseInput, 'splitMode' | 'parts'> & { between: string[] }): Expense {
  const full: ExpenseInput = {
    groupId: input.groupId,
    description: input.description,
    amount: input.amount,
    paidByMemberId: input.paidByMemberId,
    splitMode: 'equal',
    parts: input.between.map((memberId) => ({ memberId })),
  };
  return { id, ...full, parts: resolveParts(full), createdAt: at(daysAgo) };
}

const goa = groups[0].memberIds;
const flat = groups[1].memberIds;

export const expenses: Expense[] = [
  expense('e-villa', 11, { groupId: 'g-goa', description: 'Villa, two nights', amount: 1_200_000, paidByMemberId: 'm-goa-aman', between: goa }),
  expense('e-thalassa', 10, { groupId: 'g-goa', description: 'Dinner at Thalassa', amount: 800_000, paidByMemberId: 'm-goa-om', between: goa }),
  expense('e-cabs', 10, { groupId: 'g-goa', description: 'Cabs', amount: 200_000, paidByMemberId: 'm-goa-priya', between: goa }),
  expense('e-scooters', 9, { groupId: 'g-goa', description: 'Scooter rental', amount: 320_000, paidByMemberId: 'm-goa-yash', between: goa }),

  expense('e-power', 5, { groupId: 'g-flat', description: 'Electricity, August', amount: 360_000, paidByMemberId: 'm-flat-yash', between: flat }),
];

/** Backs the "Guest link" tab: what Om sees when he opens the pay link. */
export const settlements: Settlement[] = [
  {
    id: 'demo',
    groupId: 'g-flat',
    fromMemberId: 'm-flat-om',
    toMemberId: 'm-flat-yash',
    amount: 120_000,
    currency: 'INR',
    rail: 'invoice',
    status: 'awaiting_payment',
    quote: {
      amountFiat: 120_000,
      currency: 'INR',
      amountSat: 13_334,
      feeSat: 40,
      rateFiatPerBtc: 9_000_000,
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
    },
    destination: 'lnbc133340n1demoinvoiceqqqsp5mockmockmockmockmockmockmockmockmockmock',
    createdAt: at(0),
    updatedAt: at(0),
  },
];
