import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Group, User } from '@sattle/core';

import { ApiClient } from './ApiClient';
import { SavedReads, type SavedStore } from './SavedReads';

/** Storage that lasts as long as the test, and counts what was written to it. */
function memoryStore(text: string | null = null) {
  const store = {
    text,
    writes: 0,
    read: () => store.text,
    write: (next: string) => {
      store.text = next;
      store.writes++;
    },
    clear: () => {
      store.text = null;
    },
  };
  return store satisfies SavedStore;
}

const yash: User = { id: 'u-yash', displayName: 'Yash' };
const goa: Group = { id: 'g-goa', name: 'Goa trip', currency: 'INR', memberIds: ['m-1', 'm-2'], createdAt: '2026-01-01' };
const flat: Group = { id: 'g-flat', name: 'Flat 4B', currency: 'INR', memberIds: ['m-3'], createdAt: '2026-01-02' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SavedReads', () => {
  it('keeps the reads the screens are built from, and nothing that works as a key', () => {
    const saved = new SavedReads(memoryStore());
    saved.keep('/me', yash);
    saved.keep('/groups/g-goa/expenses', [{ id: 'e-1' }]);
    saved.keep('/groups/g-goa/ledger', { uri: 'sattle-ledger://secret' });
    saved.keep('/groups/g-goa/invites', { token: 'join-me' });
    saved.keep('/groups/g-goa/link', { token: 'read-me' });
    saved.keep('/settlements/s-1', { status: 'in_flight' });

    expect(saved.get('/me')).toEqual(yash);
    expect(saved.get('/groups/g-goa/expenses')).toEqual([{ id: 'e-1' }]);
    expect(saved.get('/groups/g-goa/ledger')).toBeUndefined();
    expect(saved.get('/groups/g-goa/invites')).toBeUndefined();
    expect(saved.get('/groups/g-goa/link')).toBeUndefined();
    expect(saved.get('/settlements/s-1')).toBeUndefined();
  });

  it('saves each group on the list on its own, so one opens that was never opened online', () => {
    const saved = new SavedReads(memoryStore());
    saved.keep('/groups', [goa, flat]);
    expect(saved.get('/groups/g-flat')).toEqual(flat);
  });

  it('drops what it had of a group that is no longer on the list', () => {
    const saved = new SavedReads(memoryStore());
    saved.keep('/groups', [goa, flat]);
    saved.keep('/groups/g-flat/expenses', [{ id: 'e-9' }]);
    saved.keep('/groups', [goa]);

    expect(saved.get('/groups/g-flat')).toBeUndefined();
    expect(saved.get('/groups/g-flat/expenses')).toBeUndefined();
    expect(saved.get('/groups/g-goa')).toEqual(goa);
  });

  it('stops counting an answer as current once a change is made, until the server answers again', () => {
    const saved = new SavedReads(memoryStore());
    saved.keep('/groups/g-goa/expenses', [{ id: 'e-1' }]);
    saved.outdate();

    expect(saved.get('/groups/g-goa/expenses', true)).toBeUndefined();
    expect(saved.get('/groups/g-goa/expenses')).toEqual([{ id: 'e-1' }]);

    saved.keep('/groups/g-goa/expenses', [{ id: 'e-1' }, { id: 'e-2' }]);
    expect(saved.get('/groups/g-goa/expenses', true)).toHaveLength(2);
  });

  it('forgets everything when a different account answers', () => {
    const saved = new SavedReads(memoryStore());
    saved.keep('/me', yash);
    saved.keep('/groups', [goa]);
    saved.keep('/me', { id: 'u-om', displayName: 'Om' });

    expect(saved.get('/groups')).toBeUndefined();
    expect(saved.get('/groups/g-goa')).toBeUndefined();
    expect(saved.get<User>('/me')?.id).toBe('u-om');
  });

  it('is still there on the next launch, with when it is from', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
    const store = memoryStore();
    const saved = new SavedReads(store);
    saved.keep('/groups', [goa]);
    vi.advanceTimersByTime(1000);

    const next = new SavedReads(store);
    expect(next.get('/groups')).toEqual([goa]);
    expect(next.at).toBe(new Date('2026-10-05T10:00:00Z').getTime());
  });

  it('doesn’t rewrite storage each time the server repeats itself', () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const saved = new SavedReads(store);
    saved.keep('/groups', [goa]);
    vi.advanceTimersByTime(1000);
    expect(store.writes).toBe(1);

    // A screen polling every few seconds, with nothing new each time.
    for (let i = 0; i < 5; i++) {
      saved.keep('/groups', [goa]);
      vi.advanceTimersByTime(4000);
    }
    expect(store.writes).toBe(1);
  });

  it('starts empty on storage it can’t read', () => {
    expect(new SavedReads(memoryStore('not json')).get('/me')).toBeUndefined();
    expect(new SavedReads(memoryStore(JSON.stringify({ v: 0, entries: { '/me': '{}' } }))).get('/me')).toBeUndefined();
    const blocked: SavedStore = {
      read: () => {
        throw new Error('blocked');
      },
      write: () => {
        throw new Error('blocked');
      },
      clear: () => {
        throw new Error('blocked');
      },
    };
    const saved = new SavedReads(blocked);
    saved.keep('/me', yash);
    expect(saved.get('/me')).toEqual(yash);
    expect(() => saved.clear()).not.toThrow();
  });

  it('clears storage too, and a write that was waiting doesn’t bring it back', () => {
    vi.useFakeTimers();
    const store = memoryStore();
    const saved = new SavedReads(store);
    saved.keep('/me', yash);
    saved.clear();
    vi.advanceTimersByTime(60_000);

    expect(saved.get('/me')).toBeUndefined();
    expect(saved.at).toBeNull();
    expect(store.text).toBeNull();
  });
});

describe('ApiClient with somewhere to save', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  /** A server that answers from `routes` until `down` is set, then answers nothing. */
  function server(routes: Record<string, unknown>) {
    const state = { down: false, asked: [] as string[] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const path = url.replace('http://api.test', '');
        state.asked.push(`${init.method} ${path}`);
        if (state.down) throw new TypeError('Network request failed');
        return path in routes ? json(routes[path]) : json({ code: 'not_found', message: 'No such thing.' }, 404);
      })
    );
    return state;
  }

  it('answers from the device what the server answered before, without asking it', async () => {
    const api = server({ '/me': yash, '/groups': [goa], '/groups/g-goa/expenses': [{ id: 'e-1' }] });
    const client = new ApiClient('http://api.test', () => 't', new SavedReads(memoryStore()));
    await client.getCurrentUser();
    await client.getGroups();
    await client.getExpenses('g-goa');

    api.down = true;
    api.asked.length = 0;
    await expect(client.getGroups()).rejects.toMatchObject({ code: 'network' });
    expect(await client.saved!.any.getGroups()).toEqual([goa]);
    expect(await client.saved!.any.getGroup('g-goa')).toEqual(goa);
    expect(await client.saved!.any.getExpenses('g-goa')).toEqual([{ id: 'e-1' }]);
    expect(api.asked).toEqual(['GET /groups']);
  });

  it('says so when the device has nothing saved for a read', async () => {
    server({});
    const client = new ApiClient('http://api.test', () => 't', new SavedReads(memoryStore()));
    await expect(client.saved!.any.getGroups()).rejects.toMatchObject({ code: 'network' });
    await expect(client.saved!.any.getLedgerBackup('g-goa')).rejects.toMatchObject({ code: 'network' });
  });

  it('keeps nothing when it was given nowhere to', async () => {
    server({ '/groups': [goa] });
    const client = new ApiClient('http://api.test');
    await client.getGroups();
    expect(client.saved).toBeNull();
    expect(client.savedAt).toBeNull();
  });

  it('doesn’t offer the saved copy as current after a change, only as better than nothing', async () => {
    server({ '/groups/g-goa/expenses': [{ id: 'e-1' }], '/groups/g-goa': goa });
    const client = new ApiClient('http://api.test', () => 't', new SavedReads(memoryStore()));
    await client.getExpenses('g-goa');
    await client.renameGroup('g-goa', 'Goa 2026');

    await expect(client.saved!.current.getExpenses('g-goa')).rejects.toMatchObject({ code: 'network' });
    expect(await client.saved!.any.getExpenses('g-goa')).toEqual([{ id: 'e-1' }]);

    await client.getExpenses('g-goa');
    expect(await client.saved!.current.getExpenses('g-goa')).toEqual([{ id: 'e-1' }]);
  });

  it('counts a gateway error as out of reach, and any answer from the server as in reach', async () => {
    let status = 503;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Bad gateway</html>', { status }))
    );
    const client = new ApiClient('http://api.test');
    await expect(client.getGroups()).rejects.toMatchObject({ code: 'network' });
    expect(client.reach.online).toBe(false);

    status = 404;
    await expect(client.getGroup('g-none')).rejects.toMatchObject({ code: 'not_found' });
    expect(client.reach.online).toBe(true);
  });

  it('keeps asking while out of reach and someone is listening, and says when it is back', async () => {
    vi.useFakeTimers();
    const api = server({ '/health': { ok: true, payments: 'real' }, '/groups': [goa] });
    const client = new ApiClient('http://api.test');
    const changes: boolean[] = [];
    const stop = client.reach.subscribe(() => changes.push(client.reach.online));

    api.down = true;
    await expect(client.getGroups()).rejects.toMatchObject({ code: 'network' });
    expect(changes).toEqual([false]);

    api.asked.length = 0;
    await vi.advanceTimersByTimeAsync(11_000);
    expect(api.asked).toEqual(['GET /health', 'GET /health']);
    expect(changes).toEqual([false]);

    api.down = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(changes).toEqual([false, true]);

    // Back in reach, it stops asking.
    api.asked.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.asked).toEqual([]);
    stop();
  });

  it('doesn’t keep asking when nobody is listening', async () => {
    vi.useFakeTimers();
    const api = server({});
    const client = new ApiClient('http://api.test');
    api.down = true;
    await expect(client.getGroups()).rejects.toMatchObject({ code: 'network' });

    api.asked.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.asked).toEqual([]);
  });

  it('gives up on a read the server never answers, but leaves a write to finish', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          })
      )
    );
    const client = new ApiClient('http://api.test');

    const read = client.getGroups();
    const readFailed = expect(read).rejects.toMatchObject({ code: 'network' });
    let written = false;
    client.createGroup({ name: 'Manali', currency: 'INR', memberNames: [] }).then(
      () => (written = true),
      () => (written = true)
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await readFailed;
    expect(client.reach.online).toBe(false);
    expect(written).toBe(false);
  });
});
