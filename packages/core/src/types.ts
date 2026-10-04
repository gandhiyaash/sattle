/**
 * Domain vocabulary.
 *
 * Two distinctions carry most of the weight:
 *
 * - A Member is a row in a group; a User is an account on one device. A member
 *   may never be joined by anyone. `claimedByUserId` is the link between them.
 *   Someone on two devices has two accounts holding one member.
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
  /**
   * An account that has joined as this member; absent for a ghost. A member can
   * be held by several accounts, one per device. To the user reading it, their
   * own member always names them here; anyone else's names the account that
   * member is paid through.
   */
  claimedByUserId?: string;
  /** Payout address for a ghost. Stored without changing their status. */
  lightningAddress?: string;
  /**
   * The server's word on whether a payment to them can go through now. Under
   * real payments only it can tell: their own receiving address is on their
   * account, not here. Absent from the mock.
   */
  receivable?: boolean;
  /**
   * Whether they've given a UPI ID to be paid at. The ID itself isn't here:
   * it is only shown to someone who owes them (UpiPayee).
   */
  upi?: boolean;
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
  /** Absent on quotes made before the source was recorded. */
  rateSource?: RateSource;
  expiresAt: string;
}

/**
 * Where a quote's rate came from, shown to whoever pays so a market price is
 * never confused with a made-up one.
 *
 * market    the provider's price, read within the last 30s
 * stale     the provider is down; its last answer, from `fetchedAt`
 * fallback  the provider has never answered; a configured rate
 * demo      a fixed rate, because the payment itself is simulated
 */
export interface RateSource {
  kind: 'market' | 'stale' | 'fallback' | 'demo';
  /** Who gave the rate, e.g. "CoinGecko". Absent for a configured rate. */
  provider?: string;
  /** When the provider gave it. */
  fetchedAt?: string;
}

/**
 * `upi` is a payment made outside Sattle, from the payer's UPI app to the
 * payee's UPI ID. Nothing can check it, so it starts as a UpiClaim and only
 * becomes a settlement, already `manually_confirmed`, when the payee says it
 * arrived.
 */
export type Rail = 'in_app' | 'lightning_address' | 'invoice' | 'manual' | 'upi';

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
 * A shareable link that lets people into a group: whoever opens /join/<token>
 * picks which of its people they are and, with an account, becomes that
 * member, or adds themselves if they aren't one of them. Unlike a pay link
 * this grants the whole group, to read and to write, so it expires. A group has none until someone in it makes one, and
 * at most one at a time; anyone in the group can replace it or turn it off.
 */
export interface Invite {
  token: string;
  groupId: string;
  createdAt: string;
  expiresAt: string;
}

/** Someone the join page offers to join as. */
export interface InviteMember {
  /** What the page sends back to join as this person. Opaque, and only good with this invite. */
  ref: string;
  name: string;
  /**
   * Someone has joined as them already. They can still be picked: that is the
   * same person on another device, and both are then that member.
   */
  joined: boolean;
}

/** Who someone joins as: one of the people the invite offers, or a new member under that name. */
export type JoinAs = { ref: string } | { displayName: string };

/** Only what the join page may show before someone joins. Names, no ids. */
export interface InviteView {
  groupName: string;
  invitedBy: string;
  /** Everyone in the group: who the person opening this could be. */
  members: InviteMember[];
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

/**
 * A person's own Lightning address for receiving, for wallets that can't do
 * NWC. Used when they have no NWC connection. Null when they haven't set one.
 */
export interface ReceiveAddress {
  address: string | null;
}

// -- UPI -------------------------------------------------------------------

/** A person's own UPI ID, for being paid in rupees outside Lightning. Null when they haven't set one. */
export interface UpiProfile {
  upiId: string | null;
}

/** Who to pay over UPI. Only someone who owes them right now is given this. */
export interface UpiPayee {
  upiId: string;
  name: string;
}

/**
 * A payer's word that they paid a debt over UPI. Nobody can check it, so it
 * moves no balance. The person owed either confirms it, which makes it a
 * settlement, or says it didn't arrive, which the payer is then shown.
 */
export interface UpiClaim {
  id: string;
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  /** Minor units. */
  amount: number;
  /** The reference the payer's UPI app handed back, when it gave one. A hint, not proof. */
  reference?: string;
  /** `declined`: the person owed said it didn't arrive. It stays until the payer has seen it. */
  status: 'pending' | 'declined';
  createdAt: string;
}

export interface CreateUpiClaimInput {
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  amount: number;
  reference?: string;
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
