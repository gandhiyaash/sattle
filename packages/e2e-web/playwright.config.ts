import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

import { API_PORT, API_URL, SIM_RATE_FIAT_PER_BTC, SIM_SETTLE_MS, SIM_STEP_MS, WEB_PORT, WEB_URL } from './src/env';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const CI = Boolean(process.env.CI);

/**
 * Both servers start here and are torn down with the run. The API keeps its
 * database in memory, seeds nothing and simulates payments; nothing reaches
 * the network. The web app is exported once, with these servers' addresses
 * baked in, and served the way nginx serves it (scripts/web.mjs).
 *
 * Headless always. Debug a test with `npx playwright test --ui`, or read the
 * trace a failed run leaves in test-results/.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 4 : undefined,
  reporter: CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  // Screens that keep themselves current ask the server every 4 s, so an assertion that waits on one needs longer than that.
  expect: { timeout: 10_000 },
  use: {
    baseURL: WEB_URL,
    // The app is phone-first, so it's tested as a phone: a phone's width, a touch screen, and an Android browser's user agent.
    ...devices['Pixel 7'],
    // Chrome's own headless mode, not the stripped headless shell: what it renders is what Chrome renders.
    channel: 'chromium',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  webServer: [
    {
      command: 'npx tsx src/server.ts',
      cwd: path.join(repo, 'apps/api'),
      url: `${API_URL}/health`,
      reuseExistingServer: !CI,
      timeout: 60_000,
      env: {
        PORT: String(API_PORT),
        HOST: '127.0.0.1',
        DATABASE_PATH: ':memory:',
        SEED: 'false',
        DEMO_USER_ID: '',
        CORS_ORIGIN: WEB_URL,
        PAYMENTS: 'sim',
        SIM_STEP_MS: String(SIM_STEP_MS),
        SIM_SETTLE_MS: String(SIM_SETTLE_MS),
        SIM_RATE_FIAT_PER_BTC: String(SIM_RATE_FIAT_PER_BTC),
        SIM_ALWAYS_FAIL: 'false',
        LEDGER_RELAYS: '',
        REQUEST_LOG: 'false',
        NODE_ENV: 'test',
      },
    },
    {
      command: 'node scripts/web.mjs',
      cwd: here,
      url: WEB_URL,
      reuseExistingServer: !CI,
      timeout: 180_000,
      env: { E2E_API_URL: API_URL, E2E_WEB_URL: WEB_URL, E2E_WEB_PORT: String(WEB_PORT) },
    },
  ],
});
