/**
 * The pages under Account, one for each row there (AccountScreen): the ways
 * to get paid (UPI ID, Lightning wallet, Lightning address, and the demo's
 * in-app wallet), currencies, the sign-in key, Nostr, what you're trusting,
 * and deleting the account. Each says as little as it can; how things work
 * is in the FAQ.
 *
 * Only the ways to get paid that go with the currencies they use are offered
 * (payWays): no Lightning for someone who chose rupees alone, no UPI for
 * someone who chose bitcoin alone. The one exception is something they have
 * already set up. That stays until they remove it, since hiding it would
 * leave a wallet connected, or a UPI ID visible to others, with no way to
 * take it back (useGetPaid).
 *
 * The trust disclosure (TrustModel) is the Freedom Stack argument made
 * visible in the product rather than buried in a README: it names exactly
 * what is being trusted. Writing it plainly is the point. "Your funds are
 * secured by advanced cryptography" is the sentence it exists to refuse.
 */

import React, { useEffect, useState } from 'react';
import { Linking, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  NOSTR_AUTH_PATHS,
  parseUpiId,
  upiIdHasPhoneNumber,
  type PayWays,
  type ReceiveAddress,
  type SyncView,
  type UpiProfile,
  type User,
  type WalletConnection,
} from '@sattle/core';
import { signInKey } from '../account/signInKey';
import { readToken, writeToken } from '../account/tokenStore';
import { analytics } from '../analytics/analytics';
import { useScreenView } from '../analytics/useScreenView';
import { useAppData, useViewPart } from '../data/useAppData';
import { chooseCurrencies, useCurrencyPrefs, usePayWays, useShowsNostr } from '../prefs/useCurrencyPrefs';
import { type AsyncState, useActionKeys, useAsync, useClient, useWallet } from '../react/SattleProvider';
import { APP_URL } from '../react/useSettleFlow';
import { CurrencyPicker } from './CurrencyPicker';
import { NostrKeyForm } from './NostrKeyForm';
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  Divider,
  ErrorState,
  Loading,
  Screen,
  SectionLabel,
  Segmented,
} from './primitives';
import { copyText } from './share';
import { type Appearance, makeStyles, radius, setAppearance, space, type, useAppearance, useColors } from './theme';

export type AccountPage =
  | 'upi'
  | 'lightningWallet'
  | 'lightningAddress'
  | 'demoWallet'
  | 'currencies'
  | 'signInKey'
  | 'nostr'
  | 'trust'
  | 'delete';

/** Each page's title, which is also the row that opens it. */
export const PAGE_TITLES: Record<AccountPage, string> = {
  upi: 'UPI ID',
  lightningWallet: 'Lightning wallet',
  lightningAddress: 'Lightning address',
  demoWallet: 'Demo wallet',
  currencies: 'Currencies',
  signInKey: 'Sign-in key',
  nostr: 'Nostr',
  trust: 'What you’re trusting',
  delete: 'Delete account',
};

export interface AccountPageScreenProps {
  page: AccountPage;
  onBack: () => void;
  /** The account is gone from the server. Whoever owns the token forgets it. */
  onDeleted: () => void;
  /** The account has a new sign-in key, already saved on this device. Whoever holds the client switches to it. */
  onKeyReplaced?: (token: string) => void;
}

export function AccountPageScreen({ page, onBack, onDeleted, onKeyReplaced }: AccountPageScreenProps) {
  const title = PAGE_TITLES[page];
  useScreenView(title);
  return (
    <Screen title={title} onBack={onBack}>
      {page === 'upi' && <UpiIdCard />}
      {page === 'lightningWallet' && <ConnectWallet />}
      {page === 'lightningAddress' && <ReceiveAtAddress />}
      {page === 'demoWallet' && <DemoWallet />}
      {page === 'currencies' && <Currencies />}
      {page === 'signInKey' && <SignInKeyCard onReplaced={onKeyReplaced} />}
      {page === 'nostr' && <NostrCard />}
      {page === 'trust' && <TrustPage />}
      {page === 'delete' && <DeleteAccount onDeleted={onDeleted} />}
    </Screen>
  );
}

/**
 * What they've set up to get paid, and which of the ways to show: those that
 * go with what they use, and anything already set up whatever they use. The
 * FAQ and the trust rows speak to the same ways (`ways`).
 */
export function useGetPaid() {
  const client = useClient();
  const payWays = usePayWays();
  const connection = useSetting(() => client.getWalletConnection(), 'wallet');
  const receiveAt = useSetting(() => client.getReceiveAddress(), 'receive-address');
  const upi = useSetting(() => client.getUpiId(), 'upi', upiInView);
  const show = {
    wallet: payWays.lightning || Boolean(connection.data?.connected),
    address: payWays.lightning || Boolean(receiveAt.data?.address),
    upi: payWays.upi || Boolean(upi.data?.upiId),
  };
  const ways: PayWays = { lightning: show.wallet || show.address, upi: show.upi };
  return { connection, receiveAt, upi, show, ways };
}

const upiInView = (upiProfile: UpiProfile) => (v: SyncView) => ({ ...v, upiProfile });

/**
 * One thing they can set up to be paid with: what the server holds, and what
 * it became on this screen since. A change made here is the newer of the two,
 * so `data` is always what is true now, with nothing read again.
 */
export interface Setting<T> extends AsyncState<T> {
  /** After a change made here: what the server answered it with. */
  set: (value: T) => void;
}

export function useSetting<T>(
  read: () => Promise<T>,
  key: string,
  /** How a change to it shows in what the other screens draw from, at once. */
  inView?: (value: T) => (view: SyncView) => SyncView
): Setting<T> {
  const appData = useAppData();
  // Opens on what was read last time (none of these is a key to anything), and reads it again behind.
  const current = useAsync(read, [], { key, save: true });
  const [changed, setChanged] = useState<T>();
  const set = (value: T) => {
    setChanged(value);
    appData.remember(key, value, true);
    if (inView) appData.known(inView(value));
    // Where they can be paid shows in every group they're in: whether to show Pay, and how.
    void appData.sync();
  };
  return { ...current, data: changed ?? current.data, set };
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
  const current = useSetting(() => client.getWalletConnection(), 'wallet');
  const [replacing, setReplacing] = useState(false);
  const [uri, setUri] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const conn = current.data;

  const connect = async () => {
    if (!uri.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      current.set(await client.connectWallet(uri.trim()));
      setUri('');
      setReplacing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t connect that wallet.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ gap: space.md }}>
      {current.loading && !conn && <Loading lines={2} />}
      {current.error && !conn && <ErrorState message={current.error.message} error={current.error} onRetry={current.reload} />}

      {conn?.connected && (
        <View style={{ gap: space.sm }}>
          <Text style={s.rowTitle}>Connected to {conn.alias ?? 'your wallet'}</Text>
          {conn.connectedAt && <Text style={s.rowBody}>Since {new Date(conn.connectedAt).toLocaleDateString()}</Text>}
          <Text style={s.rowBody}>Sattle is allowed to:</Text>
          <View style={s.methods}>
            {[...new Set(conn.methods.map(methodName))].map((name) => (
              <Badge key={name} text={name} />
            ))}
          </View>
        </View>
      )}

      {conn?.connected && conn.excessMethods.length > 0 && (
        <Warning
          title={`This connection can also: ${[...new Set(conn.excessMethods.map(methodName))].join(', ').toLowerCase()}`}
          body="Sattle doesn’t use that, but keeps the connection on its server. Make a receive-only one in your wallet and paste it here."
        />
      )}

      {conn && !conn.connected && (
        <Text style={s.rowBody}>Paste a Nostr Wallet Connect string from your wallet. Make it receive-only.</Text>
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
          <Text style={s.rowBody}>Treat it like a password.</Text>
          <Button label="Connect" variant="primary" busy={busy} disabled={!uri.trim()} onPress={connect} />
        </View>
      )}

      {error && <Text style={s.error}>{error}</Text>}

      {conn?.connected && !replacing && <Button label="Replace connection" onPress={() => setReplacing(true)} />}
      {conn?.connected && !replacing && (
        <ConfirmButton
          label="Disconnect wallet"
          confirmLabel="Yes, disconnect"
          hint="Money owed to you can’t land there until you connect again."
          onConfirm={async () => current.set(await client.disconnectWallet())}
        />
      )}
    </Card>
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
  const current = useSetting(() => client.getReceiveAddress(), 'receive-address');
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const address = current.data?.address;

  const run = async (fn: () => Promise<ReceiveAddress>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      current.set(await fn());
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
    <Card style={{ gap: space.md }}>
      {current.loading && address === undefined && <Loading lines={2} />}
      {current.error && address === undefined && <ErrorState message={current.error.message} error={current.error} onRetry={current.reload} />}

      {address && !editing && (
        <View style={{ gap: space.xs }}>
          <Text style={s.label}>You’re paid at</Text>
          <Text style={s.address}>{address}</Text>
          <Text style={s.rowBody}>In every group. A connected wallet goes first.</Text>
        </View>
      )}

      {address === null && !editing && <Text style={s.rowBody}>Most wallets give you one. It looks like an email.</Text>}

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

      {error && <Text style={s.error}>{error}</Text>}

      {address && !editing && (
        <View style={{ gap: space.sm }}>
          <Button label="Change address" onPress={() => setEditing(true)} />
          <Button label="Stop receiving here" variant="quiet" busy={busy} onPress={() => run(() => client.clearReceiveAddress())} />
        </View>
      )}
    </Card>
  );
}

/**
 * A UPI ID, for being paid in rupees outside Lightning. One for every group.
 * It's shown to people who owe them, and to anyone holding one of their
 * groups' shared links unless they turn that off. That is on from the start,
 * so it's said before the ID is saved. The switch here is for all their
 * groups; Manage, in a group, has the same one for that group alone.
 *
 * A UPI ID is often a mobile number, and everyone shown the ID then has the
 * number, so the page warns when the one being typed has a number in it,
 * and beside the shared-link switch when the saved one does. It only warns:
 * Save anyway saves it.
 */
function UpiIdCard() {
  const color = useColors();
  const s = useStyles();
  const client = useClient();
  const current = useSetting(() => client.getUpiId(), 'upi', upiInView);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const profile = current.data;
  const upiId = profile?.upiId;
  const onLinks = Boolean(profile?.onGroupLinks);

  const run = async (fn: () => Promise<UpiProfile>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      current.set(await fn());
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
    <>
      <Card style={{ gap: space.md }}>
        {current.loading && upiId === undefined && <Loading lines={2} />}
        {current.error && upiId === undefined && <ErrorState message={current.error.message} error={current.error} onRetry={current.reload} />}

        {upiId && !editing && (
          <View style={{ gap: space.xs }}>
            <Text style={s.label}>You’re paid at</Text>
            <Text style={s.address}>{upiId}</Text>
            <Text style={s.rowBody}>In every rupee group.</Text>
          </View>
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
              <Warning
                title="This UPI ID has a phone number in it"
                body="Everyone who sees the ID sees the number. You can still save it."
              />
            )}
            {/* Before one is saved, shared links are on: that is where a new ID starts. */}
            {upiId === null && <Text style={s.rowBody}>Shown to people who owe you, and on your group links.</Text>}
            <Button label={hasPhone ? 'Save anyway' : 'Save'} variant="primary" busy={busy} disabled={!input.trim()} onPress={save} />
            {editing && <Button label="Cancel" variant="quiet" onPress={() => setEditing(false)} />}
          </View>
        )}

        {error && <Text style={s.error}>{error}</Text>}

        {upiId && !editing && (
          <View style={{ gap: space.sm }}>
            <Button label="Change UPI ID" onPress={() => setEditing(true)} />
            <Button label="Remove it" variant="quiet" busy={busy} onPress={() => run(() => client.clearUpiId())} />
          </View>
        )}
      </Card>

      {upiId && !editing && (
        <View>
          <SectionLabel>On shared group links</SectionLabel>
          <Card style={{ gap: space.md }}>
            {savedHasPhone && (
              <Warning
                title="This UPI ID has a phone number in it"
                body={
                  onLinks
                    ? 'Anyone with one of your group links who pays you sees the number.'
                    : 'Turn this on and anyone with one of your group links who pays you sees the number.'
                }
              />
            )}
            <Text style={s.rowBody}>
              {onLinks
                ? 'On. Anyone with one of your group links can pay you by UPI, and sees the ID.'
                : 'Off. Paying from a group link can’t use UPI.'}
            </Text>
            <Button
              label={onLinks ? 'Turn off for shared links' : 'Let shared links show it'}
              busy={busy}
              onPress={() => run(() => client.setUpiOnGroupLinks(!onLinks))}
            />
            <Text style={s.rowBody}>For all your groups. A group’s Manage can choose differently.</Text>
          </Card>
        </View>
      )}
    </>
  );
}

/** The demo's in-app wallet: its balance and its Lightning address. Only the mock has one. */
function DemoWallet() {
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

  return (
    <>
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
        </Card>
      )}
      <View style={{ gap: space.sm }}>
        <Button label="Receive" variant="primary" />
        <Button label="Send" />
      </View>
    </>
  );
}

/** Which currencies they use: the one setting for the whole app (CurrencyPicker). */
function Currencies() {
  const s = useStyles();
  const prefs = useCurrencyPrefs();
  return (
    <>
      <CurrencyPicker prefs={prefs} onChange={chooseCurrencies} />
      <Text style={s.note}>
        Turning one off only hides it, and without bitcoin Nostr is hidden too. A group kept in bitcoin still shows
        Lightning.
      </Text>
    </>
  );
}

/**
 * The key to this account, for another device or for after this one is
 * wiped. It is the account, so it's shown only after a tap, and the page
 * says what it can do in the wrong hands, and how to end a key that got out.
 */
function SignInKeyCard({ onReplaced }: { onReplaced?: (token: string) => void }) {
  const s = useStyles();
  const client = useClient();
  // A retry after a lost answer replays it, so this device isn't left holding a dead key.
  const keys = useActionKeys();
  const appData = useAppData();
  const [key, setKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const replace = async () => {
    // From the moment the server swaps the keys until the new one is saved here, a request made
    // with the old one is turned away: that's not this device being signed out.
    const release = appData.holdSignOut();
    let token: string;
    try {
      token = await keys.run('replace-key', {}, (k) => client.replaceSignInKey(k));
      // Saved before anything else: the old key no longer signs in, so a reload needs this one.
      await writeToken(token);
    } finally {
      release();
    }
    onReplaced?.(token);
    setKey(signInKey(token));
    setNote(
      'Done. The old key and every device signed in with it are signed out. This is your new key: save it where the old one was.'
    );
  };

  const copy = async () => {
    const token = await readToken();
    if (!token) {
      setNote('This device has no key to copy.');
      return;
    }
    const k = signInKey(token);
    setKey(k);
    setNote(await copyText(k));
  };

  return (
    <>
      <Card style={{ gap: space.md }}>
        <Text style={s.body}>
          It opens this account on another phone or browser. Keep it like a password: anyone with it is you in all your
          groups.
        </Text>
        <Button label="Copy sign-in key" onPress={copy} />
        {note && <Text style={s.rowBody}>{note}</Text>}
        {key && (
          <Text style={s.key} selectable>
            {key}
          </Text>
        )}
      </Card>
      <Card style={{ gap: space.md }}>
        <Text style={s.body}>Key got out, or lost a phone? Replace it, and every other device is signed out.</Text>
        <ConfirmButton label="Replace sign-in key" confirmLabel="Yes, sign out my other devices" onConfirm={replace} />
      </Card>
    </>
  );
}

/**
 * A Nostr key linked to the account. Signing in with it opens the account on
 * a device with nothing on it, which a sign-in key also does, but people
 * already keep a Nostr key somewhere safe and on more than one device. For
 * a group nobody else has joined, it's the only way back in.
 */
function NostrCard() {
  const s = useStyles();
  const client = useClient();
  const appData = useAppData();
  const user = useViewPart((v) => v?.user);
  const [npub, setNpub] = useState<string | undefined | null>(null);
  const linked = npub === null ? user?.npub : npub;
  // The account as the server now has it, in what the app keeps, so coming back here shows the same.
  const known = (next: User) => {
    appData.known((v) => ({ ...v, user: next }));
    void appData.sync();
    return next.npub;
  };

  if (!user) return <Loading lines={2} />;
  return (
    <Card style={{ gap: space.md }}>
      {linked ? (
        <>
          <Text style={s.label}>Linked to</Text>
          <Text style={s.key} selectable numberOfLines={1}>
            {linked}
          </Text>
          <Text style={s.rowBody}>On a new device, Sign in with Nostr gets you back in, with all your groups.</Text>
          <ConfirmButton
            label="Unlink this key"
            confirmLabel="Yes, unlink it"
            onConfirm={async () => setNpub(known(await client.unlinkNostr()))}
          />
        </>
      ) : (
        <>
          <Text style={s.body}>Link your Nostr key to sign in with it on any device, even without your sign-in key.</Text>
          <Text style={s.rowBody}>Sattle never sees your private key.</Text>
          <NostrKeyForm
            path={NOSTR_AUTH_PATHS.link}
            action="link it"
            onProof={async (event) => setNpub(known(await client.linkNostr(event)))}
          />
        </>
      )}
    </Card>
  );
}

/** The trust rows, for the ways to get paid on show (useGetPaid). */
function TrustPage() {
  const { ways } = useGetPaid();
  return <TrustModel ways={ways} />;
}

/**
 * Ending the account. It can't be taken back and it reaches into every
 * group, so the page says what goes and what stays before the second tap.
 */
function DeleteAccount({ onDeleted }: { onDeleted: () => void }) {
  const s = useStyles();
  const client = useClient();
  const prefs = useCurrencyPrefs();
  // Deleting forgets a connected wallet whether or not they still use bitcoin, so someone who
  // turned it off with one connected is told too. If this can't be read, what they use decides.
  const wallet = useAsync(() => client.getWalletConnection(), [], { key: 'wallet', save: true });
  const forgetsWallet = prefs.uses.includes('BTC') || Boolean(wallet.data?.connected);
  return (
    <Card style={{ gap: space.md }}>
      <Text style={s.body}>
        This ends your account for good. {forgetsWallet ? 'Your wallet connection is forgotten, the' : 'The'} links you
        sent stop working, and you leave every group. A group only you could open is deleted.
      </Text>
      <Text style={s.body}>
        In groups you share, your name and balance stay for the others. What’s owed to you there can be marked settled.
      </Text>
      <ConfirmButton
        label="Delete my account"
        confirmLabel="Yes, delete my account"
        onConfirm={async () => {
          // What's queued, this screen and these taps, goes under the account while it's live,
          // so deleting it deletes them too. Never throws.
          await analytics.flush();
          await client.deleteAccount();
          onDeleted();
        }}
      />
    </Card>
  );
}

function Warning({ title, body }: { title: string; body: string }) {
  const s = useStyles();
  return (
    <View style={s.warning}>
      <Text style={s.warningTitle}>{title}</Text>
      <Text style={s.warningBody}>{body}</Text>
    </View>
  );
}

const APPEARANCE_OPTIONS: Array<{ value: Appearance; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Light, dark, or whatever the phone is set to. Remembered on this device. */
export function AppearancePicker() {
  const current = useAppearance();
  return <Segmented options={APPEARANCE_OPTIONS} value={current} onChange={setAppearance} />;
}

/**
 * Its own page under Account, one tap from where a wallet is connected, and
 * not folded behind a "learn more" there.
 *
 * Each row says what is trusted, and no more: how any of it works is in
 * FaqScreen, under the FAQ button at the top. Every sentence in both states
 * what the code does today, including the parts that aren't flattering.
 * Change the code and they have to change with it:
 *
 *   Your money          payments/lightning.ts gets the invoice from the payee's wallet
 *                       or their own address (lnurl.ts); nothing spends
 *   Wallet connection   walletStore.ts keeps nwc_uri as plain text; nwc.ts only calls
 *                       get_info, make_invoice, lookup_invoice; DELETE /me/wallet
 *                       removes the row
 *   The relay           nwc.ts encrypts each request to the wallet (NIP-44 or NIP-04)
 *   Your account        routes/accounts.ts: a name in, a random token out, nothing
 *                       else; account/tokenStore keeps it on the device; the key is
 *                       what account/signInKey copies, and routes/accounts.ts replaces
 *   Your currencies     prefs/currencyStore keeps the choice on the device and no
 *                       route takes it; payWays only decides what is drawn, here and
 *                       on the group screen, so nothing set up is removed by it
 *   Lightning address   walletStore.ts receive_address, set only by its owner
 *                       (routes/wallet.ts); lnurl.ts and safeFetch.ts only fetch
 *   Is it paid          payments/lightning.ts confirms on the wallet's `settled`, and
 *                       keeps the preimage only if preimageMatches; an address
 *                       payment needs a matching preimage (lnurl.ts verify,
 *                       proof.ts); the manual route lets the payee settle a debt by
 *                       hand (the payer, if the payee is a ghost):
 *                       settlementRules.ts checkManualRecorder; routes/upi.ts: a
 *                       claim is a row in upi_claims, not a settlement, and the
 *                       payee's confirm makes one; so does /upi-payments, where the
 *                       payer's phone passes on a UPI app's success (Android only:
 *                       upi/launchUpi.android.ts) or the payer's own yes, with the
 *                       reference if they typed one (useSettleFlow confirmPaid,
 *                       checked by parseUpiReference)
 *   Group data          migrations/001_init.sql: plain columns, no encryption
 *   Who can see what    routes/groupLinks.ts: no row in group_links until POST
 *                       /groups/:id/link, guestView, and nothing under /g/ that
 *                       writes to the group; /paid-another-way makes a claim, which
 *                       the payee confirms in routes/upi.ts; routes/payLinks.ts guestView, and its randomBytes(16)
 *                       token; walletStore.ts upi_id, and
 *                       GET /groups/:id/members/:memberId/upi refuses anyone who
 *                       doesn't owe them; routes/groupLinks.ts gives it under /g/
 *                       while upi_on_links is on, as it is from the start, or
 *                       members.upi_on_link where the person chose for that group
 *   Joining             routes/joining.ts: POST /join-requests makes a request, not a
 *                       member; only POST /join-requests/:id/approve, by someone in
 *                       the group, claims the member
 *   Exchange rate       rates.ts: CoinGecko, then Blockchain.com, then Coinbase; then the last
 *                       rate any of them gave; then a fixed rate if the server has one,
 *                       and RateUnavailableError if it hasn't, which fails the payment
 *                       (payments/lightning.ts). QUOTE_TTL_MS;
 *                       for a group kept in bitcoin, buildSatsQuote in quote.ts and
 *                       quote() in payments/lightning.ts, which never asks for a rate
 *
 * `ways` leaves out what the reader doesn't use: someone who never chose
 * bitcoin isn't asked to read about wallet connections and relays. A row
 * about something they have set up is never left out, and the rows that
 * remain are worded for what they do use.
 */
export function TrustModel({ ways }: { ways: PayWays }) {
  const s = useStyles();
  const { lightning, upi } = ways;
  // Nostr goes with bitcoin: without it, there's no Nostr key to get back in with.
  const nostr = useShowsNostr();
  const paid = [
    lightning
      ? 'A Lightning payment counts as paid when the payee’s own wallet says the invoice was settled, or with the payment proof: a code the payer’s wallet gets when it pays, which matches the invoice and can’t be made up.'
      : 'Sattle can’t see money move, so a debt is settled on someone’s word, not proof.',
    'Mark as settled is the word of the person who is owed, or of the payer when the one owed hasn’t joined.',
    upi &&
      // An iPhone hears nothing from a UPI app, and the App Store turns down an app that names Android.
      (Platform.OS === 'ios'
        ? 'A UPI payment is someone’s word too: what the payer said, with the reference they gave kept in the group’s history to check against a statement.'
        : 'A UPI payment is someone’s word too: what the payer’s UPI app said, on Android, or what the payer said, with the app’s name and the reference kept in the group’s history to check against a statement.'),
  ];
  return (
    <View>
      <Card style={{ gap: space.md }}>
        <Row
          title="Your money"
          body={
            lightning
              ? 'Sattle never holds it. The server asks the wallet or Lightning address of the person who is owed for an invoice, and the payer pays it from their own wallet. There is nothing for us to freeze, lose or refund.'
              : 'Sattle never holds it. A UPI payment goes from the payer’s UPI app straight to the person who is owed. There is nothing for us to freeze, lose or refund.'
          }
        />
        {lightning && (
          <>
            <Divider />
            <Row
              title="Your wallet connection"
              body="Sattle’s server keeps the connection string, unencrypted, to ask your wallet for invoices. It uses it only to create and check invoices, but anyone who took the string from the server could do whatever it allows, so make it receive-only. Disconnect makes the server forget it; also delete the connection in your wallet."
            />
            <Divider />
            <Row
              title="Your Lightning address"
              body="Sattle’s server keeps it and asks it for invoices, the way any wallet paying you would. Whoever runs the address, your wallet’s company, sees what you’re paid. Only you can set yours."
            />
            <Divider />
            <Row
              title="The relay in between"
              body="Requests to your wallet travel through the Nostr relay named in your connection. They are encrypted, so the relay sees when a request is sent, not what it says."
            />
          </>
        )}
        <Divider />
        <Row
          title="Your account"
          body={`A name and a random key that only this device has. No email, phone or password: only the sign-in key under Account${
            nostr ? ', or a Nostr key linked there,' : ''
          } gets you back in, so keep a copy, or losing this device loses your groups${lightning ? ' and wallet connection' : ''}.`}
        />
        <Divider />
        <Row
          title="Your currencies"
          body="Which currencies you use is kept on this device and never sent to Sattle’s server. It only changes what the app shows you; nothing you set up to get paid is removed by it."
        />
        <Divider />
        <Row title="Is it really paid?" body={paid.filter(Boolean).join(' ')} />
        <Divider />
        <Row
          title="Your group data"
          body="Group names, people’s names, expenses and payments are stored on Sattle’s server. They are not end-to-end encrypted, so the people who run Sattle can read them. Everyone in a group sees everything in that group."
        />
        <Divider />
        <Row
          title="Who can see what"
          body={`Anyone holding a group’s link sees every expense, every name and who owes whom. They can pay a debt, or mark it as paid, which counts only once the person owed confirms it, but they can’t change anything. A pay link shows one debt: who owes whom, the group’s name, the amount and whether it’s paid.${
            upi ? ' Your UPI ID is shown to people who owe you, and to anyone holding one of your groups’ links unless you turn that off.' : ''
          } Neither link can be guessed, but both can be forwarded.`}
        />
        <Divider />
        <Row
          title="Joining"
          body="Whoever holds a group’s link can join it as anyone in it, even someone who has joined, and is then that person, with their balance. A group can change that under Manage, so that picking a name asks instead: someone already in the group has to let them in, and both see the same four-digit code to check it’s really them."
        />
        {lightning && (
          <>
            <Divider />
            <Row
              title="The exchange rate"
              body="A debt in rupees is paid in sats at CoinGecko’s rate, or Blockchain.com’s or Coinbase’s when it is down, fixed for 90 seconds when the invoice is made and shown to you in sats before you pay. A group kept in bitcoin is owed in sats already, so no rate is used."
            />
          </>
        )}
      </Card>
      <Text style={s.trustFooter}>
        If any of this changes, this page changes with it. How it all works is in the FAQ.
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
  label: { ...type.label, color: color.inkMuted },
  body: { ...type.body, color: color.inkMuted },
  balance: { ...type.amountLg, color: color.ink },
  unit: { ...type.body, color: color.inkFaint },
  address: { ...type.amountMd, color: color.ink },
  key: { ...type.amountSm, color: color.ink },
  note: { ...type.caption, color: color.inkFaint, lineHeight: 18 },
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
}));
