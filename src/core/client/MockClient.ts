/**
 * In-memory client with latency and failure injection.
 *
 * It enforces the same rules the server will: ghosts can't receive, and a
 * settlement walks created → awaiting_payment → in_flight → confirmed
 * asynchronously, so no screen can be built on the assumption that paying
 * is instant.
 */

import { computeBalances, resolveParts, simplifyDebts } from '../domain/ledger';
import { canReceive } from '../domain/settlementOptions';
import {
  SattleError,
  TERMINAL_STATUSES,
  type CreateSettlementInput,
  type Expense,
  type ExpenseInput,
  type Group,
  type Member,
  type Quote,
  type Settlement,
} from '../domain/types';
import * as fixtures from './fixtures';
import { parseLightningAddress } from './lightningAddress';
import type { SattleClient } from './SattleClient';

export interface MockClientOptions {
  /** Delay applied to every call. Default 400ms. */
  latencyMs?: number;
  /** 0..1 chance that any call throws a network error. */
  failureRate?: number;
  /** Every settlement ends in `failed`. */
  alwaysFailSettlement?: boolean;
  /** How long a payment spends in flight. Default 2500ms. */
  settleDelayMs?: number;
  /** INR per BTC used for quotes. */
  rateFiatPerBtc?: number;
}

const QUOTE_TTL_MS = 90_000;

export class MockClient implements SattleClient {
  private groups: Group[];
  private members: Member[];
  private expenses: Expense[];
  private settlements: Settlement[];
  private listeners = new Map<string, Set<(s: Settlement) => void>>();
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
  }

  // -- plumbing -------------------------------------------------------------

  private async call<T>(fn: () => T): Promise<T> {
    if (this.opts.latencyMs > 0) await sleep(this.opts.latencyMs * (0.6 + Math.random() * 0.8));
    if (Math.random() < this.opts.failureRate) {
      throw new SattleError('network', 'Couldn’t reach the server. Check your connection and try again.');
    }
    return structuredClone(fn());
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

  private findSettlement(id: string) {
    const s = this.settlements.find((x) => x.id === id);
    if (!s) throw new SattleError('not_found', 'That payment doesn’t exist.');
    return s;
  }

  private update(id: string, patch: Partial<Settlement>) {
    const s = this.findSettlement(id);
    Object.assign(s, patch, { updatedAt: this.now() });
    this.listeners.get(id)?.forEach((cb) => cb(structuredClone(s)));
  }

  private quote(amountFiat: number, currency: string): Quote {
    // amountFiat is minor units; 1 BTC = 1e8 sats.
    const amountSat = Math.round((amountFiat / 100 / this.opts.rateFiatPerBtc) * 1e8);
    return {
      amountFiat,
      currency,
      amountSat,
      feeSat: Math.max(2, Math.round(amountSat * 0.003)),
      rateFiatPerBtc: this.opts.rateFiatPerBtc,
      expiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    };
  }

  // -- reads ----------------------------------------------------------------

  getCurrentUser() {
    return this.call(() => fixtures.currentUser);
  }

  getGroups() {
    return this.call(() => this.groups);
  }

  getGroup(groupId: string) {
    return this.call(() => this.findGroup(groupId));
  }

  getMembers(groupId: string) {
    return this.call(() => {
      const g = this.findGroup(groupId);
      return g.memberIds.map((id) => this.members.find((m) => m.id === id)!);
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

  addExpense(input: ExpenseInput) {
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
    });
  }

  setMemberPayoutAddress(memberId: string, address: string) {
    return this.call(() => {
      const parsed = parseLightningAddress(address);
      if (!parsed.ok) throw new SattleError('invalid_address', parsed.reason);
      const m = this.members.find((x) => x.id === memberId);
      if (!m) throw new SattleError('not_found', 'That member doesn’t exist.');
      m.lightningAddress = parsed.address; // status stays as-is: payable, not joined
      return m;
    });
  }

  markSettledManually(input: Omit<CreateSettlementInput, 'rail'> & { note?: string }) {
    return this.call(() => {
      const g = this.findGroup(input.groupId);
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
    });
  }

  async createSettlement(input: CreateSettlementInput) {
    const created = await this.call(() => {
      if (input.rail === 'manual') {
        throw new SattleError('invalid_expense', 'Use markSettledManually for manual settlements.');
      }
      const g = this.findGroup(input.groupId);
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
      return s;
    });

    this.runLifecycle(created.id);
    return created;
  }

  /** Drives a settlement to a terminal state in the background. */
  private async runLifecycle(id: string) {
    const step = Math.max(300, this.opts.latencyMs);
    await sleep(step);
    const s = this.findSettlement(id);
    const to = this.members.find((m) => m.id === s.toMemberId)!;

    this.update(id, {
      status: 'awaiting_payment',
      quote: this.quote(s.amount, s.currency),
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
}

export function isTerminal(s: Settlement) {
  return TERMINAL_STATUSES.includes(s.status);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomHex(len: number) {
  let out = '';
  for (let i = 0; i < len; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}
