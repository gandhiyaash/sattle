/**
 * A name, and that's the account. On a first launch it follows the tour
 * (OnboardingScreen); it comes back on its own after an account is deleted.
 *
 * No email, phone or password, the same thing we ask of everyone else in a
 * group. The server hands back a token and this device keeps it, which is
 * also the catch, so the screen says so before anyone commits.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, TextInput } from 'react-native';

import { createAccount } from '../client/ApiClient';
import { writeToken } from '../account/tokenStore';
import { API_URL } from '../react/SattleProvider';
import { Button, Card, ErrorState, Screen } from './primitives';
import { makeStyles, radius, space, type, useColors } from './theme';

export function WelcomeScreen({ onReady }: { onReady: (token: string) => void }) {
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
          No email, phone or password. Your account lives on this device: if you clear its data or lose it, you lose
          access to your groups.
        </Text>
      </Card>

      {error && <ErrorState message={error} />}

      <Button label="Get started" variant="primary" busy={busy} disabled={!name.trim()} onPress={submit} />
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
}));
