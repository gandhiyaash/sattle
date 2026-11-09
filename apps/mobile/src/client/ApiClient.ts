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
  NOSTR_AUTH_PATHS,
  SattleError,
  TERMINAL_STATUSES,
  type CreateGroupInput,
  type CreateSettlementInput,
  type CreateUpiClaimInput,
  type Debt,
  type Expense,
  type ExpenseInput,
  type Group,
  type GroupGuestView,
  type GroupLink,
  type GuestView,
  type HistoryEntry,
  type JoinView,
  type JoinRequest,
  type PendingJoin,
  type JoinAs,
  type LedgerBackup,
  type Member,
  type PayLink,
  type PaymentMode,
  type ReceiveAddress,
  type ReportUpiPaymentInput,
  type Settlement,
  type SyncAnswer,
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
 * How long a request waits for its answer before it's taken as lost. Without
 * one, a request on a connection that died quietly would wait for good, and a
 * change saved behind the screen (AppData) would sit as "saving" with it. A
 * write gets longer: it does more, and timing out leaves it unclear whether it
 * happened, so it's sent again with the same key.
 */
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 20_000;

/** After an older server says it has no GET /sync, how long to read it the old way before asking again. */
const NO_SYNC_RETRY_MS = 10 * 60_000;

const unreachable = () => new SattleError('network', 'Couldn’t reach the server. Check your connection and try again.');

/** The server didn't answer in time. As unknown as unreachable, but asking again at once won't be quicker. */
class TimedOut extends SattleError {
  constructor() {
    super('network', 'The server took too long to answer. Check your connection and try again.');
  }
}

/**
 * Connecting a wallet waits on the wallet itself, over Nostr: the server
 * allows it about 20 s (apps/api nwc.ts), so the app waits longer than that.
 */
const WALLET_TIMEOUT_MS = 40_000;

let extraHeaders: () => Record<string, string> = () => ({});
/**
 * Headers every request carries besides its own: which install and session
 * it came from, so the server's own record of it joins what the app reports
 * of itself. Set once by analytics.ts; this file doesn't import it, so the
 * client runs under vitest without React Native.
 */
export function setRequestHeaders(headers: () => Record<string, string>) {
  extraHeaders = headers;
}

/**
 * Makes a device account. Not on SattleClient, because nobody is signed in
 * yet when it's called; the token it returns is what ApiClient sends after.
 */
export function createAccount(baseUrl: string, displayName: string): Promise<{ user: User; token: string }> {
  return postPublic(baseUrl, '/accounts', { displayName });
}

/** A one-time challenge for a Nostr sign-in proof. Public: needed before anyone is signed in, and for linking. */
export async function nostrChallenge(baseUrl: string): Promise<string> {
  return (await postPublic<{ challenge: string }>(baseUrl, '/auth/nostr/challenge', {})).challenge;
}

/** Signs in with a Nostr proof (see @sattle/core nostrAuth): the linked account, and its token. */
export function signInWithNostr(baseUrl: string, event: unknown): Promise<{ user: User; token: string }> {
  return postPublic(baseUrl, NOSTR_AUTH_PATHS.signIn, { event });
}

async function postPublic<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', ...extraHeaders() },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SattleError('network', 'Couldn’t reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}) as { code?: string; message?: string });
    throw new SattleError((err.code as SattleError['code']) ?? 'network', err.message ?? `Request failed (${res.status}).`);
  }
  return res.json() as Promise<T>;
}

export class ApiClient implements SattleClient {
  private paymentMode?: Promise<PaymentMode>;
  /** Until when the server is read the old way, having said it has no GET /sync. */
  private noSyncUntil = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string | null = () => null
  ) {}

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
    more: Record<string, string> = {},
    timeoutMs = method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders(), ...more };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const token = this.getToken();
    if (token) headers.authorization = `Bearer ${token}`;

    const controller = typeof AbortController === 'undefined' ? undefined : new AbortController();
    const timer = controller && setTimeout(() => controller.abort(), timeoutMs);
    const lost = () => (controller?.signal.aborted ? new TimedOut() : unreachable());
    try {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller?.signal,
        });
      } catch {
        throw lost();
      }

      // Not modified: asked with a version that is still current (GET /sync). There's no body to read.
      if (res.status === 304) return null as T;
      if (!res.ok) {
        const err = await res.json().catch(() => ({}) as { code?: string; message?: string });
        throw new SattleError(
          (err.code as SattleError['code']) ?? (res.status === 404 ? 'not_found' : 'network'),
          err.message ?? `Request failed (${res.status}).`
        );
      }
      try {
        return (await res.json()) as T;
      } catch {
        // Cut off while the answer was arriving: as lost as one that never came.
        throw lost();
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async sync(version?: string, groups?: readonly string[]): Promise<SyncAnswer> {
    if (Date.now() >= this.noSyncUntil) {
      // In one order, so the same groups are the same question, with the same version, however they were asked for.
      const path = groups ? `/sync?${[...groups].sort().map((id) => `group=${encodeURIComponent(id)}`).join('&')}` : '/sync';
      try {
        try {
          return await this.syncOnce(path, version);
        } catch (e) {
          // A browser asking with a version an older server's CORS doesn't allow fails as unreachable,
          // at once. Asked again plainly, that server answers 404, and is read the old way below.
          // One that timed out would only time out again, for longer.
          if (!(version && e instanceof SattleError && e.code === 'network' && !(e instanceof TimedOut))) throw e;
          return await this.syncOnce(path);
        }
      } catch (e) {
        // GET /sync never answers 404 (a group it can't show is left out), so this is a server from before it.
        if (!(e instanceof SattleError && e.code === 'not_found')) throw e;
        this.noSyncUntil = Date.now() + NO_SYNC_RETRY_MS;
      }
    }
    return this.syncTheOldWay(groups);
  }

  /** GET /sync, saying which version the app has: a 304 is that nothing changed. */
  private async syncOnce(path: string, version?: string): Promise<SyncAnswer> {
    const answer = await this.request<SyncAnswer | null>('GET', path, undefined, undefined, version ? { 'if-none-match': `W/"${version}"` } : {});
    return answer ?? { version: version!, unchanged: true };
  }

  /**
   * The same answer from an older server's own routes, all at once: the reads
   * the screens used to make one by one. Its version is '' (never unchanged),
   * which tells AppData to ask less often.
   */
  private async syncTheOldWay(only?: readonly string[]): Promise<SyncAnswer> {
    const [user, groups, joinRequests, upiProfile] = await Promise.all([
      this.getCurrentUser(),
      this.getGroups(),
      this.getMyJoinRequests(),
      this.getUpiId(),
    ]);
    const snapshots = await Promise.all(
      groups.filter((g) => !only || only.includes(g.id)).map(async (group) => {
        const [members, expenses, settlements, upiClaims, pendingJoins] = await Promise.all([
          this.getMembers(group.id),
          this.getExpenses(group.id),
          this.getSettlements(group.id),
          this.getUpiClaims(group.id),
          this.getPendingJoins(group.id),
        ]);
        // A server from before /sync kept no log either.
        return { group, members, expenses, settlements, upiClaims, pendingJoins, log: [] };
      })
    );
    return { version: '', user, groups: snapshots, joinRequests, upiProfile };
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
  getHistory(groupId: string) {
    return this.request<HistoryEntry[]>('GET', `/groups/${groupId}/history`);
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

  openPayLink(token: string, rail?: 'lightning') {
    return this.request<GuestView>('POST', `/s/${encodeURIComponent(token)}/open`, rail && { rail }, newIdempotencyKey());
  }
  getPayLinkUpi(token: string) {
    return this.request<UpiPayee>('GET', `/s/${encodeURIComponent(token)}/upi`);
  }
  async claimUpiFromPayLink(token: string, idempotencyKey = newIdempotencyKey()) {
    await this.request('POST', `/s/${encodeURIComponent(token)}/upi-claims`, undefined, idempotencyKey);
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
  join(token: string, as: JoinAs, idempotencyKey = newIdempotencyKey()) {
    return this.request<Member>('POST', '/join', { token, ...as }, idempotencyKey);
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
  async markPaidFromGroupLink(token: string, ref: string, idempotencyKey = newIdempotencyKey()) {
    await this.request(
      'POST',
      `/g/${encodeURIComponent(token)}/debts/${encodeURIComponent(ref)}/paid-another-way`,
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
  setSimplifyDebts(groupId: string, on: boolean, idempotencyKey = newIdempotencyKey()) {
    return this.request<Group>('PUT', `/groups/${groupId}`, { simplifyDebts: on }, idempotencyKey);
  }
  setApproveJoins(groupId: string, on: boolean, idempotencyKey = newIdempotencyKey()) {
    return this.request<Group>('PUT', `/groups/${groupId}`, { approveJoins: on }, idempotencyKey);
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
    return this.request<WalletConnection>('PUT', '/me/wallet', { nwcUri }, undefined, {}, WALLET_TIMEOUT_MS);
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
  reportUpiPayment(input: ReportUpiPaymentInput, idempotencyKey = newIdempotencyKey()) {
    const { groupId, ...body } = input;
    return this.request<Settlement>('POST', `/groups/${groupId}/upi-payments`, body, idempotencyKey);
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

  linkNostr(event: unknown) {
    return this.request<User>('POST', NOSTR_AUTH_PATHS.link, { event });
  }
  unlinkNostr() {
    return this.request<User>('DELETE', NOSTR_AUTH_PATHS.link);
  }

  async replaceSignInKey(idempotencyKey = newIdempotencyKey()) {
    return (await this.request<{ token: string }>('POST', '/me/token', undefined, idempotencyKey)).token;
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
