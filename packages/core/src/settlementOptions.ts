/**
 * Decides what the payer can do BEFORE they tap anything.
 *
 * The wrong design is to let someone press Pay and catch
 * `member_cannot_receive` afterwards: by then they've committed to an action
 * that was never going to work. Here, a recipient with nowhere to receive
 * produces a `blocked` result naming them, with remedies instead of rails.
 *
 * `manual` is present in every result. A ledger that can't record "paid in
 * cash" is punitive. But it's the payee's word to give: when they've joined,
 * the payer sees it unavailable and is told to ask them. The server enforces
 * the same rule (checkManualRecorder in apps/api).
 *
 * What counts as "can receive" depends on the server's payment backend.
 * Simulated payments take anyone who joined or has an address. Real payments
 * get an invoice from the payee's own NWC wallet or their own Lightning
 * address, both on their account, so the server says (`receivable`). A
 * ghost's address was typed by someone else and proves nothing, so paying it
 * isn't offered.
 *
 * UPI is beside all of that. It is a payment outside Sattle that the payee
 * confirms, so it is offered whenever they've given a UPI ID and the group
 * is in rupees, whatever the backend, and someone who can only be paid that
 * way isn't blocked.
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

export type Remedy = 'add_address' | 'invite' | 'remind' | 'mark_settled';

/** Whether the server moves real money, or walks a simulation. */
export type PaymentMode = 'real' | 'simulated';

export interface SettlementOptions {
  rails: RailOption[];
  blocked?: { message: string; remedies: Remedy[] };
}

/** Can this member be paid at all without something changing first? */
export function canReceive(member: Member, mode: PaymentMode = 'simulated'): boolean {
  if (mode === 'real') return member.receivable ?? member.status === 'nwc_linked';
  if (member.status === 'joined' || member.status === 'nwc_linked') return true;
  return Boolean(member.lightningAddress);
}

/** UPI only moves rupees. */
export const UPI_CURRENCY = 'INR';

export function resolveSettlementOptions({
  recipient,
  walletAvailable,
  mode = 'simulated',
  currency,
}: {
  recipient: Member;
  walletAvailable: boolean;
  mode?: PaymentMode;
  /** The group's. Without it UPI is never offered. */
  currency?: string;
}): SettlementOptions {
  const real = mode === 'real';
  const upi = Boolean(recipient.upi && recipient.claimedByUserId) && currency === UPI_CURRENCY;
  const name = recipient.displayName;
  const candidates: Array<Omit<RailOption, 'rank'>> = [];

  if (recipient.status === 'joined' && !real) {
    candidates.push({
      rail: 'in_app',
      label: 'Pay from your balance',
      detail: `Instant, and ${name} gets it in the app.`,
      availability: walletAvailable
        ? { available: true }
        : { available: false, reason: 'The wallet needs the mobile app.' },
    });
  }

  if (real ? canReceive(recipient, mode) : recipient.status !== 'ghost') {
    candidates.push({
      rail: 'invoice',
      label: 'Pay with Lightning',
      detail: 'Get an invoice in sats to pay from Phoenix, Wallet of Satoshi, or any Lightning wallet.',
      availability: { available: true },
    });
  }

  if (recipient.status === 'ghost' && recipient.lightningAddress && !real) {
    candidates.push({
      rail: 'lightning_address',
      label: `Pay ${recipient.lightningAddress}`,
      detail: `${name} doesn't need the app to receive this.`,
      availability: walletAvailable
        ? { available: true }
        : { available: false, reason: 'Paying an address needs the mobile wallet.' },
    });
  }

  if (upi) {
    candidates.push({
      rail: 'upi',
      label: 'Pay by UPI',
      detail: `From GPay, PhonePe or any UPI app. ${name} confirms once it arrives.`,
      availability: { available: true },
    });
  }

  candidates.push(
    recipient.claimedByUserId
      ? {
          rail: 'manual',
          label: 'Mark as settled',
          detail: `Paid another way? Ask ${name} to mark it settled.`,
          availability: { available: false, reason: `Only ${name} can confirm a payment made outside the app.` },
        }
      : {
          rail: 'manual',
          label: 'Mark as settled',
          detail: 'Paid in cash, UPI, or forgiven.',
          availability: { available: true },
        }
  );

  // Available rails first, preserving preference order within each group.
  const ordered = [
    ...candidates.filter((c) => c.availability.available),
    ...candidates.filter((c) => !c.availability.available),
  ];
  const rails = ordered.map((c, i) => ({ ...c, rank: i + 1 }));

  if (!canReceive(recipient, mode) && !upi) {
    return { rails, blocked: blockedFor(recipient, mode) };
  }

  return { rails };
}

/**
 * The one way to pay, when there is nothing to choose between. The sheet opens
 * on it instead of asking. Null when the payer has a choice, or is blocked.
 *
 * Only ever the Lightning invoice, where starting moves nothing: it waits to
 * be paid. Never UPI, which would throw the payer into another app the moment
 * they tap Pay, so they're asked first even when it's the only way. Never
 * `manual`, and never one that pays from the balance.
 */
export function onlyRail(options: SettlementOptions): 'invoice' | null {
  if (options.blocked) return null;
  const available = options.rails.filter((r) => r.availability.available);
  if (available.length !== 1) return null;
  return available[0].rail === 'invoice' ? 'invoice' : null;
}

function blockedFor(recipient: Member, mode: PaymentMode): NonNullable<SettlementOptions['blocked']> {
  const name = recipient.displayName;
  if (mode === 'simulated') {
    return {
      message: `${name} hasn't set up a way to get paid yet. Add their Lightning address, invite them, or mark it settled if you paid another way.`,
      remedies: ['add_address', 'invite', 'mark_settled'],
    };
  }
  // They have the app, so only they can connect a wallet or confirm a payment made another way.
  if (recipient.claimedByUserId) {
    return {
      message: `${name} hasn't set up a way to get paid yet. Ask them to connect a wallet or add their Lightning address from Wallet in Sattle. If you paid another way, ask them to mark it settled.`,
      remedies: ['remind'],
    };
  }
  return {
    message: `${name} isn't on Sattle yet, so there's nowhere to pay them. Invite them, and once they set up receiving you can pay here. Or mark it settled if you paid another way.`,
    remedies: ['invite', 'mark_settled'],
  };
}
