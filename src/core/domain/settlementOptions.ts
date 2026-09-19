/**
 * Decides what the payer can do BEFORE they tap anything.
 *
 * The wrong design is to let someone press Pay and catch
 * `member_cannot_receive` afterwards: by then they've committed to an action
 * that was never going to work. Here, a recipient with nowhere to receive
 * produces a `blocked` result naming them, with remedies instead of rails.
 *
 * `manual` is present in every result. A ledger that can't record "paid in
 * cash" is punitive.
 */

import type { Member, Rail } from './types';

export interface RailOption {
  rail: Rail;
  label: string;
  detail: string;
  /** 1 is the recommended option. Only available rails are ranked first. */
  rank: number;
  availability: { available: true } | { available: false; reason: string };
}

export type Remedy = 'add_address' | 'invite' | 'mark_settled';

export interface SettlementOptions {
  rails: RailOption[];
  blocked?: { message: string; remedies: Remedy[] };
}

/** Can this member be paid at all without something changing first? */
export function canReceive(member: Member): boolean {
  if (member.status === 'joined' || member.status === 'nwc_linked') return true;
  return Boolean(member.lightningAddress);
}

export function resolveSettlementOptions({
  recipient,
  walletAvailable,
}: {
  recipient: Member;
  walletAvailable: boolean;
}): SettlementOptions {
  const name = recipient.displayName;
  const candidates: Array<Omit<RailOption, 'rank'>> = [];

  if (recipient.status === 'joined') {
    candidates.push({
      rail: 'in_app',
      label: 'Pay from your balance',
      detail: `Instant, and ${name} gets it in the app.`,
      availability: walletAvailable
        ? { available: true }
        : { available: false, reason: 'The wallet needs the mobile app.' },
    });
  }

  if (recipient.status === 'joined' || recipient.status === 'nwc_linked') {
    candidates.push({
      rail: 'invoice',
      label: 'Pay from another wallet',
      detail: 'Get an invoice to pay from Phoenix, Wallet of Satoshi, or any Lightning wallet.',
      availability: { available: true },
    });
  }

  if (recipient.status === 'ghost' && recipient.lightningAddress) {
    candidates.push({
      rail: 'lightning_address',
      label: `Pay ${recipient.lightningAddress}`,
      detail: `${name} doesn't need the app to receive this.`,
      availability: walletAvailable
        ? { available: true }
        : { available: false, reason: 'Paying an address needs the mobile wallet.' },
    });
  }

  candidates.push({
    rail: 'manual',
    label: 'Mark as settled',
    detail: 'Paid in cash, UPI, or forgiven.',
    availability: { available: true },
  });

  // Available rails first, preserving preference order within each group.
  const ordered = [
    ...candidates.filter((c) => c.availability.available),
    ...candidates.filter((c) => !c.availability.available),
  ];
  const rails = ordered.map((c, i) => ({ ...c, rank: i + 1 }));

  if (!canReceive(recipient)) {
    return {
      rails,
      blocked: {
        message: `${name} hasn't set up a way to get paid yet. Add their Lightning address, invite them, or mark it settled if you paid another way.`,
        remedies: ['add_address', 'invite', 'mark_settled'],
      },
    };
  }

  return { rails };
}
