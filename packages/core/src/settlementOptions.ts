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
 *
 * Above all of it is what the payer uses (payWays). Someone who said they
 * don't use bitcoin is never shown Lightning, and someone who doesn't use
 * rupees is never shown UPI, so what's left may be nothing: then they're
 * blocked, in words about the way they do use.
 */

import { BITCOIN } from './currency';
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

/** Which ways of paying someone is shown at all. */
export interface PayWays {
  lightning: boolean;
  upi: boolean;
}

const EVERY_WAY: PayWays = { lightning: true, upi: true };

/**
 * What to show someone, from the currencies they said they use. Bitcoin
 * brings Lightning and rupees bring UPI, so choosing one alone hides the
 * other everywhere in the app.
 *
 * A group's own currency is the exception. One kept in bitcoin can only be
 * settled over Lightning, so there it shows whatever they chose: hiding it
 * would leave them a debt with no way to pay it. UPI moves only rupees, so in
 * any other group it is hidden from everyone. `groupCurrency` is left out for
 * a screen that isn't about one group.
 */
export function payWays(uses: readonly string[], groupCurrency?: string): PayWays {
  return {
    lightning: uses.includes(BITCOIN) || groupCurrency === BITCOIN,
    upi: uses.includes(UPI_CURRENCY) && (groupCurrency === undefined || groupCurrency === UPI_CURRENCY),
  };
}

export function resolveSettlementOptions({
  recipient,
  walletAvailable,
  mode = 'simulated',
  currency,
  ways = EVERY_WAY,
}: {
  recipient: Member;
  walletAvailable: boolean;
  mode?: PaymentMode;
  /** The group's. Without it UPI is never offered. */
  currency?: string;
  /** What the payer is shown (payWays). Everything, unless they chose. */
  ways?: PayWays;
}): SettlementOptions {
  const real = mode === 'real';
  const { lightning } = ways;
  /** Whether UPI could pay a debt in this group at all, as far as this payer is concerned. */
  const upiHere = ways.upi && currency === UPI_CURRENCY;
  const upi = upiHere && Boolean(recipient.upi && recipient.claimedByUserId);
  const name = recipient.displayName;
  const candidates: Array<Omit<RailOption, 'rank'>> = [];

  if (lightning && recipient.status === 'joined' && !real) {
    candidates.push({
      rail: 'in_app',
      label: 'Pay from your balance',
      detail: `Instant, and ${name} gets it in the app.`,
      availability: walletAvailable
        ? { available: true }
        : { available: false, reason: 'The wallet needs the mobile app.' },
    });
  }

  if (lightning && (real ? canReceive(recipient, mode) : recipient.status !== 'ghost')) {
    candidates.push({
      rail: 'invoice',
      label: 'Pay from another wallet',
      detail: 'Get an invoice to pay from Phoenix, Wallet of Satoshi, or any Lightning wallet.',
      availability: { available: true },
    });
  }

  if (lightning && recipient.status === 'ghost' && recipient.lightningAddress && !real) {
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
          detail: ways.upi ? 'Paid in cash, UPI, or forgiven.' : 'Paid in cash, or forgiven.',
          availability: { available: true },
        }
  );

  // Available rails first, preserving preference order within each group.
  const ordered = [
    ...candidates.filter((c) => c.availability.available),
    ...candidates.filter((c) => !c.availability.available),
  ];
  const rails = ordered.map((c, i) => ({ ...c, rank: i + 1 }));

  if (!(lightning && canReceive(recipient, mode)) && !upi) {
    return { rails, blocked: blockedFor(recipient, mode, { lightning, upi: upiHere }) };
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

/** `ways` is what could pay this debt at all, for this payer: the message asks the recipient for one of those. */
function blockedFor(recipient: Member, mode: PaymentMode, ways: PayWays): NonNullable<SettlementOptions['blocked']> {
  const name = recipient.displayName;
  // The payer doesn't use bitcoin, so a wallet or a Lightning address is no use to them.
  if (!ways.lightning) {
    if (recipient.claimedByUserId) {
      return {
        message: `${name} hasn't added a UPI ID yet, so there's nowhere to pay them here. Ask them to add one from Wallet in Sattle. If you paid another way, ask them to mark it settled.`,
        remedies: ['remind'],
      };
    }
    return {
      message: `${name} isn't on Sattle yet, so there's nowhere to pay them. Invite them, and once they add a UPI ID you can pay here. Or mark it settled if you paid another way.`,
      remedies: ['invite', 'mark_settled'],
    };
  }
  if (mode === 'simulated') {
    return {
      message: `${name} hasn't set up a way to get paid yet. Add their Lightning address, invite them, or mark it settled if you paid another way.`,
      remedies: ['add_address', 'invite', 'mark_settled'],
    };
  }
  // They have the app, so only they can connect a wallet or confirm a payment made another way.
  if (recipient.claimedByUserId) {
    return {
      message: `${name} hasn't set up a way to get paid yet. Ask them to ${
        ways.upi ? 'add a UPI ID, connect a wallet' : 'connect a wallet'
      } or add their Lightning address from Wallet in Sattle. If you paid another way, ask them to mark it settled.`,
      remedies: ['remind'],
    };
  }
  return {
    message: `${name} isn't on Sattle yet, so there's nowhere to pay them. Invite them, and once they set up receiving you can pay here. Or mark it settled if you paid another way.`,
    remedies: ['invite', 'mark_settled'],
  };
}
