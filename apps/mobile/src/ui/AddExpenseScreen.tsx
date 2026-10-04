/**
 * Add an expense, or change one.
 *
 * The live split preview at the bottom is the part worth keeping: it shows
 * the resolved per-person amounts as you type, including how the remainder
 * lands. Splitwise hides this and people distrust it; showing it costs one
 * call to resolveParts and removes the doubt entirely.
 *
 * Given an `expense`, the same form edits it and can delete it. An expense
 * is its payer's to change (canChangeExpense), so for anyone else the form
 * is shown but can't be used, and it says whose it is.
 */

import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  canChangeExpense,
  formatFiat,
  resolveParts,
  type Expense,
  type Member,
  type SplitMode,
} from '@sattle/core';
import { useActionKeys, useClient } from '../react/SattleProvider';
import {
  Avatar,
  Button,
  Card,
  ConfirmButton,
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
  /** Change this expense instead of adding one. */
  expense?: Expense;
  /** With `expense`: who is signed in, to tell whether it's theirs to change. */
  userId?: string;
  onBack: () => void;
  /** The expense was added, changed or deleted. */
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
  expense,
  userId,
  onBack,
  onAdded,
}: AddExpenseScreenProps) {
  const client = useClient();
  const keys = useActionKeys();

  const [description, setDescription] = useState(expense?.description ?? '');
  const [amountText, setAmountText] = useState(expense ? String(expense.amount / 100) : '');
  const [paidBy, setPaidBy] = useState(expense?.paidByMemberId ?? members[0]?.id ?? '');
  const [mode, setMode] = useState<SplitMode>('equal');
  const [included, setIncluded] = useState<string[]>(
    expense ? expense.parts.map((p) => p.memberId) : members.map((m) => m.id)
  );

  const payer = expense && members.find((m) => m.id === expense.paidByMemberId);
  // Someone else's to change: the server would refuse, so don't offer.
  const locked = Boolean(expense && userId && !canChangeExpense(payer, userId));
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
      const input = {
        groupId,
        description: description.trim(),
        amount: amountMinor,
        paidByMemberId: paidBy,
        splitMode: 'equal' as const,
        parts: included.map((memberId) => ({ memberId })),
      };
      if (expense) {
        await keys.run('edit-expense', { id: expense.id, ...input }, (k) => client.updateExpense(expense.id, input, k));
      } else {
        await keys.run('add-expense', input, (k) => client.addExpense(input, k));
      }
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await keys.run('delete-expense', { id: expense!.id }, (k) => client.deleteExpense(groupId, expense!.id, k));
    onAdded();
  };

  return (
    <Screen title={expense ? 'Edit expense' : 'Add expense'} onBack={onBack}>
      {locked && (
        <Card>
          <Text style={s.notice}>Only {payer?.displayName ?? 'the person who paid'} can change this, because they paid it.</Text>
        </Card>
      )}
      {expense && !locked && expense.splitMode !== 'equal' && (
        <Text style={s.previewNote}>This was split unevenly. Saving it splits it equally between the people ticked.</Text>
      )}

      <View pointerEvents={locked ? 'none' : 'auto'} style={[s.form, locked && { opacity: 0.55 }]}>
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

      </View>

      {error && <ErrorState message={error} />}

      {!locked && (
        <Button label={expense ? 'Save changes' : 'Add expense'} variant="primary" busy={busy} onPress={submit} />
      )}
      {expense && !locked && (
        <ConfirmButton
          label="Delete expense"
          confirmLabel="Yes, delete this expense"
          hint="What it made people owe goes with it."
          onConfirm={remove}
        />
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  form: { gap: space.lg },
  notice: { ...type.body, color: color.inkMuted },
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
