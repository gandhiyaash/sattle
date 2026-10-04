import React, { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import { SattleError } from '@sattle/core';

import { clearToken, readToken } from './src/account/tokenStore';
import type { SattleClient } from './src/client/SattleClient';
import { SattleProvider, buildClient, isMock } from './src/react/SattleProvider';
import { watchForUpdates } from './src/react/useAppUpdate';
import { DemoApp } from './src/ui/DemoApp';
import { GroupGuestScreen } from './src/ui/GroupGuestScreen';
import { GuestPayScreen } from './src/ui/GuestPayScreen';
import { JoinAsNewScreen } from './src/ui/JoinScreen';
import { Loading, Screen } from './src/ui/primitives';
import { useColorMode } from './src/ui/theme';
import { WelcomeScreen } from './src/ui/WelcomeScreen';

/** The path payLinkPath() builds: /s/<token>. */
const GUEST_PATH = /^\/s\/([^/]+)\/?$/;
/** The path groupLinkPath() builds: /g/<token>. */
const GROUP_PATH = /^\/g\/([^/]+)\/?$/;
/** The path invitePath() builds: /join/<token>. */
const JOIN_PATH = /^\/join\/([^/]+)\/?$/;

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
/** An invite: the app opens on the join screen, which makes an account if there isn't one. */
const inviteToken = () => tokenFromPath(JOIN_PATH);

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
  const [invite, setInvite] = useState(inviteToken);
  // Off the address bar too, so a reload opens the app instead of a used link.
  const inviteDone = () => {
    setInvite(null);
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.history.replaceState(null, '', '/');
  };
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
  if (isMock()) return <DemoApp invite={invite} onInviteDone={inviteDone} />;
  return <AccountGate invite={invite} onInviteDone={inviteDone} />;
}

type Account = { kind: 'loading' } | { kind: 'none' } | { kind: 'ready'; client: SattleClient };

/**
 * The app proper needs a device account. A stored token the server no longer
 * knows (the database was reset, say) is dropped, and the person starts
 * again. Any other failure, like being offline, keeps the token: the screens
 * show their own errors and retry.
 */
function AccountGate({ invite, onInviteDone }: { invite: string | null; onInviteDone: () => void }) {
  const [account, setAccount] = useState<Account>({ kind: 'loading' });
  // The group someone joined on the way in, with no account before that. The app opens on it.
  const [joined, setJoined] = useState<string | null>(null);

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
      if (invite) {
        // Reading an invite needs no account. Picking who they are makes one, under that name.
        return (
          <SattleProvider>
            <JoinAsNewScreen
              token={invite}
              onJoined={(token, groupId) => {
                setJoined(groupId);
                onInviteDone();
                setAccount({ kind: 'ready', client: buildClient(token) });
              }}
              onSkip={onInviteDone}
            />
          </SattleProvider>
        );
      }
      return <WelcomeScreen onReady={(token) => setAccount({ kind: 'ready', client: buildClient(token) })} />;
    case 'ready':
      return (
        <DemoApp
          client={account.client}
          invite={invite}
          group={joined}
          onInviteDone={onInviteDone}
          // The server no longer knows the token, so the device shouldn't keep it.
          onAccountDeleted={async () => {
            await clearToken();
            setAccount({ kind: 'none' });
          }}
        />
      );
  }
}
