/**
 * New group.
 *
 * Names only. Nobody here needs the app, an email or a phone number: they
 * start as ghosts, and a pay link is how money reaches them later. Asking
 * for more up front is where Splitwise loses the people who never install.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { useClient } from '../react/SattleProvider';
import { Button, Card, ErrorState, Screen, SectionLabel } from './primitives';
import { color, radius, space, type } from './theme';

export interface NewGroupScreenProps {
  onBack: () => void;
  onCreated: (groupId: string) => void;
}

export function NewGroupScreen({ onBack, onCreated }: NewGroupScreenProps) {
  const client = useClient();

  const [name, setName] = useState('');
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
      const group = await client.createGroup({
        name: name.trim(),
        currency: 'INR',
        memberNames: people.map((p) => p.trim()).filter(Boolean),
      });
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

const s = StyleSheet.create({
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
});
