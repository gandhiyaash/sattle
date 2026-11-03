import { afterEach, describe, expect, it, vi } from 'vitest';

import { TIPS, createTips, parseTips, serializeTips, type TipStore } from './tips';
import { readTips, writeTips } from './tipsStore';

/** Every tip seen, as the device keeps it, and as the browser tests start each device with it. */
const ALL_SEEN = '{"splitIntro":true,"splitTour":true}';

/** A device's storage, scripted: what it holds, or what it throws, and what's written to it. */
function fakeStore(held: string | null | Error, { writeFails = false } = {}) {
  const writes: string[] = [];
  const store: TipStore = {
    read: async () => {
      if (held instanceof Error) throw held;
      return held;
    },
    write: async (value) => {
      if (writeFails) throw new Error('storage full');
      writes.push(value);
    },
  };
  return { store, writes };
}

describe('parseTips and serializeTips', () => {
  it('reads back what was kept', () => {
    expect(parseTips(serializeTips(['splitTour']))).toEqual(['splitTour']);
    expect(parseTips(serializeTips(TIPS)).sort()).toEqual([...TIPS].sort());
  });

  it('keeps every tip the same way on every device: each set to true, in name order', () => {
    expect(serializeTips(['splitTour', 'splitIntro', 'splitTour'])).toBe(ALL_SEEN);
    expect(serializeTips(TIPS)).toBe(ALL_SEEN);
  });

  it('is nothing seen when what was kept can’t be read, so every tip shows', () => {
    for (const raw of [null, '', 'not json', '"splitIntro"', '["splitIntro"]', 'null', '42']) {
      expect(parseTips(raw), String(raw)).toEqual([]);
    }
    expect(parseTips('{"splitIntro":false,"splitTour":"yes"}')).toEqual([]);
  });

  it('keeps a name it doesn’t know, so a tip seen in a newer version stays seen', () => {
    expect(parseTips('{"splitIntro":true,"somethingNew":true}')).toEqual(['splitIntro', 'somethingNew']);
  });
});

describe('createTips', () => {
  it('doesn’t know until the device has answered', async () => {
    const { store } = fakeStore(ALL_SEEN);
    const tips = createTips(store);
    expect(tips.seen('splitIntro')).toBeUndefined();
    await tips.read;
    expect(tips.seen('splitIntro')).toBe(true);
    expect(tips.seen('splitTour')).toBe(true);
  });

  it('shows every tip when the device can’t say', async () => {
    const { store } = fakeStore(new Error('keychain locked'));
    const tips = createTips(store);
    await tips.read;
    expect(tips.seen('splitIntro')).toBe(false);
    expect(tips.seen('splitTour')).toBe(false);
  });

  it('shows every tip on a device that has none kept, or something it can’t read', async () => {
    for (const held of [null, '{oops']) {
      const tips = createTips(fakeStore(held).store);
      await tips.read;
      expect(tips.seen('splitIntro')).toBe(false);
    }
  });

  it('remembers a tip as seen at once, and writes every one seen so far', async () => {
    const { store, writes } = fakeStore('{"splitIntro":true}');
    const tips = createTips(store);
    await tips.read;
    tips.markSeen('splitTour');
    expect(tips.seen('splitTour')).toBe(true);
    await vi.waitFor(() => expect(writes).toEqual([ALL_SEEN]));
  });

  it('marks several at once, as ending the tour does', async () => {
    const { store, writes } = fakeStore(null);
    const tips = createTips(store);
    await tips.read;
    tips.markSeen('splitIntro', 'splitTour');
    await vi.waitFor(() => expect(writes).toEqual([ALL_SEEN]));
  });

  it('keeps what the device had when a tip is marked seen before it answered', async () => {
    let answer: (v: string | null) => void = () => {};
    const writes: string[] = [];
    const tips = createTips({
      read: () => new Promise((resolve) => (answer = resolve)),
      write: async (v) => {
        writes.push(v);
      },
    });
    tips.markSeen('splitTour');
    expect(tips.seen('splitTour')).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    // Nothing written over what the device holds before it has said what that is.
    expect(writes).toEqual([]);
    answer('{"splitIntro":true}');
    await tips.read;
    expect(tips.seen('splitIntro')).toBe(true);
    expect(tips.seen('splitTour')).toBe(true);
    await vi.waitFor(() => expect(writes).toEqual([ALL_SEEN]));
  });

  it('carries on when the device can’t keep it: seen until the app closes', async () => {
    const { store } = fakeStore(null, { writeFails: true });
    const tips = createTips(store);
    await tips.read;
    tips.markSeen('splitIntro');
    expect(tips.seen('splitIntro')).toBe(true);
    // A failed write isn't an unhandled rejection: vitest fails the run on one.
    await new Promise((r) => setTimeout(r, 0));
  });

  it('writes nothing, and tells nobody, for a tip already seen', async () => {
    const { store, writes } = fakeStore(ALL_SEEN);
    const tips = createTips(store);
    await tips.read;
    const heard = vi.fn();
    tips.subscribe(heard);
    tips.markSeen('splitIntro', 'splitTour');
    await new Promise((r) => setTimeout(r, 0));
    expect(writes).toEqual([]);
    expect(heard).not.toHaveBeenCalled();
  });

  it('tells whoever is listening when the device answers and when a tip is seen', async () => {
    const { store } = fakeStore(null);
    const tips = createTips(store);
    const heard = vi.fn();
    const stop = tips.subscribe(heard);
    await tips.read;
    expect(heard).toHaveBeenCalledTimes(1);
    tips.markSeen('splitIntro');
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    tips.markSeen('splitTour');
    expect(heard).toHaveBeenCalledTimes(2);
  });
});

describe('the web store', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** localStorage, as a browser has it, or as one that blocks storage does. */
  function storage({ blocked = false } = {}) {
    const held = new Map<string, string>();
    return {
      held,
      getItem: (k: string) => {
        if (blocked) throw new DOMException('blocked', 'SecurityError');
        return held.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (blocked) throw new DOMException('blocked', 'SecurityError');
        held.set(k, v);
      },
    };
  }

  it('keeps it in localStorage under sattle.tips', async () => {
    const local = storage();
    vi.stubGlobal('localStorage', local);
    expect(await readTips()).toBeNull();
    await writeTips(ALL_SEEN);
    expect(local.held.get('sattle.tips')).toBe(ALL_SEEN);
    expect(await readTips()).toBe(ALL_SEEN);
  });

  it('reads nothing, and writes without a fuss, in a browser that blocks storage', async () => {
    vi.stubGlobal('localStorage', storage({ blocked: true }));
    await expect(readTips()).resolves.toBeNull();
    await expect(writeTips(ALL_SEEN)).resolves.toBeUndefined();
  });

  it('reads nothing where there’s no localStorage at all', async () => {
    vi.stubGlobal('localStorage', undefined);
    await expect(readTips()).resolves.toBeNull();
    await expect(writeTips(ALL_SEEN)).resolves.toBeUndefined();
  });
});
