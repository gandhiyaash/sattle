/**
 * Context, hooks, and the mock/real swap.
 *
 * EXPO_PUBLIC_USE_MOCK=true swaps in the in-memory mock, with its demo data
 * and fake wallet. Anything else talks to the real API. Nothing below this
 * provider knows or cares which one it got.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DependencyList,
} from 'react';
import { AppState, Platform } from 'react-native';

import { ApiClient } from '../client/ApiClient';
import { MockClient } from '../client/MockClient';
import { ActionKeys, type SattleClient } from '../client/SattleClient';
import { AppData, tokenFingerprint } from '../data/AppData';
import { savedStore } from '../data/savedStore';
import type { PaymentMode, Settlement } from '@sattle/core';
import { MockWallet, UnavailableWallet, type WalletProvider } from '../wallet/WalletProvider';

interface SattleContextValue {
  client: SattleClient;
  wallet: WalletProvider;
  /** What the app knows, for the screens to open on: see AppData. */
  data: AppData;
}

const SattleContext = createContext<SattleContextValue | null>(null);

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};

/** Demo mode: opt-in, so a build that forgets the variable still talks to the real API. */
export const isMock = () => process.env.EXPO_PUBLIC_USE_MOCK === 'true';

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

/** `token` is the device account's; the mock ignores it. */
export function buildClient(token: string | null = null): SattleClient {
  if (!isMock()) return new ApiClient(API_URL, () => token);
  return new MockClient({
    latencyMs: num(process.env.EXPO_PUBLIC_MOCK_LATENCY, 400),
    failureRate: num(process.env.EXPO_PUBLIC_MOCK_FAILURE_RATE, 0),
    alwaysFailSettlement: process.env.EXPO_PUBLIC_MOCK_ALWAYS_FAIL === 'true',
  });
}

/**
 * The account's AppData: its copy kept on the device under the token's
 * fingerprint, opened at once if there is one. Demo mode keeps nothing: the
 * mock starts afresh on every launch. `onSignedOut` runs when the server no
 * longer knows the token.
 */
export function buildAppData(client: SattleClient, token: string | null, onSignedOut?: () => void): AppData {
  const keep = !isMock() && token !== null;
  return new AppData(client, {
    saved: keep ? savedStore : null,
    owner: keep ? tokenFingerprint(token) : null,
    onSignedOut,
  });
}

/** Drops what the device kept of an account: it was deleted, or its token no longer works. */
export function forgetSavedData(): void {
  try {
    savedStore.clear();
  } catch {
    // Nothing kept, then.
  }
}

/**
 * There's no in-app wallet yet; people receive into their own wallet over
 * NWC. MockWallet's made-up balance only appears in demo mode, on native.
 * Replace UnavailableWallet with BreezWallet here when it exists.
 */
export function buildWallet(): WalletProvider {
  return isMock() && Platform.OS !== 'web' ? new MockWallet() : new UnavailableWallet();
}

export function SattleProvider({
  children,
  client,
  wallet,
  data,
}: {
  children: React.ReactNode;
  /** Override for tests and storybooks. */
  client?: SattleClient;
  wallet?: WalletProvider;
  /** The account's AppData (buildAppData). Without one, one that keeps nothing on the device. */
  data?: AppData;
}) {
  const value = useMemo<SattleContextValue>(() => {
    const c = client ?? buildClient();
    return { client: c, wallet: wallet ?? buildWallet(), data: data ?? new AppData(c) };
  }, [client, wallet, data]);
  // Kept current only while the app is in front, and checked at once on coming back.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => value.data.setActive(state === 'active'));
    // A browser tab can be closed or reloaded without going to the background first: keep the copy as it is.
    const leaving = () => value.data.saveNow();
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.addEventListener('pagehide', leaving);
    return () => {
      sub.remove();
      if (Platform.OS === 'web' && typeof window !== 'undefined') window.removeEventListener('pagehide', leaving);
    };
  }, [value.data]);
  // One made here goes with the provider; one handed in is its owner's to stop.
  useEffect(() => (data ? undefined : () => value.data.dispose()), [data, value.data]);
  return <SattleContext.Provider value={value}>{children}</SattleContext.Provider>;
}

function useCtx() {
  const ctx = useContext(SattleContext);
  if (!ctx) throw new Error('Wrap your app in <SattleProvider>.');
  return ctx;
}

export const useClient = () => useCtx().client;
export const useWallet = () => useCtx().wallet;
export const useAppDataContext = () => useCtx().data;

/**
 * Whether the server moves real money. Until it answers, assume it does: the
 * stricter rules only hide options for a moment, the looser ones would offer
 * payments that fail.
 */
export function usePaymentMode(): PaymentMode {
  return usePaymentModeAnswer().mode;
}

/**
 * The same, and whether the server has still to answer. Something that acts on
 * its own waits for that. If asking fails, the assumption stands.
 */
export function usePaymentModeAnswer(): { mode: PaymentMode; pending: boolean } {
  const client = useClient();
  // Once a client has answered, a screen opening later starts on the answer: asking again only to
  // be told the same would draw the whole screen a second time.
  const [answer, setAnswer] = useState<{ mode: PaymentMode; pending: boolean }>(() => {
    const known = answeredModes.get(client);
    return known ? { mode: known, pending: false } : { mode: isMock() ? 'simulated' : 'real', pending: true };
  });
  useEffect(() => {
    let live = true;
    client
      .getPaymentMode()
      .then((mode) => {
        answeredModes.set(client, mode);
        if (live) setAnswer((a) => (a.mode === mode && !a.pending ? a : { mode, pending: false }));
      })
      .catch(() => live && setAnswer((a) => (a.pending ? { ...a, pending: false } : a)));
    return () => {
      live = false;
    };
  }, [client]);
  return answer;
}

/** What each client's server said about its payments. It only changes when the server restarts. */
const answeredModes = new WeakMap<SattleClient, PaymentMode>();

/** Idempotency keys for the user actions on one screen. See ActionKeys. */
export function useActionKeys() {
  return useState(() => new ActionKeys())[0];
}

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | null;
  reload: () => void;
  /**
   * Fetches again in the background: no loading state, and a failure keeps
   * the data already on screen. For keeping a screen current.
   */
  refresh: () => void;
}

export interface AsyncOptions {
  /**
   * Keeps the answer under this name (AppData.remember), and opens on it next
   * time: no loading state, and the read goes on behind it, as the main screens
   * do with the view. A failure then keeps what's shown. Name it by what was
   * read, e.g. `history:<groupId>`.
   */
  key?: string;
  /** Keeps it on the device too, across launches. Never for anything that works as a key. */
  save?: boolean;
}

/** Runs `fn` on mount and whenever `deps` change. Ignores stale results. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList, opts: AsyncOptions = {}): AsyncState<T> {
  const appData = useContext(SattleContext)?.data;
  const { key, save = false } = opts;
  const [data, setData] = useState<T | undefined>(() => (key ? appData?.recall<T>(key)?.value : undefined));
  const [loading, setLoading] = useState(data === undefined);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let live = true;
    const kept = key ? appData?.recall<T>(key) : undefined;
    if (kept) setData(kept.value);
    setLoading(!kept);
    setError(null);
    fnRef
      .current()
      .then((d) => {
        if (key) appData?.remember(key, d, save);
        if (live) setData(d);
      })
      .catch((e) => {
        // What was kept stays on screen; only a read with nothing to show fails the screen.
        if (live && !kept) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, key, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // Results from a refresh started before the deps changed are dropped.
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
  }, [...deps, nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      generation.current = -1;
    },
    []
  );
  const refresh = useCallback(() => {
    const started = generation.current;
    fnRef
      .current()
      .then((d) => {
        if (generation.current !== started) return;
        if (key) appData?.remember(key, d, save);
        setData(d);
      })
      .catch(() => {
        // Keep what's on screen; the next refresh tries again.
      });
  }, [key, save, appData]);

  return { data, loading, error, reload, refresh };
}

/** Live view of one settlement: created → awaiting_payment → in_flight → confirmed. */
export function useSettlement(settlementId: string | null) {
  const client = useClient();
  const [settlement, setSettlement] = useState<Settlement | null>(null);

  useEffect(() => {
    if (!settlementId) return;
    let live = true;
    client.getSettlement(settlementId).then((s) => live && setSettlement(s)).catch(() => {});
    const unsub = client.onSettlementUpdate(settlementId, (s) => live && setSettlement(s));
    return () => {
      live = false;
      unsub();
    };
  }, [client, settlementId]);

  return settlement;
}
