import { describe, expect, it } from 'vitest';

import { BUSY_TIMEOUT_MS, openDb } from './db';

describe('openDb', () => {
  it('waits for a lock held by another process, such as Litestream, instead of failing at once', () => {
    const db = openDb(':memory:');
    const { timeout } = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(timeout).toBe(BUSY_TIMEOUT_MS);
  });
});
