import React, { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { SattleError } from '@sattle/core';

import { clearToken, readToken } from './src/account/tokenStore';
import type { SattleClient } from './src/client/SattleClient';
import { SattleProvider, buildClient, isMock } from './src/react/SattleProvider';
import { DemoApp } from './src/ui/DemoApp';
import { GuestPayScreen } from './src/ui/GuestPayScreen';
import { Loading, Screen } from './src/ui/primitives';
import { WelcomeScreen } from './src/ui/WelcomeScreen';

/** The path payLinkPath() builds: /s/<token>. */
const GUEST_PATH = /^\/s\/([^/]+)\/?$/;

/**
 * The token when this page was opened from a pay link. Web only: that's
 * where a guest with no app lands. Everything else gets the app.
 */
function guestToken(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const m = GUEST_PATH.exec(window.location.pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export default function App() {
  const [token] = useState(guestToken);
  if (token) {
    // Nothing but the one payment: no navigator, no demo bar, no app state.
    return (
      <SattleProvider>
        <GuestPayScreen token={token} />
      </SattleProvider>
    );
  }
  if (isMock()) return <DemoApp />;
  return <AccountGate />;
}

type Account = { kind: 'loading' } | { kind: 'none' } | { kind: 'ready'; client: SattleClient };

/**
 * The app proper needs a device account. A stored token the server no longer
 * knows (the database was reset, say) is dropped, and the person starts
 * again. Any other failure, like being offline, keeps the token: the screens
 * show their own errors and retry.
 */
function AccountGate() {
  const [account, setAccount] = useState<Account>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    (async () => {
      const token = await readToken();
      if (!token) return live && setAccount({ kind: 'none' });
      const client = buildClient(token);
      try {
        await client.getCurrentUser();
      } catch (e) {
        if (e instanceof SattleError && e.code === 'unauthorized') {
          await clearToken();
          return live && setAccount({ kind: 'none' });
        }
      }
      if (live) setAccount({ kind: 'ready', client });
    })();
    return () => {
      live = false;
    };
  }, []);

  switch (account.kind) {
    case 'loading':
      return (
        <Screen title="Sattle">
          <Loading lines={2} />
        </Screen>
      );
    case 'none':
      return <WelcomeScreen onReady={(token) => setAccount({ kind: 'ready', client: buildClient(token) })} />;
    case 'ready':
      return <DemoApp client={account.client} />;
  }
}
