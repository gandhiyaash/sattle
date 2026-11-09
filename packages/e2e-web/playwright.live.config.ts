import { defineConfig, devices } from '@playwright/test';

import { LIVE_WEB_URL } from './live/env';

/**
 * The live check: a few tests against the hosted app and API (live/), run by
 * .github/workflows/live-check.yml after every publish and once a day. Nothing
 * is started here; LIVE_WEB_URL and LIVE_API_URL say where to look.
 *
 * Production has real people on it, so these only read, except one account
 * the check makes for itself and deletes again (live/live.spec.ts).
 *
 * `LIVE_WEB_URL=… LIVE_API_URL=… npm run e2e:live -w @sattle/e2e-web`
 */
export default defineConfig({
  testDir: './live',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  // One more try for a blip on the way there; a test that only passes on it still fails the run.
  retries: 1,
  failOnFlakyTests: true,
  // The list for the log, and JSON for the step that tells Om which tests failed.
  reporter: [['list'], ['json', { outputFile: 'live-results.json' }]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: LIVE_WEB_URL,
    ...devices['Pixel 7'],
    channel: 'chromium',
    // The repo is public and a trace holds addresses and the check's token: none are kept.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
