/**
 * In-memory client with latency and failure injection.
 *
 * It enforces the same rules the server will: ghosts can't receive, and a
 * settlement walks created → awaiting_payment → in_flight → confirmed
 * asynchronously, so no screen can be built on the assumption that paying
 * is instant.
 */

import {
  LEDGER_STATUSES,
  NWC_REQUIRED_METHODS,
  SattleError,
  TERMINAL_STATUSES,
  buildQuote,
  canChangeExpense,
  canReceive,
  computeBalances,
  isInProgress,
  fixtures,
  parseLightningAddress,
  parseUpiId,
  resolveParts,
  simplifyDebts,
  toGuestSettlement,
  type CreateGroupInput,
  type CreatePayLinkInput,
  type CreateSettlementInput,
  type CreateUpiClaimInput,
  type Expense,
  type ExpenseInput,
  type Group,
  type GroupGuestView,
  type GroupLink,
  type GuestView,
  type Invite,
  type InviteView,
  type JoinAs,
  type LedgerBackup,
  type Member,
  type PayLink,
  type ReceiveAddress,
  type Settlement,
  type UpiClaim,
  type UpiPayee,
  type UpiProfile,
  type WalletConnection,
} from '@sattle/core';
import type { SattleClient } from './SattleClient';

export interface MockClientOptions {
  /** Delay applied to every call. Default 400ms. */
  latencyMs?: number;
  /**
   * 0..1 chance that any call throws a network error. Half of those happen
   * after a write was carried out, as if the response was lost, so retrying
   * with a new key does it twice.
   */
  failureRate?: number;
  /** Every settlement ends in `failed`. */
  alwaysFailSettlement?: boolean;
  /** How long a payment spends in flight. Default 2500ms. */
  settleDelayMs?: number;
  /** INR per BTC used for quotes. */
  rateFiatPerBtc?: number;
}

export class MockClient implements SattleClient {
  private groups: Group[];
  private members: Member[];
  private expenses: Expense[];
  private settlements: Settlement[];
  private payLinks: PayLink[];
  /** token → the settlement that link last opened */
  private payLinkSettlements: Record<string, string>;
  private invites: Array<Invite & { invitedBy: string }> = [];
  private groupLinks: GroupLink[];
  private wallet: WalletConnection = { connected: false, methods: [], excessMethods: [] };
  private receiveAddress: string | null = null;
  /** user id → their UPI ID. Om has one, so the demo has someone to pay by UPI. */
  private upiIds: Record<string, string> = { 'u-om': 'om@okhdfcbank' };
  private upiClaims: UpiClaim[] = [];
  private listeners = new Map<string, Set<(s: Settlement) => void>>();
  /** idempotency key → the first reply, like the server's table. */
  private replies = new Map<string, unknown>();
  private seq = 0;
  private readonly opts: Required<MockClientOptions>;

  constructor(options: MockClientOptions = {}) {
    this.opts = {
      latencyMs: 400,
      failureRate: 0,
      alwaysFailSettlement: false,
      settleDelayMs: 2500,
      rateFiatPerBtc: 9_000_000,
      ...options,
    };
    // Deep copies so two clients never share state.
    this.groups = structuredClone(fixtures.groups);
    this.members = structuredClone(fixtures.members);
    this.expenses = structuredClone(fixtures.expenses);
    this.settlements = structuredClone(fixtures.settlements);
    this.payLinks = structuredClone(fixtures.payLinks);
    this.payLinkSettlements = { ...fixtures.payLinkSettlements };
    this.groupLinks = structuredClone(fixtures.groupLinks);
  }

  // -- plumbing -------------------------------------------------------------

  /** With a key, a repeat returns the first reply instead of running `fn` again. */
  private async call<T>(fn: () => T, idempotencyKey?: string): Promise<T> {
    if (this.opts.latencyMs > 0) await sleep(this.opts.latencyMs * (0.6 + Math.random() * 0.8));
    const lost = Math.random() < this.opts.failureRate;
    if (lost && Math.random() < 0.5) throw networkError();

    let reply: T;
    if (idempotencyKey && this.replies.has(idempotencyKey)) {
      reply = this.replies.get(idempotencyKey) as T;
    } else {
      reply = structuredClone(fn());
      if (idempotencyKey) this.replies.set(idempotencyKey, reply);
    }

    // The write happened; only the response goes missing.
    if (lost) throw networkError();
    return structuredClone(reply);
  }

  private id(prefix: string) {
    return `${prefix}-${Date.now().toString(36)}-${++this.seq}`;
  }

  private now() {
    return new Date().toISOString();
  }

  private findGroup(groupId: string) {
    const g = this.groups.find((x) => x.id === groupId);
    if (!g) throw new SattleError('not_found', 'That group doesn’t exist.');
    return g;
  }

  /** Same rules as the server's checkPayer and checkManualRecorder. */
  private checkCaller(input: { fromMemberId: string; toMemberId: string }, as: 'payer' | 'manual') {
    const me = fixtures.currentUser.id;
    const payer = this.members.find((m) => m.id === input.fromMemberId);
    const payee = this.members.find((m) => m.id === input.toMemberId);
    if (!payer || !payee) throw new SattleError('not_found', 'That member isn’t in this group.');
    if (as === 'payer' && payer.claimedByUserId !== me) {
      throw new SattleError('invalid_input', `Only ${payer.displayName} can pay this.`);
    }
    if (as === 'manual' && payee.claimedByUserId !== me && (payee.claimedByUserId || payer.claimedByUserId !== me)) {
      const who = payee.claimedByUserId ? payee : payer;
      throw new SattleError('invalid_input', `Only ${who.displayName} can mark this as settled.`);
    }
  }

  private myMember(groupId: string) {
    return this.members.find((m) => m.groupId === groupId && m.claimedByUserId === fixtures.currentUser.id);
  }

  private findSettlement(id: string) {
    const s = this.settlements.find((x) => x.id === id);
    if (!s) throw new SattleError('not_found', 'That payment doesn’t exist.');
    return s;
  }

  /**
   * The mock has no real invoices to hash, so any well-formed proof matches,
   * except 64 zeros, which stands in for a proof of some other payment so
   * that error can be seen.
   */
  private prove(s: Settlement, raw: string) {
    const preimage = raw.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(preimage)) {
      throw new SattleError('invalid_input', 'That isn’t a payment proof. It’s 64 characters of 0–9 and a–f, from your wallet’s payment details.');
    }
    if (!s.destination) throw new SattleError('invalid_input', 'This payment never had an invoice, so there’s nothing to prove.');
    if (/^0{64}$/.test(preimage)) throw new SattleError('invalid_input', 'That proof is for a different payment.');
    if (s.status !== 'confirmed' && s.status !== 'manually_confirmed') {
      this.update(s.id, { status: 'confirmed', preimage, failureReason: undefined });
    }
    return structuredClone(s);
  }

  private update(id: string, patch: Partial<Settlement>) {
    const s = this.findSettlement(id);
    Object.assign(s, patch, { updatedAt: this.now() });
    this.listeners.get(id)?.forEach((cb) => cb(structuredClone(s)));
  }

  // -- reads ----------------------------------------------------------------

  async getPaymentMode() {
    return 'simulated' as const;
  }

  getCurrentUser() {
    return this.call(() => fixtures.currentUser);
  }

  /** Only the groups the user is in, like the server: leaving one takes it off the list. */
  getGroups() {
    return this.call(() => this.groups.filter((g) => this.myMember(g.id)));
  }

  getGroup(groupId: string) {
    return this.call(() => this.findGroup(groupId));
  }

  createGroup(input: CreateGroupInput, idempotencyKey?: string) {
    return this.call(() => {
      const name = input.name.trim();
      if (!name) throw new SattleError('invalid_input', 'Give the group a name.');
      const currency = input.currency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new SattleError('invalid_input', 'currency: expected a three-letter currency code like INR');
      }
      const group: Group = { id: this.id('g'), name, currency, memberIds: [], createdAt: this.now() };
      const me = fixtures.currentUser;
      const add = (m: Omit<Member, 'id' | 'groupId'>) => {
        const member: Member = { id: this.id('m'), groupId: group.id, ...m };
        this.members.push(member);
        group.memberIds.push(member.id);
      };
      add({ displayName: me.displayName, status: 'joined', claimedByUserId: me.id });
      for (const n of input.memberNames) add({ displayName: n.trim(), status: 'ghost' });
      this.groups.unshift(group);
      return group;
    }, idempotencyKey);
  }

  addMember(groupId: string, displayName: string, idempotencyKey?: string) {
    return this.call(() => {
      const g = this.findGroup(groupId);
      const name = displayName.trim();
      if (!name) throw new SattleError('invalid_input', 'Give them a name.');
      const member: Member = { id: this.id('m'), groupId, displayName: name, status: 'ghost' };
      this.members.push(member);
      g.memberIds.push(member.id);
      return member;
    }, idempotencyKey);
  }

  getMembers(groupId: string) {
    return this.call(() => {
      const g = this.findGroup(groupId);
      return g.memberIds
        .map((id) => this.members.find((m) => m.id === id)!)
        .map((m): Member => (this.takesUpi(m) ? { ...m, upi: true } : m));
    });
  }

  getExpenses(groupId: string) {
    return this.call(() => this.expenses.filter((e) => e.groupId === groupId));
  }

  getSettlements(groupId: string) {
    return this.call(() => this.settlements.filter((s) => s.groupId === groupId));
  }

  getSettlement(settlementId: string) {
    return this.call(() => this.findSettlement(settlementId));
  }

  /** Looks like the server's, but nothing is signed or published. */
  getLedgerBackup(groupId: string) {
    return this.call((): LedgerBackup => {
      this.findGroup(groupId);
      const entries =
        this.expenses.filter((e) => e.groupId === groupId).length +
        this.settlements.filter((s) => s.groupId === groupId && LEDGER_STATUSES.includes(s.status)).length;
      const relays = ['wss://relay.damus.io', 'wss://nos.lol'];
      return {
        uri: `sattle-ledger://${'d'.repeat(64)}?key=${'e'.repeat(64)}&${relays.map((r) => `relay=${encodeURIComponent(r)}`).join('&')}`,
        npub: 'npub1demo0000000000000000000000000000000000000000000000000000',
        relays,
        entries,
        published: entries,
      };
    });
  }

  getDebts(groupId: string) {
    return this.call(() => {
      const g = this.findGroup(groupId);
      const balances = computeBalances(
        g.memberIds,
        this.expenses.filter((e) => e.groupId === groupId),
        this.settlements.filter((s) => s.groupId === groupId)
      );
      return simplifyDebts(groupId, balances);
    });
  }

  // -- writes ---------------------------------------------------------------

  addExpense(input: ExpenseInput, idempotencyKey?: string) {
    return this.call(() => {
      const g = this.findGroup(input.groupId);
      const bad = [input.paidByMemberId, ...input.parts.map((p) => p.memberId)].find(
        (id) => !g.memberIds.includes(id)
      );
      if (bad) throw new SattleError('invalid_expense', 'Someone in that split isn’t in this group.');

      const expense: Expense = {
        id: this.id('e'),
        ...input,
        parts: resolveParts(input),
        createdAt: this.now(),
      };
      this.expenses.push(expense);
      return expense;
    }, idempotencyKey);
  }

  setMemberPayoutAddress(memberId: string, address: string) {
    return this.call(() => {
      const parsed = parseLightningAddress(address);
      if (!parsed.ok) throw new SattleError('invalid_address', parsed.reason);
      const m = this.members.find((x) => x.id === memberId);
      if (!m) throw new SattleError('not_found', 'That member doesn’t exist.');
      if (m.claimedByUserId && m.claimedByUserId !== fixtures.currentUser.id) {
        throw new SattleError('invalid_input', `Only ${m.displayName} can change where they get paid.`);
      }
      m.lightningAddress = parsed.address; // status stays as-is: payable, not joined
      return m;
    });
  }

  markSettledManually(input: Omit<CreateSettlementInput, 'rail'> & { note?: string }, idempotencyKey?: string) {
    return this.call(() => {
      const g = this.findGroup(input.groupId);
      this.checkCaller(input, 'manual');
      const s: Settlement = {
        id: this.id('s'),
        groupId: input.groupId,
        fromMemberId: input.fromMemberId,
        toMemberId: input.toMemberId,
        amount: input.amount,
        currency: g.currency,
        rail: 'manual',
        status: 'manually_confirmed',
        note: input.note,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.settlements.push(s);
      return s;
    }, idempotencyKey);
  }

  createSettlement(input: CreateSettlementInput, idempotencyKey?: string) {
    return this.call(() => {
      if (input.rail === 'manual') {
        throw new SattleError('invalid_expense', 'Use markSettledManually for manual settlements.');
      }
      if (input.rail === 'upi') {
        throw new SattleError('invalid_input', 'Use createUpiClaim for a UPI payment.');
      }
      const g = this.findGroup(input.groupId);
      this.checkCaller(input, 'payer');
      const to = this.members.find((m) => m.id === input.toMemberId);
      if (!to) throw new SattleError('not_found', 'That member doesn’t exist.');
      if (!canReceive(to)) {
        throw new SattleError('member_cannot_receive', `${to.displayName} has nowhere to receive this yet.`);
      }
      const s: Settlement = {
        id: this.id('s'),
        groupId: input.groupId,
        fromMemberId: input.fromMemberId,
        toMemberId: input.toMemberId,
        amount: input.amount,
        currency: g.currency,
        rail: input.rail,
        status: 'created',
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.settlements.push(s);
      // Started here, not after the reply, so it runs even if the reply is lost.
      void this.runLifecycle(s.id);
      return s;
    }, idempotencyKey);
  }

  /** Drives a settlement to a terminal state in the background. */
  private async runLifecycle(id: string) {
    const step = Math.max(300, this.opts.latencyMs);
    await sleep(step);
    const s = this.findSettlement(id);
    const to = this.members.find((m) => m.id === s.toMemberId)!;

    this.update(id, {
      status: 'awaiting_payment',
      quote: buildQuote(s.amount, s.currency, this.opts.rateFiatPerBtc, { kind: 'demo' }),
      destination:
        s.rail === 'lightning_address' && to.lightningAddress
          ? to.lightningAddress
          : `lnbc${Math.round(s.amount / 9)}n1mock${id.replace(/[^a-z0-9]/g, '')}`,
    });

    await sleep(step);
    this.update(id, { status: 'in_flight' });

    await sleep(this.opts.settleDelayMs);
    if (this.opts.alwaysFailSettlement) {
      this.update(id, { status: 'failed', failureReason: 'No route found to the recipient.' });
    } else {
      this.update(id, { status: 'confirmed', preimage: randomHex(64) });
    }
  }

  onSettlementUpdate(settlementId: string, cb: (s: Settlement) => void) {
    let set = this.listeners.get(settlementId);
    if (!set) this.listeners.set(settlementId, (set = new Set()));
    set.add(cb);
    return () => {
      set!.delete(cb);
    };
  }

  // -- pay links ------------------------------------------------------------

  submitProof(settlementId: string, preimage: string, idempotencyKey?: string) {
    return this.call(() => this.prove(this.findSettlement(settlementId), preimage), idempotencyKey);
  }

  submitGuestProof(token: string, preimage: string, idempotencyKey?: string) {
    return this.call(() => {
      const link = this.findLink(token);
      const sid = this.payLinkSettlements[token];
      if (!sid) throw new SattleError('invalid_input', 'That proof is for a different payment.');
      this.prove(this.findSettlement(sid), preimage);
      return this.guestView(link);
    }, idempotencyKey);
  }

  private findLink(token: string) {
    const link = this.payLinks.find((l) => l.token === token);
    if (!link) throw new SattleError('not_found', 'This link is no longer valid.');
    return link;
  }

  private guestView(link: PayLink): GuestView {
    const name = (id: string) => this.members.find((m) => m.id === id)!.displayName;
    const sid = this.payLinkSettlements[link.token];
    return {
      payerName: name(link.fromMemberId),
      payeeName: name(link.toMemberId),
      reason: this.findGroup(link.groupId).name,
      settlement: sid ? toGuestSettlement(this.findSettlement(sid)) : undefined,
    };
  }

  createPayLink(input: CreatePayLinkInput, idempotencyKey?: string) {
    return this.call(() => {
      const g = this.findGroup(input.groupId);
      const payee = this.members.find((m) => m.id === input.toMemberId);
      if (!payee || !g.memberIds.includes(payee.id)) throw new SattleError('not_found', 'That member isn’t in this group.');
      if (payee.claimedByUserId !== fixtures.currentUser.id) {
        throw new SattleError('invalid_input', `Only ${payee.displayName} can send a link for this.`);
      }
      const link: PayLink = {
        token: Math.random().toString(36).slice(2, 12),
        ...input,
        createdAt: this.now(),
      };
      this.payLinks.push(link);
      return link;
    }, idempotencyKey);
  }

  openPayLink(token: string) {
    return this.call(() => {
      const link = this.findLink(token);
      const sid = this.payLinkSettlements[token];
      const current = sid ? this.findSettlement(sid) : undefined;
      if (current && (isInProgress(current) || current.status === 'confirmed')) return this.guestView(link);

      const g = this.findGroup(link.groupId);
      const balances = computeBalances(
        g.memberIds,
        this.expenses.filter((e) => e.groupId === g.id),
        this.settlements.filter((s) => s.groupId === g.id)
      );
      const debt = simplifyDebts(g.id, balances).find(
        (d) => d.fromMemberId === link.fromMemberId && d.toMemberId === link.toMemberId
      );
      if (!debt || debt.amount < link.amount) {
        throw new SattleError('link_expired', 'This has already been settled.');
      }
      const payee = this.members.find((m) => m.id === link.toMemberId)!;
      if (!canReceive(payee)) {
        throw new SattleError('member_cannot_receive', `${payee.displayName} has nowhere to receive this yet.`);
      }

      const s: Settlement = {
        id: this.id('s'),
        groupId: g.id,
        fromMemberId: link.fromMemberId,
        toMemberId: link.toMemberId,
        amount: link.amount,
        currency: g.currency,
        rail: 'invoice',
        status: 'created',
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.settlements.push(s);
      this.payLinkSettlements[token] = s.id;
      void this.runLifecycle(s.id);
      return this.guestView(link);
    });
  }

  getGuestView(token: string) {
    return this.call(() => this.guestView(this.findLink(token)));
  }

  onGuestViewUpdate(token: string, cb: (v: GuestView) => void) {
    const sid = this.payLinkSettlements[token];
    if (!sid) return () => {};
    return this.onSettlementUpdate(sid, () => cb(structuredClone(this.guestView(this.findLink(token)))));
  }

  // -- invites --------------------------------------------------------------

  private isLive = (invite: Invite) => Date.parse(invite.expiresAt) > Date.now();

  /** Same rules as the server: a dead link is not_found, an old one link_expired. */
  private liveInvite(token: string) {
    const invite = this.invites.find((i) => i.token === token);
    if (!invite) throw new SattleError('not_found', 'This invite is no longer valid.');
    if (!this.isLive(invite)) throw new SattleError('link_expired', 'This invite has expired. Ask for a new one.');
    return invite;
  }

  /** Stands in for the server's hash: opaque to the page, and tied to this invite and this member. */
  private memberRef(token: string, memberId: string) {
    let h = 0;
    for (const ch of `${token}:${memberId}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `m${h.toString(36)}`;
  }

  getGroupInvite(groupId: string) {
    return this.call((): Invite | null => {
      this.findGroup(groupId);
      const found = this.invites.find((i) => i.groupId === groupId);
      if (!found || !this.isLive(found)) return null;
      const { invitedBy: _, ...invite } = found;
      return invite;
    });
  }

  createInvite(groupId: string, idempotencyKey?: string) {
    return this.call(() => {
      const g = this.findGroup(groupId);
      const me = this.members.find((m) => m.groupId === g.id && m.claimedByUserId === fixtures.currentUser.id);
      const invite: Invite = {
        token: Math.random().toString(36).slice(2, 12),
        groupId,
        createdAt: this.now(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      };
      // One at a time: the new one takes the old one's place.
      this.invites = [...this.invites.filter((i) => i.groupId !== groupId), { ...invite, invitedBy: me?.displayName ?? 'Someone' }];
      return invite;
    }, idempotencyKey);
  }

  removeInvite(groupId: string, idempotencyKey?: string) {
    return this.call(() => {
      this.findGroup(groupId);
      this.invites = this.invites.filter((i) => i.groupId !== groupId);
    }, idempotencyKey);
  }

  getInvite(token: string) {
    return this.call((): InviteView => {
      const invite = this.liveInvite(token);
      return {
        groupName: this.findGroup(invite.groupId).name,
        invitedBy: invite.invitedBy,
        members: this.members
          .filter((m) => m.groupId === invite.groupId && !m.claimedByUserId)
          .map((m) => ({ ref: this.memberRef(token, m.id), name: m.displayName })),
      };
    });
  }

  /**
   * The mock has one user, who is already in every group, so this always
   * ends in "already in this group". The join itself needs the real API.
   */
  acceptInvite(token: string, as: JoinAs, idempotencyKey?: string) {
    return this.call(() => {
      // The server checks the body before it looks at the invite: a name is 1 to 40 characters.
      if ('displayName' in as && (!as.displayName.trim() || as.displayName.trim().length > 40)) {
        throw new SattleError('invalid_input', 'Give a name of up to 40 characters.');
      }
      const invite = this.liveInvite(token);
      const me = fixtures.currentUser;
      const g = this.findGroup(invite.groupId);
      const members = this.members.filter((m) => m.groupId === g.id);
      if (members.some((m) => m.claimedByUserId === me.id)) {
        throw new SattleError('conflict', 'You’re already in this group.');
      }
      const status = this.wallet.connected ? 'nwc_linked' : 'joined';

      if ('displayName' in as) {
        const name = as.displayName.trim();
        const waiting = members.find((m) => !m.claimedByUserId && m.displayName.trim().toLowerCase() === name.toLowerCase());
        if (waiting) {
          throw new SattleError('conflict', `${waiting.displayName} is already in this group. Pick that name to join as them.`);
        }
        const added: Member = { id: this.id('m'), groupId: g.id, displayName: name, status, claimedByUserId: me.id };
        this.members.push(added);
        g.memberIds.push(added.id);
        return g;
      }

      const member = members.find((m) => this.memberRef(token, m.id) === as.ref);
      if (!member) throw new SattleError('not_found', 'That person is no longer in this group.');
      if (member.claimedByUserId) throw new SattleError('conflict', `Someone has already joined as ${member.displayName}.`);
      member.claimedByUserId = me.id;
      member.status = status;
      delete member.lightningAddress; // as the API: a groupmate typed it, not them
      return g;
    }, idempotencyKey);
  }

  // -- group links ----------------------------------------------------------

  private findGroupLink(token: string) {
    const link = this.groupLinks.find((l) => l.token === token);
    if (!link) throw new SattleError('not_found', 'This link is no longer valid.');
    return link;
  }

  private debtsOf(groupId: string) {
    const g = this.findGroup(groupId);
    const mine = (x: { groupId: string }) => x.groupId === groupId;
    return simplifyDebts(groupId, computeBalances(g.memberIds, this.expenses.filter(mine), this.settlements.filter(mine)));
  }

  /** Stands in for the server's hash: opaque to the page, and tied to this link and this pair. */
  private debtRef(token: string, d: { fromMemberId: string; toMemberId: string }) {
    let h = 0;
    for (const ch of `${token}:${d.fromMemberId}:${d.toMemberId}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `d${h.toString(36)}`;
  }

  getGroupLink(groupId: string) {
    return this.call(() => {
      this.findGroup(groupId);
      return this.groupLinks.find((l) => l.groupId === groupId) ?? null;
    });
  }

  createGroupLink(groupId: string, idempotencyKey?: string) {
    return this.call(() => {
      this.findGroup(groupId);
      const link: GroupLink = { token: Math.random().toString(36).slice(2, 12), groupId, createdAt: this.now() };
      // One at a time: the new one takes the old one's place.
      this.groupLinks = [...this.groupLinks.filter((l) => l.groupId !== groupId), link];
      return link;
    }, idempotencyKey);
  }

  removeGroupLink(groupId: string, idempotencyKey?: string) {
    return this.call(() => {
      this.findGroup(groupId);
      this.groupLinks = this.groupLinks.filter((l) => l.groupId !== groupId);
    }, idempotencyKey);
  }

  getGroupGuestView(token: string) {
    return this.call((): GroupGuestView => {
      const link = this.findGroupLink(token);
      const g = this.findGroup(link.groupId);
      const member = (id: string) => this.members.find((m) => m.id === id)!;
      return {
        groupName: g.name,
        currency: g.currency,
        expenses: this.expenses
          .filter((e) => e.groupId === g.id)
          .map((e) => ({
            description: e.description,
            amount: e.amount,
            paidBy: member(e.paidByMemberId).displayName,
            shares: e.parts.map((p) => ({ name: member(p.memberId).displayName, amount: p.amount })),
            createdAt: e.createdAt,
          })),
        debts: this.debtsOf(g.id).map((d) => ({
          ref: this.debtRef(token, d),
          from: member(d.fromMemberId).displayName,
          to: member(d.toMemberId).displayName,
          amount: d.amount,
          payable: canReceive(member(d.toMemberId)),
        })),
      };
    });
  }

  payFromGroupLink(token: string, ref: string, idempotencyKey?: string) {
    return this.call(() => {
      const link = this.findGroupLink(token);
      const debt = this.debtsOf(link.groupId).find((d) => this.debtRef(token, d) === ref);
      if (!debt) throw new SattleError('link_expired', 'This has already been settled.');
      const payee = this.members.find((m) => m.id === debt.toMemberId)!;
      if (!canReceive(payee)) {
        throw new SattleError('member_cannot_receive', `${payee.displayName} has nowhere to receive this yet.`);
      }
      // A link that has been paid is spent: the same two people can owe the same amount again.
      const spent = (l: PayLink) => {
        const sid = this.payLinkSettlements[l.token];
        return Boolean(sid) && LEDGER_STATUSES.includes(this.findSettlement(sid).status);
      };
      const same = (l: PayLink) =>
        l.groupId === debt.groupId && l.fromMemberId === debt.fromMemberId && l.toMemberId === debt.toMemberId && l.amount === debt.amount;
      let payLink = this.payLinks.find((l) => same(l) && !spent(l));
      if (!payLink) {
        payLink = {
          token: Math.random().toString(36).slice(2, 12),
          groupId: debt.groupId,
          fromMemberId: debt.fromMemberId,
          toMemberId: debt.toMemberId,
          amount: debt.amount,
          createdAt: this.now(),
        };
        this.payLinks.push(payLink);
      }
      return { token: payLink.token };
    }, idempotencyKey);
  }

  // -- changing and removing ------------------------------------------------
  // The same rules as the server's groupRules.ts.

  private findExpense(groupId: string, expenseId: string) {
    const e = this.expenses.find((x) => x.id === expenseId && x.groupId === groupId);
    if (!e) throw new SattleError('not_found', 'That expense doesn’t exist.');
    return e;
  }

  private checkExpenseOwner(expense: Expense) {
    const payer = this.members.find((m) => m.id === expense.paidByMemberId);
    if (!canChangeExpense(payer, fixtures.currentUser.id)) {
      throw new SattleError('invalid_input', `Only ${payer!.displayName} can change this, because they paid it.`);
    }
  }

  /** A payment on its way to the user: they can't leave, disconnect or go until it lands. */
  private checkNothingIncoming(groupId?: string) {
    const mine = new Set(this.members.filter((m) => m.claimedByUserId === fixtures.currentUser.id).map((m) => m.id));
    const open = this.settlements.some(
      (s) => isInProgress(s) && mine.has(s.toMemberId) && (!groupId || s.groupId === groupId)
    );
    if (open) throw new SattleError('conflict', 'A payment to you is still in progress. Wait for it to finish.');
  }

  updateExpense(expenseId: string, input: ExpenseInput, idempotencyKey?: string) {
    return this.call(() => {
      const g = this.findGroup(input.groupId);
      const bad = [input.paidByMemberId, ...input.parts.map((p) => p.memberId)].find(
        (id) => !g.memberIds.includes(id)
      );
      if (bad) throw new SattleError('invalid_expense', 'Someone in that split isn’t in this group.');
      const current = this.findExpense(g.id, expenseId);
      this.checkExpenseOwner(current);
      return Object.assign(current, { ...input, parts: resolveParts(input) });
    }, idempotencyKey);
  }

  deleteExpense(groupId: string, expenseId: string, idempotencyKey?: string) {
    return this.call(() => {
      const current = this.findExpense(groupId, expenseId);
      this.checkExpenseOwner(current);
      this.expenses = this.expenses.filter((e) => e !== current);
    }, idempotencyKey);
  }

  renameGroup(groupId: string, name: string, idempotencyKey?: string) {
    return this.call(() => {
      const g = this.findGroup(groupId);
      const next = name.trim();
      if (!next) throw new SattleError('invalid_input', 'Give the group a name.');
      g.name = next;
      return g;
    }, idempotencyKey);
  }

  deleteGroup(groupId: string, idempotencyKey?: string) {
    return this.call(() => {
      const g = this.findGroup(groupId);
      const mine = (x: { groupId: string }) => x.groupId === groupId;
      if (this.settlements.some((s) => mine(s) && isInProgress(s))) {
        throw new SattleError('conflict', 'A payment in this group is still in progress. Wait for it to finish.');
      }
      const balances = computeBalances(g.memberIds, this.expenses.filter(mine), this.settlements.filter(mine));
      if (simplifyDebts(groupId, balances).length > 0) {
        throw new SattleError('conflict', 'There’s still money owed in this group. Settle up first.');
      }
      this.groups = this.groups.filter((x) => x !== g);
      this.members = this.members.filter((x) => !mine(x));
      this.expenses = this.expenses.filter((x) => !mine(x));
      this.settlements = this.settlements.filter((x) => !mine(x));
      this.payLinks = this.payLinks.filter((x) => !mine(x));
      this.invites = this.invites.filter((x) => !mine(x));
      this.groupLinks = this.groupLinks.filter((x) => !mine(x));
    }, idempotencyKey);
  }

  removeMember(groupId: string, memberId: string, idempotencyKey?: string) {
    return this.call(() => {
      const g = this.findGroup(groupId);
      const member = this.members.find((m) => m.id === memberId && m.groupId === groupId);
      if (!member) throw new SattleError('not_found', 'That member isn’t in this group.');
      if (member.claimedByUserId) {
        throw new SattleError('invalid_input', `${member.displayName} has joined. Only they can leave.`);
      }
      const named =
        this.expenses.some((e) => e.paidByMemberId === memberId || e.parts.some((p) => p.memberId === memberId)) ||
        [...this.settlements, ...this.payLinks].some((x) => x.fromMemberId === memberId || x.toMemberId === memberId);
      if (named) {
        throw new SattleError('conflict', `${member.displayName} is part of this group’s expenses or payments, so they can’t be removed.`);
      }
      this.members = this.members.filter((m) => m !== member);
      g.memberIds = g.memberIds.filter((id) => id !== memberId);
    }, idempotencyKey);
  }

  leaveGroup(groupId: string, idempotencyKey?: string) {
    return this.call(() => {
      const g = this.findGroup(groupId);
      const me = this.myMember(g.id);
      if (!me) throw new SattleError('not_found', 'That group doesn’t exist.');
      if (this.members.filter((m) => m.groupId === g.id && m.claimedByUserId).length === 1) {
        throw new SattleError('conflict', 'You’re the only one here with an account. Delete the group instead.');
      }
      this.checkNothingIncoming(g.id);
      delete me.claimedByUserId;
      me.status = 'ghost';
    }, idempotencyKey);
  }

  // -- wallet connection ----------------------------------------------------

  connectWallet(nwcUri: string) {
    return this.call(() => {
      if (!nwcUri.trim().startsWith('nostr+walletconnect://')) {
        throw new SattleError('invalid_wallet', 'That isn’t an NWC connection string. It starts with nostr+walletconnect://');
      }
      // Mock only: `mock_methods=a,b` in the string stands in for what the
      // wallet's get_info would grant, so the warnings can be seen.
      const listed = /[?&]mock_methods=([^&]*)/.exec(nwcUri)?.[1];
      const methods = listed
        ? decodeURIComponent(listed).split(',').filter(Boolean)
        : [...NWC_REQUIRED_METHODS, 'get_info'];
      const missing = NWC_REQUIRED_METHODS.filter((m) => !methods.includes(m));
      if (missing.length > 0) {
        throw new SattleError(
          'invalid_wallet',
          `This connection can’t ${missing.join(' or ').replaceAll('_', ' ')}. Make a new one that allows receiving.`
        );
      }
      const needed = new Set<string>([...NWC_REQUIRED_METHODS, 'get_info']);
      this.wallet = {
        connected: true,
        methods,
        excessMethods: methods.filter((m) => !needed.has(m)),
        alias: 'Mock wallet',
        connectedAt: this.now(),
      };
      for (const m of this.members) {
        if (m.claimedByUserId === fixtures.currentUser.id) m.status = 'nwc_linked';
      }
      return this.wallet;
    });
  }

  getWalletConnection() {
    return this.call(() => this.wallet);
  }

  getReceiveAddress() {
    return this.call((): ReceiveAddress => ({ address: this.receiveAddress }));
  }

  /** Mock only: an address at offline.example stands in for one that doesn't answer, so that error can be seen. */
  setReceiveAddress(address: string) {
    return this.call((): ReceiveAddress => {
      const parsed = parseLightningAddress(address);
      if (!parsed.ok) throw new SattleError('invalid_address', parsed.reason);
      if (parsed.address.endsWith('@offline.example')) {
        throw new SattleError('network', 'That address didn’t answer. Check it’s right, or try again in a minute.');
      }
      this.receiveAddress = parsed.address;
      return { address: this.receiveAddress };
    });
  }

  clearReceiveAddress() {
    return this.call((): ReceiveAddress => {
      this.receiveAddress = null;
      return { address: null };
    });
  }

  // -- UPI ------------------------------------------------------------------
  //
  // The same rules as the server's routes/upi.ts. The mock has one user, so a
  // claim they make waits forever: nobody else is here to confirm it.

  private takesUpi(member: Member) {
    return Boolean(member.claimedByUserId && this.upiIds[member.claimedByUserId]);
  }

  private findUpiClaim(id: string) {
    const claim = this.upiClaims.find((x) => x.id === id);
    if (!claim) throw new SattleError('not_found', 'That UPI payment isn’t waiting any more.');
    return claim;
  }

  private checkRupees(groupId: string) {
    if (this.findGroup(groupId).currency !== 'INR') {
      throw new SattleError('invalid_input', 'UPI only works for a group in rupees.');
    }
  }

  getUpiId() {
    return this.call((): UpiProfile => ({ upiId: this.upiIds[fixtures.currentUser.id] ?? null }));
  }

  setUpiId(upiId: string) {
    return this.call((): UpiProfile => {
      const parsed = parseUpiId(upiId);
      if (!parsed.ok) throw new SattleError('invalid_input', parsed.reason);
      this.upiIds[fixtures.currentUser.id] = parsed.upiId;
      return { upiId: parsed.upiId };
    });
  }

  clearUpiId() {
    return this.call((): UpiProfile => {
      delete this.upiIds[fixtures.currentUser.id];
      return { upiId: null };
    });
  }

  getUpiPayee(groupId: string, memberId: string) {
    return this.call((): UpiPayee => {
      const g = this.findGroup(groupId);
      const payee = this.members.find((m) => m.id === memberId && m.groupId === g.id);
      if (!payee) throw new SattleError('not_found', 'That member isn’t in this group.');
      this.checkRupees(groupId);
      const me = this.myMember(groupId);
      if (!this.debtsOf(groupId).some((d) => d.fromMemberId === me?.id && d.toMemberId === payee.id)) {
        throw new SattleError('conflict', `You don’t owe ${payee.displayName} anything right now.`);
      }
      if (!this.takesUpi(payee)) {
        throw new SattleError('member_cannot_receive', `${payee.displayName} hasn’t added a UPI ID.`);
      }
      return { upiId: this.upiIds[payee.claimedByUserId!], name: payee.displayName };
    });
  }

  getUpiClaims(groupId: string) {
    return this.call(() => {
      const me = this.myMember(groupId)?.id;
      return this.upiClaims.filter((x) => x.groupId === groupId && (x.fromMemberId === me || x.toMemberId === me));
    });
  }

  createUpiClaim(input: CreateUpiClaimInput, idempotencyKey?: string) {
    return this.call(() => {
      this.findGroup(input.groupId);
      this.checkCaller(input, 'payer');
      const debt = this.debtsOf(input.groupId).find(
        (d) => d.fromMemberId === input.fromMemberId && d.toMemberId === input.toMemberId
      );
      if (!debt) throw new SattleError('conflict', 'Nothing is owed here any more.');
      if (input.amount > debt.amount) throw new SattleError('conflict', 'That’s more than is owed. Refresh and try again.');
      this.checkRupees(input.groupId);
      const payee = this.members.find((m) => m.id === input.toMemberId)!;
      if (!this.takesUpi(payee)) {
        throw new SattleError('member_cannot_receive', `${payee.displayName} hasn’t added a UPI ID.`);
      }
      const claim: UpiClaim = {
        id: this.id('uc'),
        groupId: input.groupId,
        fromMemberId: input.fromMemberId,
        toMemberId: input.toMemberId,
        amount: input.amount,
        ...(input.reference?.trim() ? { reference: input.reference.trim() } : {}),
        status: 'pending',
        createdAt: this.now(),
      };
      // One per pair: the new claim takes the place of the last.
      this.upiClaims = [
        ...this.upiClaims.filter(
          (x) => !(x.groupId === claim.groupId && x.fromMemberId === claim.fromMemberId && x.toMemberId === claim.toMemberId)
        ),
        claim,
      ];
      return claim;
    }, idempotencyKey);
  }

  confirmUpiClaim(claimId: string, idempotencyKey?: string) {
    return this.call(() => {
      const claim = this.findUpiClaim(claimId);
      const g = this.findGroup(claim.groupId);
      const payee = this.members.find((m) => m.id === claim.toMemberId)!;
      if (payee.claimedByUserId !== fixtures.currentUser.id) {
        throw new SattleError('invalid_input', `Only ${payee.displayName} can confirm this.`);
      }
      const debt = this.debtsOf(claim.groupId).find(
        (d) => d.fromMemberId === claim.fromMemberId && d.toMemberId === claim.toMemberId
      );
      if (!debt) throw new SattleError('conflict', 'Nothing is owed here any more.');
      if (claim.amount > debt.amount) throw new SattleError('conflict', 'That’s more than is owed. Refresh and try again.');
      const s: Settlement = {
        id: this.id('s'),
        groupId: claim.groupId,
        fromMemberId: claim.fromMemberId,
        toMemberId: claim.toMemberId,
        amount: claim.amount,
        currency: g.currency,
        rail: 'upi',
        status: 'manually_confirmed',
        note: claim.reference ? `Paid by UPI, ref ${claim.reference}` : 'Paid by UPI',
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.settlements.push(s);
      this.upiClaims = this.upiClaims.filter((x) => x !== claim);
      return s;
    }, idempotencyKey);
  }

  declineUpiClaim(claimId: string, idempotencyKey?: string) {
    return this.call(() => {
      const claim = this.findUpiClaim(claimId);
      const payee = this.members.find((m) => m.id === claim.toMemberId)!;
      if (payee.claimedByUserId !== fixtures.currentUser.id) {
        throw new SattleError('invalid_input', `Only ${payee.displayName} can say whether this arrived.`);
      }
      claim.status = 'declined';
      return claim;
    }, idempotencyKey);
  }

  withdrawUpiClaim(claimId: string, idempotencyKey?: string) {
    return this.call(() => {
      const claim = this.findUpiClaim(claimId);
      const payer = this.members.find((m) => m.id === claim.fromMemberId)!;
      if (payer.claimedByUserId !== fixtures.currentUser.id) {
        throw new SattleError('invalid_input', `Only ${payer.displayName} can take this back.`);
      }
      this.upiClaims = this.upiClaims.filter((x) => x !== claim);
    }, idempotencyKey);
  }

  disconnectWallet() {
    return this.call(() => {
      this.checkNothingIncoming();
      this.wallet = { connected: false, methods: [], excessMethods: [] };
      for (const m of this.members) {
        if (m.claimedByUserId === fixtures.currentUser.id && m.status === 'nwc_linked') m.status = 'joined';
      }
      return this.wallet;
    });
  }

  // -- account --------------------------------------------------------------

  /** The mock's one user isn't an account: there is no token, and nothing to delete. */
  deleteAccount(): Promise<void> {
    return this.call(() => {
      throw new SattleError('invalid_input', 'The demo has no account to delete. Reload to start it over.');
    });
  }
}

export function isTerminal(s: Settlement) {
  return TERMINAL_STATUSES.includes(s.status);
}

function networkError() {
  return new SattleError('network', 'Couldn’t reach the server. Check your connection and try again.');
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomHex(len: number) {
  let out = '';
  for (let i = 0; i < len; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}
