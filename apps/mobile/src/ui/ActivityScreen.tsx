/**
 * Activity: what's been spent, paid and changed across all the user's
 * groups, newest first, a day at a time (activityOf). Each line says which
 * group, who did it, and for money what it did for them: lent, borrowed,
 * paid or got. One that was only theirs (they paid it, and all of it was their
 * part) shows what it cost and says "just you", as the group does. A line that
 * didn't involve them shows its amount, quietly. A
 * change to a group ("Om turned on Simplify debts") has no amount. Tapping
 * one opens its group.
 *
 * It's drawn from what the app already has, so it opens at once and follows
 * the groups as they change. Edits and removals stay in each group's History.
 */

import React, { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { dateFormat, formatAmount } from '@sattle/core';
import { analytics } from '../analytics/analytics';
import { useScreenView } from '../analytics/useScreenView';
import { useFirstLoad, useView } from '../data/useAppData';
import { activityOf, type ActivityItem } from '../data/views';
import { Avatar, Card, Divider, EmptyState, ErrorState, Loading, Screen, SectionLabel } from './primitives';
import { makeStyles, space, type, useColors } from './theme';

export function ActivityScreen({ onOpenGroup }: { onOpenGroup: (groupId: string) => void }) {
  useScreenView('Activity');
  const view = useView();
  const first = useFirstLoad();
  const days = useMemo(() => (view ? byDay(activityOf(view)) : null), [view]);

  return (
    <Screen title="Activity">
      {!days && first.waiting && <Loading lines={4} />}
      {!days && first.error && <ErrorState message={first.error.message} error={first.error} onRetry={first.retry} />}
      {days?.length === 0 && <EmptyState title="Nothing yet" body="Expenses, payments and changes in your groups show up here." />}
      {days?.map((day) => (
        <View key={day.label}>
          <SectionLabel>{day.label}</SectionLabel>
          <Card style={{ padding: 0 }}>
            {day.items.map((item, i) => (
              <View key={item.id}>
                {i > 0 && <Divider />}
                <Row item={item} onPress={() => onOpenGroup(item.groupId)} />
              </View>
            ))}
          </Card>
        </View>
      ))}
    </Screen>
  );
}

function Row({ item, onPress }: { item: ActivityItem; onPress: () => void }) {
  const color = useColors();
  const s = useStyles();
  const mine = item.mine;
  return (
    <Pressable
      onPress={() => {
        analytics.tap('Activity item', { control: 'row', kind: item.kind });
        onPress();
      }}
      accessibilityRole="button"
      style={({ pressed }) => [s.row, pressed && { backgroundColor: color.surfaceSunken }]}
    >
      <Avatar name={item.groupName} />
      <View style={{ flex: 1 }}>
        <Text style={[s.title, item.kind === 'change' && s.change]} numberOfLines={item.kind === 'change' ? 2 : 1}>
          {item.title}
        </Text>
        <Text style={s.meta} numberOfLines={1}>
          {item.detail ? `${item.groupName} · ${item.detail}` : item.groupName}
        </Text>
      </View>
      {item.kind === 'change' ? null : mine === null ? (
        <Text style={s.quiet}>{formatAmount(item.amount, item.currency)}</Text>
      ) : mine === 0 ? (
        // Theirs alone: nothing lent or borrowed, so it says what it cost, in plain ink.
        <View style={s.mine}>
          <Text style={[s.amount, { color: color.ink }]}>{formatAmount(item.amount, item.currency)}</Text>
          <Text style={s.effect}>just you</Text>
        </View>
      ) : (
        <View style={s.mine}>
          <Text style={[s.amount, { color: mine > 0 ? color.owed : color.owe }]}>
            {formatAmount(Math.abs(mine), item.currency)}
          </Text>
          <Text style={s.effect}>{effect(item.kind, mine)}</Text>
        </View>
      )}
    </Pressable>
  );
}

const effect = (kind: 'expense' | 'payment', mine: number) =>
  kind === 'expense' ? (mine > 0 ? 'you lent' : 'you borrowed') : mine > 0 ? 'you got' : 'you paid';

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Today", "Yesterday", "3 Nov", and the year once it isn't this one. */
function dayOf(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return dateFormat(undefined, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(d);
}

/** The items, newest first already, in runs of the same day. */
function byDay(items: ActivityItem[]): Array<{ label: string; items: ActivityItem[] }> {
  const days: Array<{ label: string; items: ActivityItem[] }> = [];
  for (const item of items) {
    const label = dayOf(item.at);
    const last = days[days.length - 1];
    if (last?.label === label) last.items.push(item);
    else days.push({ label, items: [item] });
  }
  return days;
}

const useStyles = makeStyles((color) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, paddingHorizontal: space.lg },
  title: { ...type.body, fontWeight: '500', color: color.ink },
  // A change to a group isn't money, so it's set lighter than what was spent or paid.
  change: { fontWeight: '400', color: color.inkMuted },
  meta: { ...type.caption, color: color.inkFaint, marginTop: 1 },
  mine: { alignItems: 'flex-end' },
  amount: { ...type.amountMd },
  effect: { ...type.caption, color: color.inkFaint, marginTop: 1 },
  quiet: { ...type.amountSm, color: color.inkFaint },
}));
