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
 *
 * By shares adds a stepper per person; Exact adds an amount field per person
 * and a running total of what's left to assign, and won't save until the
 * amounts add up. An expense keeps only what each person owes, not the
 * shares behind it, so editing one split by shares opens it as exact amounts.
 *
 * Amounts are typed in the group's currency: rupees with paise after the
 * point, or whole sats in a group kept in bitcoin.
 */

import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  amountAsTyped,
  canChangeExpense,
  formatAmount,
  isBitcoin,
  parseAmount,
  resolveParts,
  type Expense,
  type ExpensePartInput,
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
import { makeStyles, radius, space, type, useColors } from './theme';

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

const MAX_SHARES = 99;

export function AddExpenseScreen({
  groupId,
  members,
  currency = 'INR',
  expense,
  userId,
  onBack,
  onAdded,
}: AddExpenseScreenProps) {
  const color = useColors();
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();
  const sats = isBitcoin(currency);
  // Sats are whole, so their keyboard has no point on it.
  const keyboard = sats ? 'number-pad' : 'decimal-pad';

  const [description, setDescription] = useState(expense?.description ?? '');
  const [amountText, setAmountText] = useState(expense ? amountAsTyped(expense.amount, currency) : '');
  const [paidBy, setPaidBy] = useState(expense?.paidByMemberId ?? members[0]?.id ?? '');
  // An uneven split comes back as the amounts it resolved to, which saving keeps.
  const [mode, setMode] = useState<SplitMode>(expense && expense.splitMode !== 'equal' ? 'exact' : 'equal');
  const [included, setIncluded] = useState<string[]>(
    expense ? expense.parts.map((p) => p.memberId) : members.map((m) => m.id)
  );
  /** By shares: whole shares per member, 1 unless changed. */
  const [weights, setWeights] = useState<Record<string, number>>({});
  /** Exact: each member's amount as typed, in rupees or sats. */
  const [exacts, setExacts] = useState<Record<string, string>>(() =>
    expense && expense.splitMode !== 'equal'
      ? Object.fromEntries(expense.parts.map((p) => [p.memberId, amountAsTyped(p.amount, currency)]))
      : {}
  );

  const payer = expense && members.find((m) => m.id === expense.paidByMemberId);
  // Someone else's to change: the server would refuse, so don't offer.
  const locked = Boolean(expense && userId && !canChangeExpense(payer, userId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountMinor = useMemo(() => parseAmount(amountText, currency), [amountText, currency]);

  // Members in group order, so the remainder lands the same way every time.
  const parts = useMemo<ExpensePartInput[]>(
    () =>
      members
        .filter((m) => included.includes(m.id))
        .map((m) =>
          mode === 'shares'
            ? { memberId: m.id, weight: weights[m.id] ?? 1 }
            : mode === 'exact'
              ? { memberId: m.id, amount: parseAmount(exacts[m.id] ?? '', currency) }
              : { memberId: m.id }
        ),
    [members, included, mode, weights, exacts, currency]
  );

  /** Exact: total still to hand out. Negative when the amounts overshoot. */
  const unassigned = amountMinor - parts.reduce((sum, p) => sum + (p.amount ?? 0), 0);

  const preview = useMemo(() => {
    if (mode === 'exact' || amountMinor <= 0 || parts.length === 0) return null;
    try {
      return resolveParts(
        {
          groupId,
          description,
          amount: amountMinor,
          paidByMemberId: paidBy,
          splitMode: mode,
          parts,
        },
        currency
      );
    } catch {
      return null;
    }
  }, [amountMinor, parts, mode, groupId, description, paidBy, currency]);

  const step = (id: string, by: number) =>
    setWeights((prev) => ({
      ...prev,
      [id]: Math.min(MAX_SHARES, Math.max(1, (prev[id] ?? 1) + by)),
    }));

  const toggle = (id: string) =>
    setIncluded((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const submit = async () => {
    if (!description.trim()) return setError('Give it a name.');
    if (amountMinor <= 0) return setError('Enter an amount.');
    if (included.length === 0) return setError('Include at least one person.');
    if (mode === 'exact' && unassigned !== 0) {
      return setError(
        unassigned > 0
          ? `${formatAmount(unassigned, currency)} still to assign.`
          : `The amounts are ${formatAmount(-unassigned, currency)} more than the total.`
      );
    }

    setBusy(true);
    setError(null);
    try {
      const input = {
        groupId,
        description: description.trim(),
        amount: amountMinor,
        paidByMemberId: paidBy,
        splitMode: mode,
        parts,
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
      {expense && !locked && expense.splitMode === 'shares' && (
        <Text style={s.previewNote}>This was split by shares. It opens as the amounts each person owes.</Text>
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
              {!sats && <Text style={s.currencySymbol}>₹</Text>}
              <TextInput
                style={[s.input, s.amountInput]}
                value={amountText}
                onChangeText={setAmountText}
                placeholder="0"
                placeholderTextColor={color.inkFaint}
                keyboardType={keyboard}
              />
              {sats && <Text style={s.currencySymbol}>sats</Text>}
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
              const shares = weights[member.id] ?? 1;
              return (
                <View key={member.id}>
                  {i > 0 && <Divider />}
                  <View style={s.memberRow}>
                    {/* Only this part toggles, so the controls on the right don't. */}
                    <Pressable onPress={() => toggle(member.id)} style={s.memberToggle}>
                      <View style={[s.check, on && s.checkOn]}>
                        {on && <Text style={s.checkMark}>✓</Text>}
                      </View>
                      <Avatar name={member.displayName} dim={!on} />
                      <View style={{ flex: 1 }}>
                        <Text style={[s.memberName, !on && { color: color.inkFaint }]} numberOfLines={1}>
                          {member.displayName}
                        </Text>
                        {on && share && mode === 'shares' && (
                          <Text style={s.share}>{formatAmount(share.amount, currency)}</Text>
                        )}
                      </View>
                    </Pressable>

                    {on && share && mode === 'equal' && (
                      <Text style={s.share}>{formatAmount(share.amount, currency)}</Text>
                    )}

                    {on && mode === 'shares' && (
                      <View style={s.stepper}>
                        <Pressable
                          onPress={() => step(member.id, -1)}
                          disabled={shares <= 1}
                          hitSlop={6}
                          style={[s.stepBtn, shares <= 1 && { opacity: 0.35 }]}
                          accessibilityLabel={`One fewer share for ${member.displayName}`}
                        >
                          <Text style={s.stepText}>−</Text>
                        </Pressable>
                        <Text style={s.stepCount}>{shares}</Text>
                        <Pressable
                          onPress={() => step(member.id, 1)}
                          disabled={shares >= MAX_SHARES}
                          hitSlop={6}
                          style={s.stepBtn}
                          accessibilityLabel={`One more share for ${member.displayName}`}
                        >
                          <Text style={s.stepText}>+</Text>
                        </Pressable>
                      </View>
                    )}

                    {on && mode === 'exact' && (
                      <View style={s.exactWrap}>
                        {!sats && <Text style={s.exactSymbol}>₹</Text>}
                        <TextInput
                          style={[s.input, s.exactInput]}
                          value={exacts[member.id] ?? ''}
                          onChangeText={(v) => setExacts((prev) => ({ ...prev, [member.id]: v }))}
                          placeholder="0"
                          placeholderTextColor={color.inkFaint}
                          keyboardType={keyboard}
                          accessibilityLabel={`${member.displayName}'s amount${sats ? ' in sats' : ''}`}
                        />
                        {sats && <Text style={s.exactSymbol}>sats</Text>}
                      </View>
                    )}
                  </View>
                </View>
              );
            })}
          </Card>
          {mode === 'equal' && preview && included.length > 1 && (
            <Text style={s.previewNote}>
              Remainder is spread a {sats ? 'sat' : 'paisa'} at a time, so the split always adds up.
            </Text>
          )}
          {mode === 'shares' && included.length > 0 && (
            <Text style={s.previewNote}>
              Two shares pays twice what one share does. Use it for someone who had more.
            </Text>
          )}
          {mode === 'exact' && included.length > 0 && amountMinor > 0 && (
            <Text
              style={[
                s.previewNote,
                { color: unassigned === 0 ? color.owed : unassigned < 0 ? color.danger : color.inkMuted },
              ]}
            >
              {unassigned === 0
                ? 'Adds up to the total.'
                : unassigned > 0
                  ? `${formatAmount(unassigned, currency)} left to assign`
                  : `${formatAmount(-unassigned, currency)} over the total`}
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

const useStyles = makeStyles((color) => ({
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
  memberToggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.md },
  memberName: { ...type.body, color: color.ink },

  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    borderRadius: radius.md,
    backgroundColor: color.paper,
  },
  stepBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontSize: 18, lineHeight: 20, color: color.ink },
  stepCount: { ...type.amountMd, minWidth: 22, textAlign: 'center', color: color.ink },

  exactWrap: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  exactSymbol: { ...type.amountSm, color: color.inkMuted },
  exactInput: { width: 104, height: 38, ...type.amountMd, textAlign: 'right' },
  share: { ...type.amountSm, color: color.inkMuted },
  previewNote: { ...type.caption, color: color.inkFaint, marginTop: space.sm },
}));
