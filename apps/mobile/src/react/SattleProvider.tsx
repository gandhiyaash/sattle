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
import { Platform } from 'react-native';

import { ApiClient } from '../client/ApiClient';
import { MockClient } from '../client/MockClient';
import { ActionKeys, type SattleClient } from '../client/SattleClient';
import type { PaymentMode, Settlement } from '@sattle/core';
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

/**
 * Whether the server moves real money. Until it answers, assume it does: the
 * stricter rules only hide options for a moment, the looser ones would offer
 * payments that fail.
 */
export function usePaymentMode(): PaymentMode {
  const client = useClient();
  const [mode, setMode] = useState<PaymentMode>(() => (isMock() ? 'simulated' : 'real'));
  useEffect(() => {
    let live = true;
    client
      .getPaymentMode()
      .then((m) => live && setMode(m))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client]);
  return mode;
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
        if (generation.current === started) setData(d);
      })
      .catch(() => {
        // Keep what's on screen; the next refresh tries again.
      });
  }, []);

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
