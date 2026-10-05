/**
 * Restore a group from its backup key: /restore on the web, "Restore a group"
 * on the welcome screen, and "Read it back" on a group's backup card.
 *
 * Everything comes from Nostr relays and is checked here: the signature on
 * every entry, the chain between them, then the decrypting. Sattle's server
 * isn't asked, so this works when it's gone, which is what the backup is for.
 * It only reads; there's nothing to change and nobody to be signed in as.
 */

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { computeBalances, formatFiat, simplifyDebts } from '@sattle/core';
import type { ReadBack } from '../ledger/readBack';
import { Amount, Avatar, Button, Card, Divider, ErrorState, Screen, SectionLabel } from './primitives';
import { makeStyles, radius, space, type, useColors } from './theme';

export interface RestoreScreenProps {
  onBack?: () => void;
  /** A key already in hand, from the group's own backup card. Read as soon as the screen opens. */
  initialKey?: string;
}

export function RestoreScreen({ onBack, initialKey }: RestoreScreenProps) {
  const color = useColors();
  const s = useStyles();
  const [key, setKey] = useState(initialKey ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [read, setRead] = useState<ReadBack | null>(null);

  const restore = async (uri = key) => {
    if (!uri.trim() || busy) return;
    setBusy(true);
    setError(null);
    setRead(null);
    try {
      const { readBack } = await import('../ledger/readBack');
      setRead(await readBack(uri));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t read that group. Try again.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initialKey) void restore(initialKey);
    // Once, for the key the screen was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Screen title="Restore a group" subtitle="From its backup key, straight off Nostr" onBack={onBack}>
      <Card style={{ gap: space.sm }}>
        <Text style={s.label}>Backup key</Text>
        <TextInput
          style={s.input}
          value={key}
          onChangeText={setKey}
          placeholder="sattle-ledger://…"
          placeholderTextColor={color.inkFaint}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          multiline
        />
        <Text style={s.note}>
          Someone in the group copies it from the group’s screen, under Backed up on Nostr. It stays on this device: the
          relays send the encrypted entries, and they’re unlocked here.
        </Text>
      </Card>

      <Button label="Read it from the relays" variant="primary" busy={busy} disabled={!key.trim()} onPress={() => restore()} />

      {error && <ErrorState message={error} />}
      {read && <Restored read={read} />}
    </Screen>
  );
}

function Restored({ read }: { read: ReadBack }) {
  const color = useColors();
  const s = useStyles();
  const hosts = read.relays.map((r) => r.replace(/^wss?:\/\//, '').replace(/\/$/, '')).join(', ');

  if (!read.group) {
    return (
      <Card>
        <Text style={s.body}>
          Nothing for this group on {hosts}. The relays may have dropped it, or the key is for a group with nothing
          added yet.
        </Text>
      </Card>
    );
  }

  const { name, currency, id } = read.group;
  const nameOf = (memberId: string) => read.members.find((m) => m.id === memberId)?.displayName ?? 'Someone';
  const balances = computeBalances(
    read.members.map((m) => m.id),
    read.expenses,
    read.settlements
  );
  const debts = simplifyDebts(id, balances);
  const spends = [...read.expenses].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

  return (
    <>
      <Card style={{ gap: space.xs }}>
        <Text style={s.groupName}>{name}</Text>
        <Text style={s.body}>
          {n(read.entries, 'entry', 'entries')} from {hosts}: {n(read.expenses.length, 'spend')},{' '}
          {n(read.settlements.length, 'settlement')}.
        </Text>
        {read.problems.length === 0 ? (
          <Text style={[s.body, { color: color.settled }]}>
            Every entry is signed by the Sattle server and follows the one before it.
          </Text>
        ) : (
          <View style={{ gap: space.xs }}>
            <Text style={[s.body, { color: color.danger }]}>Some of it doesn’t add up:</Text>
            {read.problems.map((p) => (
              <Text key={p} style={[s.note, { color: color.danger }]}>
                {p}
              </Text>
            ))}
          </View>
        )}
        <Text style={s.npub} selectable numberOfLines={1}>
          Signed by {read.npub}
        </Text>
      </Card>

      <View>
        <SectionLabel>Who owes what</SectionLabel>
        <Card style={{ gap: space.md }}>
          {debts.length === 0 ? (
            <Text style={s.body}>All settled. Nobody owes anything.</Text>
          ) : (
            debts.map((d) => (
              <View key={`${d.fromMemberId}-${d.toMemberId}`} style={s.row}>
                <Avatar name={nameOf(d.fromMemberId)} />
                <Text style={[s.rowText, { flex: 1 }]}>
                  {nameOf(d.fromMemberId)} owes {nameOf(d.toMemberId)}
                </Text>
                <Amount minor={d.amount} currency={currency} size="sm" />
              </View>
            ))
          )}
        </Card>
      </View>

      <View>
        <SectionLabel>Balances</SectionLabel>
        <Card style={{ gap: space.md }}>
          {balances.map((b) => (
            <View key={b.memberId} style={s.row}>
              <Avatar name={nameOf(b.memberId)} dim={b.net === 0} />
              <Text style={[s.rowText, { flex: 1 }]}>{nameOf(b.memberId)}</Text>
              <Amount minor={b.net} currency={currency} size="sm" net />
            </View>
          ))}
        </Card>
      </View>

      {spends.length > 0 && (
        <View>
          <SectionLabel>Spends</SectionLabel>
          <Card style={{ padding: 0 }}>
            {spends.map((e, i) => (
              <View key={e.id}>
                {i > 0 && <Divider />}
                <View style={s.spend}>
                  <View style={s.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.rowText}>{e.description}</Text>
                      <Text style={s.note}>{nameOf(e.paidByMemberId)} paid</Text>
                    </View>
                    <Amount minor={e.amount} currency={currency} size="md" />
                  </View>
                  <Text style={s.shares}>
                    {e.parts.map((p) => `${nameOf(p.memberId)} ${formatFiat(p.amount, currency)}`).join('  ·  ')}
                  </Text>
                </View>
              </View>
            ))}
          </Card>
        </View>
      )}

      {read.settlements.length > 0 && (
        <View>
          <SectionLabel>Settled</SectionLabel>
          <Card style={{ gap: space.sm }}>
            {read.settlements.map((st) => (
              <Text key={st.id} style={s.body}>
                {nameOf(st.fromMemberId)} paid {nameOf(st.toMemberId)} {formatFiat(st.amount, currency)}
              </Text>
            ))}
          </Card>
        </View>
      )}

      <Text style={s.note}>
        Read from Nostr relays and unlocked on this device. Sattle’s server wasn’t asked, so this is what you’d see if
        it were gone.
      </Text>
    </>
  );
}

const useStyles = makeStyles((color) => ({
  label: { ...type.label, color: color.inkMuted },
  input: {
    minHeight: 92,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    ...type.amountSm,
    color: color.ink,
    backgroundColor: color.paper,
    textAlignVertical: 'top',
  },
  note: { ...type.caption, color: color.inkFaint, lineHeight: 18 },
  body: { ...type.body, color: color.inkMuted },
  groupName: { ...type.title, color: color.ink },
  npub: { ...type.caption, color: color.inkFaint },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowText: { ...type.body, color: color.ink },
  spend: { padding: space.lg, gap: space.sm },
  shares: { ...type.amountSm, color: color.inkMuted, lineHeight: 20 },
}));
