/**
 * Context, hooks, and the mock/real swap.
 *
 * EXPO_PUBLIC_USE_MOCK decides which client the whole app talks to. Nothing
 * below this provider knows or cares which one it got.
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
import { Platform } from 'react-native';

import { ApiClient } from '../client/ApiClient';
import { MockClient } from '../client/MockClient';
import type { SplitSatsClient } from '../client/SplitSatsClient';
import type { Settlement } from '../domain/types';
import { MockWallet, UnavailableWallet, type WalletProvider } from '../wallet/WalletProvider';

interface SplitSatsContextValue {
  client: SplitSatsClient;
  wallet: WalletProvider;
}

const SplitSatsContext = createContext<SplitSatsContextValue | null>(null);

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};

export function buildClient(): SplitSatsClient {
  if (process.env.EXPO_PUBLIC_USE_MOCK === 'false') {
    return new ApiClient(process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000');
  }
  return new MockClient({
    latencyMs: num(process.env.EXPO_PUBLIC_MOCK_LATENCY, 400),
    failureRate: num(process.env.EXPO_PUBLIC_MOCK_FAILURE_RATE, 0),
  });
}

/** Replace MockWallet with BreezWallet here when it exists. */
export function buildWallet(): WalletProvider {
  return Platform.OS === 'web' ? new UnavailableWallet() : new MockWallet();
}

export function SplitSatsProvider({
  children,
  client,
  wallet,
}: {
  children: React.ReactNode;
  /** Override for tests and storybooks. */
  client?: SplitSatsClient;
  wallet?: WalletProvider;
}) {
  const value = useMemo<SplitSatsContextValue>(
    () => ({ client: client ?? buildClient(), wallet: wallet ?? buildWallet() }),
    [client, wallet]
  );
  return <SplitSatsContext.Provider value={value}>{children}</SplitSatsContext.Provider>;
}

function useCtx() {
  const ctx = useContext(SplitSatsContext);
  if (!ctx) throw new Error('Wrap your app in <SplitSatsProvider>.');
  return ctx;
}

export const useClient = () => useCtx().client;
export const useWallet = () => useCtx().wallet;

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

/** Runs `fn` on mount and whenever `deps` change. Ignores stale results. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fnRef
      .current()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
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
