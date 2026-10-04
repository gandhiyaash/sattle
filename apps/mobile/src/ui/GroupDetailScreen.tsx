/**
 * Group detail. The screen the demo spends most of its time on.
 *
 * Two things here carry weight beyond looking tidy:
 *
 * 1. Every member row shows their state — In app / Not joined / Payable.
 *    That is what makes the "only one person installs" claim legible instead
 *    of a line in a README. One invite, under the list, is for all of them.
 * 2. Debts come from simplifyDebts, so the settle buttons act on netted
 *    positions rather than raw pairwise history. Fewer payments, lower fees.
 */

import React, { useEffect, useState } from 'react';
import { Platform, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  canReceive,
  computeBalances,
  formatFiat,
  groupLinkPath,
  payLinkPath,
  simplifyDebts,
  type Debt,
  type Expense,
  type Member,
  type PaymentMode,
} from '@sattle/core';
import { useActionKeys, useAsync, useClient, usePaymentMode } from '../react/SattleProvider';
import { APP_URL, inviteLink } from '../react/useSettleFlow';
import {
  Amount,
  Avatar,
  Badge,
  Button,
  Card,
  Divider,
  ErrorState,
  Loading,
  Screen,
  SectionLabel,
} from './primitives';
import { share } from './share';
import { makeStyles, radius, space, type, useColors } from './theme';

export interface GroupDetailScreenProps {
  groupId: string;
  onBack: () => void;
  onAddExpense: (members: Member[], currency: string) => void;
  /** Opens an expense to change or delete it. `userId` is who is signed in. */
  onEditExpense: (expense: Expense, members: Member[], currency: string, userId: string) => void;
  /** Opens the screen for renaming, leaving and deleting the group. */
  onManage: () => void;
  onSettle: (debt: Debt, members: Member[], groupName: string) => void;
}

interface GroupView {
  name: string;
  currency: string;
  members: Member[];
  expenses: Expense[];
  debts: Debt[];
  userId: string;
  myMemberId: string | null;
  myNet: number;
}

export function GroupDetailScreen({
  groupId,
  onBack,
  onAddExpense,
  onEditExpense,
  onManage,
  onSettle,
}: GroupDetailScreenProps) {
  const color = useColors();
  const s = useStyles();
  const client = useClient();
  const mode = usePaymentMode();

  const { data, loading, error, reload, refresh } = useAsync<GroupView>(async () => {
    const [user, group, members, expenses, settlements] = await Promise.all([
      client.getCurrentUser(),
      client.getGroup(groupId),
      client.getMembers(groupId),
      client.getExpenses(groupId),
      client.getSettlements(groupId),
    ]);

    const balances = computeBalances(group.memberIds, expenses, settlements);
    const debts = simplifyDebts(groupId, balances);
    const mine = members.find((m) => m.claimedByUserId === user.id) ?? null;

    return {
      name: group.name,
      currency: group.currency,
      members,
      expenses: [...expenses].reverse(),
      debts,
      userId: user.id,
      myMemberId: mine?.id ?? null,
      myNet: balances.find((b) => b.memberId === mine?.id)?.net ?? 0,
    };
  }, [groupId]);

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

  return (
    <Screen
      title={data.name}
      subtitle={`${data.members.length} members · ${data.expenses.length} expenses`}
      onBack={onBack}
      right={<Button label="Manage" variant="quiet" onPress={onManage} />}
    >
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

      {myDebts.length > 0 && (
        <View>
          <SectionLabel>Settle up</SectionLabel>
          <View style={{ gap: space.sm }}>
            {myDebts.map((debt) => {
              const owedByMe = debt.fromMemberId === data.myMemberId;
              const other = owedByMe ? debt.toMemberId : debt.fromMemberId;
              const otherMember = data.members.find((m) => m.id === other);
              const blocked = !owedByMe && false; // they pay you; nothing to block
              const cannotReceive = owedByMe && otherMember && !canReceive(otherMember, mode);

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
                    {owedByMe && (
                      <Button
                        label={cannotReceive ? 'Options' : 'Pay'}
                        variant={cannotReceive ? 'secondary' : 'primary'}
                        onPress={() => onSettle(debt, data.members, data.name)}
                      />
                    )}
                  </View>
                  {!owedByMe &&
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
                    <MarkSettled debt={debt} payerName={nameOf(other)} onSettled={refresh} />
                  )}
                  {cannotReceive && otherMember && (
                    <Text style={s.blockedNote}>{cannotReceiveNote(otherMember, mode)}</Text>
                  )}
                </Card>
              );
            })}
          </View>
        </View>
      )}

      <ShareGroupLink groupId={groupId} groupName={data.name} />

      <View>
        <SectionLabel>Members</SectionLabel>
        <Card style={{ padding: 0 }}>
          {data.members.map((member, i) => (
            <View key={member.id}>
              {i > 0 && <Divider />}
              <MemberRow member={member} isMe={member.id === data.myMemberId} mode={mode} />
            </View>
          ))}
          <Divider />
          <AddMember groupId={groupId} onAdded={refresh} />
        </Card>
        <InviteToJoin groupId={groupId} groupName={data.name} />
      </View>

      <View>
        <SectionLabel>Expenses</SectionLabel>
        {data.expenses.length === 0 ? (
          <Text style={s.noExpenses}>Nothing yet. Add the first one below.</Text>
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
        )}
      </View>

      <Button
        label="Add expense"
        variant="primary"
        onPress={() => onAddExpense(data.members, data.currency)}
      />

      <LedgerBackupCard groupId={groupId} version={data.expenses.length} />
    </Screen>
  );
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
function cannotReceiveNote(member: Member, mode: PaymentMode): string {
  const name = member.displayName;
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

/** One member, with their state. */
function MemberRow({ member, isMe, mode }: { member: Member; isMe: boolean; mode: PaymentMode }) {
  const s = useStyles();
  return (
    <View style={s.memberRow}>
      <Avatar name={member.displayName} dim={member.status === 'ghost'} />
      <View style={{ flex: 1 }}>
        <Text style={s.memberName}>
          {member.displayName}
          {isMe ? ' (you)' : ''}
        </Text>
        <Text style={s.memberMeta}>
          {member.status === 'joined'
            ? mode === 'real' && !canReceive(member, mode)
              ? 'In app · can’t receive yet'
              : 'In app'
            : member.status === 'nwc_linked'
              ? 'External wallet'
              : member.lightningAddress
                ? member.lightningAddress
                : 'Not joined'}
        </Text>
      </View>
      {member.status === 'ghost' && (
        <Badge
          text={canReceive(member, mode) ? 'Payable' : 'No app'}
          tone={canReceive(member, mode) ? 'accent' : 'neutral'}
        />
      )}
    </View>
  );
}

/**
 * One invite for everyone, for the chat they're all in. Whoever opens it picks
 * their own name from the list and becomes that member, or adds themselves if
 * they aren't on it, so nobody needs a link of their own. Joining is full
 * membership: they can see and add to the whole group, which is why it says
 * so before it's sent. Replacing it and turning it off are under Manage.
 */
function InviteToJoin({ groupId, groupName }: { groupId: string; groupName: string }) {
  const s = useStyles();
  const client = useClient();
  const [state, setState] = useState<LinkState>({ kind: 'idle' });

  const send = async () => {
    setState({ kind: 'busy' });
    let link: Awaited<ReturnType<typeof inviteLink>>;
    try {
      link = await inviteLink(client, groupId);
    } catch (e) {
      setState({ kind: 'failed', message: e instanceof Error ? e.message : 'Couldn’t make an invite. Try again.' });
      return;
    }
    const message = `Join "${groupName}" on Sattle to see what we’ve split and settle up. Open this and pick your name, or add it: ${link.url}`;
    setState({ kind: 'sent', url: link.url, note: await share(message, link.sentNote) });
  };

  return (
    <View style={s.inviteBlock}>
      <Button
        label={state.kind === 'sent' ? 'Share the invite again' : 'Invite people to join'}
        hint="One link for everyone. They pick their name, or add themselves, then can see this group and add to it."
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
 * One link for the whole group, for the chat everyone is already in. Whoever
 * opens it sees the spends and who owes whom, and pays what they owe; they
 * can't change anything. There is no link until this is tapped, which is why
 * it says what the link shows first. Replacing it and turning it off are
 * under Manage.
 */
function ShareGroupLink({ groupId, groupName }: { groupId: string; groupName: string }) {
  const s = useStyles();
  const client = useClient();
  const [state, setState] = useState<LinkState>({ kind: 'idle' });

  const send = async () => {
    setState({ kind: 'busy' });
    let url: string;
    try {
      // Looking first is what makes a retry safe: a link made by an attempt whose reply was
      // lost is found here. So making one takes a fresh request key every time, and can never
      // be answered with a saved reply naming a link that has since been turned off.
      const link = (await client.getGroupLink(groupId)) ?? (await client.createGroupLink(groupId));
      url = `${APP_URL}${groupLinkPath(link.token)}`;
    } catch (e) {
      setState({ kind: 'failed', message: e instanceof Error ? e.message : 'Couldn’t make a link. Try again.' });
      return;
    }
    const message = `Here’s what we’ve split in "${groupName}". See what you owe and pay it from any Lightning wallet, no app needed: ${url}`;
    setState({ kind: 'sent', url, note: await share(message, 'Sent. It works until someone in the group turns it off.') });
  };

  return (
    <View>
      <SectionLabel>Group link</SectionLabel>
      <Card style={{ gap: space.sm }}>
        <Text style={s.linkIntro}>
          One link for everyone. Whoever opens it sees the spends and who owes what, and can pay what they owe from
          any Lightning wallet. They can’t change anything.
        </Text>
        <Button
          label={state.kind === 'sent' ? 'Share it again' : 'Share the group link'}
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
        <Text style={s.linkNote}>Replace it or turn it off under Manage.</Text>
      </Card>
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
    const message = `${payerName}, you owe me ${formatFiat(debt.amount, currency)} for ${groupName}. Pay here, no app needed: ${url}`;
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
function MarkSettled({ debt, payerName, onSettled }: { debt: Debt; payerName: string; onSettled: () => void }) {
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
        <Button label="Mark as settled" variant="quiet" hint="Paid in cash, UPI, or forgiven." onPress={() => setState('confirming')} />
      )}
      {typeof state === 'object' && <Text style={s.linkError}>{state.failed}</Text>}
    </View>
  );
}

/**
 * The group's ledger on Nostr: how much of it is out on relays, and the key
 * that reads it back. The key decrypts the whole group, so it's copied, not
 * shared to a chat by default.
 */
function LedgerBackupCard({ groupId, version }: { groupId: string; version: number }) {
  const s = useStyles();
  const client = useClient();
  const { data } = useAsync(() => client.getLedgerBackup(groupId), [groupId, version]);
  const [note, setNote] = useState<string | null>(null);

  if (!data) return null;

  const relays = `${data.relays.length} relay${data.relays.length === 1 ? '' : 's'}`;
  const entries = `${data.entries} ${data.entries === 1 ? 'entry' : 'entries'}`;
  const status =
    data.entries === 0
      ? 'Nothing to back up yet.'
      : data.relays.length === 0
        ? `${entries} signed. This server isn’t publishing to relays yet.`
        : data.published < data.entries
          ? `${data.published} of ${entries} on ${relays}. The rest go out shortly.`
          : `${data.entries === 1 ? 'The entry is' : `All ${entries}`} on ${relays}.`;

  const copy = async () => {
    if (Platform.OS === 'web') {
      try {
        await navigator.clipboard.writeText(data.uri);
        setNote('Copied. It unlocks this group’s history, so only give it to people in the group.');
      } catch {
        setNote('Copy the key below by hand:');
      }
      return;
    }
    const r = await Share.share({ message: data.uri }).catch(() => null);
    setNote(r?.action === Share.sharedAction ? 'Saved. Keep it somewhere only you can read.' : 'Here’s the key:');
  };

  return (
    <View>
      <SectionLabel>Backup on Nostr</SectionLabel>
      <Card style={{ gap: space.sm }}>
        <Text style={s.backupBody}>
          Every expense and payment is signed by Sattle and published, encrypted, to Nostr relays. With the backup
          key, anyone in the group can rebuild these balances without us.
        </Text>
        <Text style={s.linkNote}>{status}</Text>
        <Button label="Copy backup key" onPress={copy} />
        {note && (
          <>
            <Text style={s.linkNote}>{note}</Text>
            <Text style={s.linkUrl} selectable numberOfLines={2}>
              {data.uri}
            </Text>
          </>
        )}
      </Card>
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  backupBody: { ...type.body, color: color.inkMuted },
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
  inviteBlock: { marginTop: space.sm, gap: space.xs },
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
  noExpenses: { ...type.caption, color: color.inkFaint, marginBottom: space.sm },
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
