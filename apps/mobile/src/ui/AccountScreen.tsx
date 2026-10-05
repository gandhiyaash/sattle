/**
 * Your account: who you're signed in as, and the way out.
 *
 * An account here is a name and a key on this device, so there is little to
 * manage. The key can be copied, which is how the account gets onto another
 * device or back after this one's data is cleared, and replaced if it may
 * have got out, which signs out every other device. Deleting it is the one
 * thing that can't be taken back, and it reaches into every group, so the
 * screen spells out what goes and what stays before the second tap.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { NOSTR_AUTH_PATHS, type User } from '@sattle/core';
import { signInKey } from '../account/signInKey';
import { readToken, writeToken } from '../account/tokenStore';
import { isMock, useActionKeys, useAsync, useClient } from '../react/SattleProvider';
import { NostrKeyForm } from './NostrKeyForm';
import { copyText } from './share';
import { Button, Card, ConfirmButton, ErrorState, Loading, Screen, SectionLabel } from './primitives';
import { makeStyles, space, type } from './theme';

export interface AccountScreenProps {
  onBack: () => void;
  /** The account is gone from the server. Whoever owns the token forgets it. */
  onDeleted: () => void;
  /** The account has a new sign-in key, already saved on this device. Whoever holds the client switches to it. */
  onKeyReplaced?: (token: string) => void;
}

export function AccountScreen({ onBack, onDeleted, onKeyReplaced }: AccountScreenProps) {
  const s = useStyles();
  const client = useClient();
  const { data, loading, error, reload } = useAsync(() => client.getCurrentUser(), []);

  return (
    <Screen title="Account" onBack={onBack}>
      {loading && <Loading lines={1} />}
      {error && <ErrorState message={error.message} onRetry={reload} />}

      {data && (
        <Card style={{ gap: space.xs }}>
          <Text style={s.label}>Signed in as</Text>
          <Text style={s.name}>{data.displayName}</Text>
          <Text style={s.body}>
            Your account lives on this device. There’s no email or password: your sign-in key is the only way back
            into it.
          </Text>
        </Card>
      )}

      {data && !isMock() && <SignInKeyCard onReplaced={onKeyReplaced} />}

      {data && !isMock() && <NostrCard user={data} />}

      {data && (
        <View>
          <SectionLabel>Delete account</SectionLabel>
          <Card style={{ gap: space.md }}>
            <Text style={s.body}>
              This ends your account for good. Your wallet connection is forgotten, the links you sent stop working,
              and you leave every group. A group only you could open is deleted.
            </Text>
            <Text style={s.body}>
              In groups you share, your name and balance stay, because the others’ records still need them. Anything
              owed to you there can then be marked settled by whoever owes it.
            </Text>
            <ConfirmButton
              label="Delete my account"
              confirmLabel="Yes, delete my account"
              onConfirm={async () => {
                await client.deleteAccount();
                onDeleted();
              }}
            />
          </Card>
        </View>
      )}
    </Screen>
  );
}

/**
 * The key to this account, for another device or for after this one is
 * wiped. It is the account, so it's shown only after a tap, and the card
 * says what it can do in the wrong hands, and how to end a key that got out.
 */
function SignInKeyCard({ onReplaced }: { onReplaced?: (token: string) => void }) {
  const s = useStyles();
  const client = useClient();
  // A retry after a lost answer replays it, so this device isn't left holding a dead key.
  const keys = useActionKeys();
  const [key, setKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const replace = async () => {
    const token = await keys.run('replace-key', {}, (k) => client.replaceSignInKey(k));
    // Saved before anything else: the old key no longer signs in, so a reload needs this one.
    await writeToken(token);
    onReplaced?.(token);
    setKey(signInKey(token));
    setNote(
      'Done. The old key and every device signed in with it are signed out. This is your new key: save it where the old one was.'
    );
  };

  const copy = async () => {
    const token = await readToken();
    if (!token) {
      setNote('This device has no key to copy.');
      return;
    }
    const k = signInKey(token);
    setKey(k);
    setNote(await copyText(k));
  };

  return (
    <View>
      <SectionLabel>Use this account elsewhere</SectionLabel>
      <Card style={{ gap: space.md }}>
        <Text style={s.body}>
          Your sign-in key gets you into this account on another phone or browser, or back into it here after clearing
          this device’s data. On the welcome screen, tap I have a sign-in key and paste it.
        </Text>
        <Text style={s.body}>
          Keep it like a password, in a password manager say. Anyone with it can act as you in all your groups.
        </Text>
        <Button label="Copy sign-in key" onPress={copy} />
        {note && <Text style={s.caption}>{note}</Text>}
        {key && (
          <Text style={s.key} selectable>
            {key}
          </Text>
        )}
        <Text style={s.body}>
          If your key may have got out, or you’ve lost a phone that was signed in, replace it. Every other device
          signed in with the old key is signed out, and this one gets the new key.
        </Text>
        <ConfirmButton label="Replace sign-in key" confirmLabel="Yes, sign out my other devices" onConfirm={replace} />
      </Card>
    </View>
  );
}

/**
 * A Nostr key linked to the account. Signing in with it opens the account on
 * a device with nothing on it, which a sign-in key also does, but people
 * already keep a Nostr key somewhere safe and on more than one device. For
 * a group nobody else has joined, it's the only way back in.
 */
function NostrCard({ user }: { user: User }) {
  const s = useStyles();
  const client = useClient();
  const [npub, setNpub] = useState(user.npub);

  return (
    <View>
      <SectionLabel>Sign in with Nostr</SectionLabel>
      <Card style={{ gap: space.md }}>
        {npub ? (
          <>
            <Text style={s.body}>Linked to</Text>
            <Text style={s.key} selectable numberOfLines={1}>
              {npub}
            </Text>
            <Text style={s.body}>
              On a new phone or browser, tap Sign in with Nostr on the welcome screen to get back into this account,
              with all your groups.
            </Text>
            <ConfirmButton
              label="Unlink this key"
              confirmLabel="Yes, unlink it"
              onConfirm={async () => setNpub((await client.unlinkNostr()).npub)}
            />
          </>
        ) : (
          <>
            <Text style={s.body}>
              Link your Nostr key, and signing in with it opens this account on any device, even if you lose this one
              and your sign-in key. That includes groups nobody else has joined, where there’s nobody to let you back
              in.
            </Text>
            <Text style={s.body}>Sattle never sees your private key: your signer signs a one-time check.</Text>
            <NostrKeyForm
              path={NOSTR_AUTH_PATHS.link}
              action="link it"
              onProof={async (event) => setNpub((await client.linkNostr(event)).npub)}
            />
          </>
        )}
      </Card>
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  label: { ...type.label, color: color.inkMuted },
  name: { ...type.title, color: color.ink },
  body: { ...type.body, color: color.inkMuted },
  caption: { ...type.caption, color: color.inkMuted },
  key: { ...type.amountSm, color: color.ink },
}));
