/**
 * Account: who you're signed in as, and every setting, as short rows in
 * groups the way a phone's Settings are. Each row shows where it stands and
 * opens a page with the rest (AccountPages):
 *
 *   Get paid      UPI ID, Lightning wallet, Lightning address (and the demo's
 *                 in-app wallet), only the ones that go with what they use,
 *                 or that they've set up already (useGetPaid)
 *   Preferences   currencies, and appearance, chosen right here
 *   Sign-in       the sign-in key, and Nostr for someone who uses bitcoin or
 *                 has a key linked already
 *   About         the FAQ, what you're trusting, the privacy policy
 *   Delete account, last, on its own
 *
 * Nothing on it is long: what each thing means is on its page, and how it
 * works is in the FAQ.
 */

import React from 'react';
import { Linking, Pressable, Text, View } from 'react-native';

import type { PayWays } from '@sattle/core';
import { analytics } from '../analytics/analytics';
import { useScreenView } from '../analytics/useScreenView';
import { useFirstLoad, useViewPart } from '../data/useAppData';
import { showsNostr } from '../prefs/currencyPrefs';
import { useCurrencyPrefs } from '../prefs/useCurrencyPrefs';
import { isMock, useWallet } from '../react/SattleProvider';
import { APP_URL } from '../react/useSettleFlow';
import { AppearancePicker, PAGE_TITLES, useGetPaid, type AccountPage } from './AccountPages';
import { Avatar, Card, Divider, ErrorState, Glyph, Loading, Screen, SectionLabel } from './primitives';
import { makeStyles, space, type, useColors } from './theme';

export interface AccountScreenProps {
  onOpen: (page: AccountPage) => void;
  /** The FAQ, for the ways to get paid on show here. */
  onOpenFaq: (ways: PayWays) => void;
}

export function AccountScreen({ onOpen, onOpenFaq }: AccountScreenProps) {
  useScreenView('Account');
  const s = useStyles();
  const prefs = useCurrencyPrefs();
  const wallet = useWallet();
  // Who they are is what the app already has (AppData): nothing to wait for.
  const user = useViewPart((v) => v?.user);
  const first = useFirstLoad();
  const { connection, receiveAt, upi, show, ways } = useGetPaid();
  // The demo's in-app wallet holds sats, so it goes with Lightning.
  const demoWallet = wallet.isAvailable && ways.lightning;
  const nostr = !isMock() && Boolean(user) && (showsNostr(prefs) || Boolean(user?.npub));
  const row = (page: AccountPage, value?: string) => (
    <Row key={page} label={PAGE_TITLES[page]} value={value} onPress={() => onOpen(page)} />
  );

  const getPaid = [
    show.upi && row('upi', upi.data ? (upi.data.upiId ?? 'Add') : undefined),
    show.wallet &&
      row('lightningWallet', connection.data ? (connection.data.connected ? (connection.data.alias ?? 'Connected') : 'Connect') : undefined),
    show.address && row('lightningAddress', receiveAt.data ? (receiveAt.data.address ?? 'Add') : undefined),
    demoWallet && row('demoWallet'),
  ].filter(Boolean);

  return (
    <Screen title="Account">
      {first.waiting && !user && <Loading lines={1} />}
      {first.error && !user && <ErrorState message={first.error.message} error={first.error} onRetry={first.retry} />}

      {user && (
        <View style={s.me}>
          <Avatar name={user.displayName} me size={56} />
          <View style={{ flex: 1 }}>
            <Text style={s.name} numberOfLines={1}>
              {user.displayName}
            </Text>
            <Text style={s.meta}>Signed in on this device</Text>
          </View>
        </View>
      )}

      <Group label="Get paid">{getPaid}</Group>

      <Group label="Preferences">
        {row('currencies', currencyNames(prefs.uses))}
        <View style={s.appearance}>
          <Text style={s.label}>Appearance</Text>
          <AppearancePicker />
        </View>
      </Group>

      {user && !isMock() && (
        <Group label="Sign-in">
          {row('signInKey')}
          {nostr && row('nostr', user.npub ? 'Linked' : undefined)}
        </Group>
      )}

      <Group label="About">
        <Row label="FAQ" onPress={() => onOpenFaq(ways)} />
        {row('trust')}
        <Row label="Privacy policy" external onPress={() => Linking.openURL(`${APP_URL}/privacy`)} />
      </Group>

      {user && (
        <Card style={{ padding: 0 }}>
          <Row label={PAGE_TITLES.delete} danger onPress={() => onOpen('delete')} />
        </Card>
      )}
    </Screen>
  );
}

const currencyNames = (uses: readonly string[]) =>
  uses.map((c) => (c === 'BTC' ? 'Bitcoin' : 'Rupees')).join(' · ');

/** A labelled card of rows, with a line between each. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  const items = React.Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;
  return (
    <View>
      <SectionLabel>{label}</SectionLabel>
      <Card style={{ padding: 0 }}>
        {items.map((child, i) => (
          <View key={i}>
            {i > 0 && <Divider />}
            {child}
          </View>
        ))}
      </Card>
    </View>
  );
}

/** One setting: its name, where it stands, and a chevron to its page (an arrow out, for a link). */
function Row({
  label,
  value,
  onPress,
  danger,
  external,
}: {
  label: string;
  value?: string;
  onPress: () => void;
  danger?: boolean;
  external?: boolean;
}) {
  const color = useColors();
  const s = useStyles();
  return (
    <Pressable
      onPress={() => {
        analytics.tap(label, { control: 'row' });
        onPress();
      }}
      accessibilityRole={external ? 'link' : 'button'}
      accessibilityLabel={value ? `${label}, ${value}` : label}
      style={({ pressed }) => [s.row, pressed && { backgroundColor: color.surfaceSunken }]}
    >
      <Text style={[s.rowLabel, danger && { color: color.danger }]}>{label}</Text>
      {/* Takes the space between, so the chevron sits at the end with or without a value. */}
      <Text style={s.rowValue} numberOfLines={1}>
        {value ?? ''}
      </Text>
      {!danger && <Glyph name={external ? 'share' : 'chevronRight'} ink={color.inkFaint} size={16} weight={2.2} />}
    </Pressable>
  );
}

const useStyles = makeStyles((color) => ({
  me: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  name: { ...type.title, fontSize: 22, color: color.ink },
  meta: { ...type.caption, color: color.inkFaint, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 50, paddingHorizontal: space.lg },
  rowLabel: { ...type.body, color: color.ink, flexShrink: 0 },
  rowValue: { ...type.body, color: color.inkFaint, flex: 1, textAlign: 'right' },
  label: { ...type.body, color: color.ink },
  appearance: { gap: space.sm, padding: space.lg },
}));
