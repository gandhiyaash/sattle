/**
 * Add an expense, or change one.
 *
 * The amount comes first and largest, since it is what everyone checks, then
 * what it was for. Under them, one card says who paid and how it is split,
 * and the split resolved to each person's amount as it is typed, including
 * where the remainder lands. Splitwise hides this and people distrust it;
 * showing it costs one call to resolveParts and removes the doubt entirely.
 *
 * Who paid and how to split live in a sheet, opened from that card, since
 * most expenses are paid by whoever adds them and split equally:
 *
 *   Equally      everyone in it pays the same.
 *   By amount    each person's amount is typed, and it won't save until they
 *                add up to the total. Saved as exact amounts.
 *   By parts     someone who had twice as much has 2 parts. Saved as shares.
 *   By percent   each person's percent, reaching 100. Saved as the exact
 *                amounts they come to: the server keeps amounts, not percents.
 *
 * Split by item, from the same sheet, is for a bill with lines on it: each
 * line's price, and who had it. It comes to exact amounts too, and saves.
 *
 * Given an `expense`, the same form edits it and can delete it. An expense
 * is its payer's to change (canChangeExpense), so for anyone else the form
 * is shown but can't be used, and it says whose it is. An expense keeps only
 * what each person owes, not the shares behind it, so editing one split
 * unevenly opens it as amounts.
 *
 * Amounts are typed in the group's currency: rupees with paise after the
 * point, or whole sats in a group kept in bitcoin.
 */

import React, { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  amountAsTyped,
  canChangeExpense,
  formatAmount,
  isBitcoin,
  isHeldBy,
  parseAmount,
  resolveParts,
  type Expense,
  type ExpenseInput,
  type Member,
  type ResolvedPart,
} from '@sattle/core';
import { analytics } from '../analytics/analytics';
import { useScreenView } from '../analytics/useScreenView';
import { useActionKeys, useClient } from '../react/SattleProvider';
import {
  Avatar,
  ConfirmButton,
  ErrorState,
  Glyph,
  Pill,
  Segmented,
  Sheet,
  SheetBody,
} from './primitives';
import { faceFor, initialOf, makeStyles, radius, shadow, space, type, useColorMode, useColors } from './theme';

export interface AddExpenseScreenProps {
  groupId: string;
  /** Said at the top, so it's plain which group this goes in. */
  groupName?: string;
  members: Member[];
  currency?: string;
  /** Change this expense instead of adding one. */
  expense?: Expense;
  /**
   * Who is signed in. Adding, they are who paid unless they say otherwise:
   * whoever puts a spend in is almost always the one who paid it. Changing an
   * expense, it tells whether the expense is theirs to change.
   */
  userId?: string;
  onBack: () => void;
  /** The expense was added, changed or deleted. */
  onAdded: () => void;
}

/** How the form splits, which is one more than the server keeps: percent is saved as amounts. */
type Way = 'equal' | 'exact' | 'shares' | 'percent';

const WAYS: ReadonlyArray<{ value: Way; label: string; hint: string }> = [
  { value: 'equal', label: 'Equally', hint: 'Everyone pays the same.' },
  { value: 'exact', label: 'By amount', hint: 'Type what each person owes. It needs to add up to the total.' },
  { value: 'shares', label: 'By parts', hint: 'Someone had twice as much? Give them 2 parts.' },
  { value: 'percent', label: 'By percent', hint: 'Type each person’s percent. It needs to reach 100%.' },
];

/** A line on a bill, for Split by item. `who` are the members who had it. */
interface Item {
  key: number;
  name: string;
  price: string;
  who: string[];
}

export function AddExpenseScreen({
  groupId,
  groupName,
  members,
  currency = 'INR',
  expense,
  userId,
  onBack,
  onAdded,
}: AddExpenseScreenProps) {
  useScreenView(expense ? 'Edit expense' : 'Add expense', { groupId });
  const color = useColors();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const client = useClient();
  const keys = useActionKeys();
  const sats = isBitcoin(currency);
  // Sats are whole, so their keyboard has no point on it.
  const keyboard = sats ? 'number-pad' : 'decimal-pad';
  const fmt = (minor: number) => formatAmount(minor, currency);

  const [description, setDescription] = useState(expense?.description ?? '');
  const [amountText, setAmountText] = useState(expense ? amountAsTyped(expense.amount, currency) : '');
  const me = userId ? members.find((m) => isHeldBy(m, userId)) : undefined;
  const [paidBy, setPaidBy] = useState(expense?.paidByMemberId ?? me?.id ?? members[0]?.id ?? '');
  // An uneven split comes back as the amounts it resolved to, which saving keeps.
  const [way, setWay] = useState<Way>(expense && expense.splitMode !== 'equal' ? 'exact' : 'equal');
  const [included, setIncluded] = useState<string[]>(
    expense ? expense.parts.map((p) => p.memberId) : members.map((m) => m.id)
  );
  /** What's typed for each person, for each way of splitting, so going back to one keeps it. */
  const [typed, setTyped] = useState<Record<'exact' | 'shares' | 'percent', Record<string, string>>>(() => ({
    exact:
      expense && expense.splitMode !== 'equal'
        ? Object.fromEntries(expense.parts.map((p) => [p.memberId, amountAsTyped(p.amount, currency)]))
        : {},
    shares: {},
    percent: {},
  }));
  const [details, setDetails] = useState(false);
  const [byItem, setByItem] = useState(false);
  // Held here, not in ItemSplit, so the bill's lines are still there after going back to the form.
  const [items, setItems] = useState<Item[]>([{ key: 0, name: '', price: '', who: [] }]);

  const payer = expense && members.find((m) => m.id === expense.paidByMemberId);
  // Someone else's to change: the server would refuse, so don't offer.
  const locked = Boolean(expense && userId && !canChangeExpense(payer, userId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountField = useRef<TextInput>(null);
  const nameField = useRef<TextInput>(null);

  const amountMinor = useMemo(() => parseAmount(amountText, currency), [amountText, currency]);
  // Members in group order, so the remainder lands the same way every time.
  const inSplit = members.filter((m) => included.includes(m.id));

  /** The percents shared out evenly between whoever's in, with the odd one to the first. */
  const evenPercent = (id: string): string => {
    const n = Math.max(inSplit.length, 1);
    const even = Math.floor(100 / n);
    return String(inSplit[0]?.id === id ? 100 - even * (n - 1) : even);
  };
  // Until a percent is typed they follow who's in, so the even split stays even. After, what's on
  // screen stays put: someone let in starts at 0, and nobody else's number moves under the user.
  const percentTyped = Object.keys(typed.percent).length > 0;

  /** Before anything is typed: one part each, and the percents shared out evenly. */
  const raw = (w: 'exact' | 'shares' | 'percent', id: string): string => {
    const t = typed[w][id];
    if (t !== undefined) return t;
    if (w === 'shares') return '1';
    if (w === 'percent') return percentTyped ? '0' : evenPercent(id);
    return '';
  };
  const num = (text: string) => {
    const v = Number(text.replace(/,/g, ''));
    return Number.isFinite(v) && v > 0 ? v : 0;
  };

  /** Each person's amount, and what's wrong with the split if anything: `quiet` when it's only that nothing's typed yet. */
  const split = useMemo((): { parts: ResolvedPart[] | null; note: string; bad: boolean; quiet?: boolean } => {
    if (inSplit.length === 0) return { parts: null, note: 'Pick at least one person.', bad: true };
    if (amountMinor <= 0) return { parts: null, note: 'Type the amount first.', bad: true, quiet: true };
    const base = { groupId, description, amount: amountMinor, paidByMemberId: paidBy };
    if (way === 'exact') {
      const parts = inSplit.map((m) => ({ memberId: m.id, amount: parseAmount(raw('exact', m.id), currency) }));
      const left = amountMinor - parts.reduce((sum, p) => sum + p.amount, 0);
      if (left > 0) return { parts, note: `${fmt(left)} still to share out.`, bad: true };
      if (left < 0) return { parts, note: `${fmt(-left)} more than the total.`, bad: true };
      return { parts, note: `Adds up to ${fmt(amountMinor)}.`, bad: false };
    }
    if (way === 'percent') {
      const pct = Math.round(inSplit.reduce((sum, m) => sum + num(raw('percent', m.id)), 0) * 100) / 100;
      if (pct !== 100) return { parts: null, note: `${pct}% of 100% so far.`, bad: true };
    }
    if (way === 'shares' && inSplit.some((m) => num(raw('shares', m.id)) === 0)) {
      return { parts: null, note: 'Give everyone in the split at least 1 part, or leave them out.', bad: true };
    }
    try {
      const parts = resolveParts(
        {
          ...base,
          splitMode: way === 'equal' ? 'equal' : 'shares',
          parts: inSplit.map((m) =>
            way === 'equal' ? { memberId: m.id } : { memberId: m.id, weight: num(raw(way, m.id)) }
          ),
        },
        currency
      );
      return { parts, note: `Adds up to ${fmt(amountMinor)}.`, bad: false };
    } catch (e) {
      return { parts: null, note: e instanceof Error ? e.message : 'That split doesn’t work.', bad: true };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inSplit.map((m) => m.id).join(), amountMinor, way, typed, paidBy, groupId, description, currency]);

  const toggle = (id: string) =>
    setIncluded((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const typeFor = (w: 'exact' | 'shares' | 'percent', id: string, value: string) =>
    setTyped((prev) => {
      // The first percent typed fixes everyone else's where they're showing.
      const start =
        w === 'percent' && Object.keys(prev.percent).length === 0
          ? Object.fromEntries(inSplit.map((m) => [m.id, evenPercent(m.id)]))
          : prev[w];
      return { ...prev, [w]: { ...start, [id]: value } };
    });

  /** What goes to the server: equal and parts as they are, amounts and percents as the amounts they resolved to. */
  const toInput = (): ExpenseInput => {
    const base = { groupId, description: description.trim(), amount: amountMinor, paidByMemberId: paidBy };
    if (way === 'equal') return { ...base, splitMode: 'equal', parts: inSplit.map((m) => ({ memberId: m.id })) };
    if (way === 'shares') {
      return { ...base, splitMode: 'shares', parts: inSplit.map((m) => ({ memberId: m.id, weight: num(raw('shares', m.id)) })) };
    }
    return { ...base, splitMode: 'exact', parts: (split.parts ?? []).map((p) => ({ memberId: p.memberId, amount: p.amount })) };
  };

  const save = async (input: ExpenseInput) => {
    setBusy(true);
    setError(null);
    try {
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

  const submit = () => {
    if (!description.trim()) return setError('Give it a name.');
    if (amountMinor <= 0) return setError('Enter an amount.');
    if (split.bad) return setError(split.note);
    void save(toInput());
  };

  const remove = async () => {
    await keys.run('delete-expense', { id: expense!.id }, (k) => client.deleteExpense(groupId, expense!.id, k));
    onAdded();
  };

  const nameOf = (id: string) => members.find((m) => m.id === id)?.displayName ?? 'Someone';
  const payerName = paidBy === me?.id ? 'You' : nameOf(paidBy);
  const wayLabel = WAYS.find((w) => w.value === way)!;
  const splitTitle =
    inSplit.length === 0
      ? 'Nobody in the split yet'
      : way === 'equal'
        ? `Split equally between ${inSplit.length}`
        : `Split ${wayLabel.label.toLowerCase()} between ${inSplit.length}`;
  const splitSub = split.bad
    ? split.note
    : way === 'equal'
      ? `${amountMinor % inSplit.length ? 'about ' : ''}${fmt(Math.floor(amountMinor / inSplit.length))} each`
      : 'Everyone’s share adds up';
  const when = expense ? `added ${dayWord(expense.createdAt)}` : 'today';

  if (byItem) {
    return (
      <ItemSplit
        items={items}
        setItems={setItems}
        description={description}
        members={members}
        meId={me?.id}
        currency={currency}
        busy={busy}
        error={error}
        onBack={() => setByItem(false)}
        onSave={(amount, parts) => {
          // The form takes on what the bill came to, so going back to it shows the same split.
          setAmountText(amountAsTyped(amount, currency));
          setWay('exact');
          setIncluded(parts.map((p) => p.memberId));
          setTyped((prev) => ({
            ...prev,
            exact: Object.fromEntries(parts.map((p) => [p.memberId, amountAsTyped(p.amount, currency)])),
          }));
          if (!description.trim()) {
            setByItem(false);
            setError('Give it a name, then save.');
            return;
          }
          void save({
            groupId,
            description: description.trim(),
            amount,
            paidByMemberId: paidBy,
            splitMode: 'exact',
            parts: parts.map((p) => ({ memberId: p.memberId, amount: p.amount })),
          });
        }}
      />
    );
  }

  return (
    <View style={s.screen}>
      <View style={[s.top, { paddingTop: insets.top + space.sm }]}>
        <Glyph name="close" label="Close without saving" onPress={onBack} />
        <View style={{ flex: 1 }}>
          <Text style={s.topLabel}>{expense ? 'Edit expense in' : 'Add expense to'}</Text>
          <Text style={s.topGroup} numberOfLines={1} accessibilityRole="header">
            {groupName ?? 'this group'}
          </Text>
        </View>
        {!locked && (
          <Pill label={expense ? 'Save changes' : 'Save'} variant="primary" busy={busy} onPress={submit} />
        )}
      </View>

      <ScrollView contentContainerStyle={[s.body, { paddingBottom: space.xxl + insets.bottom }]} keyboardShouldPersistTaps="handled">
        {locked && (
          <View style={s.notice}>
            <Text style={s.noticeText}>
              Only {payer?.displayName ?? 'the person who paid'} can change this, because they paid it.
            </Text>
          </View>
        )}
        {expense && !locked && expense.splitMode === 'shares' && (
          <Text style={s.note}>This was split by parts. It opens as the amounts each person owes.</Text>
        )}

        <View pointerEvents={locked ? 'none' : 'auto'} style={[{ gap: space.md }, locked && { opacity: 0.55 }]}>
          <View style={s.amountRow}>
            {!sats && <Text style={s.amountSymbol}>₹</Text>}
            <TextInput
              ref={amountField}
              style={s.amountInput}
              value={amountText}
              onChangeText={setAmountText}
              placeholder="0"
              placeholderTextColor={color.inkFaint}
              keyboardType={keyboard}
              accessibilityLabel={sats ? 'Amount in sats' : 'Amount in rupees'}
              autoFocus={!expense}
              // Enter goes on to what it was for, with the keyboard still up.
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => nameField.current?.focus()}
            />
            {sats && <Text style={s.amountSymbol}>sats</Text>}
          </View>

          <TextInput
            ref={nameField}
            style={s.input}
            value={description}
            onChangeText={setDescription}
            placeholder="What was it for?"
            placeholderTextColor={color.inkFaint}
            accessibilityLabel="What was it for?"
            returnKeyType="done"
          />

          <View style={s.card}>
            <Pressable
              onPress={() => setDetails(true)}
              accessibilityRole="button"
              accessibilityLabel={`Paid by ${payerName}, ${when}. Change`}
              style={({ pressed }) => [s.paidRow, pressed && { backgroundColor: color.surfaceSunken }]}
            >
              <Text style={s.paidText}>
                <Text style={s.muted}>Paid by</Text> {payerName} <Text style={s.muted}>· {when}</Text>
              </Text>
              <Glyph name="chevronRight" ink={color.inkMuted} size={16} />
            </Pressable>
            <View style={s.splitRow}>
              <Faces names={inSplit.map((m) => ({ name: m.displayName, me: m.id === me?.id }))} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={s.splitTitle}>{splitTitle}</Text>
                <Text style={[s.splitSub, split.bad && !split.quiet && { color: color.danger }]}>{splitSub}</Text>
              </View>
            </View>
            <Pressable onPress={() => setDetails(true)} accessibilityRole="button" style={s.differently}>
              <Text style={s.link}>Split differently</Text>
            </Pressable>
          </View>

          {!split.bad && split.parts && (
            <View>
              <Text style={s.previewHead}>Who pays what</Text>
              {split.parts.map((p) => (
                <View key={p.memberId} style={s.previewRow}>
                  <Text style={s.previewName}>{nameOf(p.memberId)}</Text>
                  <Text style={s.previewAmount}>{fmt(p.amount)}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {error && <ErrorState message={error} />}

        {expense && !locked && (
          <ConfirmButton
            label="Delete expense"
            confirmLabel="Yes, delete this expense"
            hint="What it made people owe goes with it."
            onConfirm={remove}
          />
        )}
      </ScrollView>

      <Sheet visible={details} onClose={() => setDetails(false)}>
        <SheetBody
          title="Who paid, how to split"
          action={<Pill label="Done" variant="primary" onPress={() => setDetails(false)} />}
        >
          <View style={{ gap: space.sm }}>
            <Text style={s.label}>Paid by</Text>
            <View style={s.chips}>
              {members.map((m) => {
                const on = paidBy === m.id;
                return (
                  <Pressable
                    key={m.id}
                    onPress={() => {
                      analytics.tap('Paid by', { control: 'chip' });
                      setPaidBy(m.id);
                    }}
                    accessibilityRole="radio"
                    aria-checked={on}
                    accessibilityState={{ selected: on }}
                    style={[s.chip, on && s.chipOn]}
                  >
                    <Text style={[s.chipText, on && s.chipTextOn]}>{m.displayName}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={s.byItemRow}>
            <Text style={s.note}>{expense ? `Added ${dayWord(expense.createdAt)}` : 'Added today'}</Text>
            <Pill
              label="Split by item"
              onPress={() => {
                setDetails(false);
                setByItem(true);
              }}
            />
          </View>

          <Segmented options={WAYS} value={way} onChange={setWay} />
          <Text style={s.note}>{wayLabel.hint}</Text>

          <View>
            {members.map((m) => {
              const on = included.includes(m.id);
              const share = split.parts?.find((p) => p.memberId === m.id);
              const field = way !== 'equal' && on;
              return (
                <View key={m.id} style={s.personRow}>
                  <Pressable
                    onPress={() => {
                      analytics.tap('Between', { control: 'row', on: !on });
                      toggle(m.id);
                    }}
                    accessibilityRole="checkbox"
                    accessibilityLabel={`Include ${m.displayName}`}
                    aria-checked={on}
                    accessibilityState={{ checked: on }}
                    style={s.personToggle}
                  >
                    <Avatar name={m.displayName} me={m.id === me?.id} dim={!on} size={32} />
                    <Text style={[s.personName, !on && s.personOut]} numberOfLines={1}>
                      {m.displayName}
                    </Text>
                  </Pressable>
                  {field && (
                    <View style={s.fieldWrap}>
                      {way === 'exact' && !sats && <Text style={s.fieldAffix}>₹</Text>}
                      <TextInput
                        style={s.field}
                        value={raw(way, m.id)}
                        onChangeText={(v) => typeFor(way, m.id, v)}
                        placeholder="0"
                        placeholderTextColor={color.inkFaint}
                        keyboardType={way === 'exact' ? keyboard : 'decimal-pad'}
                        accessibilityLabel={
                          way === 'exact'
                            ? `${m.displayName}'s amount${sats ? ' in sats' : ''}`
                            : way === 'shares'
                              ? `${m.displayName}'s parts`
                              : `${m.displayName}'s percent`
                        }
                      />
                      <Text style={s.fieldAffix}>
                        {way === 'percent' ? '%' : way === 'shares' ? 'parts' : sats ? 'sats' : ''}
                      </Text>
                    </View>
                  )}
                  {!(field && way === 'exact') && (
                    <Text style={[s.personShare, !on && s.personShareOut]}>
                      {on ? (share ? fmt(share.amount) : '—') : 'Not in this'}
                    </Text>
                  )}
                </View>
              );
            })}
          </View>
          <Text style={[s.note, split.bad && !split.quiet && { color: color.danger }]} accessibilityLiveRegion="polite">
            {split.note}
          </Text>
        </SheetBody>
      </Sheet>
    </View>
  );
}

/** "today", "yesterday", or the date. */
function dayWord(iso: string): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Up to five faces, overlapping, then how many more. */
function Faces({ names }: { names: Array<{ name: string; me: boolean }> }) {
  const color = useColors();
  const s = useStyles();
  const shown = names.slice(0, 5);
  return (
    <View style={s.faces} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {shown.map((n, i) => (
        <View key={`${n.name}-${i}`} style={[s.faceRing, i > 0 && { marginLeft: -8 }]}>
          <Avatar name={n.name} me={n.me} size={32} />
        </View>
      ))}
      {names.length > 5 && (
        <View style={[s.faceRing, { marginLeft: -8 }]}>
          <View style={[s.more, { borderColor: color.lineStrong }]}>
            <Text style={s.moreText}>+{names.length - 5}</Text>
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * Split by item. Each line on the bill, its price, and who had it; each line
 * is shared equally between them, a paisa at a time for what doesn't divide.
 * What each person comes to is shown as it changes, and saving keeps those
 * amounts as an exact split of the bill's total.
 */
function ItemSplit({
  items,
  setItems,
  description,
  members,
  meId,
  currency,
  busy,
  error,
  onBack,
  onSave,
}: {
  items: Item[];
  setItems: React.Dispatch<React.SetStateAction<Item[]>>;
  description: string;
  members: Member[];
  meId: string | undefined;
  currency: string;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onSave: (amount: number, parts: ResolvedPart[]) => void;
}) {
  const color = useColors();
  const mode = useColorMode();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const sats = isBitcoin(currency);
  const fmt = (minor: number) => formatAmount(minor, currency);

  const change = (key: number, patch: Partial<Item>) =>
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  // Members in group order, so the odd paisa lands the same way every time.
  const totals = new Map<string, number>(members.map((m) => [m.id, 0]));
  let total = 0;
  let empty: string | null = null;
  items.forEach((it, n) => {
    const price = parseAmount(it.price, currency);
    if (price <= 0) return;
    total += price;
    const who = members.filter((m) => it.who.includes(m.id));
    if (who.length === 0) {
      empty ??= it.name.trim() || `Item ${n + 1}`;
      return;
    }
    const each = Math.floor(price / who.length);
    who.forEach((m, i) => totals.set(m.id, totals.get(m.id)! + each + (i < price - each * who.length ? 1 : 0)));
  });
  const bad = total === 0 || empty !== null;
  const note =
    total === 0
      ? 'Add what was on the bill, then tap who had each thing.'
      : empty
        ? `${empty} has nobody on it yet. Tap whoever had it.`
        : `Everyone’s share adds up to ${fmt(total)}.`;

  return (
    <View style={s.screen}>
      <View style={[s.top, { paddingTop: insets.top + space.sm }]}>
        <Glyph name="back" label="Back to the expense" onPress={onBack} />
        <View style={{ flex: 1 }}>
          <Text style={s.itemTitle} accessibilityRole="header">
            Split by item
          </Text>
          <Text style={s.topLabel} numberOfLines={1}>
            {description.trim() || 'This expense'} · tap who had what
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={[s.body, { paddingBottom: space.xxl + insets.bottom }]} keyboardShouldPersistTaps="handled">
        <View>
          {items.map((it, n) => {
            const price = parseAmount(it.price, currency);
            const who = it.who.length;
            const label = it.name.trim() || `Item ${n + 1}`;
            return (
              <View key={it.key} style={s.item}>
                <View style={s.itemHead}>
                  <TextInput
                    style={[s.input, s.itemName]}
                    value={it.name}
                    onChangeText={(v) => change(it.key, { name: v })}
                    placeholder={`Item ${n + 1}`}
                    placeholderTextColor={color.inkFaint}
                    accessibilityLabel={`Item ${n + 1}`}
                  />
                  <View style={s.fieldWrap}>
                    {!sats && <Text style={s.fieldAffix}>₹</Text>}
                    <TextInput
                      style={[s.field, { width: 88 }]}
                      value={it.price}
                      onChangeText={(v) => change(it.key, { price: v })}
                      placeholder="0"
                      placeholderTextColor={color.inkFaint}
                      keyboardType={sats ? 'number-pad' : 'decimal-pad'}
                      accessibilityLabel={`Price of ${label}`}
                    />
                    {sats && <Text style={s.fieldAffix}>sats</Text>}
                  </View>
                  {items.length > 1 && (
                    <Glyph
                      name="close"
                      label={`Remove ${label}`}
                      size={18}
                      ink={color.inkMuted}
                      onPress={() => setItems((prev) => prev.filter((x) => x.key !== it.key))}
                    />
                  )}
                </View>
                <View style={s.itemWho}>
                  {members.map((m) => {
                    const on = it.who.includes(m.id);
                    const face = m.id === meId ? { bg: color.accentWash, ink: color.accent } : faceFor(m.displayName, mode);
                    return (
                      <Pressable
                        key={m.id}
                        onPress={() =>
                          change(it.key, { who: on ? it.who.filter((x) => x !== m.id) : [...it.who, m.id] })
                        }
                        accessibilityRole="checkbox"
                        accessibilityLabel={`${m.displayName} had ${label}`}
                        aria-checked={on}
                        accessibilityState={{ checked: on }}
                        style={[
                          s.whoChip,
                          on
                            ? { backgroundColor: face.bg, borderColor: face.bg }
                            : { backgroundColor: color.surface, borderColor: color.lineStrong },
                        ]}
                      >
                        <Text style={[s.whoInitial, { color: on ? face.ink : color.inkMuted }]}>
                          {initialOf(m.displayName)}
                        </Text>
                      </Pressable>
                    );
                  })}
                  <Text style={[s.each, price > 0 && who === 0 && { color: color.danger }]}>
                    {price <= 0 ? '' : who ? `${fmt(Math.floor(price / who))} each` : 'Nobody yet'}
                  </Text>
                </View>
              </View>
            );
          })}
          <Pressable
            onPress={() =>
              setItems((prev) => [...prev, { key: Math.max(-1, ...prev.map((x) => x.key)) + 1, name: '', price: '', who: [] }])
            }
            accessibilityRole="button"
            style={s.addItem}
          >
            <Glyph name="plus" ink={color.accent} size={18} weight={2.4} />
            <Text style={s.link}>Add item</Text>
          </Pressable>
        </View>

        <View style={[s.card, s.totals]}>
          {members.map((m) => (
            <View key={m.id} style={s.totalCell}>
              <View style={s.totalName}>
                <View
                  style={[
                    s.dot,
                    { backgroundColor: m.id === meId ? color.accent : faceFor(m.displayName, mode).ink },
                  ]}
                />
                <Text style={s.totalText} numberOfLines={1}>
                  {m.displayName}
                </Text>
              </View>
              <Text style={s.totalAmount}>{fmt(totals.get(m.id) ?? 0)}</Text>
            </View>
          ))}
        </View>
        <Text style={[s.note, bad && total > 0 && { color: color.danger }]} accessibilityLiveRegion="polite">
          {note}
        </Text>
        {error && <ErrorState message={error} />}
        <Pill
          label={total > 0 ? `Save ${fmt(total)}` : 'Save'}
          variant="primary"
          busy={busy}
          disabled={bad}
          onPress={() =>
            onSave(
              total,
              members.filter((m) => (totals.get(m.id) ?? 0) > 0).map((m) => ({ memberId: m.id, amount: totals.get(m.id)! }))
            )
          }
        />
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  screen: { flex: 1, backgroundColor: color.paper },
  top: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingLeft: space.sm, paddingRight: space.lg },
  topLabel: { fontSize: 12, color: color.inkMuted },
  topGroup: { fontSize: 17, fontWeight: '600', color: color.ink },
  itemTitle: { fontSize: 17, fontWeight: '700', color: color.ink },
  body: { paddingHorizontal: space.lg + 4, paddingTop: space.sm, gap: space.lg },

  notice: { padding: space.md, borderRadius: radius.md, backgroundColor: color.surfaceSunken },
  noticeText: { ...type.body, color: color.inkMuted },
  note: { fontSize: 13, lineHeight: 18, color: color.inkMuted },
  muted: { color: color.inkMuted },
  link: { fontSize: 15, fontWeight: '600', color: color.accent },
  label: { fontSize: 13, fontWeight: '500', color: color.inkMuted },

  amountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs, minHeight: 64 },
  amountSymbol: { fontSize: 32, fontWeight: '600', color: color.inkMuted },
  amountInput: {
    minWidth: 80,
    maxWidth: 260,
    fontSize: 40,
    fontWeight: '700',
    letterSpacing: -1,
    fontFamily: type.amountLg.fontFamily,
    color: color.ink,
    textAlign: 'center',
    paddingVertical: space.xs,
  },
  input: {
    height: 46,
    borderWidth: 1,
    borderColor: color.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md + 2,
    ...type.body,
    color: color.ink,
    backgroundColor: color.surface,
  },

  card: {
    backgroundColor: color.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    ...shadow,
  },
  paidRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 48,
    paddingHorizontal: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  paidText: { flex: 1, fontSize: 15, color: color.ink },
  splitRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md + 2 },
  splitTitle: { fontSize: 15, fontWeight: '600', color: color.ink },
  splitSub: { fontSize: 14, color: color.inkMuted },
  differently: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  faces: { flexDirection: 'row' },
  faceRing: { borderRadius: 999, borderWidth: 2, borderColor: color.surface },
  more: {
    width: 32,
    height: 32,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surface,
  },
  moreText: { fontSize: 12, fontWeight: '600', color: color.inkMuted },

  previewHead: { fontSize: 13, fontWeight: '500', color: color.inkMuted, paddingBottom: space.xs },
  previewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    height: 40,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  previewName: { fontSize: 15, color: color.ink },
  previewAmount: { ...type.amountMd, fontSize: 15, color: color.ink },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: space.md + 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surface,
  },
  chipOn: { backgroundColor: color.accentWash, borderColor: color.accent },
  chipText: { fontSize: 14, color: color.ink },
  chipTextOn: { fontWeight: '600', color: color.accent },
  byItemRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },

  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    minHeight: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  personToggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm + 2, minHeight: 48 },
  personName: { flex: 1, fontSize: 15, color: color.ink },
  personOut: { color: color.inkFaint, textDecorationLine: 'line-through' },
  personShare: { minWidth: 80, textAlign: 'right', ...type.amountMd, fontSize: 15, color: color.ink },
  personShareOut: { fontFamily: undefined, fontSize: 13, color: color.inkFaint },
  fieldWrap: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  fieldAffix: { fontSize: 13, color: color.inkMuted },
  field: {
    width: 76,
    height: 40,
    borderWidth: 1,
    borderColor: color.lineStrong,
    borderRadius: radius.sm + 2,
    paddingHorizontal: space.sm,
    ...type.amountMd,
    fontSize: 15,
    textAlign: 'right',
    color: color.ink,
    backgroundColor: color.surface,
  },

  item: { gap: space.sm, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  itemName: { flex: 1, minWidth: 0, height: 44 },
  itemWho: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  whoChip: { width: 44, height: 44, borderRadius: 999, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  whoInitial: { fontSize: 14, fontWeight: '600' },
  each: { marginLeft: 'auto', fontSize: 12, color: color.inkMuted, fontFamily: type.amountSm.fontFamily },
  addItem: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: 48 },
  totals: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: space.lg, paddingVertical: space.md, rowGap: 6, columnGap: space.lg + 4 },
  totalCell: { width: '44%', flexGrow: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm },
  totalName: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  dot: { width: 10, height: 10, borderRadius: 999 },
  totalText: { fontSize: 14, color: color.ink, flexShrink: 1 },
  totalAmount: { ...type.amountSm, fontSize: 14, color: color.ink },
}));
