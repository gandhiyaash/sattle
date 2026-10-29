import React, { useEffect, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import { SattleError, parseSharedLink } from '@sattle/core';

import { clearToken, readToken } from './src/account/tokenStore';
import { startReporting } from './src/analytics/analytics';
import type { SattleClient } from './src/client/SattleClient';
import { useCurrenciesRead } from './src/prefs/useCurrencyPrefs';
import { SattleProvider, buildClient, isMock } from './src/react/SattleProvider';
import { watchForUpdates } from './src/react/useAppUpdate';
import { DemoApp } from './src/ui/DemoApp';
import { GroupGuestScreen } from './src/ui/GroupGuestScreen';
import { GuestPayScreen } from './src/ui/GuestPayScreen';
import { JoinAsNewScreen } from './src/ui/JoinScreen';
import { OnboardingScreen } from './src/ui/OnboardingScreen';
import { Loading, Screen } from './src/ui/primitives';
import { RestoreScreen } from './src/ui/RestoreScreen';
import { layout, useColorMode, useColors } from './src/ui/theme';
import { readToured, writeToured } from './src/ui/tourStore';
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
  const color = useColors();
  return (
    // Where the status bar, the notch and the home indicator are, so the screens can keep clear of them.
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      {/* Dark icons on the light theme, light ones on the dark. */}
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      {/* A phone's column in the middle of anything wider (layout.maxWidth). */}
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <View style={{ flex: 1, width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center' }}>
          <Root />
        </View>
      </View>
    </SafeAreaProvider>
  );
}

function Root() {
  const [token] = useState(guestToken);
  const [group] = useState(groupToken);
  const [restoring] = useState(isRestorePath);
  const [joining, setJoining] = useState(joinToken);
  // Native only: the group's shared link, /g/<token>, was tapped on a phone with the app. On the
  // web that link is `group` above, and gets the page with nothing of the app around it.
  const [shared, setShared] = useState<string | null>(null);
  const currenciesRead = useCurrenciesRead();
  // Whether this device has been shown the tour. Undefined until it has said.
  const [toured, setToured] = useState<boolean>();
  useEffect(() => {
    // If the device can't say, show it: seeing the tour twice costs less than never seeing it.
    readToured().then(setToured, () => setToured(false));
  }, []);
  const endTour = () => {
    setToured(true);
    // If that can't be kept, the tour comes round once more.
    void writeToured().catch(() => {});
  };
  // Off the address bar too, so a reload opens the app instead of a used link.
  const joinDone = () => {
    setJoining(null);
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.history.replaceState(null, '', '/');
  };
  // Native: the link that opened the app, or one tapped while it was already open. Either the
  // group's shared link, /g/, which is what Invite sends and where people see what they owe and
  // pay, or /join/, which is where Join on that page leads. The phone only hands the app the
  // links app.json claims, and only once the site vouches for the app in public/.well-known.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const open = (url: string | null) => {
      const link = url ? parseSharedLink(url) : null;
      if (!link) return;
      if (link.page === 'join') {
        setShared(null);
        setJoining(link.token);
      } else {
        setJoining(null);
        setShared(link.token);
      }
    };
    Linking.getInitialURL()
      .then(open)
      .catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => open(url));
    return () => sub.remove();
  }, []);
  // Android only: Play downloads a new version in the background. See updates/updater.ts.
  useEffect(watchForUpdates, []);
  // What happens in the app, reported to the server for the record. See analytics/analytics.ts.
  useEffect(startReporting, []);
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
    // Relays only: no client, no account, and no tour first. Back is for the app at /.
    return <RestoreScreen onBack={() => window.location.assign('/')} />;
  }
  if (toured === undefined || !currenciesRead) return <Starting />;
  // First launch: how it works, in three screens. A /join/ link that brought them
  // here is kept, and is where they go once it's over.
  if (!toured) return <OnboardingScreen onDone={endTour} />;
  const sharedDone = () => setShared(null);
  if (isMock()) return <DemoApp joining={joining} onJoinDone={joinDone} shared={shared} onSharedDone={sharedDone} />;
  return (
    <AccountGate
      joining={joining}
      onJoinDone={joinDone}
      shared={shared}
      onSharedDone={sharedDone}
      // Join on the group's page, for someone with no account yet: on to saying who they are.
      onJoinShared={(token) => {
        setShared(null);
        setJoining(token);
      }}
    />
  );
}

function Starting() {
  return (
    <Screen title="Sattle" brand>
      <Loading lines={2} />
    </Screen>
  );
}

type Account = { kind: 'loading' } | { kind: 'none' } | { kind: 'restoring' } | { kind: 'ready'; client: SattleClient };

/**
 * The app proper needs a device account. A stored token the server no longer
 * knows (the database was reset, say) is dropped, and the person starts
 * again. Any other failure, like being offline, keeps the token: the screens
 * show their own errors and retry.
 */
function AccountGate({
  joining,
  onJoinDone,
  shared,
  onSharedDone,
  onJoinShared,
}: {
  joining: string | null;
  onJoinDone: () => void;
  /** The group's shared link, opened in the app. */
  shared: string | null;
  onSharedDone: () => void;
  onJoinShared: (token: string) => void;
}) {
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
      return <Starting />;
    case 'none':
      if (joining) {
        // Seeing who the link offers needs no account. Picking who they are makes one, under that name, and joins, or asks to.
        return (
          <SattleProvider>
            <JoinAsNewScreen
              token={joining}
              // They're in, or they've asked. The app opens on their groups, where the group, or the request, is.
              onJoined={(token) => {
                onJoinDone();
                setAccount({ kind: 'ready', client: buildClient(token) });
              }}
              onSkip={onJoinDone}
            />
          </SattleProvider>
        );
      }
      if (shared) {
        // The group's page needs no account, in the app as in a browser: see what's been split,
        // pay what you owe. Join on it is where an account gets made.
        return (
          <SattleProvider>
            <GroupGuestScreen token={shared} onBack={onSharedDone} onJoin={() => onJoinShared(shared)} />
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
          shared={shared}
          onSharedDone={onSharedDone}
          // The server no longer knows the token, so the device shouldn't keep it.
          onAccountDeleted={async () => {
            await clearToken();
            setAccount({ kind: 'none' });
          }}
          // Already saved by the account screen. The old token no longer signs in.
          onKeyReplaced={(token) => setAccount({ kind: 'ready', client: buildClient(token) })}
        />
      );
  }
}
