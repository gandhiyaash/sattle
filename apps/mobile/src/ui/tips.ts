/**
 * The tips the app shows once on a device, the first time someone reaches
 * what they explain, and which of them this device has seen.
 *
 *   splitIntro   on Add expense, over the split card: Split differently is
 *                where someone is left out of a spend.
 *   splitTour    in Who paid, how to split: each thing in it, in turn.
 *
 * Seen means dealt with. Not now puts off the intro but leaves the tour for
 * the first time the sheet opens. Skip or Got it on the tour, or anything
 * else that ends it once it's up, marks every tip seen: someone who has been
 * through the sheet has no need of a pointer to it. Someone who closes the
 * app halfway through one gets it again, as with the tour at first launch.
 *
 * The device keeps them under one key (tipsStore), as an object with each
 * tip seen set to true, in name order, so a device that has seen them all
 * keeps the same text as any other. They're read once, as the app starts,
 * so a screen knows straight away whether to show its tip, and before the
 * keyboard comes up rather than after. A device that can't say shows them
 * all: seeing a tip twice costs less than never seeing it. One seen while it
 * can't be kept stays seen until the app closes.
 *
 * Nothing here imports React Native, so it runs under vitest; `tips` is the
 * app's instance.
 */

import { useSyncExternalStore } from 'react';

import { readTips, writeTips } from './tipsStore';

export type Tip = 'splitIntro' | 'splitTour';

/** Every tip the app has. A new one goes here, and in the browser tests' "seen" (packages/e2e-web/src/fixtures.ts). */
export const TIPS: readonly Tip[] = ['splitIntro', 'splitTour'];

/**
 * The names kept as seen, from what was stored. Anything unreadable is
 * nothing seen, so every tip shows. Names this version doesn't know are
 * kept, so a tip seen in a newer one isn't shown again after going back.
 */
export function parseTips(raw: string | null): string[] {
  if (!raw) return [];
  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return [];
  return Object.entries(saved)
    .filter(([, on]) => on === true)
    .map(([tip]) => tip);
}

/** `{"splitIntro":true,"splitTour":true}`: each one seen, in name order. */
export const serializeTips = (seen: Iterable<string>) =>
  JSON.stringify(Object.fromEntries([...new Set(seen)].sort().map((tip) => [tip, true])));

export interface TipStore {
  read: () => Promise<string | null>;
  write: (value: string) => Promise<void>;
}

/** The tips seen, read from `store` once, as this is made. */
export function createTips(store: TipStore) {
  let seen: ReadonlySet<string> | undefined;
  const listeners = new Set<() => void>();
  const apply = (next: ReadonlySet<string>) => {
    seen = next;
    listeners.forEach((l) => l());
  };
  // Whatever is marked seen before the device answers stays seen.
  const read = Promise.resolve()
    .then(() => store.read())
    .then(parseTips, (): string[] => [])
    .then((saved) => apply(new Set([...saved, ...(seen ?? [])])));

  return {
    /** Undefined until the device has said; then whether this tip has been seen on it. */
    seen: (tip: Tip): boolean | undefined => (seen === undefined ? undefined : seen.has(tip)),
    /** They've been seen: from now on, and from the next launch if the device can keep it. */
    markSeen(...marked: Tip[]) {
      if (seen && marked.every((tip) => seen!.has(tip))) return;
      apply(new Set([...(seen ?? []), ...marked]));
      // After the read, so what was saved before is written back with these rather than over.
      void read.then(() => store.write(serializeTips(seen!))).catch(() => {});
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Settles once the device has answered, either way. */
    read,
  };
}

export const tips = createTips({ read: readTips, write: writeTips });

/** Whether this device has seen the tip: undefined for the moment until it has said. */
export function useTipSeen(tip: Tip): boolean | undefined {
  return useSyncExternalStore(tips.subscribe, () => tips.seen(tip));
}

export const markTipSeen = (...marked: Tip[]) => tips.markSeen(...marked);
