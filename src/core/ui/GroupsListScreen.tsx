/**
 * Groups list. First screen, and the one that has to make the app feel
 * familiar within a second — this is deliberately Splitwise-shaped.
 *
 * The headline number is the user's net position across every group, which
 * is the one thing people open this kind of app to check.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { computeBalances } from '../domain/ledger';
import type { Group } from '../domain/types';
import { useAsync, useClient } from '../react/SplitSatsProvider';
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
import { color, space, type } from './theme';

export interface GroupsListScreenProps {
  onOpenGroup: (groupId: string) => void;
  onOpenWallet: () => void;
  onNewGroup?: () => void;
}

interface GroupRow {
  group: Group;
  net: number;
  memberCount: number;
}

export function GroupsListScreen({
  onOpenGroup,
  onOpenWallet,
  onNewGroup,
}: GroupsListScreenProps) {
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
        };
      })
    );
  }, []);

  const total = data?.reduce((sum, r) => sum + r.net, 0) ?? 0;

  return (
    <Screen
      title="SplitSats"
      right={<Button label="Wallet" variant="quiet" onPress={onOpenWallet} />}
    >
      <Card>
        <Text style={s.overallLabel}>
          {total > 0 ? 'You are owed' : total < 0 ? 'You owe' : 'All settled'}
        </Text>
        <Amount minor={total} size="lg" net />
      </Card>

      <View>
        <SectionLabel>Groups</SectionLabel>

        {loading && <Loading lines={2} />}
        {error && <ErrorState message={error.message} onRetry={reload} />}

        {data?.length === 0 && (
          <EmptyState
            title="No groups yet"
            body="Start one, add the people you split with, and share the link. They don't need the app."
            action={onNewGroup && <Button label="New group" variant="primary" onPress={onNewGroup} />}
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
                <Amount minor={row.net} size="md" net />
              </Pressable>
            ))}
          </Card>
        )}
      </View>

      {data && data.length > 0 && onNewGroup && (
        <Button label="New group" onPress={onNewGroup} />
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  overallLabel: { ...type.label, color: color.inkMuted, marginBottom: space.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
  },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.line },
  groupName: { ...type.body, fontWeight: '500', color: color.ink },
  groupMeta: { ...type.caption, color: color.inkFaint, marginTop: 1 },
});
