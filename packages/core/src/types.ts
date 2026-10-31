/**
 * Domain vocabulary.
 *
 * Two distinctions carry most of the weight:
 *
 * - A Member is a row in a group; a User is a person with the app. A member
 *   may never become a user. `claimedByUserId` and `alsoHeldBy` are the only
 *   links between them: one person can join as the same member from more
 *   than one device, each an account of its own (members.ts).
 * - Debt is in the group's currency, in its smallest unit: paise for a group
 *   kept in rupees, sats for one kept in bitcoin (currency.ts). A rupee debt
 *   becomes sats only inside a Quote, pinned at quote time.
 */

/** `INR`, or `BTC` for a group counted in sats. */
export type Currency = 'INR' | 'BTC' | string;

export interface User {
  id: string;
  displayName: string;
  /**
   * The Nostr key linked to the account, as npub: signing in with it opens
   * the account on any device. Only ever shown to the account itself.
   */
  npub?: string;
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
  /** The first account to join as them. Set once anyone has. */
  claimedByUserId?: string;
  /**
   * The accounts that joined as them after that one, on other phones or
   * browsers. Each is them in the group as much as the first is, and they
   * can be paid through whichever has a way set up. Absent when there are none.
   */
  alsoHeldBy?: string[];
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
  /**
   * Whether someone in the group has to let each person in. Off from the
   * start: whoever holds the link picks a name and is in, as that person.
   * On, picking a name asks, and someone already in the group says yes, with a
   * code to check it's them. Anyone in the group can change it under Manage.
   */
  approveJoins: boolean;
  createdAt: string;
  /**
   * How the group settles up (groupDebts). On: debts are combined into as
   * few payments as there can be, so someone may pay a person they never
   * split with. Off: everyone pays back whoever paid for them. Anyone in the
   * group can change it, except while a payment is under way.
   */
  simplifyDebts: boolean;
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
  /** Who put it in, which needn't be who paid. Absent for one added before that was kept. */
  addedByMemberId?: string;
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
 * payee's UPI ID. Nothing can check it. It becomes a settlement, already
 * `manually_confirmed`, in one of two ways:
 *
 * - The payer says they paid (a UpiClaim), and the payee says it arrived.
 * - On Android the payer's UPI app itself says the payment went through, and
 *   hands back its ids (UpiReceipt). That settles it straight away, on the
 *   app's word, with nothing for the payee to do.
 * - Where no app says anything (an iPhone, a browser, an Android UPI app that
 *   stayed quiet), the payer is asked whether it went through. Their yes
 *   settles it the same way, with the reference their UPI app showed them
 *   kept when they give one.
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

/**
 * What there is to find a UPI payment by, when it was settled on the payer's
 * side's word: what their UPI app handed back when it said the payment went
 * through, or the reference the payer typed in themselves where no app
 * reports. Nothing here can check either: it carries no amount, no payee and
 * no signature. What it is good for is anyone in the group looking the
 * payment up in a statement.
 */
export interface UpiReceipt {
  /** The UPI transaction ID. */
  txnId?: string;
  /** The bank's approval reference, the number both sides see in their statements. Some apps leave it out. */
  approvalRef?: string;
  /** The reference the link itself asked for, echoed back. Sattle's links ask for none, so this is rarely there. */
  txnRef?: string;
  /**
   * The UPI app it was paid in, by the name the phone shows for it: "CRED", "Google Pay".
   * Android knows which app it opened, on the link or plain for a payment by hand; an iPhone
   * and a browser don't, and leave it out.
   */
  paidWith?: string;
  /**
   * Set when it was the payer who said the payment went through, because no
   * app said it for them. The three ids above are then absent: only an app
   * hands those back.
   */
  byPayer?: true;
  /** With `byPayer`: the number their UPI app showed for the payment, if they typed it in. They don't have to. */
  reference?: string;
}

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
  /**
   * Whose word settled it, when it was settled on someone's word: whoever
   * marked it settled, or confirmed that the UPI payment arrived. For a UPI
   * payment settled on the payer's app's word (`upi`), the payer. Absent for a
   * Lightning payment, which nobody vouches for, and for one recorded before
   * this was kept.
   */
  recordedByMemberId?: string;
  /**
   * Set when this was settled because the payer's UPI app said the payment
   * went through, without asking the person owed: what that app handed back.
   * Absent for a UPI payment the person owed confirmed themselves.
   */
  upi?: UpiReceipt;
  createdAt: string;
  /** When it last changed status. Once it is settled, that is when it was paid or marked as paid. */
  updatedAt: string;
}

export interface CreateSettlementInput {
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  amount: number;
  rail: Rail;
}

// -- history ---------------------------------------------------------------
//
// Everything that has happened to a group's money, in the order it happened.
// Nothing here is stored as a history: it is read off the expenses, the
// changes made to them, and the settlements (buildHistory).

/** An expense edited or removed, as it was noted when it happened. */
export interface ExpenseChange {
  id: string;
  expenseId: string;
  /** How it read before. Absent for a change noted before that was kept. */
  before?: Expense;
  /** How it reads after. Absent when it was removed. */
  after?: Expense;
  byMemberId?: string;
  at: string;
}

interface HistoryEntryBase {
  id: string;
  /** When it happened. For a settlement, when it was paid or marked as paid. */
  at: string;
  /**
   * Who did it: added, changed or removed the expense, or gave their word that
   * a debt was paid. Absent for a Lightning payment, and for anything from
   * before this was kept.
   */
  byMemberId?: string;
}

export type HistoryEntry = HistoryEntryBase &
  (
    | { kind: 'expense_added'; expense: Expense }
    /** `expense` is how it read after the change. */
    | { kind: 'expense_changed'; expense: Expense; before?: Expense }
    /** `before` is what was removed. */
    | { kind: 'expense_removed'; before?: Expense }
    /** A debt paid. Only settlements the ledger counts: one that failed or ran out isn't here. */
    | { kind: 'settled'; settlement: Settlement }
  );

// -- groups ----------------------------------------------------------------

export interface CreateGroupInput {
  name: string;
  currency: Currency;
  /** Everyone except the creator. They start as ghosts. */
  memberNames: string[];
  /** On if left out, as every group was before it was a choice (Group.simplifyDebts). */
  simplifyDebts?: boolean;
}

// -- pay links -------------------------------------------------------------

/**
 * A link for one debt, opened at /s/<token> with no app and no account. The
 * group's page hands one out when someone on it chooses a debt to pay. The
 * token grants that one debt, never the group. It can be paid whichever way
 * the payee can be paid: over Lightning, or in a rupee group by UPI
 * (GuestView's `payable` and `upi`).
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
  /** What the link asks for, in minor units of `currency`. */
  amount: number;
  currency: Currency;
  /** Whether the person owed has somewhere to receive it over Lightning (canReceive). */
  payable: boolean;
  /**
   * Whether the link can be paid by UPI: the group is in rupees, the person
   * owed has a UPI ID, and they haven't turned that off for shared links. The
   * ID itself isn't here; getPayLinkUpi gives it.
   */
  upi?: boolean;
  /** A UPI payment someone said they made for this debt, that the person owed hasn't confirmed. */
  upiClaim?: UpiClaim['status'];
  /** With `upiClaim`: it was marked as paid another way on the group's page, not said to be paid by UPI. */
  claimAnotherWay?: true;
  /**
   * The latest payment this link started. Absent until an invoice is minted,
   * which waits for the payer to choose when the link can also be paid by UPI.
   * A UPI payment said from the link shows here once the person owed confirms it.
   */
  settlement?: GuestSettlement;
}

// -- joining ---------------------------------------------------------------
//
// The group's link (GroupLink) is also how someone joins: they open
// /join/<token> with the same token, pick which of the group's people they
// are, or add themselves, and are in. Someone who has joined can be picked
// too: whoever picks them joins as them on this device, alongside the ones
// they already have. A group that has turned on approving joins
// (Group.approveJoins) makes that a request instead, which someone already
// in the group has to say yes to.

/** Someone the join page offers to join as. */
export interface JoinMember {
  /** What the page sends back to join as this person. Opaque, and only good with this link. */
  ref: string;
  name: string;
  /** Someone has joined as them already. Picking them joins as them here too, alongside that device. */
  joined?: true;
}

/** Who someone joins as: one of the people the link offers, or a new member under that name. */
export type JoinAs = { ref: string } | { displayName: string };

/** Only what the join page may show before someone joins. Names, no ids. */
export interface JoinView {
  groupName: string;
  /** Group.approveJoins: whether picking a name joins (`join`) or asks (`askToJoin`). */
  approveJoins: boolean;
  /** Everyone in the group, joined or not: who the person opening this could be. */
  members: JoinMember[];
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
}

/** Someone waiting to be let into a group, as the people already in it see them. */
export interface PendingJoin {
  id: string;
  name: string;
  /** They picked a name already in the group, with its balance. Otherwise they're new. */
  existing: boolean;
  /**
   * Someone has joined as that name: letting this person in makes them that
   * member too, on their device. 'you' when it's the name of whoever is
   * looking. Absent for a ghost or someone new.
   */
  joined?: 'you' | 'someone';
  code: string;
  createdAt: string;
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
  /** With `upiClaim`: it was marked as paid another way (UpiClaim.anotherWay), not said to be paid by UPI. */
  claimAnotherWay?: true;
  /**
   * Whether the page can mark it as paid, for a payment made outside Sattle (cash, UPI to a phone
   * number). Whatever the person owed has set up, or hasn't: it only needs them to have joined, so
   * there is someone to confirm it.
   */
  markable?: true;
}

/** Only what the group page may show. Names and amounts, no member or group ids. */
export interface GroupGuestView {
  groupName: string;
  currency: Currency;
  /** Group.approveJoins, so the page can say what Join leads to. */
  approveJoins: boolean;
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
 * A payer's word that they paid a debt over UPI, or, from the group's page,
 * that it was paid another way (`anotherWay`). Nobody can check it, so it
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
  /** Made by someone on a shared link, the group's or a pay link, who may not be the payer. */
  viaLink?: boolean;
  /**
   * Marked as paid on the group's page, for a payment made outside Sattle: cash, or UPI to a
   * phone number. No UPI ID or Lightning address is needed for it. Confirmed, the debt is
   * settled outside the app (rail `manual`), not paid by UPI. Always `viaLink`.
   */
  anotherWay?: true;
  createdAt: string;
}

export interface CreateUpiClaimInput {
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  amount: number;
  reference?: string;
}

/**
 * A UPI payment said to have gone through, by the payer's UPI app or by the
 * payer: the debt it paid, and what the app handed back or the payer typed.
 */
export interface ReportUpiPaymentInput extends UpiReceipt {
  groupId: string;
  fromMemberId: string;
  toMemberId: string;
  amount: number;
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
