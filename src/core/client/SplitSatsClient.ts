/**
 * The only seam between the UI and the backend. Screens talk to this and
 * nothing else, so MockClient and ApiClient are interchangeable.
 */

import type {
  CreateSettlementInput,
  Debt,
  Expense,
  ExpenseInput,
  Group,
  Member,
  Settlement,
  User,
} from '../domain/types';

export interface Invite {
  url: string;
  message: string;
}

export interface SplitSatsClient {
  getCurrentUser(): Promise<User>;

  getGroups(): Promise<Group[]>;
  getGroup(groupId: string): Promise<Group>;
  getMembers(groupId: string): Promise<Member[]>;

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
}

export function newIdempotencyKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
