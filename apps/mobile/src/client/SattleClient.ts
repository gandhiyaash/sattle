/**
 * The only seam between the UI and the backend. Screens talk to this and
 * nothing else, so MockClient and ApiClient are interchangeable.
 *
 * Adding a method? Add it to MockClient in the same change, so the app keeps
 * running without the server.
 *
 * Writes take an optional `idempotencyKey`. Pass the same key when the user
 * retries the same action (ActionKeys does this), so a request that reached
 * the server before its response was lost isn't carried out twice. Without
 * one, each call gets a fresh key.
 */

import type {
  CreateGroupInput,
  CreatePayLinkInput,
  CreateSettlementInput,
  Debt,
  Expense,
  ExpenseInput,
  Group,
  GuestView,
  Invite,
  InviteView,
  LedgerBackup,
  Member,
  PayLink,
  Settlement,
  User,
  WalletConnection,
} from '@sattle/core';

export interface SattleClient {
  getCurrentUser(): Promise<User>;

  getGroups(): Promise<Group[]>;
  getGroup(groupId: string): Promise<Group>;
  /** The creator becomes a joined member; everyone in memberNames starts as a ghost. */
  createGroup(input: CreateGroupInput, idempotencyKey?: string): Promise<Group>;
  getMembers(groupId: string): Promise<Member[]>;
  /** Adds a ghost. */
  addMember(groupId: string, displayName: string, idempotencyKey?: string): Promise<Member>;

  getExpenses(groupId: string): Promise<Expense[]>;
  addExpense(input: ExpenseInput, idempotencyKey?: string): Promise<Expense>;

  /** Netted debts, counting only confirmed settlements. */
  getDebts(groupId: string): Promise<Debt[]>;

  getSettlements(groupId: string): Promise<Settlement[]>;
  getSettlement(settlementId: string): Promise<Settlement>;
  /**
   * Returns in a non-terminal state. Subscribe with onSettlementUpdate for
   * the rest. Throws `member_cannot_receive` for a recipient with nowhere to
   * receive — call resolveSettlementOptions first so that never happens.
   */
  createSettlement(input: CreateSettlementInput, idempotencyKey?: string): Promise<Settlement>;
  markSettledManually(
    input: Omit<CreateSettlementInput, 'rail'> & { note?: string },
    idempotencyKey?: string
  ): Promise<Settlement>;
  /** Returns an unsubscribe function. */
  onSettlementUpdate(settlementId: string, cb: (s: Settlement) => void): () => void;

  /** Stores a payout address for a ghost. Their status stays `ghost`. */
  setMemberPayoutAddress(memberId: string, address: string): Promise<Member>;

  /** The group's ledger on Nostr, and the key that reads it back without this server. Members only. */
  getLedgerBackup(groupId: string): Promise<LedgerBackup>;

  // -- pay links ------------------------------------------------------------

  /** Only the person owed can create one. Share `${APP_URL}${payLinkPath(token)}`. */
  createPayLink(input: CreatePayLinkInput, idempotencyKey?: string): Promise<PayLink>;
  /**
   * Public. Call once when the guest page loads: mints a fresh invoice unless
   * one is already in progress. Throws `link_expired` if the debt is gone.
   */
  openPayLink(token: string): Promise<GuestView>;
  /** Public, read-only. */
  getGuestView(token: string): Promise<GuestView>;
  /** Public. Returns an unsubscribe function. */
  onGuestViewUpdate(token: string, cb: (v: GuestView) => void): () => void;

  // -- invites --------------------------------------------------------------

  /**
   * For a ghost in a group you're in. Share `${APP_URL}${invitePath(token)}`.
   * Whoever accepts becomes a full member, so each link works once, lasts a
   * week, and making another for the same ghost kills the last.
   */
  createInvite(groupId: string, memberId: string, idempotencyKey?: string): Promise<Invite>;
  /** Public. Throws `not_found` for a dead link, `link_expired` once it's used or too old. */
  getInvite(token: string): Promise<InviteView>;
  /** The signed-in user becomes the invite's member. Returns the group they're now in. */
  acceptInvite(token: string, idempotencyKey?: string): Promise<Group>;

  // -- wallet connection ----------------------------------------------------

  /** Throws `invalid_wallet` unless the connection grants NWC_REQUIRED_METHODS. */
  connectWallet(nwcUri: string): Promise<WalletConnection>;
  getWalletConnection(): Promise<WalletConnection>;
}

export function newIdempotencyKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * One idempotency key per user action. The same action with the same input
 * keeps its key until it succeeds, so retrying after a network error replays
 * the first attempt if it got through, instead of doing it twice.
 *
 * Keeping the key after any error is safe: the server only stores a key once
 * the request succeeds, so after a real failure the retry runs afresh.
 * Changing the input makes it a different action with a new key.
 *
 * Running the same action again while it's still in flight (a double tap)
 * joins that request instead of sending a second one, which the server
 * would refuse with "still being processed" even though the first worked.
 */
export class ActionKeys {
  private keys = new Map<string, string>();
  private inFlight = new Map<string, Promise<unknown>>();

  run<T>(action: string, input: unknown, fn: (key: string) => Promise<T>): Promise<T> {
    const id = `${action} ${JSON.stringify(input)}`;
    const running = this.inFlight.get(id);
    if (running) return running as Promise<T>;

    let key = this.keys.get(id);
    if (!key) this.keys.set(id, (key = newIdempotencyKey()));
    const k = key;
    const attempt = new Promise<T>((resolve) => resolve(fn(k)))
      .then((result) => {
        this.keys.delete(id);
        return result;
      })
      .finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, attempt);
    return attempt;
  }
}
