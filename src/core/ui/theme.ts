/**
 * Design tokens.
 *
 * Direction: money software, not a crypto app. Warm paper ground rather than
 * the default white, ink rather than pure black, and a single amber accent
 * used only where the user is meant to act. Amounts are set in a monospace
 * face throughout — it makes columns of numbers line up and reads as
 * financial rather than social, which is the register we want.
 *
 * Deliberately no orange gradients, no neon, no dark-mode-by-default. The
 * brief is that Bitcoin's UX is bad marketing for Bitcoin; the way to avoid
 * adding to that is to look like something a person already trusts.
 */

import { Platform } from 'react-native';

export const color = {
  // Ground
  paper: '#FAF8F5',
  surface: '#FFFFFF',
  surfaceSunken: '#F2EEE8',

  // Ink
  ink: '#1A1714',
  inkMuted: '#6B635A',
  inkFaint: '#9C948A',

  // Lines
  line: '#E6E0D7',
  lineStrong: '#D4CCC0',

  // Accent — actions only, never decoration
  accent: '#C2621C',
  accentPressed: '#A85315',
  accentWash: '#FBF0E5',
  onAccent: '#FFFFFF',

  // Money
  owed: '#1F7A4D', // they owe you
  owe: '#B4412E', // you owe them
  settled: '#9C948A',

  // States
  danger: '#B4412E',
  dangerWash: '#FBECE9',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
} as const;

/**
 * Monospace for anything numeric. On Android the system mono is the only
 * safe bet without shipping a font file.
 */
export const mono = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'ui-monospace, SFMono-Regular, Menlo, monospace',
});

export const type = {
  display: { fontSize: 28, fontWeight: '600' as const, letterSpacing: -0.4 },
  title: { fontSize: 19, fontWeight: '600' as const, letterSpacing: -0.2 },
  heading: { fontSize: 16, fontWeight: '600' as const },
  body: { fontSize: 15, fontWeight: '400' as const, lineHeight: 21 },
  label: { fontSize: 13, fontWeight: '500' as const },
  caption: { fontSize: 12, fontWeight: '400' as const },
  amountLg: { fontSize: 30, fontWeight: '500' as const, fontFamily: mono },
  amountMd: { fontSize: 16, fontWeight: '500' as const, fontFamily: mono },
  amountSm: { fontSize: 13, fontWeight: '400' as const, fontFamily: mono },
} as const;

/** Soft, low-contrast elevation. Nothing should float dramatically. */
export const shadow = Platform.select({
  ios: {
    shadowColor: '#3A2E20',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 2 },
  },
  android: { elevation: 2 },
  default: { boxShadow: '0 2px 12px rgba(58,46,32,0.06)' },
}) as object;
