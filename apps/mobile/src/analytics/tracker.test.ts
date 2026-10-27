import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ANALYTICS_LIMITS, type AnalyticsEvent } from '@sattle/core';

import { Tracker, utf8Length } from './tracker';

let sent: AnalyticsEvent[][];
let fail: boolean;
let clock: number;
let ids: number;

const make = (over: Partial<ConstructorParameters<typeof Tracker>[0]> = {}) =>
  new Tracker({
    send: async (events) => {
      if (fail) throw new Error('offline');
      sent.push(events);
    },
    now: () => clock,
    newId: () => `id${++ids}`,
    flushAfterMs: 1000,
    flushAt: 5,
    maxQueued: 8,
    sessionGapMs: 60_000,
    maxBackoffMs: 8000,
    ...over,
  });

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  fail = false;
  clock = Date.parse('2026-10-27T10:00:00.000Z');
  ids = 0;
});
afterEach(() => vi.useRealTimers());

const names = (events: AnalyticsEvent[]) => events.map((e) => `${e.kind}:${e.name}`);
/** Lets the effects of one render finish, as React would before anything else runs. */
const afterRender = () => new Promise<void>((r) => queueMicrotask(r));

describe('Tracker', () => {
  it('stamps each event with the session, its place in it, the time and the screen it was on', async () => {
    const t = make();
    t.start();
    const leave = t.screenView('Groups', { groups: 2 });
    t.tap('New group', { control: 'button' });
    clock += 1500;
    leave();
    t.action('share', { outcome: 'sent' });
    await t.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([
      { id: 'id2', sessionId: 'id1', seq: 0, kind: 'app', name: 'open', at: '2026-10-27T10:00:00.000Z' },
      { id: 'id3', sessionId: 'id1', seq: 1, kind: 'screen', name: 'Groups', props: { groups: 2 }, at: '2026-10-27T10:00:00.000Z' },
      { id: 'id4', sessionId: 'id1', seq: 2, kind: 'tap', name: 'New group', screen: 'Groups', props: { control: 'button' }, at: '2026-10-27T10:00:00.000Z' },
      { id: 'id5', sessionId: 'id1', seq: 3, kind: 'action', name: 'share', props: { outcome: 'sent' }, at: '2026-10-27T10:00:01.500Z' },
    ]);
    expect(t.pending).toBe(0);
  });

  it('puts a sheet over its screen, and closes back onto it, whatever order they leave in', async () => {
    const t = make({ flushAt: 100 });
    const leaveGroup = t.screenView('Group');
    const leaveSheet = t.screenView('Settle up');
    t.tap('Pay');
    leaveSheet();
    t.tap('Add expense');
    const leaveNext = t.screenView('Add expense');
    leaveGroup();
    t.tap('Save');
    leaveNext();
    t.tap('Nowhere');
    await t.flush();
    expect(sent.flat().filter((e) => e.kind === 'tap').map((e) => [e.name, e.screen])).toEqual([
      ['Pay', 'Settle up'],
      ['Add expense', 'Group'],
      ['Save', 'Add expense'],
      ['Nowhere', undefined],
    ]);
  });

  it('counts a screen built again in the same render once, and a real return to it again', async () => {
    const t = make({ flushAt: 100 });
    // A new React key: the old one's cleanup, then the new one's effect, in one go.
    const first = t.screenView('Group', { groupId: 'g1', tab: 'expenses' });
    first();
    const second = t.screenView('Group', { groupId: 'g1', tab: 'expenses' });
    // Another tab is another showing, even in the same render.
    second();
    const third = t.screenView('Group', { groupId: 'g1', tab: 'settle' });
    await afterRender();
    // Away and back, renders apart: counted.
    third();
    await afterRender();
    t.screenView('Group', { groupId: 'g1', tab: 'settle' });
    await t.flush();
    expect(sent.flat().map((e) => e.props?.tab)).toEqual(['expenses', 'settle', 'settle']);
    expect(t.screen).toBe('Group');
  });

  it('sends after a while, or as soon as enough is waiting', async () => {
    const t = make();
    t.tap('One');
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(names(sent[0])).toEqual(['tap:One']);

    for (const n of ['a', 'b', 'c', 'd']) t.tap(n);
    expect(sent).toHaveLength(1);
    t.tap('e');
    await vi.advanceTimersByTimeAsync(0);
    expect(names(sent[1])).toEqual(['tap:a', 'tap:b', 'tap:c', 'tap:d', 'tap:e']);
  });

  it('sends a long queue in several posts, each within the count and the bytes', async () => {
    const t = make({ flushAt: 100, maxQueued: 100, batchEvents: 3 });
    for (let i = 0; i < 7; i++) t.tap(`t${i}`);
    await t.flush();
    expect(sent.map((b) => b.length)).toEqual([3, 3, 1]);

    sent = [];
    const bytes = 900;
    const u = make({ flushAt: 100, maxQueued: 100, batchBytes: bytes });
    // About 330 bytes each, in rupee signs that are three bytes apiece: two fit, not three.
    for (let i = 0; i < 5; i++) u.tap(`t${i}`, { pad: '₹'.repeat(80) });
    await u.flush();
    expect(sent.map((b) => b.length)).toEqual([2, 2, 1]);
    for (const b of sent) expect(utf8Length(JSON.stringify(b))).toBeLessThanOrEqual(bytes);
  });

  it('keeps what it couldn’t send for the next try, in order and with the same ids', async () => {
    const t = make();
    fail = true;
    t.tap('One');
    await t.flush();
    expect(t.pending).toBe(1);
    t.tap('Two');
    fail = false;
    await t.flush();
    expect(sent[0].map((e) => [e.id, e.name])).toEqual([
      ['id2', 'One'],
      ['id3', 'Two'],
    ]);
  });

  it('waits longer after each failure, and a full queue doesn’t hurry it', async () => {
    let tries = 0;
    const t = make({
      send: async (events) => {
        tries++;
        if (fail) throw new Error('offline');
        sent.push(events);
      },
    });
    fail = true;
    t.tap('One');
    await vi.advanceTimersByTimeAsync(1000);
    expect(tries).toBe(1);
    // Past flushAt, but sending is failing: no send per tap.
    for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) t.tap(n);
    await vi.advanceTimersByTimeAsync(0);
    expect(tries).toBe(1);
    // Then 2s, 4s, 8s, and never more than maxBackoffMs.
    await vi.advanceTimersByTimeAsync(1999);
    expect(tries).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tries).toBe(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(tries).toBe(3);
    await vi.advanceTimersByTimeAsync(8000);
    expect(tries).toBe(4);
    await vi.advanceTimersByTimeAsync(8000);
    expect(tries).toBe(5);
    // Working again: everything goes, and the pace is back to normal.
    fail = false;
    await vi.advanceTimersByTimeAsync(8000);
    expect(sent.flat().map((e) => e.name)).toEqual(['One', 'a', 'b', 'c', 'd', 'e', 'f']);
    t.tap('After');
    await vi.advanceTimersByTimeAsync(1000);
    expect(names(sent[sent.length - 1])).toEqual(['tap:After']);
  });

  it('leaves a retry to the backoff when asked to send during a failing send, or by iOS going inactive', async () => {
    let tries = 0;
    let finish!: () => void;
    const t = make({
      send: () => {
        tries++;
        return new Promise<void>((_, reject) => {
          finish = () => reject(new Error('offline'));
        });
      },
    });
    t.tap('One');
    const first = t.flush();
    // Asked again while that send is out, and it fails: no second try straight after.
    const again = t.flush();
    finish();
    await first;
    await again;
    expect(tries).toBe(1);
    // iOS's shade, pulled while the server is down: still the backoff's call.
    await t.flushIfWorking();
    expect(tries).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(tries).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tries).toBe(2);
  });

  it('still sends at once on going to the background, even right after a send failed', async () => {
    let tries = 0;
    let finish!: () => void;
    const t = make({
      send: (events) => {
        tries++;
        if (tries > 1) {
          sent.push(events);
          return Promise.resolve();
        }
        return new Promise<void>((_, reject) => {
          finish = () => reject(new Error('offline'));
        });
      },
    });
    t.tap('One');
    const first = t.flush();
    // The app leaves while that send is out, and it fails: the app may not get another turn.
    t.background();
    finish();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(tries).toBe(2);
    expect(names(sent[0])).toEqual(['tap:One', 'app:background']);
  });

  it('sends at once on going inactive while sending works', async () => {
    const t = make();
    t.tap('One');
    await t.flushIfWorking();
    expect(names(sent[0])).toEqual(['tap:One']);
  });

  it('drops the oldest once too much is waiting', async () => {
    const t = make();
    fail = true;
    for (let i = 0; i < 12; i++) t.tap(`t${i}`);
    await t.flush();
    expect(t.pending).toBe(8);
    fail = false;
    await t.flush();
    expect(sent[0].map((e) => e.name)).toEqual(['t4', 't5', 't6', 't7', 't8', 't9', 't10', 't11']);
  });

  it('sends one post at a time, and what arrives during one goes next', async () => {
    let release = () => {};
    const t = make({
      send: async (events) => {
        sent.push(events);
        await new Promise<void>((r) => (release = r));
      },
    });
    t.tap('One');
    const first = t.flush();
    t.tap('Two');
    const second = t.flush();
    expect(sent).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    release();
    await first;
    await second;
    expect(sent.map(names)).toEqual([['tap:One'], ['tap:Two']]);
  });

  it('cuts down what the server would refuse', async () => {
    const t = make({ flushAt: 100 });
    const long = 'x'.repeat(ANALYTICS_LIMITS.text + 30);
    t.screenView(long);
    t.error(`  ${long}  `);
    t.tap('   ');
    t.tap('Big', { pad: 'p'.repeat(ANALYTICS_LIMITS.propsBytes) });
    await t.flush();
    const [screen, error, blank, big] = sent[0];
    expect(screen.name).toHaveLength(ANALYTICS_LIMITS.text);
    expect(screen.name.endsWith('…')).toBe(true);
    expect(error.name).toBe(screen.name);
    expect(error.screen).toBe(screen.name);
    expect(blank.name).toBe('?');
    expect(big.props).toEqual({ tooLarge: true });
  });

  it('flushes on going to the background, and comes back in the same session when it was quick', async () => {
    const t = make();
    t.start();
    // Never left: nothing to come back from.
    t.foreground();
    t.screenView('Groups');
    t.background();
    // iOS says inactive, then background. One leaving.
    t.background();
    await vi.advanceTimersByTimeAsync(0);
    expect(names(sent[0])).toEqual(['app:open', 'screen:Groups', 'app:background']);
    clock += 10_000;
    t.foreground();
    await t.flush();
    expect(names(sent[1])).toEqual(['app:foreground']);
    expect(sent[1][0].sessionId).toBe(sent[0][0].sessionId);
    expect(sent[1][0].seq).toBe(3);
  });

  it('is a new session after long enough away, opened on the screen still showing', async () => {
    const t = make();
    t.start();
    t.screenView('Group', { groupId: 'g1' });
    t.background();
    await t.flush();
    clock += 61_000;
    t.foreground();
    t.tap('Add expense');
    await t.flush();
    const after = sent[1];
    expect(names(after)).toEqual(['app:open', 'screen:Group', 'tap:Add expense']);
    expect(after[0].props).toEqual({ after: 'away' });
    expect(after[1].props).toEqual({ groupId: 'g1' });
    expect(after[0].sessionId).not.toBe(sent[0][0].sessionId);
    expect(after.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(after[2].screen).toBe('Group');
    expect(t.session).toBe(after[0].sessionId);
  });

  it('does nothing at all when disabled', async () => {
    const t = make({ disabled: true });
    t.start();
    t.screenView('Groups');
    t.tap('One');
    await vi.advanceTimersByTimeAsync(5000);
    await t.flush();
    expect(sent).toHaveLength(0);
    expect(t.pending).toBe(0);
  });
});

describe('utf8Length', () => {
  it('counts what goes over the wire', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('₹')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
    expect(utf8Length('a₹😀é')).toBe(new TextEncoder().encode('a₹😀é').length);
  });
});
