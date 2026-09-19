/**
 * Shared primitives. Every screen is built from these so the app looks like
 * one thing rather than six.
 *
 * Note the three state components at the bottom. Loading, error and empty
 * are not afterthoughts here — the mock client injects latency and failures
 * precisely so these get built, and a judge watching a demo on conference
 * wifi will see all three.
 */

import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';

import { formatFiat } from '../domain/ledger';
import { color, radius, shadow, space, type } from './theme';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Screen({
  title,
  subtitle,
  onBack,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={s.screen}>
      <View style={s.header}>
        {onBack && (
          <Pressable onPress={onBack} hitSlop={12} style={s.back}>
            <Text style={s.backText}>‹</Text>
          </Pressable>
        )}
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle} numberOfLines={1}>
            {title}
          </Text>
          {subtitle && <Text style={s.headerSubtitle}>{subtitle}</Text>}
        </View>
        {right}
      </View>
      <ScrollView
        contentContainerStyle={s.scrollBody}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </View>
  );
}

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Text style={s.sectionLabel}>{children}</Text>;
}

export function Divider() {
  return <View style={s.divider} />;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function Button({
  label,
  hint,
  onPress,
  variant = 'secondary',
  disabled,
  busy,
}: {
  label: string;
  hint?: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'quiet';
  disabled?: boolean;
  busy?: boolean;
}) {
  const isPrimary = variant === 'primary';
  return (
    <View>
      <Pressable
        onPress={onPress}
        disabled={disabled || busy}
        style={({ pressed }) => [
          s.btn,
          isPrimary && s.btnPrimary,
          variant === 'quiet' && s.btnQuiet,
          pressed && { opacity: 0.85 },
          (disabled || busy) && { opacity: 0.4 },
        ]}
      >
        {busy ? (
          <ActivityIndicator color={isPrimary ? color.onAccent : color.ink} />
        ) : (
          <Text style={[s.btnLabel, isPrimary && s.btnLabelPrimary]}>{label}</Text>
        )}
      </Pressable>
      {hint && <Text style={s.btnHint}>{hint}</Text>}
    </View>
  );
}

export function Avatar({ name, dim }: { name: string; dim?: boolean }) {
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
      {formatFiat(Math.abs(minor), currency)}
    </Text>
  );
}

export function SatLine({ sats }: { sats: number }) {
  return (
    <Text style={s.satLine}>
      ≈ {new Intl.NumberFormat('en-US').format(Math.round(sats))} sats
    </Text>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function Loading({ lines = 3 }: { lines?: number }) {
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
  return (
    <View style={s.empty}>
      <Text style={[type.heading, { color: color.ink }]}>{title}</Text>
      <Text style={[type.body, { color: color.inkMuted, textAlign: 'center' }]}>{body}</Text>
      {action}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  back: { paddingRight: space.xs },
  backText: { fontSize: 28, lineHeight: 30, color: color.inkMuted },
  headerTitle: { ...type.title, color: color.ink },
  headerSubtitle: { ...type.caption, color: color.inkFaint, marginTop: 1 },
  scrollBody: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl },

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

  satLine: { ...type.amountSm, color: color.inkFaint },

  skeleton: {
    height: 56,
    borderRadius: radius.md,
    backgroundColor: color.surfaceSunken,
  },
  empty: { alignItems: 'center', gap: space.sm, paddingVertical: space.xxl },
});
