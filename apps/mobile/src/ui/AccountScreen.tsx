/**
 * Your account: who you're signed in as, what you use, and the way out.
 *
 * An account here is a name and a key on this device, so there is little to
 * manage. Which currencies they use is the one setting for the whole app, as
 * opposed to one group's (GroupSettingsScreen): everyone starts with both,
 * and this is where one is turned off or added back. Deleting the account is
 * the one thing that can't be taken
 * back, and it reaches into every group, so the screen spells out what goes
 * and what stays before the second tap.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { chooseCurrencies, useCurrencyPrefs } from '../prefs/useCurrencyPrefs';
import { useAsync, useClient } from '../react/SattleProvider';
import { CurrencyPicker } from './CurrencyPicker';
import { Card, ConfirmButton, ErrorState, Loading, Screen, SectionLabel } from './primitives';
import { makeStyles, space, type } from './theme';

export interface AccountScreenProps {
  onBack: () => void;
  /** The account is gone from the server. Whoever owns the token forgets it. */
  onDeleted: () => void;
}

export function AccountScreen({ onBack, onDeleted }: AccountScreenProps) {
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
            Your account lives on this device. There’s no email or password, so it can’t be moved or recovered.
          </Text>
        </Card>
      )}

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

const useStyles = makeStyles((color) => ({
  label: { ...type.label, color: color.inkMuted },
  name: { ...type.title, color: color.ink },
  body: { ...type.body, color: color.inkMuted },
  note: { ...type.caption, color: color.inkFaint, lineHeight: 18, marginTop: space.sm },
}));
