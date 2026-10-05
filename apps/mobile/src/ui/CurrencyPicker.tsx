/**
 * Which currencies someone uses, and which one a new group starts in.
 *
 * The same control ends the first-launch tour and sits under Account, so the
 * question is asked and changed in the same words. Each currency says what
 * comes with it, because that is what is really being chosen: rupees bring
 * UPI and bitcoin brings Lightning, and whatever isn't ticked the app stops
 * showing (payWays).
 */

import React from 'react';
import { Pressable, Text, View } from 'react-native';

import type { SupportedCurrency } from '@sattle/core';
import { startNewGroupsIn, toggleCurrency, type CurrencyPrefs } from '../prefs/currencyPrefs';
import { Card, Divider, Segmented } from './primitives';
import { makeStyles, radius, space, type, useColors } from './theme';

const OPTIONS: Array<{ currency: SupportedCurrency; mark: string; name: string; detail: string }> = [
  { currency: 'INR', mark: '₹', name: 'Rupees', detail: 'Keep bills in rupees and settle up by UPI.' },
  { currency: 'BTC', mark: 'sats', name: 'Bitcoin', detail: 'Keep bills in sats and settle up over Lightning.' },
];

/** The currencies someone uses, by name, for wherever they pick one of them: never one they don't use. */
export const currencyNames = (uses: readonly SupportedCurrency[]) =>
  OPTIONS.filter((o) => uses.includes(o.currency)).map((o) => ({ value: o.currency, label: o.name }));

export function CurrencyPicker({
  prefs,
  onChange,
  keepOne,
}: {
  prefs: CurrencyPrefs;
  onChange: (next: CurrencyPrefs) => void;
  /** The last currency left can't be turned off. Under Account, where there must always be a choice. */
  keepOne?: boolean;
}) {
  const color = useColors();
  const s = useStyles();
  const both = prefs.uses.length > 1;

  return (
    <View style={{ gap: space.md }}>
      <Card style={{ padding: 0 }}>
        {OPTIONS.map((o, i) => {
          const on = prefs.uses.includes(o.currency);
          const fixed = Boolean(keepOne && on && prefs.uses.length === 1);
          return (
            <View key={o.currency}>
              {i > 0 && <Divider />}
              <Pressable
                onPress={() => onChange(toggleCurrency(prefs, o.currency))}
                disabled={fixed}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on, disabled: fixed }}
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

/** What the choice so far does to the app, in a line. */
function outcome({ uses }: CurrencyPrefs): string {
  const rupees = uses.includes('INR');
  const bitcoin = uses.includes('BTC');
  if (rupees && bitcoin) {
    return 'You pick the currency for each new group. A rupee group can be settled by UPI or over Lightning, a bitcoin group over Lightning.';
  }
  if (rupees) return 'Your groups are in rupees and settled by UPI. Sattle keeps everything to do with Bitcoin out of your way.';
  if (bitcoin) return 'Your groups are in sats and settled over Lightning. Sattle keeps UPI out of your way.';
  return 'Pick at least one to carry on.';
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
}));
