/**
 * Group detail. The screen the demo spends most of its time on.
 *
 * Two things here carry weight beyond looking tidy:
 *
 * 1. Every member row shows their state — In app / Not joined / Payable.
 *    That is what makes the "only one person installs" claim legible instead
 *    of a line in a README. Anyone not joined can be invited from their row.
 * 2. Debts come from simplifyDebts, so the settle buttons act on netted
 *    positions rather than raw pairwise history. Fewer payments, lower fees.
 */

import React, { useEffect, useState } from 'react';
import { Platform, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  canReceive,
  computeBalances,
  formatFiat,
  invitePath,
  payLinkPath,
  simplifyDebts,
  type Debt,
  type Expense,
  type Member,
} from '@sattle/core';
import { useActionKeys, useAsync, useClient } from '../react/SattleProvider';
import { APP_URL } from '../react/useSettleFlow';
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
import { color, radius, space, type } from './theme';

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
  const client = useClient();

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
        <Text style={s.label}>
          {data.myNet > 0 ? 'You are owed' : data.myNet < 0 ? 'You owe' : 'All settled'}
        </Text>
        <Amount minor={data.myNet} currency={data.currency} size="lg" net />
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
              const cannotReceive = owedByMe && otherMember && !canReceive(otherMember);

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
                  {!owedByMe && (
                    <SendPayLink
                      debt={debt}
                      payerName={nameOf(other)}
                      groupName={data.name}
                      currency={data.currency}
                    />
                  )}
                  {!owedByMe && (
                    <MarkSettled debt={debt} payerName={nameOf(other)} onSettled={refresh} />
                  )}
                  {cannotReceive && (
                    <Text style={s.blockedNote}>
                      {nameOf(other)} hasn't joined — you can still pay them an address.
                    </Text>
                  )}
                </Card>
              );
            })}
          </View>
        </View>
      )}

      <View>
        <SectionLabel>Members</SectionLabel>
        <Card style={{ padding: 0 }}>
          {data.members.map((member, i) => (
            <View key={member.id}>
              {i > 0 && <Divider />}
              <MemberRow member={member} isMe={member.id === data.myMemberId} groupName={data.name} />
            </View>
          ))}
          <Divider />
          <AddMember groupId={groupId} onAdded={refresh} />
        </Card>
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
                      {nameOf(expense.paidByMemberId)} paid · split {expense.parts.length} ways
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

const REFRESH_MS = 4000;

type LinkState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'sent'; url: string; note: string }
  | { kind: 'failed'; message: string };

/**
 * One member, with their state. Someone who hasn't joined gets an Invite
 * action: it mints a link that lets one person become this member, and hands
 * it to the share sheet. Whoever uses it can see and add to the whole group.
 */
function MemberRow({ member, isMe, groupName }: { member: Member; isMe: boolean; groupName: string }) {
  const client = useClient();
  const keys = useActionKeys();
  const [invite, setInvite] = useState<LinkState>({ kind: 'idle' });

  const send = async () => {
    setInvite({ kind: 'busy' });
    let url: string;
    try {
      const input = { groupId: member.groupId, memberId: member.id };
      const made = await keys.run('invite', input, (k) => client.createInvite(input.groupId, input.memberId, k));
      url = `${APP_URL}${invitePath(made.token)}`;
    } catch (e) {
      setInvite({ kind: 'failed', message: e instanceof Error ? e.message : 'Couldn’t make an invite. Try again.' });
      return;
    }
    const message = `${member.displayName}, join "${groupName}" on Sattle to see what we’ve split and settle up: ${url}`;
    setInvite({ kind: 'sent', url, note: await share(message, 'Sent. It works once, for a week.') });
  };

  return (
    <View>
      <View style={s.memberRow}>
        <Avatar name={member.displayName} dim={member.status === 'ghost'} />
        <View style={{ flex: 1 }}>
          <Text style={s.memberName}>
            {member.displayName}
            {isMe ? ' (you)' : ''}
          </Text>
          <Text style={s.memberMeta}>
            {member.status === 'joined'
              ? 'In app'
              : member.status === 'nwc_linked'
                ? 'External wallet'
                : member.lightningAddress
                  ? member.lightningAddress
                  : 'Not joined'}
          </Text>
        </View>
        {member.status === 'ghost' && (
          <Badge
            text={member.lightningAddress ? 'Payable' : 'No app'}
            tone={member.lightningAddress ? 'accent' : 'neutral'}
          />
        )}
        {!member.claimedByUserId && (
          <Pressable onPress={send} disabled={invite.kind === 'busy'} hitSlop={12}>
            <Text style={[s.memberAction, invite.kind === 'busy' && { opacity: 0.4 }]}>
              {invite.kind === 'sent' ? 'Invite again' : 'Invite'}
            </Text>
          </Pressable>
        )}
      </View>
      {invite.kind === 'sent' && (
        <View style={s.inviteResult}>
          <Text style={s.linkNote}>{invite.note}</Text>
          <Text style={s.linkUrl} selectable numberOfLines={1}>
            {invite.url}
          </Text>
        </View>
      )}
      {invite.kind === 'failed' && (
        <View style={s.inviteResult}>
          <Text style={s.linkError}>{invite.message}</Text>
        </View>
      )}
    </View>
  );
}

/** Adds a ghost by name. Like everyone else here, they don't need the app. */
function AddMember({ groupId, onAdded }: { groupId: string; onAdded: () => void }) {
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

const s = StyleSheet.create({
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
  linkUrl: { ...type.amountSm, color: color.inkFaint },
  linkError: { ...type.caption, color: color.danger },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
  },
  memberName: { ...type.body, fontWeight: '500', color: color.ink },
  memberAction: { ...type.label, color: color.accent },
  // Lines up under the name: row padding, avatar, gap.
  inviteResult: { paddingLeft: space.lg + 36 + space.md, paddingRight: space.lg, paddingBottom: space.md, gap: space.xs },
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
  expenseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
  },
  expenseName: { ...type.body, fontWeight: '500', color: color.ink },
  expenseMeta: { ...type.caption, color: color.inkFaint, marginTop: 1 },
});
