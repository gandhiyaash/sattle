/**
 * Right after the first screen, for someone who ticked rupees: their UPI ID,
 * so that whoever owes them in a rupee group can pay them from any UPI app.
 * Skip, at the top, leaves it for Account, where it can be added or changed
 * any time.
 *
 * For them it is the launch's one question about getting paid: saving or
 * skipping answers the one the groups list would ask (GetPaidSheet), so they
 * aren't asked twice. Someone who also ticked bitcoin adds a Lightning
 * address under Account.
 *
 * Shown once, as the account is made. Someone who closes the app here goes
 * on to the tour next time, and the groups list asks where they're paid, as
 * it asks anyone with nowhere yet.
 *
 * Laid out, and moving, as the first screen does (FirstRunScreen), so the two
 * read as one. An ID saved here starts out shown on shared group links, as
 * one saved under Account does (AccountPages UpiIdCard), so the one line under
 * the field says so; Account has the rest.
 */

import React, { useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { parseUpiId, upiIdHasPhoneNumber } from '@sattle/core';
import { useScreenView } from '../analytics/useScreenView';
import { useAppData } from '../data/useAppData';
import { useClient } from '../react/SattleProvider';
import { writeGetPaidDone } from './getPaidStore';
import { FirstRunScreen, Headline, Hero, Rise, useFirstRunStyles } from './FirstRunScreen';
import { Button, ErrorState } from './primitives';
import { makeStyles, radius, space, type, useColors } from './theme';

export function UpiStepScreen({ onDone }: { onDone: () => void }) {
  useScreenView('Add UPI ID');
  const color = useColors();
  const s = useStyles();
  const f = useFirstRunStyles();
  const client = useClient();
  const appData = useAppData();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only once it reads as a whole UPI ID, so the warning doesn't come and go as digits are typed.
  const typed = parseUpiId(input);
  const hasPhone = typed.ok && upiIdHasPhoneNumber(typed.upiId);

  // The groups list's question is answered too. Kept before going on, so the groups list, which
  // looks the moment it's up, finds it. If it can't be kept, it's asked once more there.
  const finish = async () => {
    await writeGetPaidDone().catch(() => {});
    onDone();
  };

  const save = async () => {
    const upiId = input.trim();
    if (!upiId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const upiProfile = await client.setUpiId(upiId);
      // Under the key Wallet reads it by, so Wallet opens on it, and into the groups at once.
      appData.remember('upi', upiProfile, true);
      appData.known((v) => ({ ...v, upiProfile }));
      await finish();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t save that UPI ID.');
      setBusy(false);
    }
  };

  return (
    <FirstRunScreen
      right={<Button label="Skip" variant="quiet" disabled={busy} onPress={() => void finish()} />}
      footer={
        <View style={{ gap: space.md }}>
          {error && <ErrorState message={error} />}
          <Button
            label={hasPhone ? 'Save anyway' : 'Save'}
            variant="primary"
            busy={busy}
            disabled={!input.trim()}
            onPress={save}
          />
        </View>
      }
    >
      <Hero sign="₹" />
      <Rise order={1} style={s.ask}>
        <Headline before={'How should friends\n'} em="pay you" after="?" />
        <Text style={f.lead}>Add your UPI ID.</Text>
      </Rise>

      <Rise order={2} style={s.field}>
        <TextInput
          style={f.input}
          value={input}
          onChangeText={(text) => {
            setInput(text);
            setError(null);
          }}
          onSubmitEditing={save}
          returnKeyType="done"
          placeholder="name@okhdfcbank"
          placeholderTextColor={color.inkFaint}
          accessibilityLabel="UPI ID"
          editable={!busy}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />
        {hasPhone ? (
          <Rise style={s.warning}>
            <Text style={s.warningTitle}>This UPI ID has a phone number in it</Text>
            <Text style={s.warningBody}>Everyone who sees the ID sees the number. You can still save it.</Text>
          </Rise>
        ) : (
          // Shared links show a new ID from the start, so that's said before it's saved.
          <Text style={f.hint}>Shown to people who owe you, and on your group links.</Text>
        )}
      </Rise>
    </FirstRunScreen>
  );
}

const useStyles = makeStyles((color) => ({
  ask: { alignItems: 'center', gap: space.sm },
  field: { alignSelf: 'stretch', gap: space.sm },
  warning: { gap: space.xs, padding: space.md, borderRadius: radius.lg, backgroundColor: color.dangerWash },
  warningTitle: { ...type.label, color: color.danger },
  warningBody: { ...type.caption, color: color.ink, lineHeight: 18 },
}));
