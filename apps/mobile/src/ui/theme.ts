/**
 * Design tokens.
 *
 * Direction: money software, not a crypto app. A cool grey ground with white
 * cards, navy ink rather than pure black, and a single blue accent used only
 * where the user is meant to act: the blue of the payment apps people already
 * trust. Amounts are set in a monospace face throughout — it makes columns of
 * numbers line up and reads as financial rather than social.
 *
 * Deliberately no orange gradients, no neon, no dark-mode-by-default. The
 * brief is that Bitcoin's UX is bad marketing for Bitcoin; the way to avoid
 * adding to that is to look like something a person already trusts. The
 * orange lives only in the logo.
 *
 * Dark mode follows the system setting unless the person picks light or
 * dark. It keeps the same register: a deep navy ground rather than pure
 * black, and the same blue, lifted so it still reads as the thing to press.
 * White doesn't hold up on that lighter blue, so dark mode writes on it in ink.
 *
 * Text and the edges of controls meet WCAG AA in both modes: 4.5:1 for text,
 * inkFaint included, and 3:1 for lineStrong. Check a new colour before it goes in.
 */

import { useSyncExternalStore } from 'react';
import { Appearance as NativeAppearance, Platform, StyleSheet, useColorScheme } from 'react-native';

import { readAppearance, writeAppearance } from './appearanceStore';

const light = {
  // Ground
  paper: '#F5F7FA',
  surface: '#FFFFFF',
  surfaceSunken: '#EDF0F4',

  // Ink
  ink: '#0B1426',
  inkMuted: '#4A5263',
  inkFaint: '#626B7F',

  // Lines. `line` divides; `lineStrong` is the edge of something to type in or tap,
  // so it holds 3:1 against the ground.
  line: '#E3E7ED',
  lineStrong: '#838B98',

  // Accent — actions only, never decoration. The wash, with a 2px accent edge,
  // marks the one thing on a screen that should stand out: the balance, a chosen chip.
  accent: '#0B57D0',
  accentPressed: '#0842A0',
  accentWash: '#E8EEFC',
  onAccent: '#FFFFFF',

  // Money
  owed: '#1F7A4D', // they owe you
  owe: '#B4412E', // you owe them
  settled: '#626B7F',

  // States
  danger: '#B4412E',
  dangerWash: '#F9E4E4',

  // Dims the screen behind a sheet
  scrim: '#0B142666',
};

export type Palette = typeof light;

const dark: Palette = {
  paper: '#0C1018',
  surface: '#161B25',
  surfaceSunken: '#212837',

  ink: '#F0F3F8',
  inkMuted: '#AAB2C0',
  inkFaint: '#939CAD',

  line: '#2A3241',
  lineStrong: '#687286',

  accent: '#7FA2FF',
  accentPressed: '#A4BEFF',
  accentWash: '#1A2650',
  onAccent: '#0B1426',

  owed: '#4FB985',
  owe: '#E8786A',
  settled: '#939CAD',

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

/**
 * How wide the app gets. On a laptop or a tablet the screens stay a phone's
 * column in the middle, instead of buttons and rows running the width of the
 * window with what they belong to at the far side.
 */
export const layout = {
  maxWidth: 720,
  /** A dialog: one thing to read and answer, narrower still. */
  dialogWidth: 480,
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
    shadowColor: '#0B1426',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 2 },
  },
  android: { elevation: 2 },
  default: { boxShadow: '0 2px 12px rgba(11,20,38,0.06)' },
}) as object;

/** The logo's tile. The same in both modes, like an app icon. */
export const brandBlue = '#0B57D0';

/**
 * A group's cover colour: the band behind its name and the tile that stands
 * for it on Home. White text holds at least 6:1 on every one. `light` and
 * `dark` are the shapes drawn on the band.
 */
export const covers = [
  { name: 'blue', bg: '#002D9C', light: '#1440B5', dark: '#00237A' },
  { name: 'teal', bg: '#0F6B63', light: '#18847A', dark: '#0A5049' },
  { name: 'plum', bg: '#6B2C75', light: '#82408C', dark: '#511F59' },
  { name: 'green', bg: '#1F5E3E', light: '#2D7651', dark: '#15462D' },
  { name: 'red', bg: '#9B2335', light: '#B23A4B', dark: '#7A1828' },
  { name: 'indigo', bg: '#3D3480', light: '#5148A0', dark: '#2B2462' },
  { name: 'rust', bg: '#A3470F', light: '#BC5E22', dark: '#82380A' },
  { name: 'slate', bg: '#2E3A4F', light: '#3F4D66', dark: '#1F283A' },
] as const;

export type Cover = (typeof covers)[number];

/**
 * The cover for a group, from its name. Nothing is stored, so everyone in
 * the group sees the same colour, and New group can show it while the name
 * is being typed. Renaming a group can change it.
 */
export function coverFor(name: string): Cover {
  let h = 0;
  for (const ch of name.trim() || 'Group') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return covers[h % covers.length]!;
}
