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

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { computeBalances, simplifyDebts } from '../domain/ledger';
import { canReceive } from '../domain/settlementOptions';
import type { Debt, Expense, Member } from '../domain/types';
import { useAsync, useClient } from '../react/SplitSatsProvider';
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
