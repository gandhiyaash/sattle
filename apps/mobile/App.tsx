import React, { useEffect, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import { SattleError, parseGroupLinkToken } from '@sattle/core';

import { clearToken, readToken } from './src/account/tokenStore';
import type { SattleClient } from './src/client/SattleClient';
import { SattleProvider, buildClient, isMock } from './src/react/SattleProvider';
import { watchForUpdates } from './src/react/useAppUpdate';
import { DemoApp } from './src/ui/DemoApp';
import { GroupGuestScreen } from './src/ui/GroupGuestScreen';
import { GuestPayScreen } from './src/ui/GuestPayScreen';
import { JoinAsNewScreen } from './src/ui/JoinScreen';
import { Loading, Screen } from './src/ui/primitives';
import { RestoreScreen } from './src/ui/RestoreScreen';
import { useColorMode } from './src/ui/theme';
import { WelcomeScreen } from './src/ui/WelcomeScreen';

/** The path payLinkPath() builds: /s/<token>. */
const GUEST_PATH = /^\/s\/([^/]+)\/?$/;
/** The path groupLinkPath() builds: /g/<token>. */
const GROUP_PATH = /^\/g\/([^/]+)\/?$/;
/** The path joinPath() builds: /join/<token>. */
const JOIN_PATH = /^\/join\/([^/]+)\/?$/;
/** Reading a group back from its backup key. The key is pasted on the page, never put in the address. */
const RESTORE_PATH = /^\/restore\/?$/;

/** The token when this page was opened from a link of that shape. Web only: native has no path. */
function tokenFromPath(path: RegExp): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const m = path.exec(window.location.pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** A pay link: that's where a guest with no app lands. Everything else gets the app. */
const guestToken = () => tokenFromPath(GUEST_PATH);
/** A group link: the whole group, to read and to pay from, for someone with no app. */
const groupToken = () => tokenFromPath(GROUP_PATH);
/** Joining with a group's link, on the web: the app opens on the join screen, which makes an account if there isn't one. */
const joinToken = () => tokenFromPath(JOIN_PATH);
/** Web only, like the others: /restore, for someone with a backup key and maybe no account or server. */
const isRestorePath = () =>
  Platform.OS === 'web' && typeof window !== 'undefined' && RESTORE_PATH.test(window.location.pathname);

export default function App() {
  const mode = useColorMode();
  return (
    // Where the status bar, the notch and the home indicator are, so the screens can keep clear of them.
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      {/* Dark icons on the light theme, light ones on the dark. */}
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const [token] = useState(guestToken);
  const [group] = useState(groupToken);
  const [restoring] = useState(isRestorePath);
  const [joining, setJoining] = useState(joinToken);
  // Off the address bar too, so a reload opens the app instead of a used link.
  const joinDone = () => {
    setJoining(null);
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.history.replaceState(null, '', '/');
  };
  // Native: the /join/ link that opened the app, or one tapped while it was already open.
  // The phone only hands the app the links app.json claims, and only once the site vouches
  // for the app in public/.well-known.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const open = (url: string | null) => {
      const found = url ? parseGroupLinkToken(url) : null;
      if (found) setJoining(found);
    };
    Linking.getInitialURL()
      .then(open)
      .catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => open(url));
    return () => sub.remove();
  }, []);
  // Android only: Play downloads a new version in the background. See updates/updater.ts.
  useEffect(watchForUpdates, []);
  if (token) {
    // Nothing but the one payment: no navigator, no demo bar, no app state.
    return (
      <SattleProvider>
        <GuestPayScreen token={token} />
      </SattleProvider>
    );
  }
  if (group) {
    // The same: one group, read-only, and nothing of the app around it.
    return (
      <SattleProvider>
        <GroupGuestScreen token={group} />
      </SattleProvider>
    );
  }
  if (restoring) {
    // Relays only: no client, no account. Back is for the app at /.
    return <RestoreScreen onBack={() => window.location.assign('/')} />;
  }
  if (isMock()) return <DemoApp joining={joining} onJoinDone={joinDone} />;
  return <AccountGate joining={joining} onJoinDone={joinDone} />;
}

type Account = { kind: 'loading' } | { kind: 'none' } | { kind: 'restoring' } | { kind: 'ready'; client: SattleClient };

/**
 * The app proper needs a device account. A stored token the server no longer
 * knows (the database was reset, say) is dropped, and the person starts
 * again. Any other failure, like being offline, keeps the token: the screens
 * show their own errors and retry.
 */
function AccountGate({ joining, onJoinDone }: { joining: string | null; onJoinDone: () => void }) {
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
        <Screen title="Sattle" brand>
          <Loading lines={2} />
        </Screen>
      );
    case 'none':
      if (joining) {
        // Seeing who the link offers needs no account. Picking who they are makes one, under that name, and asks to join.
        return (
          <SattleProvider>
            <JoinAsNewScreen
              token={joining}
              // They've asked to join. The app opens on their groups, where the request waits.
              onJoined={(token) => {
                onJoinDone();
                setAccount({ kind: 'ready', client: buildClient(token) });
              }}
              onSkip={onJoinDone}
            />
          </SattleProvider>
        );
      }
      return (
        <WelcomeScreen
          onReady={(token) => setAccount({ kind: 'ready', client: buildClient(token) })}
          onRestore={() => setAccount({ kind: 'restoring' })}
        />
      );
    case 'restoring':
      return <RestoreScreen onBack={() => setAccount({ kind: 'none' })} />;
    case 'ready':
      return (
        <DemoApp
          client={account.client}
          joining={joining}
          onJoinDone={onJoinDone}
          // The server no longer knows the token, so the device shouldn't keep it.
          onAccountDeleted={async () => {
            await clearToken();
            setAccount({ kind: 'none' });
          }}
        />
      );
  }
}
