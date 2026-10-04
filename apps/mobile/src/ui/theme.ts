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
 *
 * Dark mode follows the system setting unless the person picks light or
 * dark on the Wallet screen. It keeps the same register: a warm
 * near-black ground rather than pure black, and the same amber, lifted a
 * little so it still reads as the thing to press.
 */

import { useSyncExternalStore } from 'react';
import { Appearance as NativeAppearance, Platform, StyleSheet, useColorScheme } from 'react-native';

import { readAppearance, writeAppearance } from './appearanceStore';

const light = {
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

  // Dims the screen behind a sheet
  scrim: '#1A171466',
};

export type Palette = typeof light;

const dark: Palette = {
  paper: '#151311',
  surface: '#1F1C19',
  surfaceSunken: '#2A2622',

  ink: '#F2EDE6',
  inkMuted: '#B0A79C',
  inkFaint: '#7F776E',

  line: '#332E29',
  lineStrong: '#48413A',

  accent: '#D9772F',
  accentPressed: '#C2621C',
  accentWash: '#3A2616',
  onAccent: '#FFFFFF',

  owed: '#4FB985',
  owe: '#E8786A',
  settled: '#7F776E',

  danger: '#E8786A',
  dangerWash: '#3A1F1B',

  scrim: '#000000A6',
};

/** Follow the system, or always use one mode. */
export type Appearance = 'system' | 'light' | 'dark';

const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark'];

let appearance: Appearance = 'system';
const listeners = new Set<() => void>();

function apply(next: Appearance) {
  appearance = next;
  // Native-drawn chrome (keyboard, alerts) follows along. The web has no such override.
  if (Platform.OS !== 'web') NativeAppearance.setColorScheme(next === 'system' ? 'unspecified' : next);
  listeners.forEach((l) => l());
}

export function setAppearance(next: Appearance) {
  apply(next);
  void writeAppearance(next);
}

// The saved choice arrives a moment after launch; until then the system's mode shows.
readAppearance()
  .then((saved) => {
    const valid = APPEARANCES.find((a) => a === saved);
    if (valid) apply(valid);
  })
  .catch(() => {});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, () => appearance);
}

export function useColorMode(): 'light' | 'dark' {
  const choice = useAppearance();
  const system = useColorScheme() === 'dark' ? 'dark' : 'light';
  return choice === 'system' ? system : choice;
}

/** The palette for the system's current light or dark setting. */
export function useColors(): Palette {
  return useColorMode() === 'dark' ? dark : light;
}

/**
 * A stylesheet built from the palette, as a hook. Each mode's sheet is
 * built once, the first time it's asked for.
 */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(
  build: (color: Palette) => T & StyleSheet.NamedStyles<any>
): () => T {
  const sheets = new Map<Palette, T>();
  return function useStyles() {
    const palette = useColors();
    let sheet = sheets.get(palette);
    if (!sheet) {
      sheet = StyleSheet.create(build(palette));
      sheets.set(palette, sheet);
    }
    return sheet;
  };
}

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
