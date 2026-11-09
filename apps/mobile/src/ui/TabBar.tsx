/**
 * The bar at the bottom of Groups, Activity and Account: a capsule floating a
 * little above the bottom edge, an icon and a label for each tab, and a
 * highlight that slides to the one that's open. Deeper screens (a group, the
 * expense form, a page under Account) don't have it; back takes them out.
 *
 *   iPhone    Apple's Liquid Glass (expo-glass-effect), where the phone has it
 *             (iOS 26 on), so what scrolls under the bar shows through it, as
 *             it does under the system's own tab bars. An older iPhone gets a
 *             translucent bar.
 *   Android   the same capsule, solid, with a soft shadow. Glass there would
 *   and web   be an imitation, so it isn't tried.
 *
 * On a phone the highlight springs to the tab that's tapped and its icon
 * bounces; in a browser, or when the phone asks for less motion, it moves at
 * once.
 *
 * It floats over the screen rather than taking room from it, so a screen with
 * the bar is told the bar's height as its bottom inset (useTabBarSpace) and
 * keeps its last row clear of it.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';

import { analytics } from '../analytics/analytics';
import { useReducedMotion } from './Coachmarks';
import { makeStyles, radius, space, useColorMode, useColors } from './theme';

const IOS = Platform.OS === 'ios';
const MOVES = Platform.OS !== 'web';
/** Apple's Liquid Glass, where this iPhone has it. It doesn't change while the app runs. */
const GLASS = IOS && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

const BAR_HEIGHT = 64;
/** Between the bar's edge and the highlight. */
const INSET = 5;

/** Stroked paths on a 24 by 24 grid, as primitives' Glyph draws them. */
const ICONS = {
  // Two people, one in front of the other.
  groups:
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2.5 21v-.5A6.5 6.5 0 0 1 9 14a6.5 6.5 0 0 1 6.5 6.5v.5M16 3.3a4 4 0 0 1 0 7.4M21.5 21v-.5a6.5 6.5 0 0 0-3.5-5.8',
  // A pulse.
  activity: 'M2.5 12h4l3-7.5 5 15 3-7.5h4',
  // Someone, in a circle.
  account:
    'M12 21.5a9.5 9.5 0 1 0 0-19 9.5 9.5 0 0 0 0 19zM12 13a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM6 18.6a7 7 0 0 1 12 0',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
} as const;

export type TabIcon = keyof typeof ICONS;

export interface TabItem<K extends string> {
  key: K;
  label: string;
  icon: TabIcon;
}

/** How far the bar sits above the bottom edge: just over the home indicator, or a gap where there's none. */
const lift = (insetBottom: number) => Math.max(insetBottom - 8, space.md);

/** What a screen under the bar leaves clear at its bottom, so nothing hides behind it. */
export function useTabBarSpace(): number {
  return lift(useSafeAreaInsets().bottom) + BAR_HEIGHT + space.sm;
}

export function TabBar<K extends string>({
  tabs,
  current,
  onSelect,
}: {
  tabs: ReadonlyArray<TabItem<K>>;
  current: K;
  onSelect: (key: K) => void;
}) {
  const s = useStyles();
  const mode = useColorMode();
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const [width, setWidth] = useState(0);
  const at = Math.max(0, tabs.findIndex((t) => t.key === current));
  const slot = width > 0 ? (width - INSET * 2) / tabs.length : 0;

  // Where the highlight is. Placed outright the first time, and when nothing should move.
  const x = useRef(new Animated.Value(0)).current;
  const placed = useRef(false);
  useEffect(() => {
    if (!slot) return;
    const to = at * slot;
    if (!placed.current || !MOVES || reduce) {
      placed.current = true;
      x.setValue(to);
      return;
    }
    Animated.spring(x, { toValue: to, speed: 16, bounciness: 6, useNativeDriver: true }).start();
  }, [at, slot, reduce, x]);

  const highlight = slot > 0 && (
    <Animated.View
      pointerEvents="none"
      style={[
        s.highlight,
        IOS ? { backgroundColor: mode === 'dark' ? 'rgba(255,255,255,0.14)' : 'rgba(11,20,38,0.07)' } : s.highlightSolid,
        { width: slot, transform: [{ translateX: x }] },
      ]}
    />
  );
  const buttons = tabs.map((t, i) => (
    <TabButton
      key={t.key}
      item={t}
      selected={i === at}
      reduce={reduce}
      onPress={() => {
        analytics.tap(t.label, { control: 'tab' });
        onSelect(t.key);
      }}
    />
  ));
  const measure = (e: { nativeEvent: { layout: { width: number } } }) => setWidth(e.nativeEvent.layout.width);

  return (
    <View pointerEvents="box-none" style={[s.wrap, { bottom: lift(insets.bottom) }]}>
      {GLASS ? (
        <GlassView
          glassEffectStyle="regular"
          isInteractive
          style={[s.bar, s.glass]}
          onLayout={measure}
          accessibilityRole="tablist"
        >
          {highlight}
          {buttons}
        </GlassView>
      ) : (
        <View
          style={[s.bar, IOS ? (mode === 'dark' ? s.frostedDark : s.frostedLight) : s.solid]}
          onLayout={measure}
          accessibilityRole="tablist"
        >
          {highlight}
          {buttons}
        </View>
      )}
    </View>
  );
}

function TabButton<K extends string>({
  item,
  selected,
  reduce,
  onPress,
}: {
  item: TabItem<K>;
  selected: boolean;
  reduce: boolean;
  onPress: () => void;
}) {
  const color = useColors();
  const s = useStyles();
  const scale = useRef(new Animated.Value(1)).current;
  const was = useRef(selected);
  // Picked: the icon bounces, once.
  useEffect(() => {
    if (selected && !was.current && MOVES && !reduce) {
      scale.setValue(0.82);
      Animated.spring(scale, { toValue: 1, speed: 14, bounciness: 14, useNativeDriver: true }).start();
    }
    was.current = selected;
  }, [selected, reduce, scale]);
  const press = (to: number) => MOVES && !reduce && Animated.spring(scale, { toValue: to, speed: 40, bounciness: 0, useNativeDriver: true }).start();

  const ink = selected ? color.accent : IOS ? color.ink : color.inkMuted;
  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => press(0.9)}
      onPressOut={() => press(1)}
      style={s.tab}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      // A browser is told separately: react-native-web doesn't read accessibilityState.
      aria-selected={selected}
      accessibilityLabel={item.label}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        <Svg width={25} height={25} viewBox="0 0 24 24" fill="none">
          <Path d={ICONS[item.icon]} stroke={ink} strokeWidth={selected ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      </Animated.View>
      <Text style={[s.label, { color: ink }, selected && s.labelOn]} numberOfLines={1}>
        {item.label}
      </Text>
    </Pressable>
  );
}

const useStyles = makeStyles((color) => ({
  // As wide as a phone allows, never wider than a phone's: on a laptop it stays a capsule.
  wrap: { position: 'absolute', left: space.xl, right: space.xl, alignItems: 'center' },
  bar: {
    flexDirection: 'row',
    width: '100%',
    maxWidth: 440,
    height: BAR_HEIGHT,
    padding: INSET,
    borderRadius: radius.pill,
  },
  glass: { overflow: 'hidden' },
  frostedLight: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    shadowColor: '#0B1426',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
  },
  frostedDark: {
    backgroundColor: 'rgba(22,27,37,0.92)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    shadowColor: '#000000',
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
  },
  solid: {
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    ...Platform.select({
      android: { elevation: 10 },
      default: { boxShadow: '0 8px 28px rgba(11,20,38,0.16)' },
    }),
  },
  highlight: { position: 'absolute', top: INSET, bottom: INSET, left: INSET, borderRadius: radius.pill },
  highlightSolid: { backgroundColor: color.accentWash },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
  label: { fontSize: 11, fontWeight: '600', letterSpacing: 0.1 },
  labelOn: { fontWeight: '700' },
}));
