/**
 * Group detail. The screen the demo spends most of its time on.
 *
 * One scroll, top to bottom, in the order people ask about a group:
 *
 * 1. The cover: the group's colour (coverFor) and letter, its name, and who
 *    is in it. On it, Add people, with a count when someone is waiting to be
 *    let in, and ⋯ for Manage.
 * 2. Where the user stands: owed, owing or square, and what the group has
 *    spent together next to their share of it.
 * 3. Who pays whom: every debt in the group, from groupDebts, so it is
 *    simplified into as few payments as there can be unless the group turned
 *    that off, and the switch for it is right there. The user's own rows act:
 *    Pay on what they owe; Remind, a UPI payment to confirm, and Mark as
 *    settled on what they're owed.
 * 4. Activity: the expenses by day, each with what it meant for the user.
 *    See all opens the full history, which has payments and changes too.
 *
 * Add people is one sheet for everyone who isn't in yet: people asking to
 * join, the group's link to send from any app, someone added by name, and
 * the members with where each stands. Whoever opens the link picks their
 * name and is in, unless the group approves joins under Manage: then they
 * wait in that sheet, with a code, until someone here lets them in.
 *
 * It only talks about the ways to pay the person looking uses (payWays).
 * Someone who chose rupees alone sees no Lightning here, and someone who
 * chose bitcoin alone sees no UPI, except in a group kept in bitcoin, where
 * Lightning is the only way there is.
 *
 * Add expense stays at the bottom however far the list has scrolled: it is
 * what the screen is opened for most.
 */

import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  canReceive,
  computeBalances,
  formatAmount,
  groupDebts,
  isBitcoin,
  isHeldBy,
  UPI_CURRENCY,
  type Debt,
  type Expense,
  type Member,
  type PaymentMode,
  type PayWays,
  type PendingJoin,
  type UpiClaim,
  type UpiProfile,
} from '@sattle/core';
import { analytics } from '../analytics/analytics';
import { useScreenView } from '../analytics/useScreenView';
import { toggleCurrency } from '../prefs/currencyPrefs';
import { chooseCurrencies, useCurrencyPrefs, usePayWays } from '../prefs/useCurrencyPrefs';
import { useActionKeys, useAsync, useClient, usePaymentMode } from '../react/SattleProvider';
import { groupLinkToShare } from '../react/useSettleFlow';
import {
  Avatar,
  Badge,
  Button,
  ConfirmButton,
  Dialog,
  ErrorState,
  Glyph,
  Loading,
  Pill,
  Screen,
  Sheet,
  SheetBody,
  Toast,
  useToast,
} from './primitives';
import { CoverArt } from './CoverArt';
import { QrCode } from './QrCode';
import { ShareVia } from './ShareVia';
import { coverFor, makeStyles, radius, shadow, space, type, useColorMode, useColors } from './theme';

export interface GroupDetailScreenProps {
  groupId: string;
  /** Open on Add people, with the link ready to send: the group was just made. */
  sharing?: boolean;
  /** Add people opened because of `sharing`. */
  onShared?: () => void;
  onBack: () => void;
  /** Opens the form for a new expense. `userId` is who is signed in: the payer unless they say otherwise. */
  onAddExpense: (members: Member[], currency: string, userId: string, groupName: string) => void;
  /** Opens an expense to change or delete it. `userId` is who is signed in. */
  onEditExpense: (expense: Expense, members: Member[], currency: string, userId: string, groupName: string) => void;
  /** Opens the screen for renaming, leaving and deleting the group, and for its link and backup. */
  onManage: () => void;
  /** Opens the group's history: every expense added, changed or removed, and every debt settled. */
  onHistory: () => void;
  /** Opens Wallet, where the user sets up how they get paid. */
  onOpenWallet: () => void;
  onSettle: (debt: Debt, members: Member[], groupName: string, currency: string) => void;
}

interface GroupView {
  name: string;
  currency: string;
  members: Member[];
  /** Newest first. */
  expenses: Expense[];
  debts: Debt[];
  /** What the debts would be with Simplify debts the other way, for "Why these payments?". */
  otherDebts: Debt[];
  simplifyDebts: boolean;
  /** UPI payments someone says they made, to or from the user, that the person owed hasn't confirmed. */
  claims: UpiClaim[];
  /** People asking to join, waiting on someone here to let them in. */
  waiting: PendingJoin[];
  /** Group.approveJoins: whether the link lets people in, or lets them ask. */
  approveJoins: boolean;
  /** Ghosts that no expense or payment names. */
  removable: Set<string>;
  /** Each member's net in the group: positive is owed to them, negative is what they owe. */
  nets: Map<string, number>;
  /** Everything the group has spent, and the user's part of it. */
  spent: number;
  myShare: number;
  /** The user's own UPI ID, if they've given one. */
  upi: UpiProfile;
  userId: string;
  myMemberId: string | null;
  myNet: number;
}

/** What's open over the screen. */
type Over = { kind: 'people' } | { kind: 'remind'; debt: Debt } | { kind: 'why' } | null;

/**
 * When the user last sent each reminder, by group and who it went to. Nothing
 * about a reminder reaches the server, since it went from the user's own app,
 * so this lasts as long as the app is open: enough to say "Reminded" on the
 * row and not to nag twice in a minute.
 */
const reminded = new Map<string, number>();

export function GroupDetailScreen({
  groupId,
  sharing,
  onShared,
  onBack,
  onAddExpense,
  onEditExpense,
  onManage,
  onHistory,
  onOpenWallet,
  onSettle,
}: GroupDetailScreenProps) {
  useScreenView('Group', { groupId });
  const color = useColors();
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();
  const mode = usePaymentMode();
  const prefs = useCurrencyPrefs();
  const insets = useSafeAreaInsets();
  const [over, setOver] = useState<Over>(sharing ? { kind: 'people' } : null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => (sharing ? onShared?.() : undefined), []);
  const [toast, showToast] = useToast();
  const [simplifying, setSimplifying] = useState(false);

  const { data, loading, error, reload, refresh } = useAsync<GroupView>(async () => {
    const [user, group, members, expenses, settlements, claims, waiting, upi] = await Promise.all([
      client.getCurrentUser(),
      client.getGroup(groupId),
      client.getMembers(groupId),
      client.getExpenses(groupId),
      client.getSettlements(groupId),
      client.getUpiClaims(groupId),
      client.getPendingJoins(groupId),
      client.getUpiId(),
    ]);

    const balances = computeBalances(group.memberIds, expenses, settlements);
    const mine = members.find((m) => isHeldBy(m, user.id)) ?? null;
    const named = new Set<string>();
    for (const e of expenses) {
      named.add(e.paidByMemberId);
      for (const p of e.parts) named.add(p.memberId);
    }
    for (const st of settlements) {
      named.add(st.fromMemberId);
      named.add(st.toMemberId);
    }

    return {
      name: group.name,
      currency: group.currency,
      members,
      expenses: [...expenses].reverse(),
      debts: groupDebts(group, expenses, settlements),
      otherDebts: groupDebts({ ...group, simplifyDebts: !group.simplifyDebts }, expenses, settlements),
      simplifyDebts: group.simplifyDebts,
      claims,
      waiting,
      approveJoins: group.approveJoins,
      removable: new Set(members.filter((m) => !m.claimedByUserId && !named.has(m.id)).map((m) => m.id)),
      nets: new Map(balances.map((b) => [b.memberId, b.net])),
      spent: expenses.reduce((sum, e) => sum + e.amount, 0),
      myShare: expenses.reduce(
        (sum, e) => sum + (e.parts.find((p) => p.memberId === mine?.id)?.amount ?? 0),
        0
      ),
      upi,
      userId: user.id,
      myMemberId: mine?.id ?? null,
      myNet: balances.find((b) => b.memberId === mine?.id)?.net ?? 0,
    };
  }, [groupId]);
  const ways = usePayWays(data?.currency);

  // A payment can land while this is open: a guest paying a link, someone
  // else settling up. Keep the balances current without a loading flash.
  useEffect(() => {
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      refresh();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (loading) {
    return (
      <Screen title="Loading…" onBack={onBack}>
        <Loading lines={4} />
      </Screen>
    );
  }

  if (error || !data) {
    return (
      <Screen title="Group" onBack={onBack}>
        <ErrorState message={error?.message ?? 'Could not load this group.'} error={error} onRetry={reload} />
      </Screen>
    );
  }

  const nameOf = (id: string) => data.members.find((m) => m.id === id)?.displayName ?? 'Someone';
  const fmt = (minor: number) => formatAmount(minor, data.currency);

  const me = data.members.find((m) => m.id === data.myMemberId);
  // Under real payments, money lands in the payee's own wallet or address. Without one, a link can't be paid.
  const iCanReceive = me ? canReceive(me, mode) : false;
  const owingMe = data.debts.filter((d) => d.toMemberId === data.myMemberId).map((d) => nameOf(d.fromMemberId));
  const rupees = data.currency === UPI_CURRENCY;
  // A group kept in bitcoin, joined by someone who said they don't use it. Getting paid here takes
  // Lightning, and Wallet only shows that to someone who uses bitcoin, so setting it up turns it on.
  const turnsOnBitcoin = isBitcoin(data.currency) && !prefs.uses.includes('BTC');
  const setUpGettingPaid = () => {
    if (turnsOnBitcoin) chooseCurrencies(toggleCurrency(prefs, 'BTC'));
    onOpenWallet();
  };

  // Everyone, the user first, as the cover lists them.
  const people = [...data.members].sort((a, b) => Number(b.id === data.myMemberId) - Number(a.id === data.myMemberId));
  const memberLine = people.map((m) => (m.id === data.myMemberId ? 'You' : m.displayName)).join(', ');

  const simplify = async (next: boolean) => {
    setSimplifying(true);
    try {
      await keys.run('simplify-debts', { groupId, on: next }, (k) => client.setSimplifyDebts(groupId, next, k));
      refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Couldn’t change that. Try again.');
    } finally {
      setSimplifying(false);
    }
  };

  const simple = data.simplifyDebts ? data.debts : data.otherDebts;
  const direct = data.simplifyDebts ? data.otherDebts : data.debts;
  const promise = data.simplifyDebts
    ? simple.length < direct.length
      ? `Simplified: everyone still pays or gets back exactly the same total, in ${count(simple.length, 'payment')} instead of ${direct.length}.`
      : 'Simplified: everyone pays or gets back exactly the same total, in as few payments as there can be.'
    : simple.length < direct.length
      ? `Every debt as it was spent: ${count(direct.length, 'payment')}. Turn on Simplify debts to settle in ${simple.length}.`
      : `Every debt as it was spent: ${count(direct.length, 'payment')}.`;

  return (
    <View style={s.screen}>
      <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        <Cover
          name={data.name}
          line={memberLine}
          waiting={data.waiting.length}
          onBack={onBack}
          onPeople={() => setOver({ kind: 'people' })}
          onManage={onManage}
        />

        <View style={s.body}>
          <View style={s.standing}>
            {data.expenses.length === 0 ? (
              // Zero because nothing has happened yet, not because it was paid off.
              <>
                <Text style={s.standingTitle}>No expenses yet</Text>
                <Text style={s.standingSub}>Add the first one and you’ll see who owes what.</Text>
              </>
            ) : (
              <>
                {data.myNet === 0 ? (
                  <View style={s.squareRow}>
                    <Glyph name="check" ink={color.settled} size={18} weight={2.6} />
                    <Text style={[s.standingTitle, { color: color.settled }]}>All square</Text>
                  </View>
                ) : (
                  <Text style={[s.standingTitle, { color: data.myNet > 0 ? color.owed : color.owe }]}>
                    {data.myNet > 0 ? 'You’re owed ' : 'You owe '}
                    <Text style={s.standingAmount}>{fmt(Math.abs(data.myNet))}</Text>
                  </Text>
                )}
                <Text style={s.standingSub}>
                  Spent together <Text style={s.num}>{fmt(data.spent)}</Text> · your share{' '}
                  <Text style={s.num}>{fmt(data.myShare)}</Text>
                </Text>
              </>
            )}
          </View>

          {owingMe.length > 0 && !iCanReceive && !(rupees && data.upi.upiId) && (
            <GetPaidCard names={owingMe} ways={ways} turnsOnBitcoin={turnsOnBitcoin} onSetUp={setUpGettingPaid} />
          )}

          {data.expenses.length > 0 && (
            <View style={s.card}>
              <View style={s.cardHead}>
                <Text style={s.cardTitle}>Who pays whom</Text>
                <View style={s.switchWrap}>
                  <Text style={s.switchLabel}>Simplify debts</Text>
                  <Switch
                    value={data.simplifyDebts}
                    onValueChange={(next) => {
                      analytics.tap('Simplify debts', { control: 'switch', on: next });
                      void simplify(next);
                    }}
                    disabled={simplifying}
                    accessibilityLabel="Simplify debts"
                    trackColor={{ false: color.lineStrong, true: color.accent }}
                    thumbColor={color.surface}
                    ios_backgroundColor={color.lineStrong}
                  />
                </View>
              </View>
              {data.debts.length === 0 ? (
                <View style={s.squareLine}>
                  <Text style={s.squareText}>Everyone’s square. Nothing to pay.</Text>
                </View>
              ) : (
                data.debts.map((debt) => (
                  <DebtRow
                    key={debt.id}
                    debt={debt}
                    data={data}
                    nameOf={nameOf}
                    mode={mode}
                    ways={ways}
                    onPay={() => onSettle(debt, data.members, data.name, data.currency)}
                    onRemind={() => setOver({ kind: 'remind', debt })}
                    onChanged={refresh}
                    onToast={showToast}
                  />
                ))
              )}
              <View style={s.cardFoot}>
                <Text style={s.promise}>{promise}</Text>
                <Pressable onPress={() => setOver({ kind: 'why' })} accessibilityRole="button" style={s.linkBtn}>
                  <Text style={s.link}>Why these payments?</Text>
                </Pressable>
              </View>
            </View>
          )}

          <View>
            <View style={s.activityHead}>
              <Text style={s.h2} accessibilityRole="header">
                Activity
              </Text>
              <Pressable
                onPress={() => {
                  analytics.tap('See all', { control: 'link' });
                  onHistory();
                }}
                accessibilityRole="link"
                accessibilityLabel="See all activity"
                style={s.linkBtn}
              >
                <Text style={s.link}>See all</Text>
              </Pressable>
            </View>
            {data.expenses.length === 0 ? (
              <Text style={s.emptyLine}>Nothing yet. Add the first one below.</Text>
            ) : (
              <Activity
                expenses={data.expenses}
                myMemberId={data.myMemberId}
                nameOf={nameOf}
                fmt={fmt}
                onOpen={(expense) => {
                  analytics.tap('Expense', { control: 'row' });
                  onEditExpense(expense, data.members, data.currency, data.userId, data.name);
                }}
              />
            )}
          </View>
        </View>
      </ScrollView>

      <View style={[s.footer, { paddingBottom: space.md + insets.bottom }]}>
        <Button
          label="Add expense"
          variant="primary"
          onPress={() => onAddExpense(data.members, data.currency, data.userId, data.name)}
        />
      </View>

      <Toast text={toast} bottom={88 + insets.bottom} />

      <Sheet visible={over?.kind === 'people'} onClose={() => setOver(null)}>
        {over?.kind === 'people' && (
          <AddPeopleSheet
            groupId={groupId}
            data={data}
            mode={mode}
            ways={ways}
            onChanged={refresh}
            onClose={() => setOver(null)}
          />
        )}
      </Sheet>

      <Sheet visible={over?.kind === 'remind'} onClose={() => setOver(null)}>
        {over?.kind === 'remind' && (
          <RemindSheet
            groupId={groupId}
            groupName={data.name}
            name={nameOf(over.debt.fromMemberId)}
            amount={fmt(over.debt.amount)}
            onSent={(note) => {
              reminded.set(remindKey(groupId, over.debt.fromMemberId), Date.now());
              setOver(null);
              showToast(note);
            }}
            onClose={() => setOver(null)}
          />
        )}
      </Sheet>

      <Dialog visible={over?.kind === 'why'} title="Why these payments?" onClose={() => setOver(null)}>
        <WhyPayments
          members={people}
          myMemberId={data.myMemberId}
          nets={data.nets}
          fmt={fmt}
          direct={direct.length}
          simple={simple.length}
        />
        <Button label="Got it" variant="primary" onPress={() => setOver(null)} />
      </Dialog>
    </View>
  );
}

/** "1 member", "3 members". */
export const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Om", "Om and N", "Om, N and Aman". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const remindKey = (groupId: string, memberId: string) => `${groupId}:${memberId}`;

/**
 * The top of the group: its colour, with two shapes and a dotted line drawn
 * on it so it reads as the group's own and not a plain bar, then its letter,
 * name and who is in it. White on every cover holds at least 6:1.
 */
function Cover({
  name,
  line,
  waiting,
  onBack,
  onPeople,
  onManage,
}: {
  name: string;
  line: string;
  waiting: number;
  onBack: () => void;
  onPeople: () => void;
  onManage: () => void;
}) {
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const cover = coverFor(name);
  const over = '#00000029';
  return (
    <View style={[s.cover, { backgroundColor: cover.bg, paddingTop: insets.top + space.md }]}>
      <CoverArt cover={cover} />
      <View style={s.coverBar}>
        <Glyph name="back" label="Back to groups" onPress={onBack} ink="#FFFFFF" on={over} weight={2.2} />
        <View style={s.coverActions}>
          <Glyph
            name="addPerson"
            label={waiting ? `Add people, ${waiting} waiting to join` : 'Add people'}
            onPress={onPeople}
            ink="#FFFFFF"
            on={over}
            weight={1.8}
          >
            {waiting > 0 && (
              <View style={s.waitingBadge} pointerEvents="none">
                <Text style={[s.waitingCount, { color: cover.bg }]}>{waiting}</Text>
              </View>
            )}
          </Glyph>
          <Glyph name="more" label="Manage group" onPress={onManage} ink="#FFFFFF" on={over} />
        </View>
      </View>
      <View style={s.coverTitle}>
        <View style={s.coverTile} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text style={[s.coverLetter, { color: cover.bg }]}>{(name.trim()[0] ?? '?').toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={s.coverName} accessibilityRole="header" numberOfLines={2}>
            {name}
          </Text>
          <Text style={s.coverLine} numberOfLines={1}>
            {line}
          </Text>
        </View>
      </View>
    </View>
  );
}

/**
 * One debt in Who pays whom. The user's own act: what they owe has Pay, or
 * Options when the person can't be paid here yet; what they're owed has
 * Remind, a UPI payment to answer when there is one, and Mark as settled.
 */
function DebtRow({
  debt,
  data,
  nameOf,
  mode,
  ways,
  onPay,
  onRemind,
  onChanged,
  onToast,
}: {
  debt: Debt;
  data: GroupView;
  nameOf: (id: string) => string;
  mode: PaymentMode;
  ways: PayWays;
  onPay: () => void;
  onRemind: () => void;
  onChanged: () => void;
  onToast: (line: string) => void;
}) {
  const color = useColors();
  const s = useStyles();
  const mineOut = debt.fromMemberId === data.myMemberId;
  const mineIn = debt.toMemberId === data.myMemberId;
  const fromName = nameOf(debt.fromMemberId);
  const toName = nameOf(debt.toMemberId);
  const claim = data.claims.find((x) => x.fromMemberId === debt.fromMemberId && x.toMemberId === debt.toMemberId);
  const claimWaiting = claim?.status === 'pending';

  const payee = data.members.find((m) => m.id === debt.toMemberId);
  // UPI is a way to pay someone who has no wallet here, as long as the group is in rupees.
  // Either way counts only if it is one the user is shown.
  const takesUpi = ways.upi && Boolean(payee?.upi);
  const takesLightning = ways.lightning && Boolean(payee && canReceive(payee, mode));
  const cannotReceive = mineOut && payee && !takesLightning && !takesUpi;
  const sentAt = reminded.get(remindKey(debt.groupId, debt.fromMemberId));

  return (
    <View style={s.debt}>
      <View style={s.debtRow}>
        <Avatar name={fromName} me={mineOut} size={32} />
        <Text style={s.debtLine}>
          {mineOut ? 'You' : fromName} <Text style={s.muted}>{mineOut ? 'pay' : 'pays'}</Text>{' '}
          {mineIn ? 'you' : toName}
        </Text>
        <Text style={[s.debtAmount, { color: mineIn ? color.owed : mineOut ? color.owe : color.ink }]}>
          {formatAmount(debt.amount, data.currency)}
        </Text>
        {mineOut && !claimWaiting && (
          <Pill
            label={cannotReceive ? 'Options' : 'Pay'}
            variant={cannotReceive ? 'outline' : 'primary'}
            accessibilityLabel={cannotReceive ? `Options for paying ${toName}` : `Pay ${toName}`}
            onPress={onPay}
          />
        )}
        {mineIn && !claimWaiting && (
          <Pill
            label={sentAt ? 'Reminded' : 'Remind'}
            variant={sentAt ? 'soft' : 'outline'}
            track="Remind"
            accessibilityLabel={sentAt ? `Remind ${fromName} again, last reminded ${ago(new Date(sentAt).toISOString())}` : `Remind ${fromName}`}
            onPress={onRemind}
          />
        )}
      </View>
      {claim && (
        <UpiClaimPanel
          claim={claim}
          mine={mineOut}
          otherName={mineOut ? toName : fromName}
          currency={data.currency}
          onChanged={onChanged}
          onToast={onToast}
        />
      )}
      {/* Nothing to send from here: they pay from the group's link, under Add people. */}
      {mineIn && !claimWaiting && <MarkSettled debt={debt} onSettled={onChanged} />}
      {cannotReceive && payee && <Text style={s.rowNote}>{cannotReceiveNote(payee, mode, ways)}</Text>}
    </View>
  );
}

/** The expenses, newest first, under the day each was added. */
function Activity({
  expenses,
  myMemberId,
  nameOf,
  fmt,
  onOpen,
}: {
  expenses: Expense[];
  myMemberId: string | null;
  nameOf: (id: string) => string;
  fmt: (minor: number) => string;
  onOpen: (expense: Expense) => void;
}) {
  const color = useColors();
  const s = useStyles();
  const days: Array<{ key: string; label: string; date: string; items: Expense[] }> = [];
  for (const e of expenses) {
    const key = new Date(e.createdAt).toDateString();
    const last = days[days.length - 1];
    if (last?.key === key) last.items.push(e);
    else days.push({ key, ...dayLabel(e.createdAt), items: [e] });
  }
  return (
    <View style={{ gap: space.md + 2 }}>
      {days.map((day) => (
        <View key={day.key} style={{ gap: space.sm }}>
          <Text style={s.dayLabel}>
            {day.label}
            {day.date ? <Text style={s.dayDate}> {day.date}</Text> : null}
          </Text>
          <View style={s.listCard}>
            {day.items.map((expense, i) => {
              const mine = expense.parts.find((p) => p.memberId === myMemberId)?.amount ?? 0;
              const paidByMe = expense.paidByMemberId === myMemberId;
              const lent = paidByMe ? expense.amount - mine : 0;
              const side = paidByMe
                ? lent > 0
                  ? { label: 'you lent', amount: lent, tone: color.owed }
                  : { label: 'just you', amount: null, tone: color.inkMuted }
                : mine > 0
                  ? { label: 'you borrowed', amount: mine, tone: color.owe }
                  : { label: 'not in this', amount: null, tone: color.inkMuted };
              return (
                <Pressable
                  key={expense.id}
                  onPress={() => onOpen(expense)}
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    s.expenseRow,
                    i < day.items.length - 1 && s.rowLine,
                    pressed && { backgroundColor: color.surfaceSunken },
                  ]}
                >
                  <View style={s.expenseTile} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <Text style={s.expenseLetter}>{(expense.description.trim()[0] ?? '?').toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Text style={s.expenseName} numberOfLines={1}>
                      {expense.description}
                    </Text>
                    <Text style={s.expenseMeta} numberOfLines={1}>
                      {paidByMe ? 'You' : nameOf(expense.paidByMemberId)} paid {fmt(expense.amount)} · {clock(expense.createdAt)}
                    </Text>
                    <Text style={s.expenseMeta} numberOfLines={1}>
                      {splitSummary(expense, nameOf)}
                    </Text>
                  </View>
                  <View style={s.expenseSide}>
                    <Text style={[s.sideLabel, { color: side.tone }]}>{side.label}</Text>
                    {side.amount !== null && (
                      <Text style={[s.sideAmount, { color: side.tone }]}>{fmt(side.amount)}</Text>
                    )}
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

/** "Today", "Yesterday", "Tuesday" within the week, then the date. */
function dayLabel(iso: string): { label: string; date: string } {
  const d = new Date(iso);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86_400_000);
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'long' });
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (days === 0) return { label: 'Today', date: `${weekday.slice(0, 3)} ${date}` };
  if (days === 1) return { label: 'Yesterday', date: `${weekday.slice(0, 3)} ${date}` };
  if (days > 1 && days < 7) return { label: weekday, date };
  return { label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }), date: '' };
}

/** "8:40 pm". */
function clock(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/** Each person's total, which simplifying never changes, and how many payments it takes each way. */
function WhyPayments({
  members,
  myMemberId,
  nets,
  fmt,
  direct,
  simple,
}: {
  members: Member[];
  myMemberId: string | null;
  nets: Map<string, number>;
  fmt: (minor: number) => string;
  direct: number;
  simple: number;
}) {
  const s = useStyles();
  const rows = members.filter((m) => (nets.get(m.id) ?? 0) !== 0);
  return (
    <View style={{ gap: space.md }}>
      <Text style={s.whyBody}>
        Simplify debts only changes who pays whom. Each person’s total stays exactly the same:
      </Text>
      <View style={s.table}>
        <View style={[s.tableRow, s.tableHead]}>
          <Text style={[s.tableCell, s.tableHeadText, { flex: 1.3 }]}>Person</Text>
          <Text style={[s.tableCell, s.tableHeadText, s.right]}>As spent</Text>
          <Text style={[s.tableCell, s.tableHeadText, s.right]}>Simplified</Text>
        </View>
        {rows.map((m) => {
          const net = nets.get(m.id) ?? 0;
          const you = m.id === myMemberId;
          const who = `${you ? 'You' : m.displayName} ${net > 0 ? (you ? 'get back' : 'gets back') : you ? 'pay' : 'pays'}`;
          return (
            <View key={m.id} style={s.tableRow}>
              <Text style={[s.tableCell, { flex: 1.3 }]}>{who}</Text>
              <Text style={[s.tableCell, s.tableNum]}>{fmt(Math.abs(net))}</Text>
              <Text style={[s.tableCell, s.tableNum]}>{fmt(Math.abs(net))}</Text>
            </View>
          );
        })}
        <View style={s.tableRow}>
          <Text style={[s.tableCell, s.tableStrong, { flex: 1.3 }]}>Payments</Text>
          <Text style={[s.tableCell, s.tableStrong, s.tableNum]}>{direct}</Text>
          <Text style={[s.tableCell, s.tableStrong, s.tableNum]}>{simple}</Text>
        </View>
      </View>
    </View>
  );
}

/**
 * People owe the user, and there is nowhere for them to pay it: no wallet or
 * Lightning address, and in a rupee group no UPI ID either. Without this, the
 * people owing are told they can't pay here yet and the user never finds out why.
 * It names only the ways the user is shown, which are the ones Wallet will offer.
 */
function GetPaidCard({
  names,
  ways,
  turnsOnBitcoin,
  onSetUp,
}: {
  names: string[];
  ways: PayWays;
  /** The group is kept in bitcoin and they don't use it yet: setting up is what starts them using it. */
  turnsOnBitcoin: boolean;
  onSetUp: () => void;
}) {
  const s = useStyles();
  const who = listNames(names);
  return (
    <View style={[s.card, s.getPaid]}>
      <Text style={s.getPaidTitle}>{who} can’t pay you yet</Text>
      <Text style={s.getPaidBody}>
        {!ways.lightning ? 'Add your UPI ID so they can pay you.' : 'Add a way to get paid so they can pay you.'}
      </Text>
      {turnsOnBitcoin && <Text style={s.note}>This also turns on Bitcoin for you.</Text>}
      <Button label="Set up getting paid" variant="primary" onPress={onSetUp} />
    </View>
  );
}

/**
 * A reminder, written for the user and sent by them from any app they use.
 * Sattle sends nothing: the person may not have the app, and a message from
 * a friend gets read.
 */
function RemindSheet({
  groupId,
  groupName,
  name,
  amount,
  onSent,
  onClose,
}: {
  groupId: string;
  groupName: string;
  name: string;
  amount: string;
  onSent: (note: string) => void;
  onClose: () => void;
}) {
  const s = useStyles();
  const client = useClient();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    groupLinkToShare(client, groupId).then(
      (link) => live && setUrl(link.url),
      (e) => live && setFailed(e instanceof Error ? e.message : 'Couldn’t make a link. Try again.')
    );
    return () => {
      live = false;
    };
  }, [client, groupId]);

  const message = `Hey ${name}, your share for ${groupName} comes to ${amount}. Pay whenever you get a sec, no app needed: ${url ?? ''}`;

  return (
    <SheetBody title={`Remind ${name}`} subtitle="Sent by you, from any app you use. You can change it before it goes.">
      {failed ? (
        <ErrorState message={failed} />
      ) : !url ? (
        <Loading lines={2} />
      ) : (
        <>
          <View style={s.bubble}>
            <Text style={s.bubbleText}>{message}</Text>
          </View>
          <ShareVia message={message} label="Send with" onDone={(_, note) => onSent(note)} />
        </>
      )}
      <Button label="Not now" variant="quiet" onPress={onClose} />
    </SheetBody>
  );
}

/**
 * Everyone who isn't in the group yet, and everyone who is. In order: people
 * waiting to be let in, since someone is waiting on that; the group's link,
 * which is how most people join; adding someone by name, from the user's
 * other groups or typed; and the members, with where each stands.
 */
function AddPeopleSheet({
  groupId,
  data,
  mode,
  ways,
  onChanged,
  onClose,
}: {
  groupId: string;
  data: GroupView;
  mode: PaymentMode;
  ways: PayWays;
  onChanged: () => void;
  onClose: () => void;
}) {
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();
  const [link, setLink] = useState<{ url: string } | { failed: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [qr, setQr] = useState(false);
  const [suggest, setSuggest] = useState<Array<{ name: string; from: string }>>([]);
  const [lastAdded, setLastAdded] = useState<string | null>(null);

  // The group's one link. Opening this makes it if there isn't one, as Invite always has.
  useEffect(() => {
    let live = true;
    groupLinkToShare(client, groupId).then(
      (l) => live && setLink({ url: l.url }),
      (e) => live && setLink({ failed: e instanceof Error ? e.message : 'Couldn’t make a link. Try again.' })
    );
    return () => {
      live = false;
    };
  }, [client, groupId]);

  // People from the user's other groups, to add with a tap. Names only: Sattle has no contacts.
  useEffect(() => {
    let live = true;
    (async () => {
      const groups = (await client.getGroups()).filter((g) => g.id !== groupId).slice(0, 8);
      const lists = await Promise.all(groups.map((g) => client.getMembers(g.id).then((ms) => ({ g, ms }))));
      const here = new Set(data.members.map((m) => m.displayName.toLowerCase()));
      const seen = new Set<string>();
      const out: Array<{ name: string; from: string }> = [];
      for (const { g, ms } of lists) {
        for (const m of ms) {
          const key = m.displayName.toLowerCase();
          if (m.claimedByUserId === data.userId || here.has(key) || seen.has(key)) continue;
          seen.add(key);
          out.push({ name: m.displayName, from: g.name });
        }
      }
      if (live) setSuggest(out.slice(0, 6));
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [client, groupId, data.members, data.userId]);

  const message =
    link && 'url' in link
      ? `Here’s what we’ve split in "${data.name}". See what you owe and pay it, no app needed. To join the group, tap Join there and ${
          data.approveJoins ? 'I’ll let you in' : 'pick your name'
        }: ${link.url}`
      : '';

  return (
    <SheetBody title="Add people" subtitle={`to ${data.name}`} onClose={onClose}>
      {data.waiting.length > 0 && (
        <View style={s.section} accessibilityLabel="Waiting to join">
          <Text style={s.h3}>Waiting to join · {data.waiting.length}</Text>
          {data.waiting.map((req) => (
            <JoinRequestCard
              key={req.id}
              request={req}
              // Two people asking to be one name: the code is how to tell which is real.
              twin={data.waiting.some((x) => x.id !== req.id && x.existing && req.existing && x.name === req.name)}
              groupName={data.name}
              onChanged={onChanged}
            />
          ))}
        </View>
      )}

      <View style={s.section}>
        <Text style={s.h3}>Share the group link</Text>
        {link === null ? (
          <Loading lines={1} />
        ) : 'failed' in link ? (
          <ErrorState message={link.failed} />
        ) : (
          <>
            <View style={s.linkBox}>
              <Glyph name="link" size={18} />
              <Text style={s.linkText} selectable numberOfLines={1}>
                {link.url}
              </Text>
            </View>
            <ShareVia message={message} copy={link.url} label="Share the link with" onDone={(_, line) => setNote(line)} />
            {note && <Text style={s.note}>{note}</Text>}
            <Text style={s.note}>
              {data.approveJoins
                ? 'Anyone with the link can see the group and pay. To join, someone here lets them in.'
                : 'Anyone with the link can see the group, pay, and join. No app needed.'}
            </Text>
            <Pressable onPress={() => setQr(!qr)} accessibilityRole="button" style={s.linkBtn}>
              <Text style={s.link}>{qr ? 'Hide QR code' : 'Show QR code'}</Text>
            </Pressable>
            {qr && (
              <View style={s.qr}>
                <QrCode value={link.url} size={200} />
              </View>
            )}
          </>
        )}
      </View>

      <View style={[s.section, s.sectionRule]}>
        <Text style={s.h3}>Add someone yourself</Text>
        <AddMember
          groupId={groupId}
          suggest={suggest}
          onAdded={(name) => {
            setLastAdded(name);
            setSuggest((prev) => prev.filter((x) => x.name.toLowerCase() !== name.toLowerCase()));
            onChanged();
          }}
        />
        <View style={s.infoBox}>
          <Glyph name="info" size={18} />
          <Text style={s.infoText}>
            {lastAdded
              ? `${lastAdded} starts at nothing owed and isn’t in earlier expenses. Add them to any they shared.`
              : 'New people start at nothing owed and aren’t added to earlier expenses. You can add them to any they shared.'}
          </Text>
        </View>
      </View>

      <View style={[s.section, s.sectionRule, { gap: 0 }]}>
        <Text style={[s.h3, { marginBottom: space.xs }]}>In this group · {data.members.length}</Text>
        {data.members.map((member) => (
          <View key={member.id}>
            <MemberRow
              member={member}
              isMe={member.id === data.myMemberId}
              mode={mode}
              ways={ways}
              // Before any expense there is nothing to be square about.
              net={data.expenses.length > 0 ? (data.nets.get(member.id) ?? 0) : undefined}
              currency={data.currency}
            />
            {data.removable.has(member.id) && (
              <View style={s.memberAction}>
                <ConfirmButton
                  label={`Remove ${member.displayName}`}
                  confirmLabel={`Yes, remove ${member.displayName}`}
                  track="Remove member"
                  onConfirm={async () => {
                    await keys.run('remove-member', { groupId, id: member.id }, (k) =>
                      client.removeMember(groupId, member.id, k)
                    );
                    onChanged();
                  }}
                />
              </View>
            )}
          </View>
        ))}
      </View>

      <Button label="Done" variant="primary" onPress={onClose} />
    </SheetBody>
  );
}

/**
 * Someone asking to join. They can't see or change anything until someone
 * here lets them in. Holding the link proves nothing, since it can be
 * forwarded, so the card says to let in only someone you know is them.
 */
function JoinRequestCard({
  request,
  twin,
  groupName,
  onChanged,
}: {
  request: PendingJoin;
  /** Someone else is asking to be the same person. */
  twin: boolean;
  groupName: string;
  onChanged: () => void;
}) {
  const s = useStyles();
  const mode = useColorMode();
  const client = useClient();
  const keys = useActionKeys();
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: 'approve' | 'decline') => {
    setBusy(action);
    setError(null);
    try {
      await keys.run<unknown>(`join-${action}`, { id: request.id }, (k) =>
        action === 'approve' ? client.approveJoin(request.id, k) : client.declineJoin(request.id, k)
      );
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That didn’t work. Try again.');
      setBusy(null);
      onChanged();
    }
  };

  return (
    <View style={[s.waitCard, { backgroundColor: mode === 'dark' ? '#3D2C10' : '#FBEFD9' }]}>
      <View style={s.waitHead}>
        {/* Ringed, since a face's tint can be the card's own. */}
        <View style={s.ring}>
          <Avatar name={request.name} size={40} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={s.waitName}>
            {request.joined === 'you'
              ? 'Someone says they’re you, on another device'
              : request.joined
                ? `Someone says they’re ${request.name}, on another device`
                : request.existing
                  ? `Someone wants to join as ${request.name}`
                  : `${request.name} wants to join`}
          </Text>
          <Text style={s.waitMeta}>
            {request.existing ? 'Asked to join as someone already here' : 'Asked to join as a new person'} ·{' '}
            {ago(request.createdAt)}
          </Text>
        </View>
      </View>
      <Text style={s.waitCode}>
        Check it’s them: their screen shows <Text style={s.code}>{request.code}</Text>
      </Text>
      <Text style={s.note}>{joinRequestNote(request, twin, groupName)}</Text>
      <View style={s.pair}>
        <Pill label="Decline" grow busy={busy === 'decline'} disabled={busy !== null} onPress={() => act('decline')} />
        <Pill
          label={`Let ${request.name} in`}
          track="Let in"
          variant="primary"
          grow
          busy={busy === 'approve'}
          disabled={busy !== null}
          onPress={() => act('approve')}
        />
      </View>
      {error && <Text style={s.error}>{error}</Text>}
    </View>
  );
}

/** What letting this person in would do, under who they are. */
function joinRequestNote(request: PendingJoin, twin: boolean, groupName: string): string {
  const { name } = request;
  if (request.joined === 'you') {
    return `Only if it’s you. They’d be you in ${groupName} too, alongside this device.`;
  }
  if (request.joined) {
    return `Only if you’ve checked with ${name}: they’d be ${name} too, alongside their other device. Ask which code they see.`;
  }
  if (twin) {
    return `More than one person wants to be ${name}. Ask ${name} which code they see.`;
  }
  if (request.existing) {
    return `Only let in if it’s ${name}. Ask which code they see.`;
  }
  return `They’ll see and add to ${groupName}, starting at nothing owed.`;
}

/** "just now", "5 min ago", "2 h ago", "3 days ago". */
function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** How an expense was divided, e.g. "split by shares, 3 ways". */
export function splitSummary(expense: Expense, nameOf: (id: string) => string): string {
  const n = expense.parts.length;
  if (n === 1) return `all for ${nameOf(expense.parts[0].memberId)}`;
  switch (expense.splitMode) {
    case 'shares':
      return `split by shares, ${n} ways`;
    case 'exact':
      return `exact amounts, ${n} ways`;
    default:
      return `split equally, ${n} ways`;
  }
}

/** Under a debt you can't pay here yet: why, and what Options offers. */
function cannotReceiveNote(member: Member, mode: PaymentMode, ways: PayWays): string {
  const name = member.displayName;
  // UPI is the only way they're shown, and this person hasn't given a UPI ID.
  if (!ways.lightning) {
    return member.claimedByUserId ? `${name} hasn’t added a UPI ID yet.` : `${name} hasn’t joined yet.`;
  }
  if (mode === 'simulated') return `${name} hasn’t joined yet.`;
  return member.claimedByUserId ? `${name} can’t be paid here yet.` : `${name} hasn’t joined yet.`;
}

const REFRESH_MS = 4000;

/**
 * One member, with their state in terms of the ways to pay the user is
 * shown, and where they stand in the group: what they owe, what they get
 * back, or settled.
 */
function MemberRow({
  member,
  isMe,
  mode,
  ways,
  net,
  currency,
}: {
  member: Member;
  isMe: boolean;
  mode: PaymentMode;
  ways: PayWays;
  /** Their net in the group; undefined before there is anything to owe. */
  net: number | undefined;
  currency: string;
}) {
  const color = useColors();
  const s = useStyles();
  const lightning = ways.lightning && canReceive(member, mode);
  // Someone with only a UPI ID can still be paid here, in a rupee group.
  const upiOnly = ways.upi && Boolean(member.upi) && !lightning;
  const state =
    member.status === 'ghost'
      ? (ways.lightning && member.lightningAddress) || 'Hasn’t joined · pays from links'
      : member.status === 'nwc_linked' && ways.lightning
        ? 'Joined'
        : upiOnly
          ? 'Joined · takes UPI'
          : ways.lightning && mode === 'real' && !lightning
            ? 'Joined · can’t be paid yet'
            : 'Joined';
  return (
    <View style={s.memberRow}>
      <Avatar name={member.displayName} me={isMe} dim={member.status === 'ghost'} size={40} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={s.memberName}>
          {member.displayName}
          {isMe ? ' (you)' : ''}
        </Text>
        <Text style={s.memberMeta}>{state}</Text>
      </View>
      <View style={s.memberSide}>
        {net !== undefined &&
          (net === 0 ? (
            <Text style={[s.memberMeta, { color: color.settled }]}>settled</Text>
          ) : (
            <>
              <Text style={s.memberMeta}>{net > 0 ? 'gets back' : 'owes'}</Text>
              <Text style={[s.sideAmount, { color: net > 0 ? color.owed : color.owe }]}>
                {formatAmount(Math.abs(net), currency)}
              </Text>
            </>
          ))}
        {member.status === 'ghost' && lightning && <Badge text="Payable" tone="accent" />}
      </View>
    </View>
  );
}

/** Adds a ghost by name, typed or tapped from another group. Like everyone else here, they don't need the app. */
function AddMember({
  groupId,
  suggest,
  onAdded,
}: {
  groupId: string;
  suggest: Array<{ name: string; from: string }>;
  onAdded: (name: string) => void;
}) {
  const color = useColors();
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (raw: string) => {
    const displayName = raw.trim();
    if (!displayName || busy) return;
    setBusy(true);
    setError(null);
    try {
      await keys.run('add-member', { groupId, displayName }, (k) => client.addMember(groupId, displayName, k));
      setName('');
      onAdded(displayName);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t add them. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: space.sm + 2 }}>
      <View style={s.addRow}>
        <TextInput
          style={s.addInput}
          value={name}
          onChangeText={setName}
          onSubmitEditing={() => add(name)}
          returnKeyType="done"
          placeholder="Their name"
          placeholderTextColor={color.inkFaint}
          accessibilityLabel="Their name"
        />
        <Pill
          label="Add"
          variant={name.trim() ? 'primary' : 'soft'}
          busy={busy}
          disabled={!name.trim()}
          onPress={() => add(name)}
        />
      </View>
      {error && <Text style={s.error}>{error}</Text>}
      {suggest.length > 0 && (
        <View style={{ gap: space.sm }}>
          <Text style={s.note}>From your other groups</Text>
          <View style={s.chips}>
            {suggest.map((g) => (
              <Pressable
                key={g.name}
                onPress={() => {
                  analytics.tap('Add from another group', { control: 'chip' });
                  void add(g.name);
                }}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={`Add ${g.name}, from ${g.from}`}
                style={({ pressed }) => [s.suggest, pressed && { opacity: 0.8 }]}
              >
                <Avatar name={g.name} size={32} />
                <Text style={s.suggestName}>{g.name}</Text>
                <Glyph name="plus" ink={color.accent} size={14} weight={2.6} />
              </Pressable>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * The payee's side of "paid in cash". Only they can record it for someone
 * who has joined, so this is where it lives; the payer's sheet tells them to
 * ask. One tap: it is their money, so it is their word to give, and the
 * history says whose it was.
 */
function MarkSettled({ debt, onSettled }: { debt: Debt; onSettled: () => void }) {
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();
  const [state, setState] = useState<'idle' | 'busy' | { failed: string }>('idle');

  const settle = async () => {
    setState('busy');
    const input = {
      groupId: debt.groupId,
      fromMemberId: debt.fromMemberId,
      toMemberId: debt.toMemberId,
      amount: debt.amount,
      note: 'Settled outside the app',
    };
    try {
      await keys.run('settle-manual', input, (k) => client.markSettledManually(input, k));
      onSettled();
    } catch (e) {
      setState({ failed: e instanceof Error ? e.message : 'Couldn’t mark it settled. Try again.' });
    }
  };

  return (
    <View style={s.under}>
      <View style={s.settledRow}>
        <Text style={s.note}>Paid you another way?</Text>
        <Pressable onPress={settle} disabled={state === 'busy'} accessibilityRole="button" style={s.linkBtn}>
          <Text style={[s.link, state === 'busy' && { opacity: 0.4 }]}>Mark as settled</Text>
        </Pressable>
      </View>
      {typeof state === 'object' && <Text style={s.error}>{state.failed}</Text>}
    </View>
  );
}

/**
 * A UPI payment someone says they made, on the debt it is for. Sattle can't
 * see it, so the person owed is asked whether it arrived; that is what
 * settles it. The payer sees that it is waiting, or that it was turned down,
 * and can take it back.
 */
function UpiClaimPanel({
  claim,
  mine,
  otherName,
  currency,
  onChanged,
  onToast,
}: {
  claim: UpiClaim;
  /** The user is the one who paid. Otherwise they are the one owed. */
  mine: boolean;
  otherName: string;
  currency: string;
  onChanged: () => void;
  onToast: (line: string) => void;
}) {
  const s = useStyles();
  const mode = useColorMode();
  const client = useClient();
  const keys = useActionKeys();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const amount = formatAmount(claim.amount, currency);
  const declined = claim.status === 'declined';

  const act = async (action: string, fn: (key: string) => Promise<unknown>, done?: string) => {
    setBusy(action);
    setError(null);
    try {
      await keys.run(action, { id: claim.id }, fn);
      if (done) onToast(done);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(null);
    }
  };

  if (mine) {
    return (
      <View style={s.under}>
        <Text style={declined ? s.error : s.note}>
          {declined
            ? `${otherName} says the UPI payment of ${amount} didn’t arrive.`
            : claim.viaLink
              ? `Waiting for ${otherName} to confirm this UPI payment of ${amount}.`
              : `Waiting for ${otherName} to confirm your UPI payment of ${amount}.`}
        </Text>
        <View style={{ alignSelf: 'flex-start' }}>
          <Pill
            label={declined ? 'OK' : 'I didn’t pay after all'}
            busy={busy === 'upi-withdraw'}
            onPress={() => act('upi-withdraw', (k) => client.withdrawUpiClaim(claim.id, k))}
          />
        </View>
        {error && <Text style={s.error}>{error}</Text>}
      </View>
    );
  }

  if (declined) {
    return (
      <View style={s.under}>
        <Text style={s.note}>You said {otherName}’s UPI payment of {amount} didn’t arrive.</Text>
        <View style={{ alignSelf: 'flex-start' }}>
          <Pill
            label="It arrived after all"
            busy={busy === 'upi-confirm'}
            onPress={() => act('upi-confirm', (k) => client.confirmUpiClaim(claim.id, k), `Marked as paid. ${amount} from ${otherName} is in the history.`)}
          />
        </View>
        {error && <Text style={s.error}>{error}</Text>}
      </View>
    );
  }

  return (
    <View style={[s.claim, { backgroundColor: mode === 'dark' ? '#173A28' : '#E4F1EA' }]}>
      <View style={{ gap: 2 }}>
        <Text style={s.claimTitle}>
          {claim.viaLink ? `Someone on a shared link says ${otherName} paid` : `${otherName} says they paid`} you {amount} by UPI
        </Text>
        <Text style={s.claimMeta}>
          {claim.reference ? `UPI ref ${claim.reference} · ` : ''}
          {ago(claim.createdAt)} · Check your UPI app
        </Text>
      </View>
      <View style={s.pair}>
        <Pill
          label="Didn’t arrive"
          grow
          busy={busy === 'upi-decline'}
          disabled={busy !== null}
          onPress={() => act('upi-decline', (k) => client.declineUpiClaim(claim.id, k), `${otherName} will see it didn’t arrive.`)}
        />
        <Pill
          label="Got it"
          variant="primary"
          grow
          busy={busy === 'upi-confirm'}
          disabled={busy !== null}
          onPress={() => act('upi-confirm', (k) => client.confirmUpiClaim(claim.id, k), `Marked as paid. ${amount} from ${otherName} is in the history.`)}
        />
      </View>
      {error && <Text style={s.error}>{error}</Text>}
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  screen: { flex: 1, backgroundColor: color.paper },

  cover: { paddingHorizontal: space.lg + 4, paddingBottom: 38, gap: space.md + 2, overflow: 'hidden' },
  coverBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  coverActions: { flexDirection: 'row', gap: space.sm },
  waitingBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  waitingCount: { fontSize: 11, fontWeight: '800' },
  coverTitle: { flexDirection: 'row', alignItems: 'center', gap: space.md + 2 },
  coverTile: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow,
  },
  coverLetter: { fontSize: 26, fontWeight: '800' },
  coverName: { fontSize: 26, fontWeight: '700', letterSpacing: -0.5, color: '#FFFFFF' },
  coverLine: { fontSize: 14, color: '#FFFFFFD9' },

  // Rises over the bottom of the cover, so the page reads as lying on it.
  body: {
    flexGrow: 1,
    marginTop: -20,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    backgroundColor: color.paper,
    paddingHorizontal: space.lg + 4,
    paddingTop: space.lg + 4,
    paddingBottom: space.xl,
    gap: space.lg,
  },
  standing: { gap: 2 },
  standingTitle: { fontSize: 15, fontWeight: '600', color: color.ink },
  standingAmount: { ...type.amountLg, fontSize: 26 },
  standingSub: { fontSize: 13, color: color.inkMuted },
  squareRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  num: { fontFamily: type.amountSm.fontFamily },

  card: {
    backgroundColor: color.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    ...shadow,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingLeft: space.lg,
    paddingRight: space.md,
    minHeight: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  cardTitle: { fontSize: 15, fontWeight: '600', color: color.ink },
  switchWrap: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  switchLabel: { fontSize: 13, color: color.ink },
  squareLine: { paddingHorizontal: space.lg, paddingVertical: space.md },
  squareText: { ...type.body, color: color.inkMuted },
  cardFoot: { paddingHorizontal: space.lg, paddingTop: space.sm + 2, paddingBottom: space.xs, gap: 2 },
  promise: { fontSize: 13, lineHeight: 19, color: color.inkMuted },
  linkBtn: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  link: { fontSize: 14, fontWeight: '600', color: color.accent },

  debt: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line, paddingBottom: space.xs },
  debtRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 2, minHeight: 56, paddingLeft: space.lg, paddingRight: space.md },
  debtLine: { flex: 1, fontSize: 15, color: color.ink },
  muted: { color: color.inkMuted },
  debtAmount: { ...type.amountMd, fontSize: 15, fontWeight: '600' },
  // Lines up under the names: row padding, face, gap.
  under: { marginLeft: space.lg + 32 + space.sm + 2, marginRight: space.md, marginBottom: space.sm, gap: space.xs },
  settledRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  rowNote: { ...type.caption, color: color.inkMuted, marginLeft: space.lg + 32 + space.sm + 2, marginBottom: space.sm },
  claim: {
    marginLeft: space.lg + 32 + space.sm + 2,
    marginRight: space.md,
    marginBottom: space.md,
    padding: space.md,
    borderRadius: radius.md + 2,
    gap: space.sm + 2,
  },
  claimTitle: { fontSize: 14, fontWeight: '600', color: color.ink },
  claimMeta: { fontSize: 12, color: color.inkMuted },
  pair: { flexDirection: 'row', gap: space.sm },

  activityHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  h2: { fontSize: 16, fontWeight: '700', color: color.ink },
  h3: { fontSize: 15, fontWeight: '700', color: color.ink },
  emptyLine: { ...type.body, color: color.inkMuted },
  dayLabel: { fontSize: 13, fontWeight: '700', color: color.ink },
  dayDate: { fontWeight: '400', color: color.inkFaint },
  listCard: {
    backgroundColor: color.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    overflow: 'hidden',
    ...shadow,
  },
  expenseRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, paddingHorizontal: space.md + 2 },
  rowLine: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line },
  expenseTile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: color.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  expenseLetter: { fontSize: 17, fontWeight: '700', color: color.inkMuted },
  expenseName: { fontSize: 15, fontWeight: '600', color: color.ink },
  expenseMeta: { fontSize: 13, color: color.inkMuted },
  expenseSide: { alignItems: 'flex-end', gap: 2 },
  sideLabel: { fontSize: 12 },
  sideAmount: { ...type.amountSm, fontSize: 15, fontWeight: '700' },

  footer: {
    paddingHorizontal: space.lg + 4,
    paddingTop: space.md + 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
    backgroundColor: color.paper,
  },

  getPaid: { borderColor: color.accent, padding: space.lg, gap: space.sm },
  getPaidTitle: { ...type.body, fontWeight: '600', color: color.ink },
  getPaidBody: { ...type.body, color: color.inkMuted },
  note: { fontSize: 13, lineHeight: 19, color: color.inkMuted },
  error: { ...type.caption, color: color.danger },

  whyBody: { ...type.body, color: color.inkMuted },
  table: { borderWidth: StyleSheet.hairlineWidth, borderColor: color.line, borderRadius: radius.md + 2, overflow: 'hidden' },
  tableRow: {
    flexDirection: 'row',
    paddingHorizontal: space.md + 2,
    paddingVertical: space.sm + 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  tableHead: { backgroundColor: color.surfaceSunken, borderTopWidth: 0 },
  tableHeadText: { fontSize: 12, fontWeight: '600', color: color.inkMuted },
  tableCell: { flex: 1, fontSize: 14, color: color.ink },
  tableNum: { textAlign: 'right', fontFamily: type.amountSm.fontFamily },
  right: { textAlign: 'right' },
  tableStrong: { fontWeight: '600' },

  bubble: {
    alignSelf: 'flex-start',
    maxWidth: 320,
    paddingVertical: space.md,
    paddingHorizontal: space.md + 2,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 16,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    backgroundColor: color.accentWash,
  },
  bubbleText: { fontSize: 15, lineHeight: 22, color: color.ink },

  section: { gap: space.sm + 2 },
  sectionRule: { paddingTop: space.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.line },
  linkBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    height: 48,
    paddingHorizontal: space.md + 2,
    borderRadius: radius.md + 2,
    backgroundColor: color.surfaceSunken,
  },
  linkText: { flex: 1, fontSize: 15, fontWeight: '500', color: color.ink },
  qr: { alignSelf: 'center', padding: space.md, borderRadius: radius.md, backgroundColor: '#FFFFFF' },
  infoBox: { flexDirection: 'row', gap: space.sm + 2, padding: space.md, borderRadius: radius.md + 2, backgroundColor: color.accentWash },
  infoText: { flex: 1, fontSize: 13, lineHeight: 19, color: color.ink },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  addInput: {
    flex: 1,
    minWidth: 0,
    height: 48,
    borderWidth: 1,
    borderColor: color.lineStrong,
    borderRadius: radius.md + 2,
    paddingHorizontal: space.md + 2,
    ...type.body,
    color: color.ink,
    backgroundColor: color.surface,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  suggest: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    height: 44,
    paddingLeft: 6,
    paddingRight: space.md + 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surface,
  },
  suggestName: { fontSize: 14, fontWeight: '600', color: color.ink },

  waitCard: { padding: space.md + 2, borderRadius: radius.lg, gap: space.md },
  waitHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  ring: { borderRadius: 999, borderWidth: 2, borderColor: color.surface },
  waitName: { fontSize: 15, fontWeight: '600', color: color.ink },
  waitMeta: { fontSize: 13, color: color.inkMuted },
  waitCode: { fontSize: 13, lineHeight: 19, color: color.ink },
  code: { fontFamily: type.amountSm.fontFamily, fontSize: 15, fontWeight: '700', letterSpacing: 2 },

  memberRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 60, paddingVertical: space.sm },
  memberName: { fontSize: 15, fontWeight: '600', color: color.ink },
  memberMeta: { fontSize: 13, color: color.inkMuted },
  memberSide: { alignItems: 'flex-end', gap: 2 },
  // Lines up under the name: face, gap.
  memberAction: { paddingLeft: 40 + space.md, paddingBottom: space.sm },
}));
