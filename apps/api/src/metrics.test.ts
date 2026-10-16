import { describe, expect, it } from 'vitest';

import { createApp } from './app';
import { openDb, seedIfEmpty } from './db';
import { Metrics } from './metrics';
import { SimulatedPayments } from './payments';

function setup() {
  const db = openDb(':memory:');
  seedIfEmpty(db);
  const metrics = new Metrics(db);
  const app = createApp({
    db,
    metrics,
    demoUserId: 'u-yash',
    payments: (repo) =>
      new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
  });
  return { app, metrics };
}

describe('metrics', () => {
  it('counts requests by route pattern, so tokens in paths never become labels', async () => {
    const { app, metrics } = setup();
    await app.request('/health');
    await app.request('/health');
    await app.request('/s/some-secret-token');
    await app.request('/no/such/route');

    const text = metrics.render();
    expect(text).toContain('sattle_http_requests_total{method="GET",route="/health",status="200"} 2');
    expect(text).toMatch(/sattle_http_requests_total\{method="GET",route="\/s\/:token",status="\d+"\} 1/);
    expect(text).toContain('sattle_http_requests_total{method="GET",route="unmatched",status="404"} 1');
    expect(text).not.toContain('some-secret-token');
    expect(text).toContain('sattle_http_request_duration_seconds_bucket{method="GET",route="/health",status="200",le="+Inf"} 2');
  });

  it('reports settlements by status and the process', () => {
    const { metrics } = setup();
    const text = metrics.render();
    expect(text).toContain('# TYPE sattle_settlements gauge');
    expect(text).toMatch(/process_resident_memory_bytes \d+/);
  });

  it('counts nothing when no metrics are passed', async () => {
    const db = openDb(':memory:');
    const app = createApp({
      db,
      payments: (repo) =>
        new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
    });
    expect((await app.request('/health')).status).toBe(200);
  });
});
