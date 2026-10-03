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
import { StyleSheet, Text, TextInput, View } from 'react-native';

import type { WalletConnection } from '@sattle/core';
import { useAsync, useClient, useWallet } from '../react/SattleProvider';
import {
  Badge,
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
        <ConnectWallet />
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
            Anyone can pay you here, from any wallet, whether or not they use Sattle.
          </Text>
        </Card>
      )}

      <View style={{ gap: space.sm }}>
        <Button label="Receive" variant="primary" />
        <Button label="Send" />
      </View>

      <ConnectWallet />

      <TrustModel />
    </Screen>
  );
}

/** What each NWC method lets the holder of the connection do, in plain words. */
const METHOD_NAMES: Record<string, string> = {
  make_invoice: 'Create invoices',
  lookup_invoice: 'Check invoices',
  get_info: 'Read wallet info',
  get_balance: 'See your balance',
  list_transactions: 'See your payments',
  pay_invoice: 'Spend',
  pay_keysend: 'Spend',
  multi_pay_invoice: 'Spend',
  multi_pay_keysend: 'Spend',
};

const methodName = (m: string) => METHOD_NAMES[m] ?? m.replaceAll('_', ' ');

/**
 * Receiving into a wallet the user already has, over Nostr Wallet Connect.
 * The server only needs to create invoices and check them. Anything more the
 * connection grants is shown as a warning, because the server stores it.
 */
function ConnectWallet() {
  const client = useClient();
  const current = useAsync(() => client.getWalletConnection(), []);
  const [connection, setConnection] = useState<WalletConnection | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [uri, setUri] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const conn = connection ?? current.data;

  const connect = async () => {
    if (!uri.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setConnection(await client.connectWallet(uri.trim()));
      setUri('');
      setReplacing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t connect that wallet.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <SectionLabel>Your own wallet</SectionLabel>
      <Card style={{ gap: space.md }}>
        {current.loading && !conn && <Loading lines={2} />}
        {current.error && !conn && <ErrorState message={current.error.message} onRetry={current.reload} />}

        {conn?.connected && (
          <View style={{ gap: space.sm }}>
            <Text style={s.rowTitle}>Connected to {conn.alias ?? 'your wallet'}</Text>
            {conn.connectedAt && (
              <Text style={s.rowBody}>Since {new Date(conn.connectedAt).toLocaleDateString()}</Text>
            )}
            <Text style={s.rowBody}>Money people owe you lands in this wallet. Sattle is allowed to:</Text>
            <View style={s.methods}>
              {[...new Set(conn.methods.map(methodName))].map((name) => (
                <Badge key={name} text={name} />
              ))}
            </View>
          </View>
        )}

        {conn?.connected && conn.excessMethods.length > 0 && (
          <View style={s.warning}>
            <Text style={s.warningTitle}>
              This connection can also: {[...new Set(conn.excessMethods.map(methodName))].join(', ').toLowerCase()}
            </Text>
            <Text style={s.warningBody}>
              Sattle doesn’t use that, but it keeps this connection on its server, so anyone who got hold of it
              could too. Make a new connection in your wallet that only allows receiving, and paste it here.
            </Text>
          </View>
        )}

        {conn && !conn.connected && (
          <Text style={s.rowBody}>
            Already have a Lightning wallet? Connect it with Nostr Wallet Connect and money people owe you lands
            there. In your wallet, make a connection that only allows creating and checking invoices.
          </Text>
        )}

        {conn && (!conn.connected || replacing) && (
          <View style={{ gap: space.sm }}>
            <TextInput
              style={s.input}
              value={uri}
              onChangeText={setUri}
              onSubmitEditing={connect}
              placeholder="nostr+walletconnect://…"
              placeholderTextColor={color.inkFaint}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <Text style={s.rowBody}>Treat it like a password. It never comes back from the server.</Text>
            <Button label="Connect" variant="primary" busy={busy} disabled={!uri.trim()} onPress={connect} />
          </View>
        )}

        {error && <Text style={s.error}>{error}</Text>}

        {conn?.connected && !replacing && (
          <Button label="Replace connection" onPress={() => setReplacing(true)} />
        )}
      </Card>
    </View>
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
  methods: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  warning: { gap: space.xs, padding: space.md, borderRadius: radius.md, backgroundColor: color.dangerWash },
  warningTitle: { ...type.label, color: color.danger },
  warningBody: { ...type.caption, color: color.ink, lineHeight: 18 },
  input: {
    height: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    ...type.body,
    color: color.ink,
    backgroundColor: color.paper,
  },
  error: { ...type.caption, color: color.danger },
});
