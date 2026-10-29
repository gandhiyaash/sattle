/**
 * What the app reports about how it is used: each screen someone lands on,
 * each thing they tap, each hand-off to another app, and what the server saw
 * them do. The app batches these and posts them to POST /analytics/events,
 * signed in or not; the server adds its own rows for the requests it
 * answers. It all goes in one table, so a session reads as one stream:
 * screen, tap, request, screen.
 *
 * Nothing here is shown to anyone yet. These are the shapes the app sends
 * and the server keeps, and the limits the server holds a batch to.
 */

/**
 * screen:   someone landed on a screen (or a sheet, or a tab of one).
 * tap:      something was pressed. `name` is what it said.
 * action:   something the app did on their behalf: opened a wallet or a UPI
 *           app, put a link on the share sheet, copied something.
 * app:      the app itself: opened, went to the background, came back.
 * error:    an error was put on screen.
 * request:  the server's own row for a request it answered. Never sent by the app.
 */
export const ANALYTICS_KINDS = ['screen', 'tap', 'action', 'app', 'error', 'request'] as const;
export type AnalyticsKind = (typeof ANALYTICS_KINDS)[number];

export const ANALYTICS_PLATFORMS = ['ios', 'android', 'web'] as const;
export type AnalyticsPlatform = (typeof ANALYTICS_PLATFORMS)[number];

/** One thing that happened in the app. */
export interface AnalyticsEvent {
  /** Made by the app. A batch sent twice, after a lost answer, is kept once. */
  id: string;
  /** One app launch, or one return to it after long enough away. */
  sessionId: string;
  /** Its place in that session, from 0. Clocks on phones drift; this doesn't. */
  seq: number;
  kind: Exclude<AnalyticsKind, 'request'>;
  name: string;
  /** The screen it happened on. A screen event names the screen itself. */
  screen?: string;
  /** Whatever else is worth keeping about it: a group id, a tab, an outcome. */
  props?: Record<string, unknown>;
  /** When it happened, by the device's clock. */
  at: string;
}

/** What the app posts: a few events from one device. */
export interface AnalyticsBatch {
  /** Made once per install and kept, so what someone did before signing in is theirs afterwards. */
  deviceId: string;
  platform: AnalyticsPlatform;
  /** The app's version, where the platform says it. */
  appVersion?: string;
  events: AnalyticsEvent[];
}

/**
 * What the server holds a batch to. Over any of these, the whole batch is
 * refused, so the app keeps under them itself: it cuts a long name short,
 * leaves out props that are too big, and sends a long queue in several posts.
 */
export const ANALYTICS_LIMITS = {
  /** Events in one batch. */
  eventsPerBatch: 200,
  /** The whole body. The same as nginx's client_max_body_size for the API, so a dev server refuses what production would. */
  batchBytes: 64 * 1024,
  /** `id`, `sessionId`, `deviceId`. */
  id: 64,
  /** `name`, `screen`, `appVersion`, in characters. */
  text: 120,
  /** `props`, as JSON, in characters. */
  propsBytes: 4096,
} as const;

/** Headers the app sends with every request, so the server's own rows join the app's. */
export const ANALYTICS_HEADERS = {
  device: 'x-sattle-device',
  session: 'x-sattle-session',
} as const;
