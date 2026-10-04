/**
 * One quiet line above the tab bar while the server can't be reached, saying
 * that what's on screen is what this device saved, and from when. Renders
 * nothing the rest of the time, and always nothing in demo mode.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useOffline } from '../react/SattleProvider';
import { makeStyles, space, type } from './theme';

export function OfflineBanner() {
  const s = useStyles();
  const { offline, savedAt } = useOffline();
  if (!offline) return null;

  return (
    <View style={s.banner}>
      <Text style={s.text}>
        {savedAt === null
          ? 'Offline. This updates when you’re back online.'
          : `Offline. Showing what was saved ${when(savedAt)}. It updates when you’re back online.`}
      </Text>
    </View>
  );
}

/** "at 4:12 pm" for today, "on 3 Oct" for any other day. */
function when(at: number): string {
  const then = new Date(at);
  return then.toDateString() === new Date().toDateString()
    ? `at ${then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    : `on ${then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

const useStyles = makeStyles((color) => ({
  banner: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
    backgroundColor: color.surfaceSunken,
  },
  text: { ...type.label, color: color.inkMuted },
}));
