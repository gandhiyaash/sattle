/**
 * The first screen: a name and the currencies they use, and that's the
 * account. It can't be skipped. It comes back on its own after an account is
 * deleted.
 *
 * No email, phone or password, the same thing we ask of everyone else in a
 * group. The server hands back a token and this device keeps it, which is
 * also the catch, so the screen says so before anyone commits.
 *
 * Rupees start ticked and bitcoin is a tap away; any number can be on, never
 * none. What isn't ticked the app keeps out of their way (currencyPrefs):
 * without bitcoin, Lightning and everything of Nostr. Someone who ticks
 * rupees is asked their UPI ID next (UpiStepScreen), then shown the tour
 * (OnboardingScreen).
 *
 * Someone who already has an account, from another device or a browser whose
 * data was cleared, pastes the sign-in key they saved from Account instead,
 * or signs in with the Nostr key they linked there.
 * And a group can be read back from its backup key with no account at all.
 * Those three wait under Other ways to sign in, so a first launch sees one
 * way in: a name. The two that are Nostr only show while bitcoin is ticked.
 * The currencies ticked count whichever way they get in.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { NOSTR_AUTH_PATHS, SattleError } from '@sattle/core';
import { useScreenView } from '../analytics/useScreenView';
import { createAccount, signInWithNostr } from '../client/ApiClient';
import { parseSignInKey } from '../account/signInKey';
import { writeToken } from '../account/tokenStore';
import { RUPEES_ONLY, showsNostr, type CurrencyPrefs } from '../prefs/currencyPrefs';
import { chooseCurrencies } from '../prefs/useCurrencyPrefs';
import { API_URL, buildClient } from '../react/SattleProvider';
import { CurrencyChips } from './CurrencyPicker';
import { FirstRunScreen, Headline, Hero, Rise, useFirstRunStyles } from './FirstRunScreen';
import { NostrKeyForm } from './NostrKeyForm';
import { Button, Card, ErrorState, Screen } from './primitives';
import { makeStyles, radius, space, type, useColors } from './theme';

export interface WelcomeScreenProps {
  /**
   * They're in, with what they use already saved. `askUpi`: the account is
   * new, and they use rupees, so their UPI ID is asked next.
   */
  onReady: (token: string, next: { askUpi: boolean }) => void;
  /** Read a group back from its backup key, with no account. */
  onRestore: () => void;
}

export function WelcomeScreen({ onReady, onRestore }: WelcomeScreenProps) {
  useScreenView('Welcome');
  const [signingIn, setSigningIn] = useState<'key' | 'nostr' | null>(null);
  // Kept here, so Back from signing in with a key or Nostr finds the other ways still showing.
  const [others, setOthers] = useState(false);
  // Kept here too, so what they ticked counts whichever way they get in.
  const [prefs, setPrefs] = useState<CurrencyPrefs>(RUPEES_ONLY);
  const ready = (token: string, made: boolean) => {
    chooseCurrencies(prefs);
    onReady(token, { askUpi: made && prefs.uses.includes('INR') });
  };
  const signedIn = (token: string) => ready(token, false);
  if (signingIn === 'key') return <SignInWithKey onReady={signedIn} onBack={() => setSigningIn(null)} />;
  if (signingIn === 'nostr') return <SignInWithNostr onReady={signedIn} onBack={() => setSigningIn(null)} />;
  return (
    <NewAccount
      onMade={(token) => ready(token, true)}
      prefs={prefs}
      setPrefs={setPrefs}
      onSignIn={setSigningIn}
      onRestore={onRestore}
      others={others}
      setOthers={setOthers}
    />
  );
}

function NewAccount({
  onMade,
  prefs,
  setPrefs,
  onSignIn,
  onRestore,
  others,
  setOthers,
}: {
  onMade: (token: string) => void;
  prefs: CurrencyPrefs;
  setPrefs: (prefs: CurrencyPrefs) => void;
  onSignIn: (how: 'key' | 'nostr') => void;
  onRestore: () => void;
  /** Whether the ways in for someone who already has an account, or a group, are showing. */
  others: boolean;
  setOthers: (others: boolean) => void;
}) {
  const color = useColors();
  const s = useStyles();
  const f = useFirstRunStyles();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const nostr = showsNostr(prefs);

  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { token } = await createAccount(API_URL, trimmed);
      await writeToken(token);
      onMade(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t set you up. Try again.');
      setBusy(false);
    }
  };

  return (
    <FirstRunScreen
      footer={
        <View style={{ gap: space.md }}>
          {error && <ErrorState message={error} />}
          <Button
            label={trimmed ? `Continue as ${trimmed}` : 'Continue'}
            // The label holds their name, which doesn't belong in the usage record.
            track="Continue"
            variant="primary"
            busy={busy}
            disabled={!trimmed}
            onPress={submit}
          />
        </View>
      }
    >
      <Hero />
      <Rise order={1} style={s.ask}>
        <Text style={f.kicker}>Hi there.</Text>
        <Headline before={'What should we\n'} em="call you" after="?" />
      </Rise>

      <Rise order={2} style={s.field}>
        <TextInput
          style={f.input}
          value={name}
          onChangeText={setName}
          // Enter only puts the keyboard away: the currencies under it are part of the answer.
          returnKeyType="done"
          placeholder="Your name"
          placeholderTextColor={color.inkFaint}
          maxLength={40}
          editable={!busy}
          // The iPhone's keyboard offers the name on their own contact card. Reading it ourselves
          // would take the Contacts permission.
          textContentType="name"
          autoComplete="name"
          autoCapitalize="words"
        />
      </Rise>

      <Rise order={3} style={s.currencies}>
        <Text style={f.subhead}>
          And the <Text style={f.subheadEm}>currencies</Text> you use
        </Text>
        <CurrencyChips prefs={prefs} onChange={setPrefs} disabled={busy} />
      </Rise>

      <Rise order={4} style={s.others}>
        <Button label="Other ways to sign in" variant="quiet" expanded={others} onPress={() => setOthers(!others)} />
        {others && (
          <>
            <Button label="I have a sign-in key" variant="quiet" onPress={() => onSignIn('key')} />
            {nostr && <Button label="Sign in with Nostr" variant="quiet" onPress={() => onSignIn('nostr')} />}
            {nostr && <Button label="Restore a group from its backup key" variant="quiet" onPress={onRestore} />}
          </>
        )}
      </Rise>
    </FirstRunScreen>
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

/**
 * The account a Nostr key was linked to, from Account on a device that was
 * signed in. Needs neither that device nor the sign-in key, so it is the way
 * back into a group nobody else had joined.
 */
function SignInWithNostr({ onReady, onBack }: { onReady: (token: string) => void; onBack: () => void }) {
  const s = useStyles();
  return (
    <Screen title="Sign in with Nostr" onBack={onBack}>
      <Card style={{ gap: space.md }}>
        <Text style={s.note}>
          If you linked a Nostr key under Account, signing in with it opens your account here, with all your groups.
        </Text>
        <NostrKeyForm
          path={NOSTR_AUTH_PATHS.signIn}
          action="sign in"
          onProof={async (event) => {
            const { token } = await signInWithNostr(API_URL, event);
            await writeToken(token);
            onReady(token);
          }}
        />
      </Card>
    </Screen>
  );
}

const useStyles = makeStyles((color) => ({
  label: { ...type.label, color: color.inkMuted },
  ask: { alignItems: 'center', gap: space.sm },
  field: { alignSelf: 'stretch' },
  currencies: { alignSelf: 'stretch', gap: space.md, marginTop: space.md },
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
  others: { alignSelf: 'stretch', alignItems: 'center', gap: space.xs, marginTop: space.sm },
}));
