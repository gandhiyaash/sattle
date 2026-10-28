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
 * point, or whole sats in a group kept in bitcoin. On a trip the total can be
 * typed in what was actually paid instead, baht say: tapping the currency
 * sign picks it, today's rate converts it into the group's currency, and the
 * expense keeps both (ForeignAmount). A new expense starts in whatever the
 * group's last one was paid in, so a week in Bangkok is baht without asking
 * each time. What each person owes, and Exact's amounts, stay in the group's
 * currency: that's what gets settled.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  amountAsTyped,
  canChangeExpense,
  convertForeign,
  currencySymbol,
  foreignCurrenciesFor,
  formatAmount,
  formatConversion,
  isBitcoin,
  minorPerTyped,
  parseAmount,
  resolveParts,
  type Expense,
  type ForeignAmount,
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
  Dialog,
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
  /** Who is signed in: to tell whether an expense is theirs to change, and who paid a new one. */
  userId?: string;
  /** What the group's newest expense was paid in, when that wasn't the group's currency. A new one starts there. */
  lastCurrency?: string;
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

/** How long the currency picker takes to fade out. */
const PICKER_CLOSE_MS = 300;

/** Today's rate for a total typed in another currency: being fetched, in hand, or not to be had. */
type RateState =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'ready'; from: string; rate: number }
  | { kind: 'failed'; message: string };

export function AddExpenseScreen({
  groupId,
  members,
  currency = 'INR',
  expense,
  userId,
  lastCurrency,
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
  /** What the total is typed in: the group's currency, or what was paid on a trip. */
  const [spentIn, setSpentIn] = useState(
    expense ? (expense.original?.currency ?? currency) : lastCurrency && lastCurrency !== currency ? lastCurrency : currency
  );
  const foreign = spentIn !== currency;
  // Reopened, an expense keeps the rate it was added at; a newly picked currency gets today's.
  const [rate, setRate] = useState<RateState>(
    expense?.original ? { kind: 'ready', from: expense.original.currency, rate: expense.original.rate } : { kind: 'none' }
  );
  const [picking, setPicking] = useState(false);
  const [amountText, setAmountText] = useState(
    expense?.original
      ? amountAsTyped(expense.original.amount, expense.original.currency)
      : expense
        ? amountAsTyped(expense.amount, currency)
        : ''
  );
  // A new expense is usually one the person adding it paid, so it starts as theirs.
  const [paidBy, setPaidBy] = useState(
    expense?.paidByMemberId ?? members.find((m) => m.claimedByUserId === userId)?.id ?? members[0]?.id ?? ''
  );
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
  const amountField = useRef<TextInput>(null);

  useEffect(() => {
    if (!foreign || (rate.kind === 'ready' && rate.from === spentIn)) return;
    let live = true;
    setRate({ kind: 'loading' });
    client.getConversionRate(spentIn, currency).then(
      (r) => live && setRate({ kind: 'ready', from: spentIn, rate: r.rate }),
      (e) => live && setRate({ kind: 'failed', message: e instanceof Error ? e.message : 'Couldn’t get a rate.' })
    );
    return () => {
      live = false;
    };
    // Only a change of currency asks again; the rate itself is what this sets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foreign, spentIn, currency, client]);

  /** The total as typed, in whatever it was paid in. */
  const typed = useMemo(() => parseAmount(amountText, spentIn), [amountText, spentIn]);
  const original: ForeignAmount | undefined =
    foreign && rate.kind === 'ready' && rate.from === spentIn && typed > 0
      ? { currency: spentIn, amount: typed, rate: rate.rate }
      : undefined;
  /** The total in the group's currency: what gets split and settled. */
  const amountMinor = foreign ? (original ? convertForeign(original) : 0) : typed;

  const pick = (code: string) => {
    setPicking(false);
    setSpentIn(code);
    // Once the picker has gone: focused while it's still closing, the field loses it again.
    setTimeout(() => amountField.current?.focus(), PICKER_CLOSE_MS);
  };

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
    if (foreign && typed > 0 && !original) {
      return setError(`Waiting for today’s ${spentIn} rate. Or tap ${currencySymbol(spentIn)} to enter it in ${currency}.`);
    }
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
        ...(original ? { original } : {}),
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
    <Screen
      title={expense ? 'Edit expense' : 'Add expense'}
      onBack={onBack}
      // On screen however long the list of people is.
      footer={
        locked ? undefined : (
          <Button label={expense ? 'Save changes' : 'Add expense'} variant="primary" busy={busy} onPress={submit} />
        )
      }
    >
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
              // A new one starts typing straight away.
              autoFocus={!expense}
              // Enter goes on to the amount, with the keyboard still up.
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => amountField.current?.focus()}
            />
          </View>

          <View>
            <Text style={s.fieldLabel}>How much?</Text>
            <View style={s.amountWrap}>
              {/* The sign is the way to another currency: on a trip, the bill's own. */}
              <Pressable
                onPress={() => setPicking(true)}
                hitSlop={6}
                style={[s.currencyChip, foreign && s.currencyChipForeign]}
                accessibilityRole="button"
                accessibilityLabel={`Paid in ${spentIn}. Change currency`}
              >
                <Text style={s.currencySymbol}>{currencySymbol(spentIn)}</Text>
                <Text style={s.currencyCaret}>▾</Text>
              </Pressable>
              <TextInput
                ref={amountField}
                style={[s.input, s.amountInput]}
                value={amountText}
                onChangeText={setAmountText}
                placeholder="0"
                placeholderTextColor={color.inkFaint}
                // Yen and sats are whole, so their keyboard has no point on it.
                keyboardType={minorPerTyped(spentIn) === 1 ? 'number-pad' : 'decimal-pad'}
                // Name, amount, Enter: for the usual expense, split equally and paid by you, that's all it takes.
                returnKeyType="done"
                onSubmitEditing={submit}
              />
            </View>
            {foreign && <Converted rate={rate} spentIn={spentIn} currency={currency} amountMinor={amountMinor} onUseGroup={() => pick(currency)} />}
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

      <Dialog visible={picking} title="Paid in" onClose={() => setPicking(false)}>
        <View style={s.chipRow}>
          {[currency, ...foreignCurrenciesFor(currency)].map((code) => (
            <Pressable
              key={code}
              onPress={() => pick(code)}
              style={[s.chip, spentIn === code && s.chipActive]}
              accessibilityLabel={code === currency ? `${code}, the group’s currency` : code}
            >
              <Text style={[s.chipText, spentIn === code && s.chipTextActive]}>
                {currencyLabel(code)}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={s.previewNote}>Converted at today’s rate. Everyone settles in {isBitcoin(currency) ? 'sats' : currency}.</Text>
      </Dialog>

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

/** A picker's chip: "฿ THB", or just "AED" for one with no sign of its own, and "sats". */
function currencyLabel(code: string): string {
  const sign = currencySymbol(code);
  return sign === code || isBitcoin(code) ? sign : `${sign} ${code}`;
}

/** Under a total typed in another currency: what it comes to in the group's, and at what rate. */
function Converted({
  rate,
  spentIn,
  currency,
  amountMinor,
  onUseGroup,
}: {
  rate: RateState;
  spentIn: string;
  currency: string;
  amountMinor: number;
  onUseGroup: () => void;
}) {
  const s = useStyles();
  if (rate.kind === 'failed') {
    return (
      <View style={s.converted}>
        <Text style={s.convertedError}>{rate.message}</Text>
        <Pressable onPress={onUseGroup} hitSlop={6}>
          <Text style={s.convertedAction}>Enter it in {isBitcoin(currency) ? 'sats' : currency} instead</Text>
        </Pressable>
      </View>
    );
  }
  if (rate.kind !== 'ready') return <Text style={s.convertedNote}>Getting today’s {spentIn} rate…</Text>;
  return (
    <Text style={s.convertedNote}>
      {amountMinor > 0 && <Text style={s.convertedAmount}>= {formatAmount(amountMinor, currency)}</Text>}
      {amountMinor > 0 ? '  ·  ' : ''}
      {formatConversion(spentIn, rate.rate, currency)}
    </Text>
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
  currencyChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 46,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    backgroundColor: color.surface,
  },
  currencyChipForeign: { borderColor: color.accent },
  currencyCaret: { ...type.caption, color: color.inkFaint },
  converted: { marginTop: space.sm, gap: space.xs },
  convertedNote: { ...type.caption, color: color.inkMuted, marginTop: space.sm },
  convertedAmount: { ...type.amountSm, color: color.ink },
  convertedError: { ...type.caption, color: color.danger },
  convertedAction: { ...type.label, color: color.accent },

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
