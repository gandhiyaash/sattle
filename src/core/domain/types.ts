/**
 * Domain vocabulary.
 *
 * Two distinctions carry most of the weight:
 *
 * - A Member is a row in a group; a User is a person with the app. A member
 *   may never become a user. `claimedByUserId` is the only link between them.
 * - Debt is denominated in fiat minor units (paise). Sats exist only inside a
 *   Quote, pinned at quote time.
 */

export type Currency = 'INR' | string;

export interface User {
  id: string;
  displayName: string;
}

/**
 * ghost       never installed anything; can pay by scanning, cannot receive
 *             unless someone stores a Lightning address for them
 * joined      has the app and an in-app wallet
 * nwc_linked  connected an external wallet over NWC
 */
export type MemberStatus = 'ghost' | 'joined' | 'nwc_linked';

export interface Member {
  id: string;
  groupId: string;
  displayName: string;
  status: MemberStatus;
  claimedByUserId?: string;
  /** Payout address for a ghost. Stored without changing their status. */
  lightningAddress?: string;
}

export interface Group {
  id: string;
  name: string;
  currency: Currency;
  memberIds: string[];
  createdAt: string;
}

export type SplitMode = 'equal' | 'shares' | 'exact';

export interface ExpensePartInput {
  memberId: string;
  /** Used by `shares`. Defaults to 1. */
  weight?: number;
  /** Used by `exact`, in minor units. */
  amount?: number;
}

export interface ExpenseInput {
  groupId: string;
  description: string;
  /** Minor units. */
  amount: number;
  paidByMemberId: string;
  splitMode: SplitMode;
  parts: ExpensePartInput[];
}

export interface ResolvedPart {
  memberId: string;
  /** Minor units. Parts always sum to the expense amount exactly. */
  amount: number;
}

export interface Expense {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  paidByMemberId: string;
  splitMode: SplitMode;
  parts: ResolvedPart[];
  createdAt: string;
}

export interface Balance {
  memberId: string;
  /** Positive: they are owed. Negative: they owe. Minor units. */
  net: number;
}

export interface Debt {
  id: string;
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  /** Minor units of the group currency. */
  amount: number;
}

export interface Quote {
  amountFiat: number;
  currency: Currency;
  amountSat: number;
  /** Separate from amountSat: fees are added on top, never deducted. */
  feeSat: number;
  rateFiatPerBtc: number;
  expiresAt: string;
}

export type Rail = 'in_app' | 'lightning_address' | 'invoice' | 'manual';

export type SettlementStatus =
  | 'created'
  | 'awaiting_payment'
  | 'in_flight'
  | 'confirmed'
  | 'failed'
  | 'expired'
  | 'manually_confirmed';

export const TERMINAL_STATUSES: readonly SettlementStatus[] = [
  'confirmed',
  'failed',
  'expired',
  'manually_confirmed',
];

/** The only statuses the ledger counts. */
export const LEDGER_STATUSES: readonly SettlementStatus[] = [
  'confirmed',
  'manually_confirmed',
];

export interface Settlement {
  id: string;
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  /** Minor units. */
  amount: number;
  currency: Currency;
  rail: Rail;
  status: SettlementStatus;
  quote?: Quote;
  /** BOLT11 invoice or Lightning address the payer should pay. */
  destination?: string;
  /** Proof of payment. Present once confirmed over Lightning. */
  preimage?: string;
  note?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSettlementInput {
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  amount: number;
  rail: Rail;
}

export type SplitSatsErrorCode =
  | 'not_found'
  | 'network'
  | 'member_cannot_receive'
  | 'invalid_address'
  | 'invalid_expense'
  | 'payment_failed';

export class SplitSatsError extends Error {
  constructor(
    public readonly code: SplitSatsErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SplitSatsError';
  }
}
