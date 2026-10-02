/**
 * Group detail. The screen the demo spends most of its time on.
 *
 * Two things here carry weight beyond looking tidy:
 *
 * 1. Every member row shows their state — In app / Not joined / Payable.
 *    That is what makes the "only one person installs" claim legible instead
 *    of a line in a README.
 * 2. Debts come from simplifyDebts, so the settle buttons act on netted
 *    positions rather than raw pairwise history. Fewer payments, lower fees.
 */

import React, { useState } from 'react';
import { Platform, Share, StyleSheet, Text, View } from 'react-native';

import {
  canReceive,
  computeBalances,
  formatFiat,
  payLinkPath,
  simplifyDebts,
  type Debt,
  type Expense,
  type Member,
} from '@sattle/core';
import { useAsync, useClient } from '../react/SattleProvider';
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
import { color, space, type } from './theme';

export interface GroupDetailScreenProps {
  groupId: string;
  onBack: () => void;
  onAddExpense: (members: Member[], currency: string) => void;
  onSettle: (debt: Debt, members: Member[], groupName: string) => void;
}

interface GroupView {
  name: string;
  currency: string;
  members: Member[];
  expenses: Expense[];
  debts: Debt[];
  myMemberId: string | null;
  myNet: number;
}

export function GroupDetailScreen({
  groupId,
  onBack,
  onAddExpense,
  onSettle,
}: GroupDetailScreenProps) {
  const client = useClient();

  const { data, loading, error, reload } = useAsync<GroupView>(async () => {
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
      myMemberId: mine?.id ?? null,
      myNet: balances.find((b) => b.memberId === mine?.id)?.net ?? 0,
    };
  }, [groupId]);

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
              <View style={s.memberRow}>
                <Avatar name={member.displayName} dim={member.status === 'ghost'} />
                <View style={{ flex: 1 }}>
                  <Text style={s.memberName}>
                    {member.displayName}
                    {member.id === data.myMemberId ? ' (you)' : ''}
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
              </View>
            </View>
          ))}
        </Card>
      </View>

      <View>
        <SectionLabel>Expenses</SectionLabel>
        <Card style={{ padding: 0 }}>
          {data.expenses.map((expense, i) => (
            <View key={expense.id}>
              {i > 0 && <Divider />}
              <View style={s.expenseRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.expenseName}>{expense.description}</Text>
                  <Text style={s.expenseMeta}>
                    {nameOf(expense.paidByMemberId)} paid · split {expense.parts.length} ways
                  </Text>
                </View>
                <Amount minor={expense.amount} currency={data.currency} size="md" />
              </View>
            </View>
          ))}
        </Card>
      </View>

      <Button
        label="Add expense"
        variant="primary"
        onPress={() => onAddExpense(data.members, data.currency)}
      />
    </Screen>
  );
}

type LinkState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'sent'; url: string; note: string }
  | { kind: 'failed'; message: string };

/**
 * Only on debts owed to you: mints a pay link and hands it to the share
 * sheet. On web without navigator.share it copies instead. The URL stays on
 * screen either way, so it can be copied by hand if both are blocked.
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
  const [state, setState] = useState<LinkState>({ kind: 'idle' });

  const send = async () => {
    setState({ kind: 'busy' });
    let url: string;
    try {
      const link = await client.createPayLink({
        groupId: debt.groupId,
        fromMemberId: debt.fromMemberId,
        toMemberId: debt.toMemberId,
        amount: debt.amount,
      });
      url = `${APP_URL}${payLinkPath(link.token)}`;
    } catch (e) {
      setState({ kind: 'failed', message: e instanceof Error ? e.message : 'Couldn’t make a link. Try again.' });
      return;
    }
    const message = `${payerName}, you owe me ${formatFiat(debt.amount, currency)} for ${groupName}. Pay here, no app needed: ${url}`;
    setState({ kind: 'sent', url, note: await share(message) });
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

/** Returns a line saying what happened, for under the button. */
async function share(message: string): Promise<string> {
  if (Platform.OS !== 'web') {
    const r = await Share.share({ message }).catch(() => null);
    return r?.action === Share.sharedAction ? 'Sent. It works until it’s paid.' : 'Not sent. Here’s the link:';
  }
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  if (nav?.share) {
    try {
      await nav.share({ text: message });
      return 'Sent. It works until it’s paid.';
    } catch {
      // Cancelled or refused: fall through to copying.
    }
  }
  try {
    await nav!.clipboard.writeText(message);
    return 'Copied. Paste it in a chat.';
  } catch {
    return 'Copy this link and send it:';
  }
}

const s = StyleSheet.create({
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
  memberMeta: { ...type.caption, color: color.inkFaint, marginTop: 1 },
  expenseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
  },
  expenseName: { ...type.body, fontWeight: '500', color: color.ink },
  expenseMeta: { ...type.caption, color: color.inkFaint, marginTop: 1 },
});
