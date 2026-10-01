/**
 * The only seam between the UI and the backend. Screens talk to this and
 * nothing else, so MockClient and ApiClient are interchangeable.
 *
 * Adding a method? Add it to MockClient in the same change, so the app keeps
 * running without the server.
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
  Member,
  PayLink,
  Settlement,
  User,
  WalletConnection,
} from '@sattle/core';

export interface Invite {
  url: string;
  message: string;
}

export interface SattleClient {
  getCurrentUser(): Promise<User>;

  getGroups(): Promise<Group[]>;
  getGroup(groupId: string): Promise<Group>;
  /** The creator becomes a joined member; everyone in memberNames starts as a ghost. */
  createGroup(input: CreateGroupInput): Promise<Group>;
  getMembers(groupId: string): Promise<Member[]>;
  /** Adds a ghost. */
  addMember(groupId: string, displayName: string): Promise<Member>;

  getExpenses(groupId: string): Promise<Expense[]>;
  addExpense(input: ExpenseInput): Promise<Expense>;

  /** Netted debts, counting only confirmed settlements. */
  getDebts(groupId: string): Promise<Debt[]>;

  getSettlements(groupId: string): Promise<Settlement[]>;
  getSettlement(settlementId: string): Promise<Settlement>;
  /**
   * Returns in a non-terminal state. Subscribe with onSettlementUpdate for
   * the rest. Throws `member_cannot_receive` for a recipient with nowhere to
   * receive — call resolveSettlementOptions first so that never happens.
   */
  createSettlement(input: CreateSettlementInput): Promise<Settlement>;
  markSettledManually(
    input: Omit<CreateSettlementInput, 'rail'> & { note?: string }
  ): Promise<Settlement>;
  /** Returns an unsubscribe function. */
  onSettlementUpdate(settlementId: string, cb: (s: Settlement) => void): () => void;

  /** Stores a payout address for a ghost. Their status stays `ghost`. */
  setMemberPayoutAddress(memberId: string, address: string): Promise<Member>;

  // -- pay links ------------------------------------------------------------

  /** Only the person owed can create one. Share `${APP_URL}${payLinkPath(token)}`. */
  createPayLink(input: CreatePayLinkInput): Promise<PayLink>;
  /**
   * Public. Call once when the guest page loads: mints a fresh invoice unless
   * one is already in progress. Throws `link_expired` if the debt is gone.
   */
  openPayLink(token: string): Promise<GuestView>;
  /** Public, read-only. */
  getGuestView(token: string): Promise<GuestView>;
  /** Public. Returns an unsubscribe function. */
  onGuestViewUpdate(token: string, cb: (v: GuestView) => void): () => void;

  // -- wallet connection ----------------------------------------------------

  /** Throws `invalid_wallet` unless the connection grants NWC_REQUIRED_METHODS. */
  connectWallet(nwcUri: string): Promise<WalletConnection>;
  getWalletConnection(): Promise<WalletConnection>;
}

export function newIdempotencyKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
