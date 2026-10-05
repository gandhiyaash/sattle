/**
 * Wallet, plus the trust disclosure.
 *
 * The TrustModel block is the Freedom Stack argument made visible in the
 * product rather than buried in a README. The track asks you to make the
 * trust assumptions underneath visible or remove them; this names exactly
 * what is being trusted, in the place where a user connects their wallet.
 *
 * Writing it plainly is the point. "Your funds are secured by advanced
 * cryptography" is the sentence this screen exists to refuse.
 */

import React, { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { parseUpiId, upiIdHasPhoneNumber, type UpiProfile, type WalletConnection } from '@sattle/core';
import { useAsync, useClient, useWallet } from '../react/SattleProvider';
import { APP_URL } from '../react/useSettleFlow';
import { Badge, Button, Card, ConfirmButton, Divider, EmptyState, ErrorState, Loading, Screen, SectionLabel } from './primitives';
import { type Appearance, makeStyles, radius, setAppearance, space, type, useAppearance, useColors } from './theme';

export interface WalletScreenProps {
  onBack: () => void;
}

export function WalletScreen({ onBack }: WalletScreenProps) {
  const s = useStyles();
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
          title="Use the wallet you already have"
          body="Sattle doesn’t hold money. Connect your own Lightning wallet below, or add your Lightning address, and what people owe you lands there. To pay someone, scan their invoice with that wallet."
        />
        <ConnectWallet />
        <ReceiveAtAddress />
        <UpiIdCard />
        <AppearancePicker />
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

      <ReceiveAtAddress />
      <UpiIdCard />
      <AppearancePicker />

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
  const color = useColors();
  const s = useStyles();
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
        {conn?.connected && !replacing && (
          <ConfirmButton
            label="Disconnect wallet"
            confirmLabel="Yes, disconnect"
            hint="Sattle forgets the connection. Money people owe you can’t land there until you connect again."
            onConfirm={async () => setConnection(await client.disconnectWallet())}
          />
        )}
      </Card>
    </View>
  );
}

/**
 * Receiving at a Lightning address, for the wallets most people already have
 * that can't do NWC (Wallet of Satoshi, Phoenix, Blink and so on). One
 * address for every group. The server checks it answers before saving it.
 */
function ReceiveAtAddress() {
  const color = useColors();
  const s = useStyles();
  const client = useClient();
  const current = useAsync(() => client.getReceiveAddress(), []);
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const address = saved !== undefined ? saved : current.data?.address;

  const run = async (fn: () => Promise<{ address: string | null }>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setSaved((await fn()).address);
      setInput('');
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t save that address.');
    } finally {
      setBusy(false);
    }
  };
  const save = () => input.trim() && run(() => client.setReceiveAddress(input.trim()));

  return (
    <View>
      <SectionLabel>Or a Lightning address</SectionLabel>
      <Card style={{ gap: space.md }}>
        {current.loading && address === undefined && <Loading lines={2} />}
        {current.error && address === undefined && <ErrorState message={current.error.message} onRetry={current.reload} />}

        {address && !editing && (
          <View style={{ gap: space.sm }}>
            <Text style={s.label}>You receive at</Text>
            <Text style={s.address}>{address}</Text>
            <Text style={s.rowBody}>
              In every group. If you also connect a wallet above, that’s used first.
            </Text>
          </View>
        )}

        {address === null && !editing && (
          <Text style={s.rowBody}>
            Wallet of Satoshi, Phoenix, Blink and most other wallets give you a Lightning address. It looks like an
            email. Add yours and money people owe you is sent there.
          </Text>
        )}

        {(address === null || editing) && (
          <View style={{ gap: space.sm }}>
            <TextInput
              style={s.input}
              value={input}
              onChangeText={setInput}
              onSubmitEditing={save}
              placeholder="you@walletofsatoshi.com"
              placeholderTextColor={color.inkFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
            />
            <Button label="Save" variant="primary" busy={busy} disabled={!input.trim()} onPress={save} />
            {editing && <Button label="Cancel" variant="quiet" onPress={() => setEditing(false)} />}
          </View>
        )}

        {address !== undefined && (
          <Text style={s.rowBody}>
            Some wallets tell Sattle when you’ve been paid. With the rest, the person paying sends the payment proof
            their wallet gives them, or you mark it settled.
          </Text>
        )}

        {error && <Text style={s.error}>{error}</Text>}

        {address && !editing && (
          <View style={{ gap: space.sm }}>
            <Button label="Change address" onPress={() => setEditing(true)} />
            <Button label="Stop receiving here" variant="quiet" busy={busy} onPress={() => run(() => client.clearReceiveAddress())} />
          </View>
        )}
      </Card>
    </View>
  );
}

/**
 * A UPI ID, for being paid in rupees outside Lightning. One for every group.
 * Sattle can't see a UPI payment, so the card says who confirms one, and who
 * is shown the ID: people who owe them, and anyone holding one of their
 * groups' shared links, unless they turn that off. It says so before the ID
 * is saved, since that is on from the start. The switch here is for all
 * their groups; Manage, in a group, has the same one for that group alone.
 *
 * A UPI ID is often a mobile number, and everyone shown the ID then has the
 * number. So when the one being typed has a number in it, the card says who
 * would see it and that an ID without one can be had. It only warns: the ID
 * works as well as any other, and Save anyway saves it. A saved ID with a
 * number in it is warned about beside the shared-link switch too, since IDs
 * saved before the warning existed kept what that switch was.
 */
function UpiIdCard() {
  const color = useColors();
  const s = useStyles();
  const client = useClient();
  const current = useAsync(() => client.getUpiId(), []);
  const [saved, setSaved] = useState<UpiProfile | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const profile = saved ?? current.data;
  const upiId = profile?.upiId;
  const onLinks = Boolean(profile?.onGroupLinks);

  const run = async (fn: () => Promise<UpiProfile>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setSaved(await fn());
      setInput('');
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t save that UPI ID.');
    } finally {
      setBusy(false);
    }
  };
  const save = () => input.trim() && run(() => client.setUpiId(input.trim()));

  // Only once it reads as a whole UPI ID, so the warning doesn't come and go as digits are typed.
  const typed = parseUpiId(input);
  const hasPhone = typed.ok && upiIdHasPhoneNumber(typed.upiId);
  const savedHasPhone = Boolean(upiId && upiIdHasPhoneNumber(upiId));

  return (
    <View>
      <SectionLabel>UPI</SectionLabel>
      <Card style={{ gap: space.md }}>
        {current.loading && upiId === undefined && <Loading lines={2} />}
        {current.error && upiId === undefined && <ErrorState message={current.error.message} onRetry={current.reload} />}

        {upiId && !editing && (
          <View style={{ gap: space.sm }}>
            <Text style={s.label}>You can be paid at</Text>
            <Text style={s.address}>{upiId}</Text>
            <Text style={s.rowBody}>
              In every group kept in rupees. People in a group who owe you are shown it
              {onLinks
                ? ', and so is anyone with one of your groups’ shared links, unless you turned that off for the group.'
                : '. A group’s shared link shows it only if you turned that on for the group.'}
            </Text>
          </View>
        )}

        {upiId === null && !editing && (
          <Text style={s.rowBody}>
            Add your UPI ID and people who owe you in a rupee group can pay you from GPay, PhonePe or any UPI app. It
            looks like name@okhdfcbank. Anyone holding one of your groups’ shared links can pay you this way too, and
            sees the ID when they do. You can turn that off once it’s saved.
          </Text>
        )}

        {(upiId === null || editing) && (
          <View style={{ gap: space.sm }}>
            <TextInput
              style={s.input}
              value={input}
              onChangeText={setInput}
              onSubmitEditing={save}
              placeholder="name@okhdfcbank"
              placeholderTextColor={color.inkFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
            />
            {hasPhone && (
              <View style={s.warning}>
                <Text style={s.warningTitle}>This UPI ID has a phone number in it</Text>
                <Text style={s.warningBody}>
                  {/* Before one is saved, shared links are on: that is where a new ID starts. */}
                  {upiId === null || onLinks
                    ? 'People in your groups who owe you are shown this ID, and so is anyone holding one of your groups’ shared links. All of them would see the number.'
                    : 'People in your groups who owe you are shown this ID, and so is anyone holding the shared link of a group you turned that on for. All of them would see the number.'}{' '}
                  You can have a UPI ID with no phone number in it: most UPI apps let you add another, like
                  name@okhdfcbank, in their UPI settings. You can still save this one.
                </Text>
              </View>
            )}
            <Button
              label={hasPhone ? 'Save anyway' : 'Save'}
              variant="primary"
              busy={busy}
              disabled={!input.trim()}
              onPress={save}
            />
            {editing && <Button label="Cancel" variant="quiet" onPress={() => setEditing(false)} />}
          </View>
        )}

        {upiId !== undefined && (
          <Text style={s.rowBody}>
            Sattle can’t see a UPI payment. The person paying tells you they’ve paid, and it’s settled when you
            confirm it arrived.
          </Text>
        )}

        {error && <Text style={s.error}>{error}</Text>}

        {upiId && !editing && (
          <View style={{ gap: space.sm }}>
            <Divider />
            <Text style={s.label}>On shared group links</Text>
            {savedHasPhone && (
              <View style={s.warning}>
                <Text style={s.warningTitle}>This UPI ID has a phone number in it</Text>
                <Text style={s.warningBody}>
                  {onLinks
                    ? 'Anyone holding one of your groups’ shared links sees it when they choose to pay you, so they see the number too.'
                    : 'Turn this on and anyone holding one of your groups’ shared links sees it when they choose to pay you, so they see the number too.'}{' '}
                  Most UPI apps let you add an ID with no number in it, like name@okhdfcbank.
                </Text>
              </View>
            )}
            <Text style={s.rowBody}>
              {onLinks
                ? 'On. Someone paying from a group’s shared link, without the app, can pay you by UPI. They see your UPI ID when they choose to pay you, so turn this off if a link has gone further than people you know.'
                : 'Off. Someone paying from a group’s shared link, without the app, can’t pay you by UPI. Turn it on and anyone holding that link can see your UPI ID, so only if the link stays with people you know.'}
            </Text>
            <Text style={s.rowBody}>
              This is for every group you’re in. To choose differently for one group, open it and go to Manage.
            </Text>
            <Button
              label={onLinks ? 'Turn off for shared links' : 'Let shared links show it'}
              busy={busy}
              onPress={() => run(() => client.setUpiOnGroupLinks(!onLinks))}
            />
          </View>
        )}

        {upiId && !editing && (
          <View style={{ gap: space.sm }}>
            <Button label="Change UPI ID" onPress={() => setEditing(true)} />
            <Button label="Remove it" variant="quiet" busy={busy} onPress={() => run(() => client.clearUpiId())} />
          </View>
        )}
      </Card>
    </View>
  );
}

/**
 * Deliberately not hidden behind a "learn more". A user deciding whether to
 * connect a wallet should read this without hunting for it.
 *
 * Every sentence states what the code does today, including the parts that
 * aren't flattering. Change the code and this has to change with it:
 *
 *   Your money          payments/lightning.ts gets the invoice from the payee's wallet
 *                       or their own address (lnurl.ts); nothing spends
 *   Wallet connection   walletStore.ts keeps nwc_uri as plain text; nwc.ts only calls
 *                       get_info, make_invoice, lookup_invoice; DELETE /me/wallet
 *                       removes the row
 *   The relay           nwc.ts encrypts each request to the wallet (NIP-44 or NIP-04)
 *   Your account        routes/accounts.ts: a name in, a random token out, nothing
 *                       else; account/tokenStore keeps it on the device
 *   Lightning address   walletStore.ts receive_address, set only by its owner
 *                       (routes/wallet.ts); lnurl.ts and safeFetch.ts only fetch
 *   Is it paid          payments/lightning.ts confirms on the wallet's `settled`, and
 *                       keeps the preimage only if preimageMatches; an address
 *                       payment needs a matching preimage (lnurl.ts verify,
 *                       proof.ts); the manual route lets
 *                       the payee settle a debt by hand (the payer, if the payee is
 *                       a ghost): settlementRules.ts checkManualRecorder
 *   Group data          migrations/001_init.sql: plain columns, no encryption
 *   Pay links           routes/payLinks.ts guestView, and its randomBytes(16) token
 *   Group links         routes/groupLinks.ts: no row in group_links until POST
 *                       /groups/:id/link, guestView, and nothing under /g/ that writes
 *   UPI                 routes/upi.ts: a claim is a row in upi_claims, not a settlement;
 *                       only the payee's confirm makes one; walletStore.ts upi_id, and
 *                       GET /groups/:id/members/:memberId/upi refuses anyone who
 *                       doesn't owe them; routes/groupLinks.ts gives it under /g/
 *                       while upi_on_links is on, as it is from the start, or
 *                       members.upi_on_link where the person chose for that group
 *   Joining             routes/joining.ts: POST /join-requests makes a request, not a
 *                       member; only POST /join-requests/:id/approve, by someone in
 *                       the group, claims the member
 *   Exchange rate       rates.ts (CoinGecko, last rate, fixed rate), QUOTE_TTL_MS
 */
export function TrustModel() {
  const s = useStyles();
  return (
    <View>
      <SectionLabel>What you're trusting</SectionLabel>
      <Card style={{ gap: space.md }}>
        <Row
          title="Your money"
          body="Sattle never holds it. To collect a debt, the server asks the wallet or Lightning address of the person who is owed to create a Lightning invoice, and the payer pays it from their own wallet. Nothing sits with us in between, so there is nothing for us to freeze, lose or refund."
        />
        <Divider />
        <Row
          title="Your wallet connection"
          body="If you connect a wallet, Sattle's server keeps the connection string, unencrypted, because it needs it to ask your wallet for invoices. It asks only three things: what the connection allows, to create an invoice, and whether an invoice was paid. It has no code that spends. But anyone who gets the string can do whatever it allows, so make it receive-only. Disconnect makes the server forget the string. To be sure nobody can use it again, also delete the connection in your wallet."
        />
        <Divider />
        <Row
          title="Your Lightning address"
          body="If you add one, Sattle's server keeps it and asks it for invoices, the way any wallet paying you would. An address can only receive, so there is nothing to steal, but whoever runs it (your wallet's company) sees what you're paid. Only you can set yours."
        />
        <Divider />
        <Row
          title="The relay in between"
          body="Requests to your wallet travel through the Nostr relay named in your connection. They are encrypted, so the relay sees when a request is sent, not what it says."
        />
        <Divider />
        <Row
          title="Your account"
          body="It's a name and a random key that only this device has. No email, phone or password, so there's nothing to recover it with: clear this device's data or lose it, and you lose access to your groups and wallet connection."
        />
        <Divider />
        <Row
          title="Is it really paid?"
          body="A payment counts as paid when the payee's own wallet says the invoice was settled, and Sattle keeps the payment proof only when it matches the invoice. For a Lightning address, it counts only with that proof: a code the payer's wallet gets when it pays, which no one can make up. Settled by hand is different: the person who is owed marks it, or the person paying if the one owed hasn't joined, and it is their word, not proof."
        />
        <Divider />
        <Row
          title="UPI"
          body="A UPI payment happens in your UPI app, outside Sattle, and nothing tells us about it. The person paying says they paid, and the balance moves only when the person who is owed confirms it arrived. If you add a UPI ID, Sattle's server keeps it, and someone in the group who owes you is shown it. So is anyone holding one of your groups' shared links, when they choose to pay you, unless you turn that off, for all your groups or for one."
        />
        <Divider />
        <Row
          title="Your group data"
          body="Group names, people's names, expenses and payments are stored on Sattle's server. They are not end-to-end encrypted, so the people who run Sattle can read them. Everyone in a group sees everything in that group."
        />
        <Divider />
        <Row
          title="Pay links"
          body="Anyone who has a pay link sees who owes whom, the group's name, the amount and whether it is paid, and nothing else about the group. A link can't be guessed, but it can be forwarded."
        />
        <Divider />
        <Row
          title="Group links"
          body="A group has no link until someone in it makes one. Anyone who has that link sees every expense, each person's share, everyone's name and who owes whom, and can pay a debt. They can't change anything: a UPI payment they say they made counts only once the person owed confirms it. They can ask to join, which is covered below. It can't be guessed, but it can be forwarded, and anyone in the group can replace it or turn it off."
        />
        <Divider />
        <Row
          title="Joining"
          body="The group link lets someone ask to join, not join. Someone already in the group has to let them in, and both see the same four-digit code to check it's really them. Until then they can do no more than anyone else holding the link. Once in, they see and can add to everything, like everyone else."
        />
        <Divider />
        <Row
          title="The exchange rate"
          body="Debts are kept in your currency and paid in sats. The server takes the rate from CoinGecko and fixes it for 90 seconds when it makes the invoice, and you see the amount in sats before you pay. If CoinGecko is down, it uses the last rate it had, or a fixed one."
        />
      </Card>
      <Text style={s.trustFooter}>
        If any of this changes, this screen changes with it.
      </Text>
      {/* Play requires the policy to be reachable from inside the app, not only the listing. */}
      <Text
        style={s.privacyLink}
        accessibilityRole="link"
        onPress={() => Linking.openURL(`${APP_URL}/privacy`)}
      >
        Privacy policy
      </Text>
    </View>
  );
}

const APPEARANCE_OPTIONS: Array<{ value: Appearance; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Light, dark, or whatever the phone is set to. Remembered on this device. */
function AppearancePicker() {
  const s = useStyles();
  const current = useAppearance();
  return (
    <View>
      <SectionLabel>Appearance</SectionLabel>
      <View style={s.segments} accessibilityRole="radiogroup">
        {APPEARANCE_OPTIONS.map((o) => {
          const selected = o.value === current;
          return (
            <Pressable
              key={o.value}
              onPress={() => setAppearance(o.value)}
              style={[s.segment, selected && s.segmentSelected]}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
            >
              <Text style={[s.segmentLabel, selected && s.segmentLabelSelected]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Row({ title, body }: { title: string; body: string }) {
  const s = useStyles();
  return (
    <View style={{ gap: 3 }}>
      <Text style={s.rowTitle}>{title}</Text>
      <Text style={s.rowBody}>{body}</Text>
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  label: { ...type.label, color: color.inkMuted, marginBottom: space.xs },
  balance: { ...type.amountLg, color: color.ink },
  unit: { ...type.body, color: color.inkFaint },
  address: { ...type.amountMd, color: color.ink, marginBottom: space.xs },
  addressNote: { ...type.caption, color: color.inkMuted, lineHeight: 17 },
  rowTitle: { ...type.label, color: color.ink },
  rowBody: { ...type.caption, color: color.inkMuted, lineHeight: 18 },
  trustFooter: { ...type.caption, color: color.inkFaint, marginTop: space.sm },
  privacyLink: { ...type.caption, color: color.accent, marginTop: space.sm, textDecorationLine: 'underline' },
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
}));
