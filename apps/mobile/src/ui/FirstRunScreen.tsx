/**
 * The frame for the first screens of a new account: the first screen
 * (WelcomeScreen) and the UPI step after it (UpiStepScreen).
 *
 * Unlike Screen, there's no title bar and no lines: one question in the
 * middle of the page, set large, with what answers it under it and the one
 * button that goes on at the bottom. A Skip, where there is one, sits alone
 * at the top right. The footer steps aside while the keyboard is up, as
 * Screen's does, and on iOS the page scrolls what's being typed in clear of
 * the keyboard.
 *
 * Headline, Hero and the styles here are the pieces both screens share, so
 * they read as one sequence.
 *
 * On a phone the screen comes in moving: each block rises into place a beat
 * after the one above it (Rise), and the hero pops in and then floats,
 * slowly, while the screen is up. Not in a browser, where it would only slow
 * the tests, and not when the phone asks for less motion (useReducedMotion).
 */

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useReducedMotion } from './Coachmarks';
import { useKeyboardUp } from './primitives';
import { brandBlue, makeStyles, radius, space, type } from './theme';

const LOGO_MARK = require('../../assets/logo-mark.png');

/** Phones only: a browser draws the screen as it is. */
export const MOVES = Platform.OS !== 'web';

/** How long each block takes to rise, and how far apart they start. */
const RISE_MS = 560;
const STEP_MS = 90;

/**
 * A block of the screen that rises into place as the screen opens, `order`
 * beats after the first. Still, and already in place, in a browser or when
 * the phone asks for less motion.
 */
export function Rise({
  order = 0,
  style,
  children,
}: {
  order?: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  const shown = useRef(new Animated.Value(MOVES ? 0 : 1)).current;
  useEffect(() => {
    if (!MOVES) return;
    const rise = Animated.timing(shown, {
      toValue: 1,
      duration: RISE_MS,
      delay: STEP_MS * order,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    rise.start();
    return () => rise.stop();
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The phone says so a moment after the screen is up: whatever was moving is put in place.
  useEffect(() => {
    if (reduce) shown.setValue(1);
  }, [reduce, shown]);
  if (!MOVES) return <View style={style}>{children}</View>;
  const lift = shown.interpolate({ inputRange: [0, 1], outputRange: [22, 0] });
  return <Animated.View style={[style, { opacity: shown, transform: [{ translateY: lift }] }]}>{children}</Animated.View>;
}

export function FirstRunScreen({
  right,
  footer,
  children,
}: {
  /** At the top right, alone: Skip, say. */
  right?: React.ReactNode;
  /** The one thing that goes on, kept at the bottom. */
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const s = useFirstRunStyles();
  const insets = useSafeAreaInsets();
  const bar = useKeyboardUp() ? null : footer;
  return (
    <View style={s.screen}>
      <View style={[s.top, { paddingTop: insets.top + space.xs }]}>{right}</View>
      <ScrollView
        contentContainerStyle={[s.body, { paddingBottom: bar ? space.lg : space.xxl + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <View style={s.column}>{children}</View>
      </ScrollView>
      {bar && <View style={[s.footer, { paddingBottom: space.md + insets.bottom }]}>{bar}</View>}
    </View>
  );
}

/**
 * The question, centred and large, with the words that matter set heavier.
 * End `before` with a line break to keep those words together on a line.
 */
export function Headline({ before, em, after = '' }: { before: string; em: string; after?: string }) {
  const s = useFirstRunStyles();
  return (
    <Text style={s.headline} accessibilityRole="header">
      {before}
      <Text style={s.headlineEm}>{em}</Text>
      {after}
    </Text>
  );
}

/**
 * What sits over the question: Sattle's mark, or a sign for what's being
 * asked. On a phone it pops in with a little overshoot, then floats a few
 * points up and down, slowly, for as long as the screen is up.
 */
export function Hero({ sign }: { sign?: string }) {
  const s = useFirstRunStyles();
  const reduce = useReducedMotion();
  const pop = useRef(new Animated.Value(MOVES ? 0 : 1)).current;
  const float = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!MOVES || reduce) {
      pop.setValue(1);
      float.setValue(0);
      return;
    }
    const drift = (to: number) =>
      Animated.timing(float, { toValue: to, duration: 1800, easing: Easing.inOut(Easing.sin), useNativeDriver: true });
    const run = Animated.sequence([
      Animated.spring(pop, { toValue: 1, friction: 5, tension: 70, useNativeDriver: true }),
      Animated.loop(Animated.sequence([drift(1), drift(0)])),
    ]);
    run.start();
    return () => run.stop();
  }, [reduce, pop, float]);

  const moving = MOVES
    ? {
        opacity: pop.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 1] }),
        transform: [
          { scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) },
          { translateY: float.interpolate({ inputRange: [0, 1], outputRange: [0, -5] }) },
        ],
      }
    : null;
  return (
    <Animated.View
      style={[sign ? s.sign : s.mark, moving]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {sign ? <Text style={s.signText}>{sign}</Text> : <Image source={LOGO_MARK} style={{ width: 64, height: 64 }} />}
    </Animated.View>
  );
}

export const useFirstRunStyles = makeStyles((color) => ({
  screen: { flex: 1, backgroundColor: color.paper },
  top: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: space.md,
  },
  // Centred in the space when it fits, scrolling when it doesn't.
  body: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: space.xl, paddingTop: space.md },
  column: { width: '100%', maxWidth: 420, alignSelf: 'center', alignItems: 'center', gap: space.lg },
  footer: { paddingHorizontal: space.xl, paddingTop: space.md, backgroundColor: color.paper },

  mark: {
    width: 64,
    height: 64,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: brandBlue,
    marginBottom: space.xs,
  },
  sign: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    backgroundColor: color.accentWash,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  signText: { fontSize: 28, fontWeight: '600', color: color.accent },

  // Above the question, a quiet hello.
  kicker: { ...type.label, fontSize: 15, color: color.inkMuted, textAlign: 'center' },
  headline: {
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '400',
    letterSpacing: -0.6,
    color: color.ink,
    textAlign: 'center',
  },
  headlineEm: { fontWeight: '800' },
  lead: { ...type.body, fontSize: 16, lineHeight: 23, color: color.inkMuted, textAlign: 'center', maxWidth: 340 },

  // The one field, as wide as the column and as round as the chips.
  input: {
    alignSelf: 'stretch',
    height: 58,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    backgroundColor: color.surface,
    paddingHorizontal: space.xl,
    fontSize: 20,
    fontWeight: '500',
    color: color.ink,
    textAlign: 'center',
  },
  hint: { ...type.caption, fontSize: 13, lineHeight: 18, color: color.inkFaint, textAlign: 'center' },
  // A second question further down the same screen.
  subhead: { fontSize: 21, lineHeight: 27, fontWeight: '400', letterSpacing: -0.3, color: color.ink, textAlign: 'center' },
  subheadEm: { fontWeight: '800' },
}));
