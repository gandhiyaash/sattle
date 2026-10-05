/**
 * Groups list. First screen, and the one that has to make the app feel
 * familiar within a second — this is deliberately Splitwise-shaped.
 *
 * The headline number is the user's net position across every group, which
 * is the one thing people open this kind of app to check.
 *
 * Groups they've asked to join sit above the list until someone there lets
 * them in, and the list checks back while one is waiting.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { computeBalances, type Group, type JoinRequest } from '@sattle/core';
import { useActionKeys, useAsync, useClient } from '../react/SattleProvider';
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
  /** Opens the screen that takes a group's link. */
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

  const { data, loading, error, reload, refresh } = useAsync<GroupRow[]>(async () => {
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

  const asked = useAsync(() => client.getMyJoinRequests(), []);
  const waiting = asked.data?.filter((r) => r.status === 'pending').length ?? 0;
  const seen = useRef(waiting);

  // While someone in a group still has to let them in, check back. A request that
  // was waiting and is now gone was let in, so the group is in the list: read it again.
  useEffect(() => {
    if (waiting < seen.current) refresh();
    seen.current = waiting;
    if (waiting === 0) return;
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      asked.refresh();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [waiting, asked.refresh, refresh]);

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

      {asked.data && asked.data.length > 0 && (
        <View>
          <SectionLabel>Asked to join</SectionLabel>
          <View style={{ gap: space.sm }}>
            {asked.data.map((req) => (
              <WaitingToJoin key={req.id} request={req} onChanged={asked.refresh} />
            ))}
          </View>
        </View>
      )}

      <View>
        {/* With nothing but a request waiting, there's no list yet to label. */}
        {!(data?.length === 0 && asked.data?.length) && <SectionLabel>Groups</SectionLabel>}

        {loading && <Loading lines={2} />}
        {error && <ErrorState message={error.message} onRetry={reload} />}

        {data?.length === 0 && !asked.data?.length && (
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

const REFRESH_MS = 4000;

/**
 * A group they've asked to join. Nobody is let in by holding the link, so this
 * says who has to act, and gives the code that person may ask for: if two
 * people asked to be the same name, it is how they tell them apart.
 */
function WaitingToJoin({ request, onChanged }: { request: JoinRequest; onChanged: () => void }) {
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const declined = request.status === 'declined';

  const withdraw = async () => {
    setBusy(true);
    setError(null);
    try {
      await keys.run('join-withdraw', { id: request.id }, (k) => client.withdrawJoinRequest(request.id, k));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That didn’t work. Try again.');
      setBusy(false);
    }
  };

  return (
    <Card style={{ gap: space.sm }}>
      <View style={s.waitingTop}>
        <Avatar name={request.groupName} dim />
        <View style={{ flex: 1 }}>
          <Text style={s.groupName}>{request.groupName}</Text>
          <Text style={s.groupMeta}>as {request.name}</Text>
        </View>
        {!declined && <Badge text="Waiting" tone="neutral" />}
      </View>
      {declined ? (
        <Text style={s.waitingBody}>
          Nobody let you in as {request.name}. If that is you, ask again from the group’s link, and tell someone in{' '}
          {request.groupName} your code.
        </Text>
      ) : (
        <>
          <Text style={s.waitingBody}>
            Someone in {request.groupName} has to let you in. If they ask, tell them your code:
          </Text>
          <Text style={s.code} selectable accessibilityLabel={`Code ${request.code.split('').join(' ')}`}>
            {request.code}
          </Text>
        </>
      )}
      <Button label={declined ? 'OK' : 'Take back my request'} variant="quiet" busy={busy} onPress={withdraw} />
      {error && <Text style={s.error}>{error}</Text>}
    </Card>
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
  waitingTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  waitingBody: { ...type.body, color: color.inkMuted },
  code: { ...type.amountLg, color: color.ink, letterSpacing: 6 },
  error: { ...type.caption, color: color.danger },
}));
