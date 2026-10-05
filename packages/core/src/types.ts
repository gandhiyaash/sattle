/**
 * Domain vocabulary.
 *
 * Two distinctions carry most of the weight:
 *
 * - A Member is a row in a group; a User is a person with the app. A member
 *   may never become a user. `claimedByUserId` is the only link between them.
 * - Debt is in the group's currency, in its smallest unit: paise for a group
 *   kept in rupees, sats for one kept in bitcoin (currency.ts). A rupee debt
 *   becomes sats only inside a Quote, pinned at quote time.
 */

/** `INR`, or `BTC` for a group counted in sats. */
export type Currency = 'INR' | 'BTC' | string;

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
  /**
   * The server's word on whether a payment to them can go through now. Under
   * real payments only it can tell: their own receiving address is on their
   * account, not here. Absent from the mock.
   */
  receivable?: boolean;
  /**
   * Whether they've given a UPI ID to be paid at. The ID itself isn't here:
   * it is shown to someone paying them (UpiPayee).
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
  /** The debt, in minor units of `currency`. For a group kept in bitcoin that is sats, the same as `amountSat`. */
  amountFiat: number;
  currency: Currency;
  amountSat: number;
  /** Separate from amountSat: fees are added on top, never deducted. */
  feeSat: number;
  /** 1 for a group kept in bitcoin, where nothing was converted. */
  rateFiatPerBtc: number;
  /** Absent on quotes made before the source was recorded, and where no rate was used. */
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

// -- joining ---------------------------------------------------------------
//
// The group's link (GroupLink) is also how someone asks to join: they open
// /join/<token> with the same token, pick which of the group's ghosts they
// are, or add themselves, and someone already in the group lets them in.

/** Someone the join page offers to join as. */
export interface JoinMember {
  /** What the page sends back to join as this person. Opaque, and only good with this link. */
  ref: string;
  name: string;
}

/** Who someone joins as: one of the people the link offers, or a new member under that name. */
export type JoinAs = { ref: string } | { displayName: string };

/** Only what the join page may show before someone joins. Names, no ids. */
export interface JoinView {
  groupName: string;
  /** Everyone in the group who hasn't joined: who the person opening this could be. */
  members: JoinMember[];
  /**
   * The names of the people who have. The page shows them so the whole group is
   * on it. Each belongs to an account already, so picking one isn't joining.
   */
  joined: string[];
  /**
   * The same people, to pick for taking a place back: someone who joined, then
   * lost the phone or browser they joined with. Letting them in hands the
   * name to the new account. Absent from servers older than this.
   */
  rejoin?: JoinMember[];
}

/**
 * Asking to join, as the person asking sees it. The link doesn't let anyone
 * in by itself: someone already in the group has to say yes, so a link that
 * was forwarded can't be used to become someone. Once they do, the request is
 * gone and the group is in the asker's list. `declined` stays until the asker
 * has seen it.
 */
export interface JoinRequest {
  id: string;
  groupName: string;
  /** The name they'll have in the group: the one they picked, or the one they gave. */
  name: string;
  /**
   * Four digits, shown to them and to whoever lets them in. If two people ask
   * to be the same person, asking "which code do you see?" tells them apart.
   */
  code: string;
  status: 'pending' | 'declined';
  createdAt: string;
  /** They asked for a name someone has joined as: their own, on a device they no longer have. */
  takesOver?: boolean;
}

/** Someone waiting to be let into a group, as the people already in it see them. */
export interface PendingJoin {
  id: string;
  name: string;
  /** They picked a name already in the group, and take over its balance. Otherwise they're new. */
  existing: boolean;
  code: string;
  createdAt: string;
  /**
   * Someone has joined as that name, and letting this person in hands it to
   * them: 'you' when it's the name of whoever is looking. Absent for a ghost
   * or someone new.
   */
  replacing?: 'you' | 'someone';
}

// -- group links -----------------------------------------------------------

/**
 * The group's one link. It shows the whole group to anyone who holds it:
 * every spend, who owes whom, and a way to pay a debt. It can't change
 * anything, but its holder can ask to join with it, which someone in the
 * group has to say yes to. A group has none until someone in it makes one,
 * and at most one at a time; anyone in the group can replace it or turn it
 * off. It doesn't run out by itself.
 */
export interface GroupLink {
  token: string;
  groupId: string;
  createdAt: string;
}

/** A spend as the group page shows it. Names and amounts, no ids. */
export interface GroupGuestExpense {
  description: string;
  /** Minor units. */
  amount: number;
  paidBy: string;
  /** Each person's part of it. */
  shares: { name: string; amount: number }[];
  createdAt: string;
}

/** A debt as the group page shows it. */
export interface GroupGuestDebt {
  /** What the page sends back to pay this debt. Opaque, and only good with this group link. */
  ref: string;
  from: string;
  to: string;
  /** Minor units. */
  amount: number;
  /** Whether the person owed has somewhere to receive it over Lightning (canReceive). */
  payable: boolean;
  /**
   * Whether the person owed takes UPI from this page: the group is in rupees,
   * they have a UPI ID, and they haven't turned that off for shared links.
   * The ID itself isn't here; getGroupLinkUpi gives it for one debt.
   */
  upi?: boolean;
  /** A UPI payment someone said they made for this debt, that the person owed hasn't confirmed. */
  upiClaim?: UpiClaim['status'];
}

/** Only what the group page may show. Names and amounts, no member or group ids. */
export interface GroupGuestView {
  groupName: string;
  currency: Currency;
  expenses: GroupGuestExpense[];
  debts: GroupGuestDebt[];
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
  /** The newest entry on the relays, as a nevent anyone can look up. Absent until one is published. */
  latest?: string;
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
  /**
   * Whether anyone holding one of their groups' shared links can be shown the
   * UPI ID to pay them. On unless they turn it off; the ID often holds a phone
   * number and a shared link has no login, so the app says so where the ID is
   * added. It covers every group they're in, except one they've chosen for by
   * itself (UpiOnGroupLink).
   */
  onGroupLinks?: boolean;
}

/** Whether one group's shared link can show a person's UPI ID. */
export interface UpiOnGroupLink {
  /** What applies to this group now. */
  on: boolean;
  /** What they chose for this group alone, or null while it follows their choice for all groups. */
  choice: boolean | null;
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
  /** Made by someone on the group's shared link, who may not be the payer. */
  viaLink?: boolean;
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
