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
  type CreateUpiClaimInput,
  type Debt,
  type Expense,
  type ExpenseInput,
  type Group,
  type GroupGuestView,
  type GroupLink,
  type GuestView,
  type JoinView,
  type JoinRequest,
  type PendingJoin,
  type JoinAs,
  type LedgerBackup,
  type Member,
  type PayLink,
  type PaymentMode,
  type ReceiveAddress,
  type Settlement,
  type UpiClaim,
  type UpiOnGroupLink,
  type UpiPayee,
  type UpiProfile,
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
  private paymentMode?: Promise<PaymentMode>;

  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string | null = () => null
  ) {}

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
  getPaymentMode() {
    // Asked once: it only changes when the server restarts. A server too old
    // to say is treated as real, so nobody is offered a payment it can't make.
    this.paymentMode ??= this.request<{ payments?: PaymentMode }>('GET', '/health').then(
      (h) => h.payments ?? 'real',
      (e) => {
        this.paymentMode = undefined;
        throw e;
      }
    );
    return this.paymentMode;
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
  submitProof(settlementId: string, preimage: string, idempotencyKey = newIdempotencyKey()) {
    return this.request<Settlement>('POST', `/settlements/${settlementId}/proof`, { preimage }, idempotencyKey);
  }
  getLedgerBackup(groupId: string) {
    return this.request<LedgerBackup>('GET', `/groups/${groupId}/ledger`);
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
  submitGuestProof(token: string, preimage: string, idempotencyKey = newIdempotencyKey()) {
    return this.request<GuestView>('POST', `/s/${encodeURIComponent(token)}/proof`, { preimage }, idempotencyKey);
  }

  getJoinView(token: string) {
    return this.request<JoinView>('GET', `/join/${encodeURIComponent(token)}`);
  }
  getJoinedGroup(token: string) {
    return this.request<Group | null>('GET', `/links/${encodeURIComponent(token)}/group`);
  }
  askToJoin(token: string, as: JoinAs, idempotencyKey = newIdempotencyKey()) {
    return this.request<JoinRequest>('POST', '/join-requests', { token, ...as }, idempotencyKey);
  }
  getMyJoinRequests() {
    return this.request<JoinRequest[]>('GET', '/me/join-requests');
  }
  async withdrawJoinRequest(requestId: string, idempotencyKey = newIdempotencyKey()) {
    await this.request('DELETE', `/join-requests/${encodeURIComponent(requestId)}`, undefined, idempotencyKey);
  }
  getPendingJoins(groupId: string) {
    return this.request<PendingJoin[]>('GET', `/groups/${groupId}/join-requests`);
  }
  approveJoin(requestId: string, idempotencyKey = newIdempotencyKey()) {
    return this.request<Member>('POST', `/join-requests/${encodeURIComponent(requestId)}/approve`, undefined, idempotencyKey);
  }
  async declineJoin(requestId: string, idempotencyKey = newIdempotencyKey()) {
    await this.request('POST', `/join-requests/${encodeURIComponent(requestId)}/decline`, undefined, idempotencyKey);
  }

  getGroupLink(groupId: string) {
    return this.request<GroupLink | null>('GET', `/groups/${groupId}/link`);
  }
  createGroupLink(groupId: string, idempotencyKey = newIdempotencyKey()) {
    return this.request<GroupLink>('POST', `/groups/${groupId}/link`, undefined, idempotencyKey);
  }
  async removeGroupLink(groupId: string, idempotencyKey = newIdempotencyKey()) {
    await this.request('DELETE', `/groups/${groupId}/link`, undefined, idempotencyKey);
  }
  getGroupGuestView(token: string) {
    return this.request<GroupGuestView>('GET', `/g/${encodeURIComponent(token)}`);
  }
  payFromGroupLink(token: string, ref: string, idempotencyKey = newIdempotencyKey()) {
    return this.request<{ token: string }>(
      'POST',
      `/g/${encodeURIComponent(token)}/debts/${encodeURIComponent(ref)}/pay-link`,
      undefined,
      idempotencyKey
    );
  }
  getGroupLinkUpi(token: string, ref: string) {
    return this.request<UpiPayee>('GET', `/g/${encodeURIComponent(token)}/debts/${encodeURIComponent(ref)}/upi`);
  }
  async claimUpiFromGroupLink(token: string, ref: string, idempotencyKey = newIdempotencyKey()) {
    await this.request(
      'POST',
      `/g/${encodeURIComponent(token)}/debts/${encodeURIComponent(ref)}/upi-claims`,
      undefined,
      idempotencyKey
    );
  }

  updateExpense(expenseId: string, input: ExpenseInput, idempotencyKey = newIdempotencyKey()) {
    return this.request<Expense>('PUT', `/groups/${input.groupId}/expenses/${expenseId}`, input, idempotencyKey);
  }
  async deleteExpense(groupId: string, expenseId: string, idempotencyKey = newIdempotencyKey()) {
    await this.request('DELETE', `/groups/${groupId}/expenses/${expenseId}`, undefined, idempotencyKey);
  }
  renameGroup(groupId: string, name: string, idempotencyKey = newIdempotencyKey()) {
    return this.request<Group>('PUT', `/groups/${groupId}`, { name }, idempotencyKey);
  }
  async deleteGroup(groupId: string, idempotencyKey = newIdempotencyKey()) {
    await this.request('DELETE', `/groups/${groupId}`, undefined, idempotencyKey);
  }
  async removeMember(groupId: string, memberId: string, idempotencyKey = newIdempotencyKey()) {
    await this.request('DELETE', `/groups/${groupId}/members/${memberId}`, undefined, idempotencyKey);
  }
  async leaveGroup(groupId: string, idempotencyKey = newIdempotencyKey()) {
    await this.request('POST', `/groups/${groupId}/leave`, undefined, idempotencyKey);
  }

  connectWallet(nwcUri: string) {
    return this.request<WalletConnection>('PUT', '/me/wallet', { nwcUri });
  }
  getWalletConnection() {
    return this.request<WalletConnection>('GET', '/me/wallet');
  }
  getReceiveAddress() {
    return this.request<ReceiveAddress>('GET', '/me/receive-address');
  }
  setReceiveAddress(address: string) {
    return this.request<ReceiveAddress>('PUT', '/me/receive-address', { address });
  }
  clearReceiveAddress() {
    return this.request<ReceiveAddress>('DELETE', '/me/receive-address');
  }

  getUpiId() {
    return this.request<UpiProfile>('GET', '/me/upi');
  }
  setUpiId(upiId: string) {
    return this.request<UpiProfile>('PUT', '/me/upi', { upiId });
  }
  setUpiOnGroupLinks(on: boolean) {
    return this.request<UpiProfile>('PUT', '/me/upi/group-links', { on });
  }
  getUpiOnGroupLink(groupId: string) {
    return this.request<UpiOnGroupLink>('GET', `/me/upi/group-links/${groupId}`);
  }
  setUpiOnGroupLink(groupId: string, on: boolean | null) {
    return this.request<UpiOnGroupLink>('PUT', `/me/upi/group-links/${groupId}`, { on });
  }
  clearUpiId() {
    return this.request<UpiProfile>('DELETE', '/me/upi');
  }
  getUpiPayee(groupId: string, memberId: string) {
    return this.request<UpiPayee>('GET', `/groups/${groupId}/members/${memberId}/upi`);
  }
  getUpiClaims(groupId: string) {
    return this.request<UpiClaim[]>('GET', `/groups/${groupId}/upi-claims`);
  }
  createUpiClaim(input: CreateUpiClaimInput, idempotencyKey = newIdempotencyKey()) {
    const { groupId, ...body } = input;
    return this.request<UpiClaim>('POST', `/groups/${groupId}/upi-claims`, body, idempotencyKey);
  }
  confirmUpiClaim(claimId: string, idempotencyKey = newIdempotencyKey()) {
    return this.request<Settlement>('POST', `/upi-claims/${claimId}/confirm`, undefined, idempotencyKey);
  }
  declineUpiClaim(claimId: string, idempotencyKey = newIdempotencyKey()) {
    return this.request<UpiClaim>('POST', `/upi-claims/${claimId}/decline`, undefined, idempotencyKey);
  }
  async withdrawUpiClaim(claimId: string, idempotencyKey = newIdempotencyKey()) {
    await this.request('DELETE', `/upi-claims/${claimId}`, undefined, idempotencyKey);
  }
  disconnectWallet() {
    return this.request<WalletConnection>('DELETE', '/me/wallet');
  }

  /**
   * A retry after a lost response finds the token already dead. That 401
   * means the first attempt worked, so it counts as done.
   */
  async deleteAccount() {
    try {
      await this.request('DELETE', '/me');
    } catch (e) {
      if (!(e instanceof SattleError && e.code === 'unauthorized')) throw e;
    }
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
