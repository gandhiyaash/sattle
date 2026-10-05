/**
 * Your account: who you're signed in as, and the way out.
 *
 * An account here is a name and a key on this device, so there is little to
 * manage. The key can be copied, which is how the account gets onto another
 * device or back after this one's data is cleared. Deleting it is the one
 * thing that can't be taken back, and it reaches into every group, so the
 * screen spells out what goes and what stays before the second tap.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { signInKey } from '../account/signInKey';
import { readToken } from '../account/tokenStore';
import { isMock, useAsync, useClient } from '../react/SattleProvider';
import { copyText } from './share';
import { Button, Card, ConfirmButton, ErrorState, Loading, Screen, SectionLabel } from './primitives';
import { makeStyles, space, type } from './theme';

export interface AccountScreenProps {
  onBack: () => void;
  /** The account is gone from the server. Whoever owns the token forgets it. */
  onDeleted: () => void;
}

export function AccountScreen({ onBack, onDeleted }: AccountScreenProps) {
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

      {data && !isMock() && <SignInKeyCard />}

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
 * says what it can do in the wrong hands.
 */
function SignInKeyCard() {
  const s = useStyles();
  const [key, setKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

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
