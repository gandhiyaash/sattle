/**
 * First launch: a name, and that's the account.
 *
 * No email, phone or password, the same thing we ask of everyone else in a
 * group. The server hands back a token and this device keeps it, which is
 * also the catch, so the screen says so before anyone commits.
 *
 * Someone who already has an account, from another device or a browser whose
 * data was cleared, pastes the sign-in key they saved from Account instead.
 * And a group can be read back from its backup key with no account at all.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { SattleError } from '@sattle/core';
import { createAccount } from '../client/ApiClient';
import { parseSignInKey } from '../account/signInKey';
import { writeToken } from '../account/tokenStore';
import { API_URL, buildClient } from '../react/SattleProvider';
import { Button, Card, ErrorState, Screen } from './primitives';
import { makeStyles, radius, space, type, useColors } from './theme';

export interface WelcomeScreenProps {
  onReady: (token: string) => void;
  /** Read a group back from its backup key, with no account. */
  onRestore: () => void;
}

export function WelcomeScreen({ onReady, onRestore }: WelcomeScreenProps) {
  const [signingIn, setSigningIn] = useState(false);
  return signingIn ? (
    <SignInWithKey onReady={onReady} onBack={() => setSigningIn(false)} />
  ) : (
    <NewAccount onReady={onReady} onSignIn={() => setSigningIn(true)} onRestore={onRestore} />
  );
}

function NewAccount({
  onReady,
  onSignIn,
  onRestore,
}: {
  onReady: (token: string) => void;
  onSignIn: () => void;
  onRestore: () => void;
}) {
  const color = useColors();
  const s = useStyles();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { token } = await createAccount(API_URL, name.trim());
      await writeToken(token);
      onReady(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t set you up. Try again.');
      setBusy(false);
    }
  };

  return (
    <Screen title="Sattle" brand subtitle="Split bills in sats. Only one of you needs the app.">
      <Card style={{ gap: space.sm }}>
        <Text style={s.label}>What should your friends call you?</Text>
        <TextInput
          style={s.input}
          value={name}
          onChangeText={setName}
          onSubmitEditing={submit}
          returnKeyType="done"
          placeholder="Your name"
          placeholderTextColor={color.inkFaint}
          maxLength={40}
          autoFocus
        />
        <Text style={s.note}>
          No email, phone or password. Your account lives on this device. To use it anywhere else, or to get it back
          after clearing this device’s data, save your sign-in key from Account.
        </Text>
      </Card>

      {error && <ErrorState message={error} />}

      <Button label="Get started" variant="primary" busy={busy} disabled={!name.trim()} onPress={submit} />

      <View style={s.others}>
        <Button label="I have a sign-in key" variant="quiet" onPress={onSignIn} />
        <Button label="Restore a group from its backup key" variant="quiet" onPress={onRestore} />
      </View>
    </Screen>
  );
}

/**
 * The account from another device. The key is checked against the server
 * before it's kept, so a mistyped one doesn't leave this device signed in
 * as nobody.
 */
function SignInWithKey({ onReady, onBack }: { onReady: (token: string) => void; onBack: () => void }) {
  const color = useColors();
  const s = useStyles();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!key.trim() || busy) return;
    const token = parseSignInKey(key);
    if (!token) {
      setError('That isn’t a sign-in key. It starts with sattle-signin:');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await buildClient(token).getCurrentUser();
      await writeToken(token);
      onReady(token);
    } catch (e) {
      setError(
        e instanceof SattleError && e.code === 'unauthorized'
          ? 'No account has that key. It may have been deleted.'
          : e instanceof Error
            ? e.message
            : 'Couldn’t check that key. Try again.'
      );
      setBusy(false);
    }
  };

  return (
    <Screen title="Sign in with your key" onBack={onBack}>
      <Card style={{ gap: space.sm }}>
        <Text style={s.label}>Sign-in key</Text>
        <TextInput
          style={s.input}
          value={key}
          onChangeText={setKey}
          onSubmitEditing={submit}
          returnKeyType="done"
          placeholder="sattle-signin:…"
          placeholderTextColor={color.inkFaint}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          secureTextEntry
          autoFocus
        />
        <Text style={s.note}>
          On the device you’re already signed in on, it’s under Account, Use this account elsewhere. Both devices stay
          signed in as you.
        </Text>
      </Card>

      {error && <ErrorState message={error} />}

      <Button label="Sign in" variant="primary" busy={busy} disabled={!key.trim()} onPress={submit} />
    </Screen>
  );
}

const useStyles = makeStyles((color) => ({
  label: { ...type.label, color: color.inkMuted },
  input: {
    height: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    ...type.body,
    color: color.ink,
    backgroundColor: color.paper,
  },
  note: { ...type.caption, color: color.inkFaint, lineHeight: 18 },
  others: { gap: space.xs },
}));
