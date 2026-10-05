/**
 * New group.
 *
 * Names only. Nobody here needs the app, an email or a phone number: they
 * start as ghosts, and a pay link is how money reaches them later. Asking
 * for more up front is where Splitwise loses the people who never install.
 *
 * The group is kept in the currency its maker uses. Only someone who uses
 * both rupees and bitcoin is asked, and the question opens on the one they
 * said new groups start in. A group's currency can't be changed afterwards,
 * since every amount in it is counted in that currency's units.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { isBitcoin } from '@sattle/core';
import { useCurrencyPrefs } from '../prefs/useCurrencyPrefs';
import { useActionKeys, useClient } from '../react/SattleProvider';
import { CURRENCY_NAMES } from './CurrencyPicker';
import { Button, Card, ErrorState, Screen, SectionLabel, Segmented } from './primitives';
import { makeStyles, radius, space, type, useColors } from './theme';

export interface NewGroupScreenProps {
  onBack: () => void;
  onCreated: (groupId: string) => void;
}

export function NewGroupScreen({ onBack, onCreated }: NewGroupScreenProps) {
  const color = useColors();
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();
  const prefs = useCurrencyPrefs();

  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(prefs.newGroups);
  const [people, setPeople] = useState<string[]>(['']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setPerson = (i: number, value: string) =>
    setPeople((prev) => prev.map((p, j) => (j === i ? value : p)));

  const submit = async () => {
    if (!name.trim()) return setError('Give the group a name.');

    setBusy(true);
    setError(null);
    try {
      const input = {
        name: name.trim(),
        currency,
        memberNames: people.map((p) => p.trim()).filter(Boolean),
      };
      const group = await keys.run('create-group', input, (k) => client.createGroup(input, k));
      onCreated(group.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the group.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="New group" onBack={onBack}>
      <Card>
        <Text style={s.fieldLabel}>What’s it for?</Text>
        <TextInput
          style={s.input}
          value={name}
          onChangeText={setName}
          placeholder="Goa trip"
          placeholderTextColor={color.inkFaint}
          autoFocus
        />
      </Card>

      {prefs.uses.length > 1 && (
        <View>
          <SectionLabel>Kept in</SectionLabel>
          <Segmented options={CURRENCY_NAMES.filter((c) => prefs.uses.includes(c.value))} value={currency} onChange={setCurrency} />
          <Text style={s.note}>
            {isBitcoin(currency)
              ? 'Amounts are in sats, and people settle up over Lightning. This can’t be changed later.'
              : 'Amounts are in rupees, and people settle up by UPI or over Lightning. This can’t be changed later.'}
          </Text>
        </View>
      )}

      <View>
        <SectionLabel>Who’s in it</SectionLabel>
        <Card style={{ gap: space.sm }}>
          <Text style={s.you}>You</Text>
          {people.map((person, i) => (
            <TextInput
              key={i}
              style={s.input}
              value={person}
              onChangeText={(v) => setPerson(i, v)}
              placeholder="Their name"
              placeholderTextColor={color.inkFaint}
            />
          ))}
          <Button label="Add another person" variant="quiet" onPress={() => setPeople((p) => [...p, ''])} />
        </Card>
        <Text style={s.note}>They don’t need the app. You can add more people later.</Text>
      </View>

      {error && <ErrorState message={error} />}

      <Button label="Create group" variant="primary" busy={busy} onPress={submit} />
    </Screen>
  );
}

const useStyles = makeStyles((color) => ({
  fieldLabel: { ...type.label, color: color.inkMuted, marginBottom: space.sm },
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
  you: { ...type.body, color: color.inkMuted, paddingHorizontal: space.md, paddingVertical: space.xs },
  note: { ...type.caption, color: color.inkFaint, marginTop: space.sm },
}));
