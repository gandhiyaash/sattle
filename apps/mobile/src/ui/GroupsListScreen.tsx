/**
 * Groups list. First screen, and the one that has to make the app feel
 * familiar within a second — this is deliberately Splitwise-shaped.
 *
 * The headline number is the user's net position across every group, which
 * is the one thing people open this kind of app to check, on the accent wash
 * so it's the first thing seen. Under it, what's owed each way. Rupees and
 * sats don't add up to one number, so someone with groups in both gets one each.
 *
 * Each group's tile is its cover colour (coverFor) with its first letter, the
 * same colour its own screen opens on. With no groups yet, the list is
 * replaced by the kinds of thing people split, each starting a group with
 * a name of that kind suggested.
 *
 * Groups they've asked to join sit above the list until someone there lets
 * them in, and the list checks back while one is waiting.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { computeBalances, formatAmount, isHeldBy, SUPPORTED_CURRENCIES, type Group, type JoinRequest } from '@sattle/core';
import { analytics } from '../analytics/analytics';
import { useScreenView } from '../analytics/useScreenView';
import { useActionKeys, useAsync, useClient } from '../react/SattleProvider';
import { Amount, Avatar, Badge, Button, Card, ErrorState, Loading, Screen, SectionLabel } from './primitives';
import { useCurrencyPrefs } from '../prefs/useCurrencyPrefs';
import { coverFor, initialOf, makeStyles, radius, space, type, useColors } from './theme';

export interface GroupsListScreenProps {
  onOpenGroup: (groupId: string) => void;
  /** `example` is a name for the kind of group picked, for New group to suggest. */
  onNewGroup?: (example?: string) => void;
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
  onNewGroup,
  onJoin,
}: GroupsListScreenProps) {
  useScreenView('Groups');
  const color = useColors();
  const s = useStyles();
  const client = useClient();
  // Before any group, nothing is owed in any currency: say it in the one they start groups in.
  const prefs = useCurrencyPrefs();

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
        const mine = members.find((m) => isHeldBy(m, user.id));
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

  // Net position per currency, over the groups where something has been spent. In the order
  // the app lists currencies everywhere else, not the order the groups happen to come in.
  const totals = new Map<string, { net: number; owed: number; owe: number }>();
  for (const currency of new Set([...SUPPORTED_CURRENCIES, ...(data ?? []).map((r) => r.group.currency)])) {
    const spent = (data ?? []).filter((r) => r.group.currency === currency && r.expenseCount > 0);
    if (spent.length === 0) continue;
    totals.set(currency, {
      net: spent.reduce((sum, r) => sum + r.net, 0),
      owed: spent.reduce((sum, r) => sum + Math.max(r.net, 0), 0),
      owe: spent.reduce((sum, r) => sum + Math.max(-r.net, 0), 0),
    });
  }
  const noGroups = data?.length === 0 && !asked.data?.length;

  return (
    <Screen title="Sattle" brand>
      <View style={s.balance}>
        <Text style={s.balanceLabel}>Across all groups</Text>
        {totals.size === 0 ? (
          <>
            <Text style={[s.big, { color: color.settled }]}>{formatAmount(0, prefs.newGroups)}</Text>
            <Text style={s.nothingYet}>
              <Text style={s.strong}>Nothing to settle yet. </Text>
              Once you split a bill, what you’re owed and what you owe adds up here.
            </Text>
          </>
        ) : (
          [...totals].map(([currency, t], i) => (
            <View key={currency} style={[{ gap: space.xs }, i > 0 && s.balanceNext]}>
              <Text style={[s.direction, { color: t.net > 0 ? color.owed : t.net < 0 ? color.owe : color.inkMuted }]}>
                {t.net > 0 ? 'You’re owed' : t.net < 0 ? 'You owe' : 'All square'}
              </Text>
              {t.net !== 0 && <Amount minor={t.net} currency={currency} size="lg" net />}
              <View style={s.split}>
                <Text style={s.splitText}>
                  Owed to you <Text style={s.splitAmount}>{formatAmount(t.owed, currency)}</Text>
                </Text>
                <Text style={s.splitText}>
                  You owe <Text style={s.splitAmount}>{formatAmount(t.owe, currency)}</Text>
                </Text>
              </View>
            </View>
          ))
        )}
      </View>

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

      <View style={{ gap: space.sm }}>
        {/* With nothing but a request waiting, there's no list yet to label. */}
        {!(data?.length === 0 && asked.data?.length) && (
          <View style={s.groupsHead}>
            <Text style={s.groupsTitle} accessibilityRole="header">
              Groups
            </Text>
            {onNewGroup && (
              <Pressable onPress={() => onNewGroup()} hitSlop={8} accessibilityRole="button" style={s.link}>
                <Text style={s.linkText}>New group</Text>
              </Pressable>
            )}
          </View>
        )}

        {loading && <Loading lines={2} />}
        {error && <ErrorState message={error.message} error={error} onRetry={reload} />}

        {noGroups && <FirstGroup onNewGroup={onNewGroup} onJoin={onJoin} />}

        {data && data.length > 0 && (
          <Card style={{ padding: 0 }}>
            {data.map((row, i) => (
              <Pressable
                key={row.group.id}
                onPress={() => {
                  analytics.tap('Group', { control: 'row', groupId: row.group.id });
                  onOpenGroup(row.group.id);
                }}
                accessibilityRole="button"
                style={({ pressed }) => [
                  s.row,
                  i > 0 && s.rowBorder,
                  pressed && { backgroundColor: color.surfaceSunken },
                ]}
              >
                <GroupTile name={row.group.name} />
                <View style={{ flex: 1 }}>
                  <Text style={s.groupName}>{row.group.name}</Text>
                  <Text style={s.groupMeta}>{row.memberCount === 1 ? 'Just you' : `${row.memberCount} people`}</Text>
                </View>
                {row.expenseCount === 0 ? (
                  <Text style={s.groupMeta}>No expenses yet</Text>
                ) : row.net === 0 ? (
                  <View style={s.square}>
                    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={color.inkFaint} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <Path d="M5 12l5 5L20 7" />
                    </Svg>
                    <Text style={s.groupMeta}>All square</Text>
                  </View>
                ) : (
                  // Said in words too: the colour alone doesn't tell everyone which way it goes.
                  <View style={s.net}>
                    <Text style={[s.netWord, { color: row.net > 0 ? color.owed : color.owe }]}>
                      {row.net > 0 ? 'you’re owed' : 'you owe'}
                    </Text>
                    <Amount minor={row.net} currency={row.group.currency} size="md" net />
                  </View>
                )}
              </Pressable>
            ))}
          </Card>
        )}
      </View>

      {data && data.length > 0 && onJoin && <Button label="Join with a link" variant="quiet" onPress={onJoin} />}
    </Screen>
  );
}

/** A group's tile: its cover colour, with its first letter. */
export function GroupTile({ name, size = 40 }: { name: string; size?: number }) {
  const s = useStyles();
  return (
    <View
      style={[s.tile, { width: size, height: size, backgroundColor: coverFor(name).bg }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[s.tileLetter, { fontSize: Math.round(size * 0.45) }]}>{initialOf(name)}</Text>
    </View>
  );
}

/** `example` is what New group suggests for the name, so picking one is a start on it. */
const KINDS = [
  { emoji: '🏖️', title: 'A trip', sub: 'Stays, food, travel', example: 'Goa trip' },
  { emoji: '🏠', title: 'A flat', sub: 'Rent, groceries, bills', example: 'Flat 4B' },
  { emoji: '🍽️', title: 'One dinner', sub: 'Split tonight’s bill', example: 'Friday dinner' },
  { emoji: '✨', title: 'Something else', sub: 'Name it yourself', example: undefined },
];

/** In place of the list, for someone with no groups: what they might split, and the way in by a friend's link. */
function FirstGroup({ onNewGroup, onJoin }: { onNewGroup?: (example?: string) => void; onJoin?: () => void }) {
  const s = useStyles();
  const color = useColors();
  return (
    <View style={{ gap: space.md }}>
      {onNewGroup && (
        <View style={s.start}>
          <View style={{ gap: space.xs }}>
            <Text style={s.startTitle}>What are you splitting?</Text>
            <Text style={s.startBody}>Pick one to start a group. Friends see their share and pay you, without the app.</Text>
          </View>
          <View style={s.kinds}>
            {KINDS.map((k) => (
              <Pressable
                key={k.title}
                onPress={() => {
                  analytics.tap('New group', { control: 'kind', kind: k.title });
                  onNewGroup(k.example);
                }}
                accessibilityRole="button"
                accessibilityLabel={`${k.title}: ${k.sub}`}
                style={({ pressed }) => [s.kind, pressed && { borderColor: color.accent }]}
              >
                <Text style={s.kindEmoji} importantForAccessibility="no">
                  {k.emoji}
                </Text>
                <Text style={s.kindTitle}>{k.title}</Text>
                <Text style={s.groupMeta}>{k.sub}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      {onJoin && (
        <View style={s.joinCard}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={s.kindTitle}>Got a link from a friend?</Text>
            <Text style={s.startBody}>Open it, then pick your name to join their group.</Text>
          </View>
          <Button label="Use a link" onPress={onJoin} />
        </View>
      )}
    </View>
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
            {`Someone in ${request.groupName} has to let you in. If they ask, tell them your code:`}
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
  // The one thing on Home that should stand out: the wash with a 2px accent edge.
  balance: {
    backgroundColor: color.accentWash,
    borderWidth: 2,
    borderColor: color.accent,
    borderRadius: radius.lg + 2,
    padding: space.lg + 2,
    gap: space.xs,
  },
  balanceLabel: { ...type.label, color: color.inkMuted },
  balanceNext: { marginTop: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.line },
  direction: { ...type.heading },
  big: { ...type.amountLg },
  nothingYet: { ...type.body, color: color.inkMuted },
  strong: { fontWeight: '600', color: color.ink },
  split: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.lg,
    marginTop: space.sm,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: color.line,
  },
  splitText: { ...type.label, color: color.inkMuted },
  splitAmount: { fontFamily: type.amountSm.fontFamily, color: color.ink },
  groupsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  groupsTitle: { ...type.heading, color: color.ink },
  link: { minHeight: 44, justifyContent: 'center' },
  linkText: { ...type.body, fontWeight: '500', color: color.accent },
  netWord: { ...type.caption },
  square: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  tile: { borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  tileLetter: { fontWeight: '800', color: '#FFFFFF' },
  start: {
    backgroundColor: color.accentWash,
    borderWidth: 2,
    borderColor: color.accent,
    borderRadius: radius.lg + 2,
    padding: space.lg,
    gap: space.md,
  },
  startTitle: { ...type.heading, color: color.ink },
  startBody: { ...type.label, fontWeight: '400', lineHeight: 19, color: color.inkMuted },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  kind: {
    flexBasis: '47%',
    flexGrow: 1,
    minHeight: 76,
    padding: space.md,
    gap: 2,
    borderRadius: radius.md + 2,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surface,
  },
  kindEmoji: { fontSize: 20, lineHeight: 24 },
  kindTitle: { ...type.body, fontWeight: '600', color: color.ink },
  joinCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    paddingLeft: space.lg,
    borderRadius: radius.lg + 2,
    backgroundColor: color.surfaceSunken,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
  },
  net: { alignItems: 'flex-end' },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.line },
  groupName: { ...type.body, fontWeight: '500', color: color.ink },
  groupMeta: { ...type.caption, color: color.inkFaint, marginTop: 1 },
  waitingTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  waitingBody: { ...type.body, color: color.inkMuted },
  code: { ...type.amountLg, color: color.ink, letterSpacing: 6 },
  error: { ...type.caption, color: color.danger },
}));
