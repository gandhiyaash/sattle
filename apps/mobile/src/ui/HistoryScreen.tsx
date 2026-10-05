/**
 * A group's history: every expense added, changed or removed, and every debt
 * settled, newest first. It opens from Settle up, where what it answers gets
 * asked: was this paid, when, and how do we know.
 *
 * A row says what happened, who did it and when. Tapping one opens the rest
 * in a sheet (HistoryEntrySheet). For a payment that is when it was paid or
 * marked as paid, how, and its proof if it has one: a Lightning payment does,
 * and one settled on someone's word has their name in its place. For an
 * expense it is who paid and each person's part, and for a change, both sides
 * of it.
 *
 * Nothing can be done from here. An expense is changed from the Expenses tab,
 * and what was changed there shows up here.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';

import {
  formatAmount,
  formatRate,
  formatSats,
  isBitcoin,
  partChanges,
  type HistoryEntry,
  type Member,
  type Settlement,
} from '@sattle/core';
import { useAsync, useClient } from '../react/SattleProvider';
import { splitSummary } from './GroupDetailScreen';
import { Amount, BreakdownRow, Button, Card, Divider, ErrorState, Loading, Screen } from './primitives';
import { copyText } from './share';
import { makeStyles, radius, space, type, useColors } from './theme';

export interface HistoryScreenProps {
  groupId: string;
  onBack: () => void;
  /** Opens one entry in full. The members and the currency are what it takes to name the people and amounts in it. */
  onOpen: (entry: HistoryEntry, members: Member[], currency: string) => void;
}

export function HistoryScreen({ groupId, onBack, onOpen }: HistoryScreenProps) {
  const color = useColors();
  const s = useStyles();
  const client = useClient();

  const { data, loading, error, reload } = useAsync(async () => {
    const [group, members, entries] = await Promise.all([
      client.getGroup(groupId),
      client.getMembers(groupId),
      client.getHistory(groupId),
    ]);
    return { name: group.name, currency: group.currency, members, entries };
  }, [groupId]);

  if (loading) {
    return (
      <Screen title="History" onBack={onBack}>
        <Loading lines={4} />
      </Screen>
    );
  }

  if (error || !data) {
    return (
      <Screen title="History" onBack={onBack}>
        <ErrorState message={error?.message ?? 'Could not load this group’s history.'} onRetry={reload} />
      </Screen>
    );
  }

  const nameOf = namer(data.members);

  return (
    <Screen title="History" subtitle={data.name} onBack={onBack}>
      {data.entries.length === 0 ? (
        <Text style={s.empty}>Nothing yet. What gets added, changed and paid in this group shows up here.</Text>
      ) : (
        <Card style={{ padding: 0 }}>
          {data.entries.map((entry, i) => (
            <View key={entry.id}>
              {i > 0 && <Divider />}
              <Pressable
                onPress={() => onOpen(entry, data.members, data.currency)}
                accessibilityRole="button"
                style={({ pressed }) => [s.row, pressed && { backgroundColor: color.surfaceSunken }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowTitle}>{titleOf(entry, nameOf)}</Text>
                  <Text style={s.rowMeta}>
                    {happened(entry, doer(entry, data.members))} · {when(entry.at)}
                  </Text>
                </View>
                <RowAmount entry={entry} currency={data.currency} />
              </Pressable>
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}

type NameOf = (memberId: string) => string;
type ExpenseEntry = Exclude<HistoryEntry, { kind: 'settled' }>;

const namer =
  (members: Member[]): NameOf =>
  (id) =>
    members.find((m) => m.id === id)?.displayName ?? 'Someone';

/** Who did it, when that was kept and they are still in the group. Otherwise the entry goes without a name. */
const doer = (entry: HistoryEntry, members: Member[]) => members.find((m) => m.id === entry.byMemberId)?.displayName;

/** The expense as the entry left it. For a removal that is how it read before, and nothing at all if that wasn't kept. */
const expenseOf = (entry: ExpenseEntry) => (entry.kind === 'expense_removed' ? entry.before : entry.expense);

/** Lightning, whichever way the invoice was reached. The other two are someone's word. */
const overLightning = (st: Settlement) => st.rail !== 'manual' && st.rail !== 'upi';

function titleOf(entry: HistoryEntry, nameOf: NameOf): string {
  if (entry.kind !== 'settled') return expenseOf(entry)?.description ?? 'An expense';
  const { fromMemberId, toMemberId, rail } = entry.settlement;
  // Marked as settled covers cash and a debt let go, so it doesn't say that anything was paid.
  return `${nameOf(fromMemberId)} ${rail === 'manual' ? 'settled with' : 'paid'} ${nameOf(toMemberId)}`;
}

/** What happened and who did it: "Added by Yash", "Marked as settled by Om", "Paid over Lightning". */
function happened(entry: HistoryEntry, by: string | undefined): string {
  const who = by ? ` by ${by}` : '';
  switch (entry.kind) {
    case 'expense_added':
      return `Added${who}`;
    case 'expense_changed':
      return `Changed${who}`;
    case 'expense_removed':
      return `Removed${who}`;
    case 'settled':
      if (entry.settlement.rail === 'manual') return `Marked as settled${who}`;
      if (entry.settlement.rail === 'upi') return by ? `Paid by UPI, confirmed by ${by}` : 'Paid by UPI';
      return 'Paid over Lightning';
  }
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * "Today, 6:42 pm", "Yesterday, 9:10 am", "3 Oct, 6:42 pm", and with the year once it isn't this one.
 * On a phone whose clock is behind the server's, something can land on what the phone still
 * thinks is tomorrow. That shows its date, which is right, where calling it today would not be.
 */
function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  const date = d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${date}, ${time}`;
}

/** The whole date and the time, for the sheet: "5 Oct 2026, 7:01 pm". */
const exactly = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "split equally, 3 ways" as the start of a line. */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function RowAmount({ entry, currency }: { entry: HistoryEntry; currency: string }) {
  const s = useStyles();
  if (entry.kind === 'settled') return <Amount minor={entry.settlement.amount} currency={currency} size="md" />;
  const expense = expenseOf(entry);
  if (!expense) return null;
  // Struck through: it no longer counts towards what anyone owes.
  if (entry.kind === 'expense_removed') return <Text style={s.rowAmountGone}>{formatAmount(expense.amount, currency)}</Text>;
  return <Amount minor={expense.amount} currency={currency} size="md" />;
}

export interface HistoryEntrySheetProps {
  entry: HistoryEntry;
  members: Member[];
  currency: string;
  onClose: () => void;
}

/** One entry in full. Drawn inside the navigator's sheet, like settling up. */
export function HistoryEntrySheet({ entry, members, currency, onClose }: HistoryEntrySheetProps) {
  const s = useStyles();
  const { height } = useWindowDimensions();
  const nameOf = namer(members);
  const by = doer(entry, members);

  return (
    // A split between many people is taller than the screen, so past most of its height the sheet scrolls.
    <ScrollView style={{ maxHeight: height * 0.85 }} contentContainerStyle={s.sheet}>
      <Text style={s.title}>{titleOf(entry, nameOf)}</Text>
      {entry.kind === 'settled' ? (
        <SettlementDetail settlement={entry.settlement} at={entry.at} by={by} nameOf={nameOf} />
      ) : (
        <ExpenseDetail entry={entry} by={by} nameOf={nameOf} currency={currency} />
      )}
      <Button label="Close" variant="quiet" onPress={onClose} />
    </ScrollView>
  );
}

function SettlementDetail({
  settlement: st,
  at,
  by,
  nameOf,
}: {
  settlement: Settlement;
  /** When it was paid, or marked as paid. */
  at: string;
  /** Whose word settled it, for one settled on someone's word. */
  by: string | undefined;
  nameOf: NameOf;
}) {
  const s = useStyles();
  const lightning = overLightning(st);
  // In sats the amount owed is the amount sent, and no rate joined them.
  const quote = lightning && !isBitcoin(st.currency) ? st.quote : undefined;
  // What was noted when it was settled says how, and for UPI it has the reference in it.
  const how = lightning ? 'Lightning' : (st.note ?? (st.rail === 'upi' ? 'Paid by UPI' : 'Settled outside the app'));

  return (
    <>
      <View style={s.amountBlock}>
        <Text style={s.amount}>{formatAmount(st.amount, st.currency)}</Text>
      </View>
      <View style={s.rows}>
        <BreakdownRow
          label={st.rail === 'manual' ? 'Marked as settled' : st.rail === 'upi' ? 'Confirmed' : 'Paid'}
          value={exactly(at)}
        />
        {by && <BreakdownRow label={st.rail === 'upi' ? 'Confirmed by' : 'Marked by'} value={by} />}
        <BreakdownRow label="How" value={how} />
        {quote && (
          <>
            <BreakdownRow label="Sent" value={formatSats(quote.amountSat)} numeric />
            <BreakdownRow label="Exchange rate" value={formatRate(quote)} numeric />
          </>
        )}
      </View>
      <Proof settlement={st} by={by} payeeName={nameOf(st.toMemberId)} />
    </>
  );
}

/**
 * The proof that a payment was made, or why there is none. Only a Lightning
 * payment can have one. Anything else was settled because someone said so,
 * and the sheet names them instead.
 */
function Proof({ settlement: st, by, payeeName }: { settlement: Settlement; by: string | undefined; payeeName: string }) {
  const s = useStyles();
  const [copied, setCopied] = useState<string | null>(null);

  if (!st.preimage) {
    return (
      <Text style={s.note}>
        {st.rail === 'manual'
          ? `No payment proof. This was settled outside the app, on ${by ? `${by}’s word` : 'the word of whoever marked it'}.`
          : st.rail === 'upi'
            ? // Only the person owed can confirm a UPI payment.
              `No payment proof. Sattle can’t see a UPI payment, so this is settled on ${by ?? payeeName}’s word that it arrived.`
            : `No payment proof was kept. ${payeeName}’s wallet said the invoice was paid.`}
      </Text>
    );
  }

  const { preimage } = st;
  return (
    <View style={s.proof}>
      <Text style={s.proofLabel}>Payment proof</Text>
      <Text style={s.proofValue} selectable>
        {preimage}
      </Text>
      <Text style={s.proofNote}>
        {st.quote?.rateSource?.kind === 'demo'
          ? 'Payments here are simulated, so this one is made up. A real one comes from the payer’s wallet.'
          : 'The payer’s wallet got this code when it paid. It matches the invoice, and nobody can make one up.'}
      </Text>
      <Button label="Copy proof" onPress={async () => setCopied(await copyText(preimage))} />
      {copied && <Text style={s.proofNote}>{copied}</Text>}
    </View>
  );
}

function ExpenseDetail({ entry, by, nameOf, currency }: { entry: ExpenseEntry; by: string | undefined; nameOf: NameOf; currency: string }) {
  const s = useStyles();
  const expense = expenseOf(entry);
  // Only a change has two sides to show.
  const before = entry.kind === 'expense_changed' ? entry.before : undefined;
  const label = entry.kind === 'expense_added' ? 'Added' : entry.kind === 'expense_changed' ? 'Changed' : 'Removed';
  const money = (minor: number) => formatAmount(minor, currency);
  /** Something an edit could have changed: both sides when it did, and how it reads when it didn't. */
  const sides = (was: string | undefined, is: string) => (was !== undefined && was !== is ? `${was} → ${is}` : is);

  const parts = !expense
    ? []
    : before
      ? partChanges(before, expense).map((p) => ({
          memberId: p.memberId,
          value:
            p.after === undefined
              ? `${money(p.before ?? 0)}, taken out`
              : p.before === undefined
                ? `${money(p.after)}, added`
                : sides(money(p.before), money(p.after)),
        }))
      : expense.parts.map((p) => ({ memberId: p.memberId, value: money(p.amount) }));

  return (
    <>
      {expense && (
        <View style={s.amountBlock}>
          <Text style={[s.amount, entry.kind === 'expense_removed' && s.amountGone]}>{money(expense.amount)}</Text>
        </View>
      )}
      <View style={s.rows}>
        <BreakdownRow label={label} value={exactly(entry.at)} />
        {by && <BreakdownRow label={`${label} by`} value={by} />}
        {expense && (
          <>
            {before && before.description !== expense.description && (
              <BreakdownRow label="Name" value={`${before.description} → ${expense.description}`} />
            )}
            {before && before.amount !== expense.amount && (
              <BreakdownRow label="Amount" value={`${money(before.amount)} → ${money(expense.amount)}`} numeric />
            )}
            <BreakdownRow
              label="Paid by"
              value={sides(before && nameOf(before.paidByMemberId), nameOf(expense.paidByMemberId))}
            />
            <BreakdownRow
              label="Split"
              value={sides(before && sentence(splitSummary(before, nameOf)), sentence(splitSummary(expense, nameOf)))}
            />
          </>
        )}
      </View>

      {parts.length > 0 && (
        <>
          <Text style={s.rowsLabel}>Each person’s part</Text>
          <View style={s.rows}>
            {parts.map((p) => (
              <BreakdownRow key={p.memberId} label={nameOf(p.memberId)} value={p.value} numeric />
            ))}
          </View>
        </>
      )}

      {!expense && <Text style={s.note}>What it said wasn’t kept.</Text>}
      {entry.kind === 'expense_changed' && !entry.before && (
        <Text style={s.note}>How it read before this change wasn’t kept. This is how it read after.</Text>
      )}
    </>
  );
}

const useStyles = makeStyles((color) => ({
  empty: { ...type.caption, color: color.inkFaint },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
  rowTitle: { ...type.body, fontWeight: '500', color: color.ink },
  rowMeta: { ...type.caption, color: color.inkFaint, marginTop: 1 },
  rowAmountGone: { ...type.amountMd, color: color.inkFaint, textDecorationLine: 'line-through' },

  sheet: { padding: space.xl, gap: space.sm },
  title: { ...type.title, color: color.ink, marginBottom: space.xs },
  amountBlock: { alignItems: 'center', marginBottom: space.md },
  amount: { ...type.amountLg, color: color.ink },
  amountGone: { color: color.inkFaint, textDecorationLine: 'line-through' },
  rows: {
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  rowsLabel: { ...type.caption, color: color.inkFaint, marginTop: space.sm },
  note: { ...type.caption, color: color.inkMuted, lineHeight: 18 },
  proof: {
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  proofLabel: { ...type.caption, color: color.inkFaint },
  proofValue: { ...type.amountSm, color: color.ink },
  proofNote: { ...type.caption, color: color.inkMuted, lineHeight: 18 },
}));
