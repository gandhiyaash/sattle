/**
 * Groups list. First screen, and the one that has to make the app feel
 * familiar within a second — this is deliberately Splitwise-shaped.
 *
 * The headline number is the user's net position across every group, which
 * is the one thing people open this kind of app to check.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { computeBalances, type Group } from '@sattle/core';
import { useAsync, useClient } from '../react/SattleProvider';
import {
  Amount,
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  Screen,
  SectionLabel,
} from './primitives';
import { makeStyles, space, type, useColors } from './theme';

export interface GroupsListScreenProps {
  onOpenGroup: (groupId: string) => void;
  onOpenWallet: () => void;
  onNewGroup?: () => void;
  /** Opens the screen that takes an invite link. */
  onJoin?: () => void;
}

interface GroupRow {
  group: Group;
  net: number;
  memberCount: number;
  /** With none, a zero net means nothing has happened yet, not that it's settled. */
  expenseCount: number;
}

export function GroupsListScreen({
  onOpenGroup,
  onOpenWallet,
  onNewGroup,
  onJoin,
}: GroupsListScreenProps) {
  const color = useColors();
  const s = useStyles();
  const client = useClient();

  const { data, loading, error, reload } = useAsync<GroupRow[]>(async () => {
    const [user, groups] = await Promise.all([
      client.getCurrentUser(),
      client.getGroups(),
    ]);

    return Promise.all(
      groups.map(async (group) => {
        const [members, expenses, settlements] = await Promise.all([
          client.getMembers(group.id),
          client.getExpenses(group.id),
          client.getSettlements(group.id),
        ]);
        const mine = members.find((m) => m.claimedByUserId === user.id);
        const balances = computeBalances(group.memberIds, expenses, settlements);
        return {
          group,
          net: balances.find((b) => b.memberId === mine?.id)?.net ?? 0,
          memberCount: members.length,
          expenseCount: expenses.length,
        };
      })
    );
  }, []);

  const total = data?.reduce((sum, r) => sum + r.net, 0) ?? 0;
  const anyExpenses = data?.some((r) => r.expenseCount > 0) ?? false;

  return (
    <Screen
      title="Sattle"
      brand
      right={<Button label="Wallet" variant="quiet" onPress={onOpenWallet} />}
    >
      <Card>
        {total === 0 && !anyExpenses ? (
          <>
            <Text style={s.overallLabel}>No expenses yet</Text>
            <Text style={s.nothingYet}>Add one to a group and what you owe or are owed shows here.</Text>
          </>
        ) : (
          <>
            <Text style={s.overallLabel}>
              {total > 0 ? 'You are owed' : total < 0 ? 'You owe' : 'All settled'}
            </Text>
            <Amount minor={total} size="lg" net />
          </>
        )}
      </Card>

      <View>
        <SectionLabel>Groups</SectionLabel>

        {loading && <Loading lines={2} />}
        {error && <ErrorState message={error.message} onRetry={reload} />}

        {data?.length === 0 && (
          <EmptyState
            title="No groups yet"
            body="Start one, add the people you split with, and share the link. They don't need the app."
            action={
              <View style={{ gap: space.sm }}>
                {onNewGroup && <Button label="New group" variant="primary" onPress={onNewGroup} />}
                {onJoin && <Button label="Join with a link" onPress={onJoin} />}
              </View>
            }
          />
        )}

        {data && data.length > 0 && (
          <Card style={{ padding: 0 }}>
            {data.map((row, i) => (
              <Pressable
                key={row.group.id}
                onPress={() => onOpenGroup(row.group.id)}
                style={({ pressed }) => [
                  s.row,
                  i > 0 && s.rowBorder,
                  pressed && { backgroundColor: color.surfaceSunken },
                ]}
              >
                <Avatar name={row.group.name} />
                <View style={{ flex: 1 }}>
                  <Text style={s.groupName}>{row.group.name}</Text>
                  <Text style={s.groupMeta}>{row.memberCount} members</Text>
                </View>
                {row.expenseCount === 0 ? (
                  <Text style={s.groupMeta}>No expenses</Text>
                ) : (
                  <Amount minor={row.net} size="md" net />
                )}
              </Pressable>
            ))}
          </Card>
        )}
      </View>

      {data && data.length > 0 && (
        <View style={{ gap: space.sm }}>
          {onNewGroup && <Button label="New group" onPress={onNewGroup} />}
          {onJoin && <Button label="Join with a link" variant="quiet" onPress={onJoin} />}
        </View>
      )}
    </Screen>
  );
}

const useStyles = makeStyles((color) => ({
  overallLabel: { ...type.label, color: color.inkMuted, marginBottom: space.xs },
  nothingYet: { ...type.body, color: color.inkFaint },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
  },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.line },
  groupName: { ...type.body, fontWeight: '500', color: color.ink },
  groupMeta: { ...type.caption, color: color.inkFaint, marginTop: 1 },
}));
