/**
 * What the app reports of how it is used, and when it sends it. The screens
 * say what happened (screen, tap, action, error); this queues it, stamps it
 * with the session and the screen it was on, and posts it in batches:
 * every few seconds, or sooner once enough has piled up, and when the app
 * goes to the background.
 *
 * A batch that can't be sent goes back on the queue with the same ids, so
 * the server keeps it once, and the next try waits longer each time it
 * fails. A long queue goes in several posts, each under what nginx and a
 * browser closing the tab will carry. What the server would refuse, a name
 * too long or props too big, is cut down here instead, since one bad event
 * gets its whole batch refused.
 *
 * A session is one launch, or one return to the app after long enough away
 * (SESSION_GAP_MS): the same person coming back the next morning is a new
 * one. Each event has its place in the session, since phone clocks drift.
 *
 * The screen an event was on is a stack, not a value: a sheet opens over a
 * screen and closes back onto it, so screenView() hands back a leave() that
 * takes it off again. Nothing here imports React Native, so it runs under
 * vitest against a fake send; analytics.ts is the app's instance.
 */

import { ANALYTICS_LIMITS, type AnalyticsBatch, type AnalyticsEvent } from '@sattle/core';

export type Props = Record<string, unknown>;

export interface TrackerOptions {
  /** Posts a batch. Throws when it couldn't, and the batch is tried again later. */
  send: (events: AnalyticsEvent[]) => Promise<void>;
  /** Reporting is off: nothing is queued or sent. Demo mode. */
  disabled?: boolean;
  now?: () => number;
  newId?: () => string;
  /** How long an event waits before a batch goes, at most, while sending works. */
  flushAfterMs?: number;
  /** A batch goes as soon as this many are waiting, while sending works. */
  flushAt?: number;
  /** Oldest events are dropped past this, so a server that's down doesn't fill the phone's memory. */
  maxQueued?: number;
  /** Away for longer than this, and coming back is a new session. */
  sessionGapMs?: number;
  /** Events in one post. */
  batchEvents?: number;
  /** One post's events, as UTF-8 JSON. */
  batchBytes?: number;
  /** After a failed send, the wait doubles from flushAfterMs up to this. */
  maxBackoffMs?: number;
}

const FLUSH_AFTER_MS = 5_000;
const FLUSH_AT = 25;
const MAX_QUEUED = 500;
const SESSION_GAP_MS = 30 * 60_000;
const BATCH_EVENTS = 50;
/** Under nginx's 64 KB for the API, and a browser's 64 KB for a request that outlives the page, with room for the rest of the body. */
const BATCH_BYTES = 48 * 1024;
const MAX_BACKOFF_MS = 5 * 60_000;

export const newEventId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/**
 * A new id for this install (see deviceStore). Here and not in deviceStore.ts: on a phone, Metro
 * resolves './deviceStore' to deviceStore.native.ts, even from inside that file.
 */
export const newDeviceId = () => `d-${newEventId()}`;

/** Trimmed, never empty, and no longer than the server takes. */
const text = (s: string) => {
  const t = s.trim();
  if (!t) return '?';
  return t.length > ANALYTICS_LIMITS.text ? `${t.slice(0, ANALYTICS_LIMITS.text - 1)}…` : t;
};

/** How many bytes `s` is in UTF-8, which is what goes over the wire. */
export function utf8Length(s: string) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

interface ShownScreen {
  name: string;
  props?: Props;
  /** The props as JSON: what tells this showing from another of the same screen. */
  key: string;
}

export class Tracker {
  private readonly send: TrackerOptions['send'];
  private readonly disabled: boolean;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly flushAfterMs: number;
  private readonly flushAt: number;
  private readonly maxQueued: number;
  private readonly sessionGapMs: number;
  private readonly batchEvents: number;
  private readonly batchBytes: number;
  private readonly maxBackoffMs: number;

  private queue: AnalyticsEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> | null = null;
  /** Sends that failed in a row. Above 0, the next try waits longer, and a full queue doesn't hurry it. */
  private failures = 0;
  private sessionId: string;
  private seq = 0;
  /** When the app last went to the background, or null while it's in front. */
  private awaySince: number | null = null;
  /** The screens showing, innermost last. */
  private screens: ShownScreen[] = [];
  /** The screen that went in this render's effects, until they have all run. See screenView. */
  private justLeft: ShownScreen | null = null;

  constructor(opts: TrackerOptions) {
    this.send = opts.send;
    this.disabled = opts.disabled ?? false;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? newEventId;
    this.flushAfterMs = opts.flushAfterMs ?? FLUSH_AFTER_MS;
    this.flushAt = opts.flushAt ?? FLUSH_AT;
    this.maxQueued = opts.maxQueued ?? MAX_QUEUED;
    this.sessionGapMs = opts.sessionGapMs ?? SESSION_GAP_MS;
    this.batchEvents = opts.batchEvents ?? BATCH_EVENTS;
    this.batchBytes = opts.batchBytes ?? BATCH_BYTES;
    this.maxBackoffMs = opts.maxBackoffMs ?? MAX_BACKOFF_MS;
    this.sessionId = this.newId();
  }

  /** The session every event is in right now. Sent as a header with each request, so the server's rows join these. */
  get session() {
    return this.sessionId;
  }

  /** The screen on top, if any. */
  get screen(): string | undefined {
    return this.screens[this.screens.length - 1]?.name;
  }

  /** How many are waiting to go. */
  get pending() {
    return this.queue.length;
  }

  /** The app is up. The first thing in a session. */
  start() {
    this.track('app', 'open');
  }

  /** Gone to the background. What's queued goes now, since the app may not come back. Said once per leaving. */
  background() {
    if (this.awaySince !== null) return;
    this.awaySince = this.now();
    this.track('app', 'background');
    void this.flush(true);
  }

  /** Back in front. After long enough away, a new session, opened like the first. Nothing when it never left. */
  foreground() {
    if (this.awaySince === null) return;
    const away = this.now() - this.awaySince;
    this.awaySince = null;
    if (away > this.sessionGapMs) {
      this.sessionId = this.newId();
      this.seq = 0;
      this.track('app', 'open', { after: 'away' });
      // The screen that was showing is still showing. It is the first thing seen in the new session.
      const top = this.screens[this.screens.length - 1];
      if (top) this.track('screen', top.name, top.props);
      return;
    }
    this.track('app', 'foreground');
  }

  /**
   * A screen (or a sheet, or a tab of one) is showing. The leave() handed
   * back takes it off the stack when it goes, whether or not something
   * opened over it in the meantime.
   *
   * A screen built again in the same render, because its React key changed
   * or StrictMode ran its effects twice, is the same showing, and isn't
   * counted twice. React runs every effect's cleanup and then every new
   * effect in one go, so what left in that go is still `justLeft` when the
   * new one arrives; a microtask clears it after.
   */
  screenView(name: string, props?: Props): () => void {
    const entry: ShownScreen = { name, props, key: JSON.stringify(props ?? null) };
    this.screens.push(entry);
    const again = this.justLeft?.name === entry.name && this.justLeft.key === entry.key;
    this.justLeft = null;
    if (!again) this.track('screen', name, props);
    return () => {
      this.screens = this.screens.filter((s) => s !== entry);
      this.justLeft = entry;
      queueMicrotask(() => {
        if (this.justLeft === entry) this.justLeft = null;
      });
    };
  }

  /** Something was pressed. `name` is what it said. */
  tap(name: string, props?: Props) {
    this.track('tap', name, props);
  }

  /** Something the app did on their behalf: opened another app, shared a link, copied something. */
  action(name: string, props?: Props) {
    this.track('action', name, props);
  }

  /** An error was put on screen. `code` is which; never its message, which can name people. */
  error(code: string, props?: Props) {
    this.track('error', code, props);
  }

  track(kind: AnalyticsEvent['kind'], name: string, props?: Props) {
    if (this.disabled) return;
    const event: AnalyticsEvent = {
      id: this.newId(),
      sessionId: this.sessionId,
      seq: this.seq++,
      kind,
      name: text(name),
      at: new Date(this.now()).toISOString(),
    };
    // A screen event names the screen it is; everything else says which it was on.
    if (kind !== 'screen' && this.screen) event.screen = text(this.screen);
    if (props && Object.keys(props).length > 0) {
      // Measured the way the server measures it.
      event.props = JSON.stringify(props).length <= ANALYTICS_LIMITS.propsBytes ? props : { tooLarge: true };
    }
    this.queue.push(event);
    this.trim();
    // A send under way picks this up when it's done (see drain).
    if (this.sending) return;
    if (this.queue.length >= this.flushAt && this.failures === 0) void this.flush();
    else this.schedule();
  }

  /**
   * Sends what's queued now, in as many posts as it takes, even while
   * sending has been failing. One at a time: a flush during a send waits for
   * it, and if that send failed, leaves the rest to the backoff rather than
   * trying again at once, unless `leaving`: going to the background, when the
   * app may not get another turn. Never throws: what couldn't be sent is put
   * back, oldest first, and tried again later.
   */
  flush(leaving = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.sending) {
      return this.sending.then(() => (this.failures > 0 && !leaving ? this.schedule() : this.flush(leaving)));
    }
    if (this.queue.length === 0) return Promise.resolve();
    this.sending = this.drain().finally(() => {
      this.sending = null;
      // Anything that arrived as the last send finished.
      this.schedule();
    });
    return this.sending;
  }

  /**
   * Sends what's queued now while sending works, and otherwise leaves it to
   * the backoff. For moments that may or may not be a leaving, like iOS's
   * notification shade or app switcher: pulled down again and again while the
   * server is down, each would otherwise be another try at once.
   */
  flushIfWorking(): Promise<void> {
    if (this.failures === 0) return this.flush();
    this.schedule();
    return Promise.resolve();
  }

  /** Batch after batch, until the queue is empty or a send fails. */
  private async drain() {
    while (this.queue.length > 0) {
      const batch = this.nextBatch();
      try {
        await this.send(batch);
        this.failures = 0;
      } catch {
        this.queue = [...batch, ...this.queue];
        this.trim();
        this.failures++;
        return;
      }
    }
  }

  /** Takes as many from the front of the queue as fit in one post. Always at least one: any single event fits. */
  private nextBatch() {
    let bytes = 2;
    let n = 0;
    while (n < this.queue.length && n < this.batchEvents) {
      const size = utf8Length(JSON.stringify(this.queue[n])) + 1;
      if (n > 0 && bytes + size > this.batchBytes) break;
      bytes += size;
      n++;
    }
    return this.queue.splice(0, n);
  }

  /** A send goes in a while: soon while sending works, and later each time it has failed. */
  private schedule() {
    if (this.timer || this.sending || this.queue.length === 0) return;
    const wait =
      this.failures === 0 ? this.flushAfterMs : Math.min(this.flushAfterMs * 2 ** this.failures, this.maxBackoffMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  private trim() {
    if (this.queue.length > this.maxQueued) this.queue.splice(0, this.queue.length - this.maxQueued);
  }
}

/** The batch the server takes, around the events. */
export const toBatch = (
  events: AnalyticsEvent[],
  device: { deviceId: string; platform: AnalyticsBatch['platform']; appVersion?: string }
): AnalyticsBatch => ({ ...device, events });
