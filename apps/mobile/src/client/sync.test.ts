import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SyncView } from '@sattle/core';

import { ApiClient } from './ApiClient';
import { MockClient } from './MockClient';

const view: SyncView = {
  user: { id: 'u-1', displayName: 'Riya' },
  groups: [],
  joinRequests: [],
  upiProfile: { upiId: null, onGroupLinks: true },
};

type Seen = { url: string; headers: Record<string, string> };

/** fetch, answered by `answer` for each request in turn; what was asked is kept in `seen`. */
function serve(answer: (req: Seen, n: number) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const req = { url, headers: (init.headers ?? {}) as Record<string, string> };
      seen.push(req);
      return answer(req, seen.length);
    })
  );
  return seen;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe('ApiClient.sync', () => {
  it('asks GET /sync, with the version it has as a weak If-None-Match, and takes a 304 as nothing changed', async () => {
    const seen = serve((req) =>
      req.headers['if-none-match'] ? new Response(null, { status: 304 }) : json({ version: 'v1', ...view })
    );
    const client = new ApiClient('http://api.test', () => 't-1');
    expect(await client.sync()).toEqual({ version: 'v1', ...view });
    expect(await client.sync('v1')).toEqual({ version: 'v1', unchanged: true });
    expect(seen.map((s) => s.url)).toEqual(['http://api.test/sync', 'http://api.test/sync']);
    expect(seen[1]!.headers['if-none-match']).toBe('W/"v1"');
    expect(seen[1]!.headers.authorization).toBe('Bearer t-1');
  });

  it('asks for some groups by name', async () => {
    const seen = serve(() => json({ version: 'v', ...view }));
    await new ApiClient('http://api.test').sync(undefined, ['g-2', 'g 1']);
    // In one order, so the same groups are the same question with the same version.
    expect(seen[0]!.url).toBe('http://api.test/sync?group=g%201&group=g-2');
  });

  it('reads an older server, which has no /sync, the old way: the same answer from its own routes', async () => {
    const seen = serve((req) => {
      const path = new URL(req.url).pathname;
      if (path === '/sync') return json({ code: 'not_found', message: 'No such route.' }, 404);
      if (path === '/me') return json(view.user);
      if (path === '/groups') return json([{ id: 'g-1', name: 'Goa', currency: 'INR', memberIds: [], approveJoins: false, createdAt: '', simplifyDebts: false }]);
      if (path === '/me/join-requests') return json([]);
      if (path === '/me/upi') return json(view.upiProfile);
      return json([]);
    });
    const client = new ApiClient('http://api.test');
    const answer = await client.sync('v-old');
    expect(answer).toMatchObject({ version: '', user: view.user, joinRequests: [], upiProfile: view.upiProfile });
    expect('groups' in answer && answer.groups.map((g) => g.group.name)).toEqual(['Goa']);
    const paths = seen.map((s) => new URL(s.url).pathname);
    expect(paths).toContain('/groups/g-1/expenses');
    expect(paths).toContain('/groups/g-1/join-requests');

    // And it doesn't ask /sync again for a while.
    seen.length = 0;
    await client.sync();
    expect(seen.map((s) => new URL(s.url).pathname)).not.toContain('/sync');
  });

  it('asks again without its version when asking with it couldn’t get through (a browser and an older server’s CORS)', async () => {
    const seen = serve((req) => {
      if (req.headers['if-none-match']) throw new TypeError('Failed to fetch');
      return json({ version: 'v2', ...view });
    });
    expect(await new ApiClient('http://api.test').sync('v1')).toEqual({ version: 'v2', ...view });
    expect(seen).toHaveLength(2);
  });

  it('says it couldn’t reach the server when neither way gets through', async () => {
    serve(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(new ApiClient('http://api.test').sync('v1')).rejects.toMatchObject({ code: 'network' });
  });

  it('gives up on a request that never answers, as one that couldn’t get through', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      )
    );
    const asking = new ApiClient('http://api.test').sync();
    const failed = expect(asking).rejects.toMatchObject({ code: 'network' });
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    vi.useRealTimers();
  });
});

describe('MockClient.sync', () => {
  it('answers what its reads do, and that nothing changed when nothing has', async () => {
    const mock = new MockClient({ latencyMs: 0 });
    const first = await mock.sync();
    if (first.unchanged) throw new Error('expected the whole view');
    expect(first.groups.map((g) => g.group.id)).toEqual((await mock.getGroups()).map((g) => g.id));
    const flat = first.groups.find((g) => g.group.id === 'g-flat')!;
    expect(flat.members).toEqual(await mock.getMembers('g-flat'));
    expect(flat.expenses).toEqual(await mock.getExpenses('g-flat'));
    expect(first.upiProfile).toEqual(await mock.getUpiId());

    expect(await mock.sync(first.version)).toEqual({ version: first.version, unchanged: true });
    const only = await mock.sync(undefined, ['g-flat']);
    expect(!only.unchanged && only.groups.map((g) => g.group.id)).toEqual(['g-flat']);
  });
});
