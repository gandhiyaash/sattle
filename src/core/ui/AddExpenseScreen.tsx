/**
 * Add expense.
 *
 * The live split preview at the bottom is the part worth keeping: it shows
 * the resolved per-person amounts as you type, including how the remainder
 * lands. Splitwise hides this and people distrust it; showing it costs one
 * call to resolveParts and removes the doubt entirely.
 */

import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatFiat, resolveParts } from '../domain/ledger';
import type { Member, SplitMode } from '../domain/types';
import { useClient } from '../react/SattleProvider';
import {
  Avatar,
  Button,
  Card,
  Divider,
  ErrorState,
  Screen,
  SectionLabel,
} from './primitives';
import { color, radius, space, type } from './theme';

export interface AddExpenseScreenProps {
  groupId: string;
  members: Member[];
  currency?: string;
  onBack: () => void;
  onAdded: () => void;
}

const MODES: Array<{ mode: SplitMode; label: string }> = [
  { mode: 'equal', label: 'Equally' },
  { mode: 'shares', label: 'By shares' },
  { mode: 'exact', label: 'Exact' },
];

export function AddExpenseScreen({
  groupId,
  members,
  currency = 'INR',
  onBack,
  onAdded,
}: AddExpenseScreenProps) {
  const client = useClient();

  const [description, setDescription] = useState('');
  const [amountText, setAmountText] = useState('');
  const [paidBy, setPaidBy] = useState(members[0]?.id ?? '');
  const [mode, setMode] = useState<SplitMode>('equal');
  const [included, setIncluded] = useState<string[]>(members.map((m) => m.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Parse rupees into paise. Reject anything that isn't a clean number.
  const amountMinor = useMemo(() => {
    const n = Number(amountText.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }, [amountText]);

  const preview = useMemo(() => {
    if (amountMinor <= 0 || included.length === 0) return null;
    try {
      return resolveParts({
        groupId,
        description,
        amount: amountMinor,
        paidByMemberId: paidBy,
        splitMode: mode === 'exact' ? 'equal' : mode,
        parts: included.map((memberId) => ({ memberId, weight: 1 })),
      });
    } catch {
      return null;
    }
  }, [amountMinor, included, mode, groupId, description, paidBy]);

  const toggle = (id: string) =>
    setIncluded((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const submit = async () => {
    if (!description.trim()) return setError('Give it a name.');
    if (amountMinor <= 0) return setError('Enter an amount.');
    if (included.length === 0) return setError('Include at least one person.');

    setBusy(true);
    setError(null);
    try {
      await client.addExpense({
        groupId,
        description: description.trim(),
        amount: amountMinor,
        paidByMemberId: paidBy,
        splitMode: 'equal',
        parts: included.map((memberId) => ({ memberId })),
      });
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Add expense" onBack={onBack}>
      <Card style={{ gap: space.lg }}>
        <View>
          <Text style={s.fieldLabel}>What was it?</Text>
          <TextInput
            style={s.input}
            value={description}
            onChangeText={setDescription}
            placeholder="Dinner at Thalassa"
            placeholderTextColor={color.inkFaint}
          />
        </View>

        <View>
          <Text style={s.fieldLabel}>How much?</Text>
          <View style={s.amountWrap}>
            <Text style={s.currencySymbol}>₹</Text>
            <TextInput
              style={[s.input, s.amountInput]}
              value={amountText}
              onChangeText={setAmountText}
              placeholder="0"
              placeholderTextColor={color.inkFaint}
              keyboardType="decimal-pad"
            />
          </View>
        </View>
      </Card>

      <View>
        <SectionLabel>Paid by</SectionLabel>
        <View style={s.chipRow}>
          {members.map((member) => (
            <Pressable
              key={member.id}
              onPress={() => setPaidBy(member.id)}
              style={[s.chip, paidBy === member.id && s.chipActive]}
            >
              <Text style={[s.chipText, paidBy === member.id && s.chipTextActive]}>
                {member.displayName}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View>
        <SectionLabel>Split</SectionLabel>
        <View style={s.chipRow}>
          {MODES.map((m) => (
            <Pressable
              key={m.mode}
              onPress={() => setMode(m.mode)}
              style={[s.chip, mode === m.mode && s.chipActive]}
            >
              <Text style={[s.chipText, mode === m.mode && s.chipTextActive]}>
                {m.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View>
        <SectionLabel>Between</SectionLabel>
        <Card style={{ padding: 0 }}>
          {members.map((member, i) => {
            const on = included.includes(member.id);
            const share = preview?.find((p) => p.memberId === member.id);
            return (
              <View key={member.id}>
                {i > 0 && <Divider />}
                <Pressable onPress={() => toggle(member.id)} style={s.memberRow}>
                  <View style={[s.check, on && s.checkOn]}>
                    {on && <Text style={s.checkMark}>✓</Text>}
                  </View>
                  <Avatar name={member.displayName} dim={!on} />
                  <Text style={[s.memberName, !on && { color: color.inkFaint }]}>
                    {member.displayName}
                  </Text>
                  {on && share && (
                    <Text style={s.share}>{formatFiat(share.amount, currency)}</Text>
                  )}
                </Pressable>
              </View>
            );
          })}
        </Card>
        {preview && included.length > 1 && (
          <Text style={s.previewNote}>
            Remainder is spread a paisa at a time, so the split always adds up.
          </Text>
        )}
      </View>

      {error && <ErrorState message={error} />}

      <Button label="Add expense" variant="primary" busy={busy} onPress={submit} />
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
  amountWrap: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  currencySymbol: { ...type.amountMd, fontSize: 20, color: color.inkMuted },
  amountInput: { flex: 1, ...type.amountMd, fontSize: 20 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    backgroundColor: color.surface,
  },
  chipActive: { backgroundColor: color.ink, borderColor: color.ink },
  chipText: { ...type.label, color: color.ink },
  chipTextActive: { color: color.paper },

  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
  },
  check: {
    width: 20,
    height: 20,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: color.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: color.accent, borderColor: color.accent },
  checkMark: { color: color.onAccent, fontSize: 12, fontWeight: '700' },
  memberName: { ...type.body, flex: 1, color: color.ink },
  share: { ...type.amountSm, color: color.inkMuted },
  previewNote: { ...type.caption, color: color.inkFaint, marginTop: space.sm },
});
