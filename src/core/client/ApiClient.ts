/**
 * HTTP client. The routes don't exist yet — each method body is the spec
 * for one endpoint.
 *
 * Writes that move money or create records send an `idempotency-key`. The
 * server must honour it: a retried settlement that mints a second invoice is
 * a double payment.
 */

import {
  SattleError,
  TERMINAL_STATUSES,
  type CreateSettlementInput,
  type Debt,
  type Expense,
  type ExpenseInput,
  type Group,
  type Member,
  type Settlement,
  type User,
} from '../domain/types';
import { newIdempotencyKey, type SattleClient } from './SattleClient';

const POLL_MS = 2000;

export class ApiClient implements SattleClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string | null = () => null
  ) {}

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    idempotent = false
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotent) headers['idempotency-key'] = newIdempotencyKey();
    const token = this.getToken();
    if (token) headers.authorization = `Bearer ${token}`;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new SattleError('network', 'Couldn’t reach the server. Check your connection and try again.');
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}) as { code?: string; message?: string });
      throw new SattleError(
        (err.code as SattleError['code']) ?? (res.status === 404 ? 'not_found' : 'network'),
        err.message ?? `Request failed (${res.status}).`
      );
    }
    return res.json() as Promise<T>;
  }

  getCurrentUser() {
    return this.request<User>('GET', '/me');
  }
  getGroups() {
    return this.request<Group[]>('GET', '/groups');
  }
  getGroup(groupId: string) {
    return this.request<Group>('GET', `/groups/${groupId}`);
  }
  getMembers(groupId: string) {
    return this.request<Member[]>('GET', `/groups/${groupId}/members`);
  }
  getExpenses(groupId: string) {
    return this.request<Expense[]>('GET', `/groups/${groupId}/expenses`);
  }
  addExpense(input: ExpenseInput) {
    return this.request<Expense>('POST', `/groups/${input.groupId}/expenses`, input, true);
  }
  getDebts(groupId: string) {
    return this.request<Debt[]>('GET', `/groups/${groupId}/debts`);
  }
  getSettlements(groupId: string) {
    return this.request<Settlement[]>('GET', `/groups/${groupId}/settlements`);
  }
  getSettlement(settlementId: string) {
    return this.request<Settlement>('GET', `/settlements/${settlementId}`);
  }
  createSettlement(input: CreateSettlementInput) {
    return this.request<Settlement>('POST', `/groups/${input.groupId}/settlements`, input, true);
  }
  markSettledManually(input: Omit<CreateSettlementInput, 'rail'> & { note?: string }) {
    return this.request<Settlement>(
      'POST',
      `/groups/${input.groupId}/settlements/manual`,
      input,
      true
    );
  }
  setMemberPayoutAddress(memberId: string, address: string) {
    return this.request<Member>('PUT', `/members/${memberId}/payout-address`, { address });
  }

  /** Polls until terminal. Swap for SSE or a websocket when the server has one. */
  onSettlementUpdate(settlementId: string, cb: (s: Settlement) => void) {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const s = await this.getSettlement(settlementId);
        if (stopped) return;
        cb(s);
        if (TERMINAL_STATUSES.includes(s.status)) return;
      } catch {
        // transient; keep polling
      }
      setTimeout(tick, POLL_MS);
    };
    setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
    };
  }
}
