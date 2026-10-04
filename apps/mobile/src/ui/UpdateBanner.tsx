/**
 * One quiet line above the tab bar while an update is on offer, downloading,
 * or downloaded and waiting for a restart. Renders nothing the rest of the
 * time, and always nothing on iOS and the web.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppUpdate } from '../react/useAppUpdate';
import { makeStyles, space, type } from './theme';

export function UpdateBanner() {
  const s = useStyles();
  const { phase, progress, update, restart } = useAppUpdate();
  if (phase === 'idle') return null;

  const { text, action } = (() => {
    switch (phase) {
      case 'available':
        return { text: 'A new version of Sattle is available.', action: { label: 'Update', onPress: update } };
      case 'downloading':
        return {
          text: progress === null ? 'Downloading the update…' : `Downloading the update… ${Math.round(progress * 100)}%`,
          action: null,
        };
      case 'ready':
        return { text: 'The update is ready to install.', action: { label: 'Restart', onPress: restart } };
    }
  })();

  return (
    <View style={s.banner}>
      <Text style={s.text}>{text}</Text>
      {action && (
        <Pressable onPress={action.onPress} hitSlop={12}>
          <Text style={s.action}>{action.label}</Text>
        </Pressable>
      )}
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
