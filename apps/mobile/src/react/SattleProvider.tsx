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
  useSyncExternalStore,
  type DependencyList,
} from 'react';
import { AppState, Platform } from 'react-native';

import { ApiClient } from '../client/ApiClient';
import { MockClient } from '../client/MockClient';
import { SavedReads } from '../client/SavedReads';
import { savedStore } from '../client/savedStore';
import { ActionKeys, type SattleClient } from '../client/SattleClient';
import { SattleError, type PaymentMode, type Settlement } from '@sattle/core';
import { MockWallet, UnavailableWallet, type WalletProvider } from '../wallet/WalletProvider';

interface SattleContextValue {
  client: SattleClient;
  wallet: WalletProvider;
}

const SattleContext = createContext<SattleContextValue | null>(null);

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};

/** Demo mode: opt-in, so a build that forgets the variable still talks to the real API. */
export const isMock = () => process.env.EXPO_PUBLIC_USE_MOCK === 'true';

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

/**
 * What this device has saved of the signed-in account, to open on when the
 * server can't be reached. One copy, shared by every client built for it.
 */
export const savedReads = new SavedReads(savedStore);

/** `token` is the device account's; the mock ignores it. */
export function buildClient(token: string | null = null): SattleClient {
  // Only an account's reads are saved. A guest page has no account to come back as.
  if (!isMock()) return new ApiClient(API_URL, () => token, token ? savedReads : undefined);
  return new MockClient({
    latencyMs: num(process.env.EXPO_PUBLIC_MOCK_LATENCY, 400),
    failureRate: num(process.env.EXPO_PUBLIC_MOCK_FAILURE_RATE, 0),
    alwaysFailSettlement: process.env.EXPO_PUBLIC_MOCK_ALWAYS_FAIL === 'true',
  });
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
}: {
  children: React.ReactNode;
  /** Override for tests and storybooks. */
  client?: SattleClient;
  wallet?: WalletProvider;
}) {
  const value = useMemo<SattleContextValue>(
    () => ({ client: client ?? buildClient(), wallet: wallet ?? buildWallet() }),
    [client, wallet]
  );
  return <SattleContext.Provider value={value}>{children}</SattleContext.Provider>;
}

function useCtx() {
  const ctx = useContext(SattleContext);
  if (!ctx) throw new Error('Wrap your app in <SattleProvider>.');
  return ctx;
}

export const useClient = () => useCtx().client;
export const useWallet = () => useCtx().wallet;

/** What only the real client has: a copy of its reads on the device, and word of whether the server answers. */
const real = (client: SattleClient) => (client instanceof ApiClient ? client : null);

const unreachable = (e: unknown) => e instanceof SattleError && e.code === 'network';

const never = () => () => {};

/**
 * Whether the server is out of reach, which makes what's on screen the copy
 * this device saved, and when that copy is from. Also asks again the moment
 * something suggests the connection is back: the app returns to the front,
 * or the browser says it's online.
 */
export function useOffline(): { offline: boolean; savedAt: number | null } {
  const api = real(useClient());
  const reach = api?.reach;
  const isOffline = () => !(reach?.online ?? true);
  const offline = useSyncExternalStore(reach?.subscribe ?? never, isOffline, isOffline);

  useEffect(() => {
    if (!reach) return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') reach.check();
    });
    const onWeb = Platform.OS === 'web' && typeof window !== 'undefined';
    if (onWeb) window.addEventListener('online', reach.check);
    return () => {
      sub.remove();
      if (onWeb) window.removeEventListener('online', reach.check);
    };
  }, [reach]);

  return { offline, savedAt: offline ? (api?.savedAt ?? null) : null };
}

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
 * its own waits for that. If asking fails, what it said last time stands, and
 * the assumption if it never has.
 */
export function usePaymentModeAnswer(): { mode: PaymentMode; pending: boolean } {
  const client = useClient();
  const [answer, setAnswer] = useState<{ mode: PaymentMode; pending: boolean }>(() => ({
    mode: isMock() ? 'simulated' : 'real',
    pending: true,
  }));
  useEffect(() => {
    let live = true;
    client
      .getPaymentMode()
      .catch((e) => real(client)?.saved?.any.getPaymentMode() ?? Promise.reject(e))
      .then((mode) => live && setAnswer({ mode, pending: false }))
      .catch(() => live && setAnswer((a) => ({ ...a, pending: false })));
    return () => {
      live = false;
    };
  }, [client]);
  return answer;
}

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

/**
 * Runs `fn` on mount and whenever `deps` change. Ignores stale results.
 *
 * `fn` reads through the client it is handed, not one it holds, because it
 * runs twice: against what this device saved, so the screen opens at once,
 * then against the server, whose answer replaces that. If the server can't be
 * reached, what was saved stays up, and is brought up to date once it can.
 */
export function useAsync<T>(fn: (client: SattleClient) => Promise<T>, deps: DependencyList): AsyncState<T> {
  const client = useClient();
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const clientRef = useRef(client);
  clientRef.current = client;
  // The server's answer is on screen. A saved one that turns up late mustn't replace it.
  const answered = useRef(false);

  useEffect(() => {
    let live = true;
    answered.current = false;
    setLoading(true);
    setError(null);
    const saved = real(clientRef.current)?.saved;

    /** Puts up what the device has, if it has everything `fn` reads. */
    const show = async (from: SattleClient | undefined) => {
      if (!from) return false;
      try {
        const d = await fnRef.current(from);
        if (live && !answered.current) {
          setData(d);
          setLoading(false);
        }
        return true;
      } catch {
        return false;
      }
    };

    void show(saved?.current);
    fnRef
      .current(clientRef.current)
      .then((d) => {
        if (!live) return;
        answered.current = true;
        setData(d);
      })
      .catch(async (e) => {
        // Out of reach: what's saved is the best there is, even where a change made here has outdated it.
        if (unreachable(e) && (await show(saved?.any))) return;
        if (live && !answered.current) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

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
      .current(clientRef.current)
      .then((d) => {
        if (generation.current !== started) return;
        answered.current = true;
        setData(d);
        setError(null);
        setLoading(false);
      })
      .catch(() => {
        // Keep what's on screen; the next refresh tries again.
      });
  }, []);

  // The server is back in reach: catch up on whatever changed while it wasn't.
  const reach = real(client)?.reach;
  useEffect(() => reach?.subscribe(() => reach.online && refresh()), [reach, refresh]);

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
