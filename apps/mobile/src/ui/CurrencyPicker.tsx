/**
 * Which currencies someone uses, and which one a new group starts in. It
 * sits under Account, ticked as they last chose.
 *
 * Each currency says what comes with it, because that is what is really
 * being chosen: rupees bring UPI and bitcoin brings Lightning, and whatever
 * isn't ticked the app stops showing (payWays). The last one left can't be
 * unticked.
 *
 * CurrencyChips asks the same on the first screen, in a line of chips under
 * the name.
 */

import React, { useRef } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';

import type { SupportedCurrency } from '@sattle/core';
import { analytics } from '../analytics/analytics';
import { startNewGroupsIn, toggleCurrency, type CurrencyPrefs } from '../prefs/currencyPrefs';
import { useReducedMotion } from './Coachmarks';
import { MOVES } from './FirstRunScreen';
import { Card, Divider, Glyph, Segmented } from './primitives';
import { makeStyles, radius, space, type, useColors } from './theme';

const OPTIONS: Array<{ currency: SupportedCurrency; mark: string; name: string; chip: string; detail: string }> = [
  { currency: 'INR', mark: '₹', name: 'Rupees', chip: '₹ · INR', detail: 'Keep bills in rupees and settle up by UPI.' },
  { currency: 'BTC', mark: 'sats', name: 'Bitcoin', chip: '₿ · BTC', detail: 'Keep bills in sats and settle up over Lightning.' },
];

/** The currencies someone uses, by name, for wherever they pick one of them: never one they don't use. */
export const currencyNames = (uses: readonly SupportedCurrency[]) =>
  OPTIONS.filter((o) => uses.includes(o.currency)).map((o) => ({ value: o.currency, label: o.name }));

export function CurrencyPicker({
  prefs,
  onChange,
}: {
  prefs: CurrencyPrefs;
  onChange: (next: CurrencyPrefs) => void;
}) {
  const color = useColors();
  const s = useStyles();
  const both = prefs.uses.length > 1;

  return (
    <View style={{ gap: space.md }}>
      <Card style={{ padding: 0 }}>
        {OPTIONS.map((o, i) => {
          const on = prefs.uses.includes(o.currency);
          // The last one left stays on.
          const fixed = on && prefs.uses.length === 1;
          return (
            <View key={o.currency}>
              {i > 0 && <Divider />}
              <Pressable
                onPress={() => {
                  analytics.tap('Currency', { control: 'checkbox', currency: o.currency, on: !on });
                  onChange(toggleCurrency(prefs, o.currency));
                }}
                disabled={fixed}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on, disabled: fixed }}
                // A browser is told separately: react-native-web doesn't read accessibilityState.
                aria-checked={on}
                accessibilityLabel={`${o.name}. ${o.detail}`}
                style={({ pressed }) => [
                  s.row,
                  i === 0 && s.rowFirst,
                  i === OPTIONS.length - 1 && s.rowLast,
                  (on || pressed) && s.rowOn,
                ]}
              >
                <View style={[s.mark, on && { backgroundColor: color.surface }]}>
                  <Text style={[s.markText, o.mark.length === 1 && s.markSign]}>{o.mark}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>{o.name}</Text>
                  <Text style={s.detail}>{o.detail}</Text>
                </View>
                <View style={[s.check, on && s.checkOn, fixed && { opacity: 0.5 }]}>
                  {on && <Text style={s.checkMark}>✓</Text>}
                </View>
              </Pressable>
            </View>
          );
        })}
      </Card>

      {both && (
        <View style={{ gap: space.sm }}>
          <Text style={s.label}>New groups start in</Text>
          <Segmented
            options={currencyNames(prefs.uses)}
            value={prefs.newGroups}
            onChange={(currency) => onChange(startNewGroupsIn(prefs, currency))}
          />
        </View>
      )}

      <Text style={s.outcome}>{outcome(prefs)}</Text>
    </View>
  );
}

/**
 * The first screen's way of asking: a chip for each currency, centred, any
 * number of them on, never none. A chosen one has the accent wash and edge
 * (theme). On a phone a chip gives a little under the finger and springs
 * back as it's let go.
 */
export function CurrencyChips({
  prefs,
  onChange,
  disabled,
}: {
  prefs: CurrencyPrefs;
  onChange: (next: CurrencyPrefs) => void;
  disabled?: boolean;
}) {
  const s = useStyles();
  return (
    <View style={s.chips}>
      {OPTIONS.map((o) => {
        const on = prefs.uses.includes(o.currency);
        return (
          <Chip
            key={o.currency}
            option={o}
            on={on}
            // The last one left stays on. It isn't drawn as off-limits: it's chosen, and tapping it just keeps it.
            fixed={on && prefs.uses.length === 1}
            disabled={disabled}
            onPress={() => {
              analytics.tap('Currency', { control: 'chip', currency: o.currency, on: !on });
              onChange(toggleCurrency(prefs, o.currency));
            }}
          />
        );
      })}
    </View>
  );
}

function Chip({
  option,
  on,
  fixed,
  disabled,
  onPress,
}: {
  option: (typeof OPTIONS)[number];
  on: boolean;
  fixed: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const color = useColors();
  const s = useStyles();
  const reduce = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const spring = (toValue: number, bounciness: number) => {
    if (!MOVES || reduce) return;
    Animated.spring(scale, { toValue, speed: 30, bounciness, useNativeDriver: true }).start();
  };
  const off = Boolean(disabled || fixed);
  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => spring(0.93, 0)}
      onPressOut={() => spring(1, 14)}
      disabled={off}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on, disabled: off }}
      // A browser is told separately: react-native-web doesn't read accessibilityState.
      aria-checked={on}
      accessibilityLabel={`${option.name}. ${option.detail}`}
    >
      {({ pressed }) => (
        <Animated.View
          style={[s.chip, on && s.chipOn, !MOVES && pressed && { opacity: 0.85 }, { transform: [{ scale }] }]}
        >
          {on && <Glyph name="check" ink={color.accent} size={16} weight={2.6} />}
          <Text style={[s.chipLabel, on && s.chipLabelOn]}>{option.chip}</Text>
        </Animated.View>
      )}
    </Pressable>
  );
}

/** What the choice so far does to the app, in a line. */
function outcome({ uses }: CurrencyPrefs): string {
  const rupees = uses.includes('INR');
  const bitcoin = uses.includes('BTC');
  if (rupees && bitcoin) {
    return 'You pick the currency for each new group. A rupee group can be settled by UPI or over Lightning, a bitcoin group over Lightning.';
  }
  if (rupees) return 'Your groups are in rupees and settled by UPI. Sattle keeps everything to do with Bitcoin out of your way.';
  return 'Your groups are in sats and settled over Lightning. Sattle keeps UPI out of your way.';
}

const useStyles = makeStyles((color) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
  // The card's corners are rounded and it doesn't clip, so the rows at its ends are too.
  rowFirst: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  rowLast: { borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
  rowOn: { backgroundColor: color.accentWash },
  // The circle an avatar is, holding the unit the currency is counted in.
  mark: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markText: { ...type.amountSm, fontWeight: '500', color: color.ink },
  // A sign on its own is set larger, to weigh the same as a word.
  markSign: { fontSize: 20 },
  name: { ...type.body, fontWeight: '500', color: color.ink },
  detail: { ...type.caption, color: color.inkMuted, lineHeight: 17, marginTop: 1 },
  check: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: color.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: color.accent, borderColor: color.accent },
  checkMark: { color: color.onAccent, fontSize: 13, fontWeight: '700' },
  label: { ...type.label, color: color.inkMuted },
  outcome: { ...type.caption, color: color.inkMuted, lineHeight: 18 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space.sm },
  // The edge is there, clear, when it's off, so a chip doesn't move as it's ticked.
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 48,
    minWidth: 112,
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: color.surfaceSunken,
  },
  chipOn: { borderColor: color.accent, backgroundColor: color.accentWash },
  chipLabel: { fontSize: 16, fontWeight: '500', color: color.inkMuted },
  chipLabelOn: { color: color.ink, fontWeight: '700' },
}));
