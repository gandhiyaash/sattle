/**
 * Your account: who you're signed in as, what you use, and the way out.
 *
 * An account here is a name and a key on this device, so there is little to
 * manage. The key can be copied, which is how the account gets onto another
 * device or back after this one's data is cleared, and replaced if it may
 * have got out, which signs out every other device. Which currencies they use
 * is the one setting for the whole app, as opposed to one group's
 * (GroupSettingsScreen): everyone starts with both, and this is where one is
 * turned off or added back. Deleting the account is the one thing that can't
 * be taken back, and it reaches into every group, so the screen spells out
 * what goes and what stays before the second tap.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { signInKey } from '../account/signInKey';
import { readToken, writeToken } from '../account/tokenStore';
import { chooseCurrencies, useCurrencyPrefs } from '../prefs/useCurrencyPrefs';
import { isMock, useActionKeys, useAsync, useClient } from '../react/SattleProvider';
import { CurrencyPicker } from './CurrencyPicker';
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
  const prefs = useCurrencyPrefs();
  const { data, loading, error, reload } = useAsync(() => client.getCurrentUser(), []);
  // Deleting forgets a connected wallet whether or not they still use bitcoin, so someone who
  // turned it off with one connected is told too. If this can't be read, what they use decides.
  const wallet = useAsync(() => client.getWalletConnection(), []);
  const forgetsWallet = prefs.uses.includes('BTC') || Boolean(wallet.data?.connected);

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

      {/* Kept on this device, so there is nothing to wait for and nothing here that can fail. */}
      <View>
        <SectionLabel>Currencies</SectionLabel>
        <CurrencyPicker prefs={prefs} onChange={chooseCurrencies} />
        <Text style={s.note}>
          Turning one off only hides it. A group keeps its currency, so one kept in bitcoin still shows Lightning.
          What you’ve set up to get paid stays until you remove it in Wallet.
        </Text>
      </View>

      {data && (
        <View>
          <SectionLabel>Delete account</SectionLabel>
          <Card style={{ gap: space.md }}>
            <Text style={s.body}>
              This ends your account for good. {forgetsWallet ? 'Your wallet connection is forgotten, the' : 'The'}{' '}
              links you sent stop working, and you leave every group. A group only you could open is deleted.
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

const useStyles = makeStyles((color) => ({
  label: { ...type.label, color: color.inkMuted },
  name: { ...type.title, color: color.ink },
  body: { ...type.body, color: color.inkMuted },
  caption: { ...type.caption, color: color.inkMuted },
  key: { ...type.amountSm, color: color.ink },
  note: { ...type.caption, color: color.inkFaint, lineHeight: 18, marginTop: space.sm },
}));
