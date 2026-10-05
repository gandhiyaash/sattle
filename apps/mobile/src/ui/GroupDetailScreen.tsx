/**
 * Group detail. The screen the demo spends most of its time on.
 *
 * Under the balance it is three tabs: the expenses, the members, and what
 * there is to settle. Which one is showing is the navigator's to hold, since
 * this screen is built again after every payment and every new expense.
 *
 * A few things here carry weight beyond looking tidy:
 *
 * 1. Every member row shows their state — In app / Not joined / Payable.
 *    That is what makes the "only one person installs" claim legible instead
 *    of a line in a README. One link, from the share icon in the header, is
 *    for all of them. A member nothing has been built on yet can be removed
 *    from their row; that is the server's rule (groupRules.ts), not a choice
 *    made here.
 * 2. Debts come from simplifyDebts, so the settle buttons act on netted
 *    positions rather than raw pairwise history. Fewer payments, lower fees.
 * 3. Nobody joins by holding the link: whoever asks to join shows up here,
 *    with a code, and someone in the group lets them in or turns them down.
 *    They show above the tabs, since someone is waiting on the answer.
 * 4. It only talks about the ways to pay the person looking uses (payWays).
 *    Someone who chose rupees alone sees no Lightning here, and someone who
 *    chose bitcoin alone sees no UPI, except in a group kept in bitcoin,
 *    where Lightning is the only way there is.
 *
 * Add expense stays at the bottom of the screen however far the list has
 * scrolled: it is what the screen is opened for most.
 */

import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  canReceive,
  computeBalances,
  formatAmount,
  isBitcoin,
  payLinkPath,
  simplifyDebts,
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
import { toggleCurrency } from '../prefs/currencyPrefs';
import { chooseCurrencies, useCurrencyPrefs, usePayWays } from '../prefs/useCurrencyPrefs';
import { useActionKeys, useAsync, useClient, usePaymentMode } from '../react/SattleProvider';
import { APP_URL, groupLinkToShare } from '../react/useSettleFlow';
import {
  Amount,
  Avatar,
  Badge,
  Button,
  Card,
  ConfirmButton,
  Divider,
  ErrorState,
  IconButton,
  Loading,
  Screen,
  SectionLabel,
  Segmented,
} from './primitives';
import { share } from './share';
import { makeStyles, radius, space, type, useColors } from './theme';

/** The three parts of a group, one showing at a time. */
export type GroupTab = 'expenses' | 'members' | 'settle';

const TABS: ReadonlyArray<{ value: GroupTab; label: string }> = [
  { value: 'expenses', label: 'Expenses' },
  { value: 'members', label: 'Members' },
  { value: 'settle', label: 'Settle up' },
];

export interface GroupDetailScreenProps {
  groupId: string;
  tab: GroupTab;
  onTab: (tab: GroupTab) => void;
  onBack: () => void;
  onAddExpense: (members: Member[], currency: string) => void;
  /** Opens an expense to change or delete it. `userId` is who is signed in. */
  onEditExpense: (expense: Expense, members: Member[], currency: string, userId: string) => void;
  /** Opens the screen for renaming, leaving and deleting the group, and for its link and backup. */
  onManage: () => void;
  /** Opens Wallet, where the user sets up how they get paid. */
  onOpenWallet: () => void;
  onSettle: (debt: Debt, members: Member[], groupName: string, currency: string) => void;
}

interface GroupView {
  name: string;
  currency: string;
  members: Member[];
  expenses: Expense[];
  debts: Debt[];
  /** UPI payments someone says they made, to or from the user, that the person owed hasn't confirmed. */
  claims: UpiClaim[];
  /** People asking to join, waiting on someone here to let them in. */
  waiting: PendingJoin[];
  /** Ghosts that no expense or payment names. */
  removable: Set<string>;
  /** The user's own UPI ID, if they've given one. */
  upi: UpiProfile;
  userId: string;
  myMemberId: string | null;
  myNet: number;
}

export function GroupDetailScreen({
  groupId,
  tab,
  onTab,
  onBack,
  onAddExpense,
  onEditExpense,
  onManage,
  onOpenWallet,
  onSettle,
}: GroupDetailScreenProps) {
  const color = useColors();
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();
  const mode = usePaymentMode();
  const prefs = useCurrencyPrefs();
  /** What the share icon last did. The link stays on screen, so it can be copied by hand. */
  const [shared, setShared] = useState<LinkState>({ kind: 'idle' });

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
    const debts = simplifyDebts(groupId, balances);
    const mine = members.find((m) => m.claimedByUserId === user.id) ?? null;
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
      debts,
      claims,
      waiting,
      removable: new Set(members.filter((m) => !m.claimedByUserId && !named.has(m.id)).map((m) => m.id)),
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
        <ErrorState message={error?.message ?? 'Could not load this group.'} onRetry={reload} />
      </Screen>
    );
  }

  const nameOf = (id: string) =>
    data.members.find((m) => m.id === id)?.displayName ?? 'Someone';

  const me = data.members.find((m) => m.id === data.myMemberId);
  // Under real payments, money lands in the payee's own wallet or address. Without one, a link can't be paid.
  const iCanReceive = me ? canReceive(me, mode) : false;

  const myDebts = data.debts.filter(
    (d) => d.fromMemberId === data.myMemberId || d.toMemberId === data.myMemberId
  );
  const owingMe = myDebts.filter((d) => d.toMemberId === data.myMemberId).map((d) => nameOf(d.fromMemberId));
  const rupees = data.currency === UPI_CURRENCY;
  // A group kept in bitcoin, joined by someone who said they don't use it. Getting paid here takes
  // Lightning, and Wallet only shows that to someone who uses bitcoin, so setting it up turns it on.
  const turnsOnBitcoin = isBitcoin(data.currency) && !prefs.uses.includes('BTC');
  const setUpGettingPaid = () => {
    if (turnsOnBitcoin) chooseCurrencies(toggleCurrency(prefs, 'BTC'));
    onOpenWallet();
  };

  // The group's one link, for the chat everyone is in. Whoever opens it sees what's been split
  // and can pay what they owe with no app. The same page has Join on it: they say who they
  // are, and someone here lets them in.
  const shareGroup = async () => {
    setShared({ kind: 'busy' });
    let link: Awaited<ReturnType<typeof groupLinkToShare>>;
    try {
      link = await groupLinkToShare(client, groupId);
    } catch (e) {
      setShared({ kind: 'failed', message: e instanceof Error ? e.message : 'Couldn’t make a link. Try again.' });
      return;
    }
    const message = `Here’s what we’ve split in "${data.name}". See what you owe and pay it, no app needed. To join the group, tap Join there and I’ll let you in: ${link.url}`;
    setShared({ kind: 'sent', url: link.url, note: await share(message, link.sentNote) });
  };

  return (
    <Screen
      title={data.name}
      subtitle={`${data.members.length} members · ${data.expenses.length} expenses`}
      onBack={onBack}
      right={
        <View style={s.headerActions}>
          <Button label="Manage" variant="quiet" onPress={onManage} />
          <IconButton icon="share" label="Share this group" busy={shared.kind === 'busy'} onPress={shareGroup} />
        </View>
      }
      footer={<Button label="Add expense" variant="primary" onPress={() => onAddExpense(data.members, data.currency)} />}
    >
      {shared.kind === 'sent' && (
        <Shared url={shared.url} note={shared.note} onHide={() => setShared({ kind: 'idle' })} />
      )}
      {shared.kind === 'failed' && <ErrorState message={shared.message} />}

      {/* Above the tabs, whichever is showing: someone is waiting on an answer. */}
      {data.waiting.length > 0 && (
        <View>
          <SectionLabel>Asking to join</SectionLabel>
          <View style={{ gap: space.sm }}>
            {data.waiting.map((req) => (
              <JoinRequestCard
                key={req.id}
                request={req}
                // Two people asking to be one name: the code is how to tell which is real.
                twin={data.waiting.some((x) => x.id !== req.id && x.existing && req.existing && x.name === req.name)}
                groupName={data.name}
                onChanged={refresh}
              />
            ))}
          </View>
        </View>
      )}

      <Card>
        {data.expenses.length === 0 ? (
          // Zero because nothing has happened yet, not because it was paid off.
          <>
            <Text style={s.label}>No expenses yet</Text>
            <Text style={s.nothingYet}>Add the first one and you'll see who owes what.</Text>
          </>
        ) : (
          <>
            <Text style={s.label}>
              {data.myNet > 0 ? 'You are owed' : data.myNet < 0 ? 'You owe' : 'All settled'}
            </Text>
            <Amount minor={data.myNet} currency={data.currency} size="lg" net />
          </>
        )}
      </Card>

      <Segmented options={TABS} value={tab} onChange={onTab} />

      {tab === 'expenses' &&
        (data.expenses.length === 0 ? (
          <Text style={s.emptyTab}>Nothing yet. Add the first one below.</Text>
        ) : (
          <Card style={{ padding: 0 }}>
            {data.expenses.map((expense, i) => (
              <View key={expense.id}>
                {i > 0 && <Divider />}
                <Pressable
                  onPress={() => onEditExpense(expense, data.members, data.currency, data.userId)}
                  style={({ pressed }) => [s.expenseRow, pressed && { backgroundColor: color.surfaceSunken }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.expenseName}>{expense.description}</Text>
                    <Text style={s.expenseMeta}>
                      {nameOf(expense.paidByMemberId)} paid · {splitSummary(expense, nameOf)}
                    </Text>
                  </View>
                  <Amount minor={expense.amount} currency={data.currency} size="md" />
                </Pressable>
              </View>
            ))}
          </Card>
        ))}

      {tab === 'members' && (
        <Card style={{ padding: 0 }}>
          {data.members.map((member, i) => (
            <View key={member.id}>
              {i > 0 && <Divider />}
              <MemberRow member={member} isMe={member.id === data.myMemberId} mode={mode} ways={ways} />
              {data.removable.has(member.id) && (
                <View style={s.memberAction}>
                  <ConfirmButton
                    label={`Remove ${member.displayName}`}
                    confirmLabel={`Yes, remove ${member.displayName}`}
                    onConfirm={async () => {
                      await keys.run('remove-member', { groupId, id: member.id }, (k) =>
                        client.removeMember(groupId, member.id, k)
                      );
                      refresh();
                    }}
                  />
                </View>
              )}
            </View>
          ))}
          <Divider />
          <AddMember groupId={groupId} onAdded={refresh} />
        </Card>
      )}

      {tab === 'settle' && (
        <>
          {owingMe.length > 0 && !iCanReceive && !(rupees && data.upi.upiId) && (
            <GetPaidCard names={owingMe} ways={ways} turnsOnBitcoin={turnsOnBitcoin} onSetUp={setUpGettingPaid} />
          )}
          {myDebts.length === 0 ? (
            <Text style={s.emptyTab}>Nothing to settle. You don’t owe anyone here, and nobody owes you.</Text>
          ) : (
            <View style={{ gap: space.sm }}>
              {myDebts.map((debt) => {
                const owedByMe = debt.fromMemberId === data.myMemberId;
                const other = owedByMe ? debt.toMemberId : debt.fromMemberId;
                const otherMember = data.members.find((m) => m.id === other);
                const blocked = !owedByMe && false; // they pay you; nothing to block
                // UPI is a way to pay someone who has no wallet here, as long as the group is in rupees.
                // Either way counts only if it is one the user is shown.
                const takesUpi = ways.upi && Boolean(otherMember?.upi);
                const takesLightning = ways.lightning && Boolean(otherMember && canReceive(otherMember, mode));
                const cannotReceive = owedByMe && otherMember && !takesLightning && !takesUpi;
                const claim = data.claims.find(
                  (x) => x.fromMemberId === debt.fromMemberId && x.toMemberId === debt.toMemberId
                );
                // They've said they paid by UPI. Paying again would pay twice, so Pay waits with the claim.
                const waiting = owedByMe && claim?.status === 'pending';

                return (
                  <Card key={debt.id} style={{ padding: space.md }}>
                    <View style={s.debtRow}>
                      <Avatar name={nameOf(other)} dim={!owedByMe} />
                      <View style={{ flex: 1 }}>
                        <Text style={s.debtText}>
                          {owedByMe ? `You owe ${nameOf(other)}` : `${nameOf(other)} owes you`}
                        </Text>
                        <Amount
                          minor={debt.amount}
                          currency={data.currency}
                          size="sm"
                        />
                      </View>
                      {owedByMe && !waiting && (
                        <Button
                          label={cannotReceive ? 'Options' : 'Pay'}
                          variant={cannotReceive ? 'secondary' : 'primary'}
                          onPress={() => onSettle(debt, data.members, data.name, data.currency)}
                        />
                      )}
                    </View>
                    {claim && (
                      <UpiClaimNote
                        claim={claim}
                        mine={owedByMe}
                        otherName={nameOf(other)}
                        currency={data.currency}
                        onChanged={refresh}
                      />
                    )}
                    {/* A pay link asks for a Lightning payment, so it goes with Lightning. */}
                    {!owedByMe &&
                      ways.lightning &&
                      (iCanReceive ? (
                        <SendPayLink
                          debt={debt}
                          payerName={nameOf(other)}
                          groupName={data.name}
                          currency={data.currency}
                        />
                      ) : (
                        <Text style={s.blockedNote}>
                          Set up receiving from Wallet to send {nameOf(other)} a pay link.
                        </Text>
                      ))}
                    {!owedByMe && (
                      <MarkSettled debt={debt} payerName={nameOf(other)} upi={ways.upi} onSettled={refresh} />
                    )}
                    {cannotReceive && otherMember && (
                      <Text style={s.blockedNote}>{cannotReceiveNote(otherMember, mode, ways)}</Text>
                    )}
                  </Card>
                );
              })}
            </View>
          )}
        </>
      )}
    </Screen>
  );
}

/** "Om", "Om and N", "Om, N and Aman". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
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
    <Card style={s.getPaid}>
      <Text style={s.getPaidTitle}>{who} can’t pay you yet</Text>
      <Text style={s.linkIntro}>
        {!ways.lightning
          ? 'Add your UPI ID, and they can pay you in the app.'
          : ways.upi
            ? 'Add a way to get paid: a UPI ID, a Lightning wallet, or a Lightning address. Then they can pay you in the app.'
            : 'Add a way to get paid: a Lightning wallet or a Lightning address. Then they can pay you in the app.'}
      </Text>
      {turnsOnBitcoin && (
        <Text style={s.linkNote}>
          This group is kept in bitcoin, so they pay you over Lightning. Setting it up turns Bitcoin on for you; you
          can turn it off again under Account.
        </Text>
      )}
      <Button label="Set up getting paid" variant="primary" onPress={onSetUp} />
    </Card>
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
    <Card style={{ padding: space.md, gap: space.sm }}>
      <View style={s.debtRow}>
        <Avatar name={request.name} dim />
        <View style={{ flex: 1 }}>
          <Text style={s.debtText}>
            {request.existing ? `Someone wants to join as ${request.name}` : `${request.name} wants to join`}
          </Text>
          <Text style={s.memberMeta}>
            Code {request.code} · {ago(request.createdAt)}
            {request.existing ? '' : ' · new to the group'}
          </Text>
        </View>
      </View>
      <Text style={[s.linkNote, s.indented]}>
        {twin
          ? `More than one person is asking to be ${request.name}. Ask ${request.name} which code they see, and let in only that one.`
          : request.existing
            ? `They’ll see everything in ${groupName} and take over ${request.name}’s balance. Let them in only if you know it’s ${request.name}: if unsure, ask which code they see.`
            : `They’ll see everything in ${groupName} and can add to it.`}
      </Text>
      <View style={[s.joinActions, s.indented]}>
        <Button label="Let in" variant="primary" busy={busy === 'approve'} disabled={busy !== null} onPress={() => act('approve')} />
        <Button label="Not them" busy={busy === 'decline'} disabled={busy !== null} onPress={() => act('decline')} />
      </View>
      {error && <Text style={[s.linkError, s.indented]}>{error}</Text>}
    </Card>
  );
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
function splitSummary(expense: Expense, nameOf: (id: string) => string): string {
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
    return member.claimedByUserId
      ? `${name} hasn’t added a UPI ID yet, so you can’t pay them here.`
      : `${name} isn't on Sattle yet. Invite them, or mark it settled if you paid another way.`;
  }
  if (mode === 'simulated') return `${name} hasn't joined — you can still pay them an address.`;
  return member.claimedByUserId
    ? `${name} needs to set up receiving before you can pay here.`
    : `${name} isn't on Sattle yet. Invite them, or mark it settled if you paid another way.`;
}

const REFRESH_MS = 4000;

type LinkState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'sent'; url: string; note: string }
  | { kind: 'failed'; message: string };

/** One member, with their state, in terms of the ways to pay the user is shown. */
function MemberRow({ member, isMe, mode, ways }: { member: Member; isMe: boolean; mode: PaymentMode; ways: PayWays }) {
  const s = useStyles();
  const lightning = ways.lightning && canReceive(member, mode);
  // Someone with only a UPI ID can still be paid here, in a rupee group.
  const upiOnly = ways.upi && Boolean(member.upi) && !lightning;
  const state =
    member.status === 'ghost'
      ? (ways.lightning && member.lightningAddress) || 'Not joined'
      : member.status === 'nwc_linked' && ways.lightning
        ? 'External wallet'
        : upiOnly
          ? 'In app · takes UPI'
          : ways.lightning && mode === 'real' && !lightning
            ? 'In app · can’t receive yet'
            : 'In app';
  return (
    <View style={s.memberRow}>
      <Avatar name={member.displayName} dim={member.status === 'ghost'} />
      <View style={{ flex: 1 }}>
        <Text style={s.memberName}>
          {member.displayName}
          {isMe ? ' (you)' : ''}
        </Text>
        <Text style={s.memberMeta}>{state}</Text>
      </View>
      {member.status === 'ghost' && <Badge text={lightning ? 'Payable' : 'No app'} tone={lightning ? 'accent' : 'neutral'} />}
    </View>
  );
}

/**
 * What the share icon just did, at the top of the screen. The icon has no
 * room to say what the link is, so this does: whoever opens it sees the group
 * and can pay, and can ask to join, which someone here has to say yes to.
 * Replacing it and turning it off are under Manage.
 */
function Shared({ url, note, onHide }: { url: string; note: string; onHide: () => void }) {
  const s = useStyles();
  return (
    <Card style={{ gap: space.xs }}>
      <View style={s.sharedTop}>
        <Text style={[s.linkNote, { flex: 1 }]}>{note}</Text>
        <Pressable onPress={onHide} hitSlop={12} accessibilityRole="button">
          <Text style={s.sharedHide}>Hide</Text>
        </Pressable>
      </View>
      <Text style={s.linkUrl} selectable numberOfLines={1}>
        {url}
      </Text>
      <Text style={s.linkNote}>
        One link for everyone. Whoever opens it sees what’s been split and who owes what, and can pay what they owe
        with no app. They can also ask to join from it: you or anyone here lets them in. Replace it or turn it off
        under Manage.
      </Text>
    </Card>
  );
}

/** Adds a ghost by name. Like everyone else here, they don't need the app. */
function AddMember({ groupId, onAdded }: { groupId: string; onAdded: () => void }) {
  const color = useColors();
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const displayName = name.trim();
      await keys.run('add-member', { groupId, displayName }, (k) => client.addMember(groupId, displayName, k));
      setName('');
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t add them. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.addMember}>
      <View style={s.addMemberRow}>
        <TextInput
          style={s.addInput}
          value={name}
          onChangeText={setName}
          onSubmitEditing={add}
          returnKeyType="done"
          placeholder="Add someone by name"
          placeholderTextColor={color.inkFaint}
        />
        <Button label="Add" busy={busy} disabled={!name.trim()} onPress={add} />
      </View>
      {error && <Text style={s.linkError}>{error}</Text>}
    </View>
  );
}

/**
 * Only on debts owed to you: mints a pay link and hands it to the share
 * sheet. The URL stays on screen afterwards, so it can be copied by hand.
 */
function SendPayLink({
  debt,
  payerName,
  groupName,
  currency,
}: {
  debt: Debt;
  payerName: string;
  groupName: string;
  currency: string;
}) {
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();
  const [state, setState] = useState<LinkState>({ kind: 'idle' });

  const send = async () => {
    setState({ kind: 'busy' });
    let url: string;
    try {
      const input = {
        groupId: debt.groupId,
        fromMemberId: debt.fromMemberId,
        toMemberId: debt.toMemberId,
        amount: debt.amount,
      };
      const link = await keys.run('pay-link', input, (k) => client.createPayLink(input, k));
      url = `${APP_URL}${payLinkPath(link.token)}`;
    } catch (e) {
      setState({ kind: 'failed', message: e instanceof Error ? e.message : 'Couldn’t make a link. Try again.' });
      return;
    }
    const message = `${payerName}, you owe me ${formatAmount(debt.amount, currency)} for ${groupName}. Pay here, no app needed: ${url}`;
    setState({ kind: 'sent', url, note: await share(message, 'Sent. It works until it’s paid.') });
  };

  return (
    <View style={s.linkBlock}>
      <Button
        label={state.kind === 'sent' ? 'Send again' : 'Send pay link'}
        busy={state.kind === 'busy'}
        onPress={send}
      />
      {state.kind === 'sent' && (
        <>
          <Text style={s.linkNote}>{state.note}</Text>
          <Text style={s.linkUrl} selectable numberOfLines={1}>
            {state.url}
          </Text>
        </>
      )}
      {state.kind === 'failed' && <Text style={s.linkError}>{state.message}</Text>}
    </View>
  );
}

/**
 * The payee's side of "paid in cash". Only they can record it for someone
 * who has joined, so this is where it lives; the payer's sheet tells them to
 * ask. Two taps, since nothing undoes it.
 */
function MarkSettled({
  debt,
  payerName,
  upi,
  onSettled,
}: {
  debt: Debt;
  payerName: string;
  /** Whether UPI is something the user is shown here, and so worth naming as a way it may have been paid. */
  upi: boolean;
  onSettled: () => void;
}) {
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();
  const [state, setState] = useState<'idle' | 'confirming' | 'busy' | { failed: string }>('idle');

  const confirm = async () => {
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
    <View style={s.linkBlock}>
      {state === 'confirming' || state === 'busy' ? (
        <Button label={`Yes, ${payerName} paid me`} busy={state === 'busy'} onPress={confirm} />
      ) : (
        <Button
          label="Mark as settled"
          variant="quiet"
          hint={upi ? 'Paid in cash, UPI, or forgiven.' : 'Paid in cash, or forgiven.'}
          onPress={() => setState('confirming')}
        />
      )}
      {typeof state === 'object' && <Text style={s.linkError}>{state.failed}</Text>}
    </View>
  );
}

/**
 * A UPI payment someone says they made, on the debt it is for. Sattle can't
 * see it, so the person owed is asked whether it arrived; that is what
 * settles it. The payer sees that it is waiting, or that it was turned down,
 * and can take it back.
 */
function UpiClaimNote({
  claim,
  mine,
  otherName,
  currency,
  onChanged,
}: {
  claim: UpiClaim;
  /** The user is the one who paid. Otherwise they are the one owed. */
  mine: boolean;
  otherName: string;
  currency: string;
  onChanged: () => void;
}) {
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const amount = formatAmount(claim.amount, currency);
  const declined = claim.status === 'declined';

  const act = async (action: string, fn: (key: string) => Promise<unknown>) => {
    setBusy(action);
    setError(null);
    try {
      await keys.run(action, { id: claim.id }, fn);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(null);
    }
  };

  if (mine) {
    return (
      <View style={s.linkBlock}>
        <Text style={declined ? s.linkError : s.linkNote}>
          {declined
            ? `${otherName} says the UPI payment of ${amount} didn’t arrive. Check with them, or pay again.`
            : claim.viaLink
              ? `Someone on the group link told ${otherName} this was paid by UPI (${amount}). It’s settled once they confirm it arrived.`
              : `You told ${otherName} you paid ${amount} by UPI. It’s settled once they confirm it arrived.`}
        </Text>
        <Button
          label={declined ? 'OK' : 'I didn’t pay after all'}
          variant="quiet"
          busy={busy === 'upi-withdraw'}
          onPress={() => act('upi-withdraw', (k) => client.withdrawUpiClaim(claim.id, k))}
        />
        {error && <Text style={s.linkError}>{error}</Text>}
      </View>
    );
  }

  return (
    <View style={s.linkBlock}>
      <Text style={s.linkNote}>
        {declined
          ? `You said ${otherName}’s UPI payment of ${amount} didn’t arrive.`
          : `${claim.viaLink ? `Someone on the group link says ${otherName} paid` : `${otherName} says they paid`} you ${amount} by UPI.${
              claim.reference ? ` Reference ${claim.reference}.` : ''
            } Check your bank or UPI app before you confirm.`}
      </Text>
      <Button
        label={declined ? 'It arrived after all' : 'Yes, I got it'}
        variant={declined ? 'secondary' : 'primary'}
        busy={busy === 'upi-confirm'}
        onPress={() => act('upi-confirm', (k) => client.confirmUpiClaim(claim.id, k))}
      />
      {!declined && (
        <Button
          label="It didn’t arrive"
          variant="quiet"
          busy={busy === 'upi-decline'}
          onPress={() => act('upi-decline', (k) => client.declineUpiClaim(claim.id, k))}
        />
      )}
      {error && <Text style={s.linkError}>{error}</Text>}
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  label: { ...type.label, color: color.inkMuted, marginBottom: space.xs },
  debtRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  debtText: { ...type.body, color: color.ink },
  blockedNote: {
    ...type.caption,
    color: color.inkMuted,
    marginTop: space.sm,
    marginLeft: 48,
  },
  linkBlock: { marginTop: space.sm, marginLeft: 48, gap: space.xs },
  // Lines up under the names: avatar, gap.
  indented: { marginLeft: 48 },
  joinActions: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  getPaid: { borderColor: color.accent, gap: space.sm },
  getPaidTitle: { ...type.body, fontWeight: '600', color: color.ink },
  linkNote: { ...type.caption, color: color.inkMuted },
  linkIntro: { ...type.body, color: color.inkMuted },
  linkUrl: { ...type.amountSm, color: color.inkFaint },
  linkError: { ...type.caption, color: color.danger },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
  },
  memberName: { ...type.body, fontWeight: '500', color: color.ink },
  // Lines up under the name: row padding, avatar, gap.
  memberAction: { paddingLeft: space.lg + 36 + space.md, paddingRight: space.lg, paddingBottom: space.md },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  sharedTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  sharedHide: { ...type.label, color: color.accent },
  addMember: { padding: space.md, gap: space.xs },
  addMemberRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  addInput: {
    flex: 1,
    height: 44,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    ...type.body,
    color: color.ink,
    backgroundColor: color.paper,
  },
  memberMeta: { ...type.caption, color: color.inkFaint, marginTop: 1 },
  emptyTab: { ...type.caption, color: color.inkFaint },
  nothingYet: { ...type.body, color: color.inkFaint },
  expenseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
  },
  expenseName: { ...type.body, fontWeight: '500', color: color.ink },
  expenseMeta: { ...type.caption, color: color.inkFaint, marginTop: 1 },
}));
