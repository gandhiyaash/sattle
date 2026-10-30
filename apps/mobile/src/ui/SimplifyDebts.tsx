/**
 * Whether a group simplifies its debts, as Splitwise does: chosen when the
 * group is made (NewGroupScreen) and changed under Manage
 * (GroupSettingsScreen). Off to start with: the app sends `false` when it
 * makes a group, so the API's own default never applies.
 *
 * Simplified, debts are combined into as few payments as there can be, so
 * someone may pay a person they never split with. Off, everyone pays back
 * whoever paid for them. Nobody pays more or less either way, only to
 * different people. groupDebts in @sattle/core is the rule.
 */

import React from 'react';
import { Switch, Text, View } from 'react-native';

import { analytics } from '../analytics/analytics';
import { LearnMore } from './primitives';
import { makeStyles, space, type, useColors } from './theme';

export function SimplifyDebtsSwitch({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  const color = useColors();
  const s = useStyles();
  return (
    <View style={{ gap: space.sm }}>
      <View style={s.row}>
        <View style={s.words}>
          <Text style={s.title}>Simplify debts</Text>
          <Text style={s.caption}>
            {value
              ? 'Debts are combined, so everyone settles up in as few payments as possible.'
              : 'Everyone pays back the people who paid for them.'}
          </Text>
        </View>
        <Switch
          value={value}
          onValueChange={(next) => {
            analytics.tap('Simplify debts', { control: 'switch', on: next });
            onChange(next);
          }}
          disabled={disabled}
          accessibilityLabel="Simplify debts"
          trackColor={{ false: color.lineStrong, true: color.accent }}
          thumbColor={color.surface}
          ios_backgroundColor={color.lineStrong}
        />
      </View>
      <LearnMore>
        Say Aman owes Priya, and Priya owes Om the same. Simplified, Aman pays Om and Priya is done: one payment
        instead of two. Nobody pays more or less either way, only to different people.
      </LearnMore>
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  words: { flex: 1, gap: space.xs },
  title: { ...type.body, fontWeight: '600', color: color.ink },
  caption: { ...type.caption, color: color.inkMuted },
}));
