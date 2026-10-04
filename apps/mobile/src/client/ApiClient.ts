/**
 * HTTP client. The routes don't exist yet — each method body is the spec
 * for one endpoint.
 *
 * Writes that move money or create records send an `idempotency-key`. The
 * server must honour it: a retried settlement that mints a second invoice is
 * a double payment. The key comes from the caller when it's retrying a user
 * action (see ActionKeys); otherwise each call mints its own.
 */

import {
  SattleError,
  TERMINAL_STATUSES,
  type CreateGroupInput,
  type CreatePayLinkInput,
  type CreateSettlementInput,
  type Debt,
  type Expense,
  type ExpenseInput,
  type Group,
  type GuestView,
  type Invite,
  type InviteView,
  type Member,
  type PayLink,
  type Settlement,
  type User,
  type WalletConnection,
} from '@sattle/core';
import { newIdempotencyKey, type SattleClient } from './SattleClient';

const POLL_MS = 2000;

/**
 * Makes a device account. Not on SattleClient, because nobody is signed in
 * yet when it's called; the token it returns is what ApiClient sends after.
 */
export async function createAccount(baseUrl: string, displayName: string): Promise<{ user: User; token: string }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/accounts`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ displayName }),
    });
  } catch {
    throw new SattleError('network', 'Couldn’t reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}) as { code?: string; message?: string });
    throw new SattleError((err.code as SattleError['code']) ?? 'network', err.message ?? `Request failed (${res.status}).`);
  }
  return res.json() as Promise<{ user: User; token: string }>;
}

export class ApiClient implements SattleClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string | null = () => null
  ) {}

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    idempotencyKey?: string
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
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
  createGroup(input: CreateGroupInput, idempotencyKey = newIdempotencyKey()) {
    return this.request<Group>('POST', '/groups', input, idempotencyKey);
  }
  getMembers(groupId: string) {
    return this.request<Member[]>('GET', `/groups/${groupId}/members`);
  }
  addMember(groupId: string, displayName: string, idempotencyKey = newIdempotencyKey()) {
    return this.request<Member>('POST', `/groups/${groupId}/members`, { displayName }, idempotencyKey);
  }
  getExpenses(groupId: string) {
    return this.request<Expense[]>('GET', `/groups/${groupId}/expenses`);
  }
  addExpense(input: ExpenseInput, idempotencyKey = newIdempotencyKey()) {
    return this.request<Expense>('POST', `/groups/${input.groupId}/expenses`, input, idempotencyKey);
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
  createSettlement(input: CreateSettlementInput, idempotencyKey = newIdempotencyKey()) {
    return this.request<Settlement>('POST', `/groups/${input.groupId}/settlements`, input, idempotencyKey);
  }
  markSettledManually(
    input: Omit<CreateSettlementInput, 'rail'> & { note?: string },
    idempotencyKey = newIdempotencyKey()
  ) {
    return this.request<Settlement>(
      'POST',
      `/groups/${input.groupId}/settlements/manual`,
      input,
      idempotencyKey
    );
  }
  setMemberPayoutAddress(memberId: string, address: string) {
    return this.request<Member>('PUT', `/members/${memberId}/payout-address`, { address });
  }


  createPayLink(input: CreatePayLinkInput, idempotencyKey = newIdempotencyKey()) {
    const { groupId, ...body } = input;
    return this.request<PayLink>('POST', `/groups/${groupId}/pay-links`, body, idempotencyKey);
  }
  openPayLink(token: string) {
    return this.request<GuestView>('POST', `/s/${encodeURIComponent(token)}/open`, undefined, newIdempotencyKey());
  }
  getGuestView(token: string) {
    return this.request<GuestView>('GET', `/s/${encodeURIComponent(token)}`);
  }

  createInvite(groupId: string, memberId: string, idempotencyKey = newIdempotencyKey()) {
    return this.request<Invite>('POST', `/groups/${groupId}/invites`, { memberId }, idempotencyKey);
  }
  getInvite(token: string) {
    return this.request<InviteView>('GET', `/join/${encodeURIComponent(token)}`);
  }
  acceptInvite(token: string, idempotencyKey = newIdempotencyKey()) {
    return this.request<Group>('POST', '/groups/join', { token }, idempotencyKey);
  }

  connectWallet(nwcUri: string) {
    return this.request<WalletConnection>('PUT', '/me/wallet', { nwcUri });
  }
  getWalletConnection() {
    return this.request<WalletConnection>('GET', '/me/wallet');
  }

  /**
   * Server-sent events where the platform has EventSource (web), so every
   * status shows; polling everywhere else. EventSource can't send a bearer
   * token, so with one set this polls too until the server issues stream
   * tickets.
   */
  onSettlementUpdate(settlementId: string, cb: (s: Settlement) => void) {
    const done = (s: Settlement) => TERMINAL_STATUSES.includes(s.status);
    const polling = () => poll(() => this.getSettlement(settlementId), cb, done);
    if (typeof EventSource === 'undefined' || this.getToken()) return polling();
    return stream(`${this.baseUrl}/settlements/${encodeURIComponent(settlementId)}/events`, 'settlement', cb, done, polling);
  }

  onGuestViewUpdate(token: string, cb: (v: GuestView) => void) {
    return poll(
      () => this.getGuestView(token),
      cb,
      (v) => Boolean(v.settlement && TERMINAL_STATUSES.includes(v.settlement.status))
    );
  }
}

/**
 * Listens to one SSE event until `done`. If the stream drops before then
 * (server restart, the server's time limit, a proxy), it hands over to
 * `fallback` for good rather than letting EventSource reconnect forever.
 */
function stream<T>(
  url: string,
  event: string,
  cb: (v: T) => void,
  done: (v: T) => boolean,
  fallback: () => () => void
) {
  let finished = false;
  let stopFallback: (() => void) | undefined;
  const es = new EventSource(url);
  es.addEventListener(event, (e) => {
    const v = JSON.parse((e as MessageEvent<string>).data) as T;
    cb(v);
    if (done(v)) {
      finished = true;
      es.close();
    }
  });
  es.onerror = () => {
    es.close();
    if (finished) return;
    stopFallback ??= fallback();
  };
  return () => {
    finished = true;
    es.close();
    stopFallback?.();
  };
}

/** Calls `fetch` every POLL_MS until `done`, skipping transient errors. */
function poll<T>(fetch: () => Promise<T>, cb: (v: T) => void, done: (v: T) => boolean) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const v = await fetch();
      if (stopped) return;
      cb(v);
      if (done(v)) return;
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
