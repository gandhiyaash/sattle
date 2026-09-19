/**
 * Wallet, plus the trust disclosure.
 *
 * The TrustModel block is the Freedom Stack argument made visible in the
 * product rather than buried in a README. The track asks you to make the
 * trust assumptions underneath visible or remove them; this names exactly
 * what is being trusted, in the place where a user's money actually sits.
 *
 * Writing it plainly is the point. "Your funds are secured by advanced
 * cryptography" is the sentence this screen exists to refuse.
 */

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useWallet } from '../react/SplitSatsProvider';
import {
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  Loading,
  Screen,
  SectionLabel,
} from './primitives';
import { color, radius, space, type } from './theme';

export interface WalletScreenProps {
  onBack: () => void;
}

export function WalletScreen({ onBack }: WalletScreenProps) {
  const wallet = useWallet();
  const [balance, setBalance] = useState<number | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet.isAvailable) return;
    Promise.all([wallet.getBalance(), wallet.getLightningAddress()])
      .then(([b, addr]) => {
        setBalance(b.balanceSat);
        setAddress(addr);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Wallet unavailable.'));
  }, [wallet]);

  if (!wallet.isAvailable) {
    return (
      <Screen title="Wallet" onBack={onBack}>
        <EmptyState
          title="Wallet lives in the app"
          body="The wallet needs the mobile app. On the web you can still see balances, add expenses, and pay anyone who sends you a link."
        />
        <TrustModel />
      </Screen>
    );
  }

  return (
    <Screen title="Wallet" onBack={onBack}>
      <Card>
        <Text style={s.label}>Balance</Text>
        {balance === null && !error ? (
          <Loading lines={1} />
        ) : (
          <Text style={s.balance}>
            {new Intl.NumberFormat('en-US').format(balance ?? 0)}
            <Text style={s.unit}> sats</Text>
          </Text>
        )}
      </Card>

      {error && <ErrorState message={error} />}

      {address && (
        <Card>
          <Text style={s.label}>Your Lightning address</Text>
          <Text style={s.address}>{address}</Text>
          <Text style={s.addressNote}>
            Anyone can pay you here, from any wallet, whether or not they use SplitSats.
          </Text>
        </Card>
      )}

      <View style={{ gap: space.sm }}>
        <Button label="Receive" variant="primary" />
        <Button label="Send" />
      </View>

      <TrustModel />
    </Screen>
  );
}

/**
 * Deliberately not hidden behind a "learn more". A user deciding whether to
 * keep money here should read this without hunting for it.
 */
export function TrustModel() {
  return (
    <View>
      <SectionLabel>What you're trusting</SectionLabel>
      <Card style={{ gap: space.md }}>
        <Row
          title="Your keys"
          body="Generated on this device and never sent anywhere. We cannot move your money, freeze it, or see your balance. If you lose the device and the backup, we cannot help you recover it either."
        />
        <Divider />
        <Row
          title="Liquid federation"
          body="Balances are held on Liquid, a Bitcoin sidechain run by a federation of functionaries. That federation could, in principle, collude to censor or seize. It is a weaker guarantee than holding Bitcoin on-chain, and a stronger one than a custodial app."
        />
        <Divider />
        <Row
          title="Your group data"
          body="Expenses and balances are encrypted on your device before they sync. Relays store ciphertext they cannot read. There is no server holding a list of who you eat dinner with."
        />
        <Divider />
        <Row
          title="Swaps"
          body="Paying an outside Lightning wallet routes through a swap provider, which briefly sees the amount and the destination. In-app payments skip this entirely."
        />
      </Card>
      <Text style={s.trustFooter}>
        If any of this changes, this screen changes with it.
      </Text>
    </View>
  );
}

function Row({ title, body }: { title: string; body: string }) {
  return (
    <View style={{ gap: 3 }}>
      <Text style={s.rowTitle}>{title}</Text>
      <Text style={s.rowBody}>{body}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  label: { ...type.label, color: color.inkMuted, marginBottom: space.xs },
  balance: { ...type.amountLg, color: color.ink },
  unit: { ...type.body, color: color.inkFaint },
  address: { ...type.amountMd, color: color.ink, marginBottom: space.xs },
  addressNote: { ...type.caption, color: color.inkMuted, lineHeight: 17 },
  rowTitle: { ...type.label, color: color.ink },
  rowBody: { ...type.caption, color: color.inkMuted, lineHeight: 18 },
  trustFooter: { ...type.caption, color: color.inkFaint, marginTop: space.sm },
});
