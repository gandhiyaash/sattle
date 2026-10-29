/**
 * The API, spoken to directly: for making accounts and seeding a group
 * faster than clicking would, for reading what the server holds after the
 * browser has acted, and for the tests that abuse the routes themselves.
 */

import { request, type APIRequestContext } from '@playwright/test';
import type {
  Debt,
  Expense,
  ExpenseInput,
  Group,
  GroupLink,
  GuestView,
  GroupGuestView,
  HistoryEntry,
  JoinView,
  JoinRequest,
  Member,
  PayLink,
  PendingJoin,
  Settlement,
  UpiClaim,
  UpiProfile,
  User,
} from '@sattle/core';

import { API_URL } from './env';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS';

export interface RawAnswer<T = unknown> {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** The JSON body, or null when there was none. */
  body: T;
}

/** What the server answered when it refused: the status, and the code and message the app would show. */
export class ApiRefusal extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiRefusal';
  }
}

export interface Account {
  user: User;
  token: string;
}

export class Api {
  constructor(
    private readonly ctx: APIRequestContext,
    /** Sent as the bearer token. Null speaks as nobody. */
    readonly token: string | null = null
  ) {}

  static async create(baseURL = API_URL) {
    return new Api(await request.newContext({ baseURL }));
  }

  /** The same connection, speaking as the holder of `token`. */
  as(token: string | null) {
    return new Api(this.ctx, token);
  }

  dispose() {
    return this.ctx.dispose();
  }

  /** The answer as it came, refusal or not. */
  async raw<T = unknown>(
    method: Method,
    path: string,
    body?: unknown,
    opts: { key?: string; token?: string | null; headers?: Record<string, string> } = {}
  ): Promise<RawAnswer<T>> {
    const token = opts.token === undefined ? this.token : opts.token;
    const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
    if (token) headers.authorization = `Bearer ${token}`;
    if (opts.key) headers['idempotency-key'] = opts.key;
    const res = await this.ctx.fetch(path, {
      method,
      headers,
      data: body === undefined ? undefined : body,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status(), ok: res.ok(), headers: res.headers(), body: parsed as T };
  }

  /** The body, or an ApiRefusal with the server's code and message. */
  async call<T>(method: Method, path: string, body?: unknown, opts?: { key?: string; token?: string | null }): Promise<T> {
    const r = await this.raw<T & { code?: string; message?: string }>(method, path, body, opts);
    if (!r.ok) {
      const err = (r.body ?? {}) as { code?: string; message?: string };
      throw new ApiRefusal(r.status, err.code ?? 'unknown', err.message ?? `Request failed (${r.status}).`);
    }
    return r.body as T;
  }

  get<T>(path: string) {
    return this.call<T>('GET', path);
  }
  post<T>(path: string, body?: unknown, key?: string) {
    return this.call<T>('POST', path, body, { key });
  }
  put<T>(path: string, body?: unknown, key?: string) {
    return this.call<T>('PUT', path, body, { key });
  }
  del<T>(path: string, key?: string) {
    return this.call<T>('DELETE', path, undefined, { key });
  }

  // -- accounts -------------------------------------------------------------

  /** A device account, as the welcome screen makes one. Public. */
  account(displayName: string) {
    return this.call<Account>('POST', '/accounts', { displayName }, { token: null });
  }
  me() {
    return this.get<User>('/me');
  }

  // -- groups -----------------------------------------------------------------

  groups() {
    return this.get<Group[]>('/groups');
  }
  group(groupId: string) {
    return this.get<Group>(`/groups/${groupId}`);
  }
  createGroup(input: { name: string; currency?: string; memberNames: string[]; simplifyDebts?: boolean }) {
    return this.post<Group>('/groups', input);
  }
  members(groupId: string) {
    return this.get<Member[]>(`/groups/${groupId}/members`);
  }
  addMember(groupId: string, displayName: string) {
    return this.post<Member>(`/groups/${groupId}/members`, { displayName });
  }
  expenses(groupId: string) {
    return this.get<Expense[]>(`/groups/${groupId}/expenses`);
  }
  addExpense(input: ExpenseInput) {
    return this.post<Expense>(`/groups/${input.groupId}/expenses`, input);
  }
  debts(groupId: string) {
    return this.get<Debt[]>(`/groups/${groupId}/debts`);
  }
  settlements(groupId: string) {
    return this.get<Settlement[]>(`/groups/${groupId}/settlements`);
  }
  history(groupId: string) {
    return this.get<HistoryEntry[]>(`/groups/${groupId}/history`);
  }
  markSettled(input: { groupId: string; fromMemberId: string; toMemberId: string; amount: number; note?: string }) {
    const { groupId, ...body } = input;
    return this.post<Settlement>(`/groups/${groupId}/settlements/manual`, body);
  }
  setApproveJoins(groupId: string, on: boolean) {
    return this.put<Group>(`/groups/${groupId}`, { approveJoins: on });
  }
  setSimplifyDebts(groupId: string, on: boolean) {
    return this.put<Group>(`/groups/${groupId}`, { simplifyDebts: on });
  }

  // -- links --------------------------------------------------------------------

  groupLink(groupId: string) {
    return this.get<GroupLink | null>(`/groups/${groupId}/link`);
  }
  createGroupLink(groupId: string) {
    return this.post<GroupLink>(`/groups/${groupId}/link`);
  }
  createPayLink(input: { groupId: string; fromMemberId: string; toMemberId: string; amount: number }) {
    const { groupId, ...body } = input;
    return this.post<PayLink>(`/groups/${groupId}/pay-links`, body);
  }
  guestView(token: string) {
    return this.call<GuestView>('GET', `/s/${encodeURIComponent(token)}`, undefined, { token: null });
  }
  groupGuestView(token: string) {
    return this.call<GroupGuestView>('GET', `/g/${encodeURIComponent(token)}`, undefined, { token: null });
  }
  joinView(token: string) {
    return this.call<JoinView>('GET', `/join/${encodeURIComponent(token)}`, undefined, { token: null });
  }
  join(token: string, as: { ref: string } | { displayName: string }) {
    return this.post<Member>('/join', { token, ...as });
  }
  askToJoin(token: string, as: { ref: string } | { displayName: string }) {
    return this.post<JoinRequest>('/join-requests', { token, ...as });
  }
  myJoinRequests() {
    return this.get<JoinRequest[]>('/me/join-requests');
  }
  pendingJoins(groupId: string) {
    return this.get<PendingJoin[]>(`/groups/${groupId}/join-requests`);
  }
  approveJoin(requestId: string) {
    return this.post<Member>(`/join-requests/${requestId}/approve`);
  }

  // -- ways to be paid ---------------------------------------------------------

  setUpiId(upiId: string) {
    return this.put<UpiProfile>('/me/upi', { upiId });
  }
  setUpiOnGroupLinks(on: boolean) {
    return this.put<UpiProfile>('/me/upi/group-links', { on });
  }
  setReceiveAddress(address: string) {
    return this.put<{ address: string | null }>('/me/receive-address', { address });
  }
  upiClaims(groupId: string) {
    return this.get<UpiClaim[]>(`/groups/${groupId}/upi-claims`);
  }

  // -- shortcuts ------------------------------------------------------------------

  /** The member row this account holds in a group. */
  async myMember(groupId: string) {
    const [me, members] = await Promise.all([this.me(), this.members(groupId)]);
    const mine = members.find((m) => m.claimedByUserId === me.id);
    if (!mine) throw new Error(`${me.displayName} isn't in group ${groupId}`);
    return mine;
  }

  /** The member row with this name in a group. */
  async memberNamed(groupId: string, name: string) {
    const member = (await this.members(groupId)).find((m) => m.displayName === name);
    if (!member) throw new Error(`no member named ${name} in group ${groupId}`);
    return member;
  }

  /**
   * A group with these people as ghosts and, optionally, some spends already
   * in it: each is paid by `paidBy` and split equally between everyone unless
   * `between` says otherwise. Amounts are in minor units (paise or sats).
   */
  async seedGroup(input: {
    name: string;
    people: string[];
    currency?: string;
    simplifyDebts?: boolean;
    spends?: Array<{ description: string; amount: number; paidBy: string; between?: string[] }>;
  }) {
    const group = await this.createGroup({
      name: input.name,
      currency: input.currency,
      memberNames: input.people,
      simplifyDebts: input.simplifyDebts,
    });
    const members = await this.members(group.id);
    const byName = new Map(members.map((m) => [m.displayName, m]));
    const idOf = (name: string) => {
      const m = byName.get(name);
      if (!m) throw new Error(`no member named ${name}`);
      return m.id;
    };
    const expenses: Expense[] = [];
    for (const spend of input.spends ?? []) {
      expenses.push(
        await this.addExpense({
          groupId: group.id,
          description: spend.description,
          amount: spend.amount,
          paidByMemberId: idOf(spend.paidBy),
          splitMode: 'equal',
          parts: (spend.between ?? members.map((m) => m.displayName)).map((name) => ({ memberId: idOf(name) })),
        })
      );
    }
    return { group, members, expenses, idOf };
  }
}
