/**
 * One quiet line above the tab bar while the server can't be reached and the
 * screens are showing what the app kept (AppData): the numbers may be behind
 * what others have done since. Says when they're from, and offers to ask
 * again. Renders nothing the rest of the time, and nothing before there is
 * anything kept: then the screen itself says it couldn't load.
 */

import React, { useCallback, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { dateFormat } from '@sattle/core';
import { analytics } from '../analytics/analytics';
import { useAppData } from '../data/useAppData';
import { makeStyles, space, type } from './theme';

/** `inset`: room to leave below it, for the home indicator when it's at the very bottom. */
export function OfflineBanner({ inset = 0 }: { inset?: number }) {
  const s = useStyles();
  const appData = useAppData();
  const offline = useSyncExternalStore(
    appData.subscribe,
    useCallback(() => appData.getView() !== null && appData.getStatus().error?.code === 'network', [appData])
  );
  const syncedAt = useSyncExternalStore(
    appData.subscribe,
    useCallback(() => appData.getStatus().syncedAt, [appData])
  );
  if (!offline) return null;

  const when = syncedAt ? ` from ${dateFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(syncedAt))}` : '';
  return (
    <View style={[s.banner, inset > 0 && { paddingBottom: space.md + inset }]} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Text style={s.text}>Can’t reach the server. Showing what was saved{when}.</Text>
      <Pressable
        onPress={() => {
          analytics.tap('Try again', { control: 'banner' });
          void appData.sync();
        }}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Try reaching the server again"
      >
        <Text style={s.action}>Try again</Text>
      </Pressable>
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
    backgroundColor: color.surfaceSunken,
  },
  text: { ...type.label, flex: 1, color: color.inkMuted },
  action: { ...type.label, color: color.accent },
}));
