import React, { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { SattleError } from '@sattle/core';

import { clearToken, readToken } from './src/account/tokenStore';
import type { SattleClient } from './src/client/SattleClient';
import { SattleProvider, buildClient, isMock } from './src/react/SattleProvider';
import { watchForUpdates } from './src/react/useAppUpdate';
import { DemoApp } from './src/ui/DemoApp';
import { GroupGuestScreen } from './src/ui/GroupGuestScreen';
import { GuestPayScreen } from './src/ui/GuestPayScreen';
import { InviteSummary } from './src/ui/JoinScreen';
import { Loading, Screen } from './src/ui/primitives';
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
/** An invite: the app opens on the join screen, after making an account if there isn't one. */
const inviteToken = () => tokenFromPath(JOIN_PATH);

export default function App() {
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
      return (
        <WelcomeScreen
          // Reading an invite needs no account, so it can say who's asking before the name does.
          intro={
            invite ? (
              <SattleProvider>
                <InviteSummary token={invite} />
              </SattleProvider>
            ) : undefined
          }
          onReady={(token) => setAccount({ kind: 'ready', client: buildClient(token) })}
        />
      );
    case 'ready':
      return (
        <DemoApp
          client={account.client}
          invite={invite}
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
