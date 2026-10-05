/**
 * Shared primitives. Every screen is built from these so the app looks like
 * one thing rather than six.
 *
 * Note the three state components at the bottom. Loading, error and empty
 * are not afterthoughts here — the mock client injects latency and failures
 * precisely so these get built, and a judge watching a demo on conference
 * wifi will see all three.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { describeRateSource, formatAmount, formatRate, formatSats, isBitcoin, type Quote } from '@sattle/core';
import { makeStyles, radius, shadow, space, type, useColorMode, useColors } from './theme';

const LOGO = {
  light: require('../../assets/logo-light.png'),
  dark: require('../../assets/logo-dark.png'),
};
/** The logo's width over its height. */
const LOGO_ASPECT = 326 / 120;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Screen({
  title,
  brand,
  subtitle,
  onBack,
  right,
  footer,
  children,
}: {
  title: string;
  /** Show the logo in place of the title. The title is still what screen readers say. */
  brand?: boolean;
  subtitle?: string;
  onBack?: () => void;
  right?: React.ReactNode;
  /** Stays at the bottom while the rest scrolls, for the one thing the screen is there to do. */
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const s = useStyles();
  const mode = useColorMode();
  const insets = useSafeAreaInsets();
  // While someone is typing, the footer steps aside: on Android the window shrinks to the
  // keyboard, and a bar fixed to its bottom would sit over what little is left to type in.
  const typing = useKeyboardUp();
  const bar = typing ? null : footer;
  return (
    <View style={s.screen}>
      {/* The app draws under the status bar and the notch, so the header starts below them. */}
      <View style={[s.header, { paddingTop: Math.max(insets.top + space.md, space.xl) }]}>
        {onBack && (
          <Pressable onPress={onBack} hitSlop={12} style={s.back}>
            <Text style={s.backText}>‹</Text>
          </Pressable>
        )}
        <View style={{ flex: 1 }}>
          {brand ? (
            <Image
              source={LOGO[mode]}
              style={s.logo}
              resizeMode="contain"
              accessibilityRole="header"
              accessibilityLabel={title}
            />
          ) : (
            <Text style={s.headerTitle} numberOfLines={1}>
              {title}
            </Text>
          )}
          {subtitle && <Text style={s.headerSubtitle}>{subtitle}</Text>}
        </View>
        {right}
      </View>
      <ScrollView
        // With a footer, that is what keeps clear of the home indicator.
        contentContainerStyle={[s.scrollBody, { paddingBottom: bar ? space.xl : space.xxl + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
      {bar && <View style={[s.footer, { paddingBottom: space.md + insets.bottom }]}>{bar}</View>}
    </View>
  );
}

/** Whether the on-screen keyboard is up. Always false in a browser, which doesn't say. */
function useKeyboardUp() {
  const [up, setUp] = useState(false);
  useEffect(() => {
    // iOS says before the keyboard moves, so the bar is gone by the time it arrives. Android only says after.
    const ios = Platform.OS === 'ios';
    const shown = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () => setUp(true));
    const hidden = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setUp(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return up;
}

/**
 * For whatever sits above a bar that already clears the bottom of the display, like
 * the tab bar. The screens inside don't leave room for the home indicator a second time.
 */
export function AboveBottomBar({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const value = useMemo(() => ({ ...insets, bottom: 0 }), [insets]);
  return <SafeAreaInsetsContext.Provider value={value}>{children}</SafeAreaInsetsContext.Provider>;
}

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  const s = useStyles();
  return <View style={[s.card, style]}>{children}</View>;
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  const s = useStyles();
  return <Text style={s.sectionLabel}>{children}</Text>;
}

export function Divider() {
  const s = useStyles();
  return <View style={s.divider} />;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function Button({
  label,
  hint,
  onPress,
  href,
  variant = 'secondary',
  disabled,
  busy,
  danger,
}: {
  label: string;
  hint?: string;
  onPress?: () => void;
  /**
   * In a browser, makes the button a real link there, so the browser does the going and
   * `onPress` isn't needed. That is what gives a phone the chance to hand the address to an
   * app that claims it. Ignored in the installed app.
   *
   * Give one or the other, not both. With both, a browser runs `onPress` and then leaves for
   * the link anyway, cutting off whatever `onPress` started, and the installed app runs only
   * `onPress`.
   */
  href?: string;
  variant?: 'primary' | 'secondary' | 'quiet';
  disabled?: boolean;
  busy?: boolean;
  /** For something that can't be undone. */
  danger?: boolean;
}) {
  const color = useColors();
  const s = useStyles();
  const isPrimary = variant === 'primary';
  // react-native-web draws anything with an href as <a>. React Native's own types don't have the prop.
  const link = href && Platform.OS === 'web' ? ({ href, accessibilityRole: 'link' } as object) : null;
  return (
    <View>
      <Pressable
        {...link}
        onPress={onPress}
        disabled={disabled || busy}
        style={({ pressed }) => [
          s.btn,
          isPrimary && s.btnPrimary,
          variant === 'quiet' && s.btnQuiet,
          danger && variant === 'secondary' && { borderColor: color.danger },
          pressed && { opacity: 0.85 },
          (disabled || busy) && { opacity: 0.4 },
        ]}
      >
        {busy ? (
          <ActivityIndicator color={isPrimary ? color.onAccent : danger ? color.danger : color.ink} />
        ) : (
          <Text style={[s.btnLabel, isPrimary && s.btnLabelPrimary, danger && !isPrimary && { color: color.danger }]}>
            {label}
          </Text>
        )}
      </Pressable>
      {hint && <Text style={s.btnHint}>{hint}</Text>}
    </View>
  );
}

/** Stroked paths on a 24 by 24 grid. */
const ICONS = {
  // Two sheets, one over the other.
  copy: 'M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
};

/** An action drawn instead of written, where there is no room for a word. `label` is what a screen reader says in its place. */
export function IconButton({
  icon,
  label,
  onPress,
  busy,
}: {
  icon: keyof typeof ICONS;
  label: string;
  onPress?: () => void;
  busy?: boolean;
}) {
  const color = useColors();
  const s = useStyles();
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [s.iconBtn, pressed && { backgroundColor: color.surfaceSunken }]}
    >
      {busy ? (
        <ActivityIndicator color={color.ink} />
      ) : (
        <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
          <Path d={ICONS[icon]} stroke={color.ink} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </Svg>
      )}
    </Pressable>
  );
}

/**
 * Two taps for anything that can't be undone: the first asks, the second
 * does it. `onConfirm` may throw; the message shows under the button and the
 * button goes back to asking.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  hint,
  onConfirm,
}: {
  label: string;
  /** What the second tap says, e.g. "Yes, delete it". */
  confirmLabel: string;
  hint?: string;
  onConfirm: () => Promise<void>;
}) {
  const color = useColors();
  const [state, setState] = useState<'idle' | 'confirming' | 'busy'>('idle');
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setState('busy');
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That didn’t work. Try again.');
    }
    setState('idle');
  };

  return (
    <View style={{ gap: space.sm }}>
      {state === 'idle' ? (
        <Button label={label} hint={hint} danger variant="quiet" onPress={() => setState('confirming')} />
      ) : (
        <>
          <Button label={confirmLabel} danger busy={state === 'busy'} onPress={confirm} />
          {state === 'confirming' && <Button label="Cancel" variant="quiet" onPress={() => setState('idle')} />}
        </>
      )}
      {error && <Text style={[type.caption, { color: color.danger }]}>{error}</Text>}
    </View>
  );
}

/** One of a few, side by side: the appearance, or which currency a group is kept in. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const s = useStyles();
  return (
    <View style={s.segments} accessibilityRole="radiogroup">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={[s.segment, selected && s.segmentSelected]}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            // A browser is told separately: react-native-web doesn't read accessibilityState.
            aria-checked={selected}
          >
            <Text style={[s.segmentLabel, selected && s.segmentLabelSelected]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Avatar({ name, dim }: { name: string; dim?: boolean }) {
  const color = useColors();
  const s = useStyles();
  const initials = name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <View style={[s.avatar, dim && { backgroundColor: color.surfaceSunken }]}>
      <Text style={[s.avatarText, dim && { color: color.inkFaint }]}>{initials}</Text>
    </View>
  );
}

export function Badge({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'accent' }) {
  const color = useColors();
  const s = useStyles();
  return (
    <View style={[s.badge, tone === 'accent' && { backgroundColor: color.accentWash }]}>
      <Text style={[s.badgeText, tone === 'accent' && { color: color.accent }]}>{text}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Renders a net position with the sign carried by colour and wording rather
 * than a minus sign, because "-₹1,200" reads as an error and "you owe" does
 * not. Zero renders as settled, never as ₹0.
 */
export function Amount({
  minor,
  currency = 'INR',
  size = 'md',
  net,
}: {
  minor: number;
  currency?: string;
  size?: 'lg' | 'md' | 'sm';
  /** When true, colour and sign indicate direction. */
  net?: boolean;
}) {
  const color = useColors();
  const style = size === 'lg' ? type.amountLg : size === 'sm' ? type.amountSm : type.amountMd;

  if (net && minor === 0) {
    return <Text style={[style, { color: color.settled }]}>settled</Text>;
  }

  const tone = !net
    ? color.ink
    : minor > 0
      ? color.owed
      : color.owe;

  return (
    <Text style={[style, { color: tone }]}>
      {formatAmount(Math.abs(minor), currency)}
    </Text>
  );
}

/** The exact sats an invoice is for. Not approximate: the rate is pinned. */
export function SatLine({ sats }: { sats: number }) {
  const s = useStyles();
  return <Text style={s.satLine}>{formatSats(sats)}</Text>;
}

/**
 * How the fiat amount became sats, laid out like a checkout: the rate, where
 * it came from, and the fee on top. The payer sees this before they pay.
 *
 * A group kept in bitcoin is owed in sats, so no rate was used and there is
 * none to show: only the fee, and that the payment is simulated when it is.
 */
export function QuoteBreakdown({ quote, fee = true }: { quote: Quote; fee?: boolean }) {
  const s = useStyles();
  const source = describeRateSource(quote.rateSource);
  const sats = isBitcoin(quote.currency);
  const demo = quote.rateSource?.kind === 'demo';
  if (sats && !fee && !demo) return null;
  return (
    <View style={s.breakdown}>
      {!sats && <BreakdownRow label="Exchange rate" value={formatRate(quote)} numeric />}
      {!sats && source && <BreakdownRow label="Rate from" value={source} />}
      {sats && demo && <BreakdownRow label="Demo" value="No real money moves" />}
      {fee && <BreakdownRow label="Network fee" value={`≈ ${formatSats(quote.feeSat)}, paid on top`} />}
    </View>
  );
}

export function BreakdownRow({ label, value, numeric }: { label: string; value: string; numeric?: boolean }) {
  const s = useStyles();
  return (
    <View style={s.breakdownRow}>
      <Text style={s.breakdownLabel}>{label}</Text>
      <Text style={[s.breakdownValue, numeric && s.breakdownNumeric]} selectable>
        {value}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function Loading({ lines = 3 }: { lines?: number }) {
  const s = useStyles();
  return (
    <View style={{ gap: space.sm }}>
      {Array.from({ length: lines }).map((_, i) => (
        <View key={i} style={[s.skeleton, { opacity: 1 - i * 0.18 }]} />
      ))}
    </View>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  const color = useColors();
  return (
    <Card style={{ backgroundColor: color.dangerWash, borderColor: color.danger }}>
      <Text style={[type.body, { color: color.danger }]}>{message}</Text>
      {onRetry && (
        <View style={{ marginTop: space.md }}>
          <Button label="Try again" onPress={onRetry} />
        </View>
      )}
    </Card>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  const color = useColors();
  const s = useStyles();
  return (
    <View style={s.empty}>
      <Text style={[type.heading, { color: color.ink }]}>{title}</Text>
      <Text style={[type.body, { color: color.inkMuted, textAlign: 'center' }]}>{body}</Text>
      {action}
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  screen: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  back: { paddingRight: space.xs },
  backText: { fontSize: 28, lineHeight: 30, color: color.inkMuted },
  headerTitle: { ...type.title, color: color.ink },
  logo: { height: 30, width: 30 * LOGO_ASPECT },
  headerSubtitle: { ...type.caption, color: color.inkFaint, marginTop: 1 },
  scrollBody: { padding: space.lg, gap: space.lg },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
    backgroundColor: color.paper,
  },

  card: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    padding: space.lg,
    ...shadow,
  },
  sectionLabel: {
    ...type.caption,
    color: color.inkFaint,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: space.sm,
  },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: color.line },

  btn: {
    height: 48,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  btnPrimary: { backgroundColor: color.accent, borderColor: 'transparent' },
  btnQuiet: { backgroundColor: 'transparent', borderColor: 'transparent' },
  btnLabel: { ...type.label, fontSize: 15, color: color.ink },
  btnLabelPrimary: { color: color.onAccent },
  btnHint: {
    ...type.caption,
    color: color.inkFaint,
    marginTop: space.xs,
    marginLeft: space.xs,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },

  avatar: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: color.accentWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { ...type.label, fontSize: 12, color: color.accent },

  badge: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceSunken,
    alignSelf: 'flex-start',
  },
  badgeText: { ...type.caption, fontSize: 11, color: color.inkMuted },

  segments: {
    flexDirection: 'row',
    gap: space.xs,
    padding: space.xs,
    borderRadius: radius.md,
    backgroundColor: color.surfaceSunken,
  },
  segment: { flex: 1, height: 36, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  segmentSelected: {
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
  },
  segmentLabel: { ...type.label, color: color.inkMuted },
  segmentLabelSelected: { color: color.ink },

  satLine: { ...type.amountSm, color: color.inkMuted },

  breakdown: {
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.md,
    paddingVertical: space.xs,
  },
  breakdownLabel: { ...type.caption, color: color.inkFaint },
  breakdownValue: { ...type.caption, color: color.inkMuted, flexShrink: 1, textAlign: 'right' },
  breakdownNumeric: { ...type.amountSm, fontSize: 12 },

  skeleton: {
    height: 56,
    borderRadius: radius.md,
    backgroundColor: color.surfaceSunken,
  },
  empty: { alignItems: 'center', gap: space.sm, paddingVertical: space.xxl },
}));
