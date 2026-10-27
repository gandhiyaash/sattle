/**
 * The app's one tracker (see tracker.ts), and what it needs from the phone:
 * where to post, who's signed in, which install this is, and when the app
 * goes to and from the background.
 *
 * Batches go to POST /analytics/events with the account token when there is
 * one, so the rows are that account's; a guest's go without. Every other
 * request carries the install and session as headers, so the server's own
 * rows for them join these. In demo mode there is no server, and nothing
 * is kept.
 */

import { AppState, Platform } from 'react-native';

import { ANALYTICS_HEADERS, type AnalyticsBatch, type AnalyticsEvent } from '@sattle/core';

import appJson from '../../app.json';
import { readToken } from '../account/tokenStore';
import { setRequestHeaders } from '../client/ApiClient';
import { API_URL, isMock } from '../react/SattleProvider';
import { readDeviceId } from './deviceStore';
import { Tracker, newDeviceId, toBatch } from './tracker';

const platform: AnalyticsBatch['platform'] = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
/** Set by the release builds (the version tagged, a PR's number, the web's commit); app.json's otherwise. */
const appVersion: string = process.env.EXPO_PUBLIC_APP_VERSION || appJson.expo.version;

let device: Promise<string> | undefined;
/** Known once the store has answered; requests before that go without it. */
let deviceId: string | null = null;
const readDevice = () =>
  (device ??= readDeviceId()
    // A store that can't answer still gets an id, for this launch only.
    .catch(() => newDeviceId())
    .then((id) => {
      deviceId = id;
      return id;
    }));

async function send(events: AnalyticsEvent[]) {
  const [token, deviceId] = await Promise.all([readToken().catch(() => null), readDevice()]);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}/analytics/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify(toBatch(events, { deviceId, platform, appVersion })),
    // A browser closing the tab still sends it. The tracker keeps each batch under the 64 KB this allows.
    keepalive: true,
  });
  // A 5xx, no answer at all, or a 429 (nginx's limit on the route, or the server's daily cap) is
  // tried again.
  if (res.status >= 500 || res.status === 429) throw new Error(`analytics: ${res.status}`);
  // Any other 4xx would be the same next time, so the batch is dropped rather than sent forever.
  // The tracker keeps every batch to what the server takes, so one means the two have come apart:
  // a 413 its BATCH_BYTES and the server's limit, a 400 the event's shape (a new kind, a changed
  // field), a 404 a server too old for the route. Said aloud, so the loss isn't silent.
  if (res.status >= 400) console.warn(`analytics: dropped a batch of ${events.length}; the server answered ${res.status}`);
}

export const analytics = new Tracker({ send, disabled: isMock() });

setRequestHeaders(() => ({
  ...(deviceId ? { [ANALYTICS_HEADERS.device]: deviceId } : {}),
  [ANALYTICS_HEADERS.session]: analytics.session,
}));

/**
 * The app is up: says so, and follows it to the background and back.
 * Returns the cleanup, so it drops straight into an effect.
 */
export function startReporting(): () => void {
  if (isMock()) return () => {};
  void readDevice();
  analytics.start();
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') analytics.foreground();
    else if (state === 'background') analytics.background();
    // iOS only: the notification shade, a call, or the app switcher, where swiping the app away
    // ends it with no background first. Nothing to record, but what's queued goes now, unless
    // sending has been failing: then the backoff decides, or each pull of the shade is a try.
    else if (state === 'inactive') void analytics.flushIfWorking();
  });
  return () => sub.remove();
}
