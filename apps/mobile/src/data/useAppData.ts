/**
 * The screens' way into AppData. Each hook reads one thing and redraws only
 * when that thing changes (useSyncExternalStore).
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import type { GroupSnapshot, SyncView } from '@sattle/core';
import { useAppDataContext } from '../react/SattleProvider';
import type { AppData, Notice, SyncStatus } from './AppData';
import type { Change } from './changes';
import { snapshotOf } from './views';

/** How often a screen that shows balances checks for someone else's changes, as the screens did before. */
export const KEEP_CURRENT_MS = 4000;

export function useAppData(): AppData {
  return useAppDataContext();
}

/** The server's last answer with this device's changes over it; null until the first one. */
export function useView(): SyncView | null {
  const data = useAppData();
  return useSyncExternalStore(data.subscribe, data.getView);
}

export function useChanges(): readonly Change[] {
  const data = useAppData();
  return useSyncExternalStore(data.subscribe, data.getChanges);
}

export function useSyncStatus(): SyncStatus {
  const data = useAppData();
  return useSyncExternalStore(data.subscribe, data.getStatus);
}

export function useNotices(): readonly Notice[] {
  const data = useAppData();
  return useSyncExternalStore(data.subscribe, data.getNotices);
}

/** One part of the view, e.g. `(v) => v?.user`. Redraws only when that part is another object. */
export function useViewPart<T>(select: (view: SyncView | null) => T): T {
  const data = useAppData();
  const pick = useRef(select);
  pick.current = select;
  const get = useCallback(() => pick.current(data.getView()), [data]);
  return useSyncExternalStore(data.subscribe, get);
}

/** One group as the screens show it, or undefined while it isn't known. Redraws only when it changes. */
export function useGroupSnapshot(groupId: string): GroupSnapshot | undefined {
  const data = useAppData();
  const get = useCallback(() => snapshotOf(data.getView(), groupId), [data, groupId]);
  return useSyncExternalStore(data.subscribe, get);
}

/** This device's changes still to be confirmed in one group. The same array until one of them changes. */
export function useGroupChanges(groupId: string): readonly Change[] {
  const data = useAppData();
  const last = useRef<readonly Change[]>([]);
  const get = useCallback(() => {
    const now = data.getChanges().filter((c) => c.groupId === groupId);
    const was = last.current;
    if (now.length === was.length && now.every((c, i) => c === was[i])) return was;
    last.current = now;
    return now;
  }, [data, groupId]);
  return useSyncExternalStore(data.subscribe, get);
}

/**
 * While the screen is up, the server is checked every `ms` (in front only),
 * for one group or everything, and once at once if what's known of it is
 * older than a couple of seconds: opening a screen shows what's saved and
 * catches up behind it.
 */
export function useKeepCurrent(ms = KEEP_CURRENT_MS, groupId?: string) {
  const data = useAppData();
  useEffect(() => {
    if (!data.isFresh(2000, groupId)) void data.sync(groupId ? [groupId] : undefined);
    return data.keepCurrent(ms, groupId);
  }, [data, ms, groupId]);
}

type FirstLoad = { waiting: boolean; error: SyncStatus['error'] };

/**
 * For a screen built from the view: whether it's still waiting for the first
 * answer, or that failed with nothing saved to show instead. Once there is
 * something to show, the syncs behind it don't redraw the screen.
 */
export function useFirstLoad(): FirstLoad & { retry: () => void } {
  const data = useAppData();
  const last = useRef<FirstLoad>({ waiting: true, error: null });
  const get = useCallback(() => {
    const view = data.getView();
    const status = data.getStatus();
    const now: FirstLoad = { waiting: view === null && !status.error, error: view === null ? status.error : null };
    const was = last.current;
    if (now.waiting === was.waiting && now.error === was.error) return was;
    last.current = now;
    return now;
  }, [data]);
  const first = useSyncExternalStore(data.subscribe, get);
  const idle = useSyncExternalStore(
    data.subscribe,
    useCallback(() => data.getView() === null && !data.getStatus().syncing && !data.getStatus().error, [data])
  );
  useEffect(() => {
    // Nothing to show and nothing on its way: ask.
    if (idle) void data.sync();
  }, [data, idle]);
  const retry = useCallback(() => void data.sync(), [data]);
  return { ...first, retry };
}
