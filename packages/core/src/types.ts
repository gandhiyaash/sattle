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

// -- groups ----------------------------------------------------------------

export interface CreateGroupInput {
  name: string;
  currency: Currency;
  /** Everyone except the creator. They start as ghosts. */
  memberNames: string[];
}

// -- pay links -------------------------------------------------------------

/**
 * A shareable link for one debt: the payee sends it to the payer, who opens
 * /s/<token> with no app and no account. The token grants that one debt,
 * never the group.
 */
export interface PayLink {
  token: string;
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  /** Minor units. */
  amount: number;
  createdAt: string;
}

export interface CreatePayLinkInput {
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  amount: number;
}

/** Only what the guest page may show. No member ids, no group id. */
export type GuestSettlement = Pick<
  Settlement,
  'id' | 'amount' | 'currency' | 'status' | 'quote' | 'destination' | 'preimage' | 'failureReason' | 'updatedAt'
>;

export interface GuestView {
  payerName: string;
  payeeName: string;
  /** e.g. the group name. */
  reason: string;
  /** Absent until the link is opened and an invoice minted. */
  settlement?: GuestSettlement;
}

// -- invites ---------------------------------------------------------------

/**
 * A shareable link that lets one person take over one ghost: whoever opens
 * /join/<token> with an account becomes that member. Unlike a pay link this
 * grants the whole group, to read and to write, so it works once and expires.
 */
export interface Invite {
  token: string;
  groupId: string;
  memberId: string;
  createdAt: string;
  expiresAt: string;
}

/** Only what the join page may show before someone accepts. Names, no ids. */
export interface InviteView {
  groupName: string;
  /** The member they would become. */
  memberName: string;
  invitedBy: string;
}

// -- wallet connection -----------------------------------------------------

/**
 * The payee's NWC connection, as the server sees it. The connection string
 * itself never comes back from the server.
 */
/**
 * A group's ledger, mirrored to Nostr. Every expense and confirmed settlement
 * is signed by the server and encrypted with a key only members get. `uri`
 * carries that key: with it, anyone in the group can rebuild the balances
 * from the relays without this server.
 */
export interface LedgerBackup {
  /** `sattle-ledger://<server pubkey>?key=<hex>&relay=wss://…`. A secret: it decrypts the group. */
  uri: string;
  /** The server's signing key, as npub. */
  npub: string;
  relays: string[];
  entries: number;
  published: number;
}

export interface WalletConnection {
  connected: boolean;
  /** NWC methods the wallet granted, from get_info. Ideally just make_invoice + lookup_invoice. */
  methods: string[];
  /** Methods granted that the server doesn't need — shown as a warning (e.g. pay_invoice). */
  excessMethods: string[];
  alias?: string;
  connectedAt?: string;
}

export type SattleErrorCode =
  | 'not_found'
  | 'network'
  | 'member_cannot_receive'
  | 'invalid_address'
  | 'invalid_expense'
  | 'payment_failed'
  | 'unauthorized'
  | 'conflict'
  | 'invalid_input'
  | 'invalid_wallet'
  | 'link_expired'
  | 'not_implemented'
  | 'internal';

export class SattleError extends Error {
  constructor(
    public readonly code: SattleErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SattleError';
  }
}
