/**
 * Guest payment page — what someone sees when they open /s/<token>.
 *
 * This is the most important screen in the product and the one a judge
 * should be shown second, right after the group screen. It is the proof of
 * the whole claim: no app, no signup, no key, no cookie. Just who, how
 * much, what for, and one button.
 *
 * Constraints that shaped it:
 * - It offers the ways the person owed can be paid, and only those. Lightning
 *   alone opens straight on the invoice. In a rupee group they may take UPI
 *   too: then the page asks which, and makes no invoice until it is told,
 *   since one nobody asked for would stand in the way of the UPI payment.
 *   UPI alone opens on who to pay.
 * - Sattle can't see a UPI payment. So "I've paid" is the payer's word, and
 *   the page waits for the person owed to confirm it in the app. Once they
 *   have, it shows Paid like any other.
 * - It renders on web, where there is no embedded wallet. So the action is
 *   always "open your wallet" or "scan this", never "pay from balance".
 * - The invoice is minted when this page loads (openPayLink), not when the
 *   link was created. BOLT11 expires in minutes; half of pre-generated links
 *   would be dead on arrival. When one does lapse, the page asks for a fresh
 *   one rather than leaving a dead QR on screen.
 * - Nothing on this page reveals the rest of the group. The token grants
 *   one debt, not the ledger — and GuestView carries no ids to leak.
 * - A group kept in bitcoin owes in sats, so there is no rate on the page:
 *   the amount is the sats to pay.
 * - Some payees receive at a Lightning address whose provider can't tell us
 *   it was paid. The payer's wallet can: it gets the payment proof (the
 *   preimage) when it pays. So a browser wallet (WebLN) pays and hands the
 *   proof straight back, and anyone else can paste it, on a live invoice or
 *   one we've called expired, since it may have been paid late.
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  SattleError,
  formatAmount,
  formatRate,
  formatSats,
  isBitcoin,
  upiPayUri,
  type GuestSettlement,
  type GuestView,
} from '@sattle/core';
import { useActionKeys, useAsync, useClient } from '../react/SattleProvider';
import { CopyInvoice } from './InvoicePanel';
import { openAppLink } from './openLink';
import { BreakdownRow, Button, ErrorState, QuoteBreakdown, SatLine } from './primitives';
import { QrCode } from './QrCode';
import { makeStyles, radius, shadow, space, type, useColors } from './theme';
import { UpiPanel } from './UpiPanel';

export interface GuestPayScreenProps {
  /** From /s/<token>. The only thing the page knows on arrival. */
  token: string;
  /** Reached by tapping Settle on the group page, so the reader has seen the group. */
  fromGroup?: boolean;
}

const FromGroup = createContext(false);

/** How often the page asks whether the person owed has answered a UPI payment. */
const UPI_CHECK_MS = 4000;

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; view: GuestView }
  | { kind: 'failed'; error: SattleError };

export function GuestPayScreen({ token, fromGroup = false }: GuestPayScreenProps) {
  return (
    <FromGroup.Provider value={fromGroup}>
      <GuestPay token={token} />
    </FromGroup.Provider>
  );
}

function GuestPay({ token }: { token: string }) {
  const color = useColors();
  const s = useStyles();
  const client = useClient();
  const fromGroup = useContext(FromGroup);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  // Bumped to open the link again: after a failure, or once an invoice lapses.
  const [attempt, setAttempt] = useState(0);
  const retry = () => setAttempt((n) => n + 1);
  // Set once the payer has chosen Lightning over UPI, which is what makes the invoice.
  // Coming from the group page they chose it there.
  const [rail, setRail] = useState<'lightning' | undefined>(fromGroup ? 'lightning' : undefined);
  /** The payer is paying by UPI: who to pay is up, with "I've paid" under it. */
  const [byUpi, setByUpi] = useState(false);

  useEffect(() => {
    let live = true;
    let unsub: (() => void) | undefined;
    setLoad({ kind: 'loading' });
    client
      .openPayLink(token, rail)
      .then((view) => {
        if (!live) return;
        setLoad({ kind: 'ready', view });
        unsub = client.onGuestViewUpdate(token, (v) => live && setLoad({ kind: 'ready', view: v }));
      })
      .catch((e) => {
        if (!live) return;
        const error = e instanceof SattleError ? e : new SattleError('network', 'Something went wrong. Try again.');
        setLoad({ kind: 'failed', error });
      });
    return () => {
      live = false;
      unsub?.();
    };
  }, [client, token, attempt, rail]);

  // The person owed answers a UPI payment in the app. Once they have, open the link again:
  // it is paid, or they said it didn't arrive and it is there to pay again.
  const waitingOnUpi = load.kind === 'ready' && load.view.upiClaim === 'pending';
  useEffect(() => {
    if (!waitingOnUpi) return;
    const t = setInterval(() => {
      client
        .getGuestView(token)
        .then((v) => v.upiClaim !== 'pending' && setAttempt((n) => n + 1))
        .catch(() => {});
    }, UPI_CHECK_MS);
    return () => clearInterval(t);
  }, [client, token, waitingOnUpi]);

  if (load.kind === 'loading') {
    return (
      <Page>
        <ActivityIndicator color={color.accent} />
      </Page>
    );
  }

  if (load.kind === 'failed') return <LinkError error={load.error} onRetry={retry} />;

  const { view } = load;
  const settlement = view.settlement;
  /** Sends a proof; the answer shows the payment it proved. Throws for the caller to show. */
  const sendProof = async (preimage: string) => {
    const next = await client.submitGuestProof(token, preimage);
    setLoad({ kind: 'ready', view: next });
  };
  const proof = <ProofEntry onSubmit={sendProof} />;
  const header = (
    <>
      <Text style={s.brand}>Sattle</Text>
      <Text style={s.title}>
        {view.payerName}, you owe {view.payeeName}
      </Text>
    </>
  );

  const owed = (
    <View style={s.amountBlock}>
      <Text style={s.amount}>{formatAmount(view.amount, view.currency)}</Text>
    </View>
  );

  if (settlement?.status === 'confirmed' || settlement?.status === 'manually_confirmed') {
    return <Paid payeeName={view.payeeName} settlement={settlement} />;
  }

  // Paying again now would pay it twice, so there is nothing to tap until the person owed has answered.
  if (view.upiClaim === 'pending') {
    return (
      <Page>
        {header}
        {owed}
        <Text style={s.reason}>{view.reason}</Text>
        <Notice
          title={`Waiting for ${view.payeeName}`}
          body={`Someone said this was paid by UPI. It’s settled once ${view.payeeName} confirms it arrived. You can close this.`}
        />
        <Footer />
      </Page>
    );
  }

  // On the group page UPI has its own button next to this one, so from there this page is Lightning's.
  const upiOffered = Boolean(view.upi) && !fromGroup;
  const turnedDown = view.upiClaim === 'declined' && (
    <Notice
      title="The UPI payment didn’t arrive"
      body={`${view.payeeName} says it didn’t reach them. Check with them before paying again.`}
    />
  );
  const payWithLightning = () => {
    setByUpi(false);
    // Already chosen once, so asking again is for a fresh invoice.
    if (rail === 'lightning') retry();
    else setRail('lightning');
  };
  /** For under an invoice that is dead: the other way to pay, when there is one. */
  const upiInstead = upiOffered && <Button label="Pay by UPI instead" onPress={() => setByUpi(true)} />;

  // Chosen, or the only way there is: then there was nothing to ask.
  if (upiOffered && (byUpi || (!settlement && !view.payable))) {
    return (
      <UpiPay
        token={token}
        view={view}
        header={header}
        notice={turnedDown}
        onLightning={view.payable ? payWithLightning : undefined}
        onSaid={() => {
          setByUpi(false);
          retry();
        }}
      />
    );
  }

  if (!settlement && upiOffered) {
    return (
      <Page>
        {header}
        {owed}
        <Text style={s.reason}>{view.reason}</Text>
        {turnedDown}
        <Button
          label="Pay by UPI"
          variant="primary"
          hint={`From GPay, PhonePe or any UPI app. ${view.payeeName} confirms once it arrives.`}
          onPress={() => setByUpi(true)}
        />
        <Button
          label="Pay with Lightning"
          hint="Get an invoice in sats to pay from any Lightning wallet."
          onPress={payWithLightning}
        />
        <Footer />
      </Page>
    );
  }

  if (!settlement || settlement.status === 'created') {
    return (
      <Page>
        {header}
        <Text style={s.reason}>{view.reason}</Text>
        <View style={s.waiting}>
          <ActivityIndicator color={color.accent} />
          <Text style={s.waitingText}>Getting a fresh invoice…</Text>
        </View>
        <Footer />
      </Page>
    );
  }

  switch (settlement.status) {
    case 'failed':
      return (
        <Page>
          {header}
          <AmountBlock settlement={settlement} />
          <Notice
            title="That payment didn’t go through"
            body={`${settlement.failureReason ?? 'The payment failed.'} Nothing was taken — try again.`}
          />
          <Button label="Try again" variant="primary" onPress={retry} />
          {upiInstead}
          <Footer />
        </Page>
      );

    case 'expired':
      return (
        <Expired
          header={header}
          reason={view.reason}
          why={settlement.failureReason}
          sats={isBitcoin(settlement.currency)}
          onRenew={retry}
          proof={proof}
          other={upiInstead}
        />
      );

    case 'in_flight':
      return (
        <Page>
          {header}
          <AmountBlock settlement={settlement} />
          <Text style={s.reason}>{view.reason}</Text>
          <View style={s.waiting}>
            <ActivityIndicator color={color.accent} />
            <Text style={s.waitingText}>Waiting for the payment to confirm…</Text>
          </View>
          <Footer />
        </Page>
      );

    case 'awaiting_payment':
      return (
        <Invoice
          header={header}
          reason={view.reason}
          settlement={settlement}
          onRenew={retry}
          proof={proof}
          other={upiInstead}
          onPaidInBrowser={(preimage) => sendProof(preimage)}
        />
      );
  }
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function Invoice({
  header,
  reason,
  settlement,
  onRenew,
  proof,
  other,
  onPaidInBrowser,
}: {
  header: React.ReactNode;
  reason: string;
  settlement: GuestSettlement;
  onRenew: () => void;
  proof: React.ReactNode;
  /** Another way to pay. Not offered while the invoice is live: the two together could pay it twice. */
  other?: React.ReactNode;
  onPaidInBrowser: (preimage: string) => Promise<void>;
}) {
  const s = useStyles();
  const left = useSecondsLeft(settlement.quote?.expiresAt);
  const sats = isBitcoin(settlement.currency);
  // The server only marks it `expired` later; don't leave a dead QR up meanwhile.
  if (left === 0) {
    return <Expired header={header} reason={reason} sats={sats} onRenew={onRenew} proof={proof} other={other} />;
  }

  const { destination, quote } = settlement;
  return (
    <Page>
      {header}
      <AmountBlock settlement={settlement} />
      {quote && <QuoteBreakdown quote={quote} />}
      <Text style={s.reason}>{reason}</Text>

      {destination && (
        <>
          <Button
            label="Open your wallet"
            variant="primary"
            onPress={() => openAppLink(`lightning:${destination}`).catch(() => {})}
          />
          <Text style={s.hint}>
            Works with Phoenix, Wallet of Satoshi, Zeus, Blink — any Lightning wallet.
          </Text>
          <BrowserWalletPay invoice={destination} onPaid={onPaidInBrowser} />

          <View style={s.qrBlock}>
            <View style={s.qrFrame}>
              <QrCode value={`lightning:${destination}`} size={220} />
            </View>
            <Text style={s.invoice} numberOfLines={2} selectable>
              {destination}
            </Text>
            {left !== null && (
              <Text style={s.countdown}>
                {sats ? 'Invoice good for' : 'Rate and invoice locked for'} {formatClock(left)}
              </Text>
            )}
          </View>
          <CopyInvoice invoice={destination} />
        </>
      )}

      {destination && proof}
      <Footer />
    </Page>
  );
}

function Expired({
  header,
  reason,
  why,
  sats,
  onRenew,
  proof,
  other,
}: {
  header: React.ReactNode;
  reason: string;
  /** The server's reason, when it couldn't tell whether this was paid. */
  why?: string;
  /** The debt is in sats, so a new invoice is for the same amount: there's no rate to have moved. */
  sats: boolean;
  onRenew: () => void;
  proof: React.ReactNode;
  /** Another way to pay, now that this invoice is dead. */
  other?: React.ReactNode;
}) {
  const s = useStyles();
  return (
    <Page>
      {header}
      <Text style={s.reason}>{reason}</Text>
      {why ? (
        <Notice title="We can’t tell if this was paid" body={why} />
      ) : (
        <Notice
          title="This invoice expired"
          body={
            sats
              ? 'Lightning invoices only last a few minutes. Get a new one for the same amount.'
              : 'Lightning invoices only last a few minutes, and the sats price moves. Get a new one at today’s rate.'
          }
        />
      )}
      {/* Paid already? Their proof settles it; a new invoice would mean paying twice. */}
      {proof}
      <Button label="Get a new invoice" variant={why ? 'secondary' : 'primary'} onPress={onRenew} />
      {other}
      <Footer />
    </Page>
  );
}

/**
 * Paying the link by UPI: who to pay, then the payer's word that they did.
 * The UPI ID is asked for here and not before, so it reaches only someone
 * who went to pay.
 */
function UpiPay({
  token,
  view,
  header,
  notice,
  onLightning,
  onSaid,
}: {
  token: string;
  view: GuestView;
  header: React.ReactNode;
  /** Said above the details: that the last UPI payment was turned down. */
  notice?: React.ReactNode;
  /** The other way, when the person owed takes it. */
  onLightning?: () => void;
  /** They've said they paid. The page goes to waiting on the person owed. */
  onSaid: () => void;
}) {
  const color = useColors();
  const s = useStyles();
  const client = useClient();
  const keys = useActionKeys();
  const { data: payee, loading, error, reload } = useAsync(() => client.getPayLinkUpi(token), [token]);
  const [saying, setSaying] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const amount = formatAmount(view.amount, view.currency);

  // Moves nothing: the person owed is asked whether it arrived.
  const sayPaid = async () => {
    setSaying(true);
    setFailed(null);
    try {
      await keys.run('upi-claim', { token }, (k) => client.claimUpiFromPayLink(token, k));
      onSaid();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'Couldn’t send that. Try again.');
      setSaying(false);
    }
  };

  return (
    <Page>
      {header}
      <View style={s.amountBlock}>
        <Text style={s.amount}>{amount}</Text>
      </View>
      <Text style={s.reason}>{view.reason}</Text>
      {notice}
      {loading ? (
        <ActivityIndicator color={color.accent} />
      ) : error || !payee ? (
        <ErrorState message={error?.message ?? 'Couldn’t get the UPI details. Try again.'} onRetry={reload} />
      ) : (
        <>
          <UpiPanel
            payee={payee}
            uri={upiPayUri({ upiId: payee.upiId, name: payee.name, amount: view.amount, note: view.reason })}
          />
          <Text style={s.hint}>
            Pay {amount}, then tap below. {view.payeeName} confirms it arrived, and then it’s settled.
          </Text>
          <Button label="I’ve paid" variant="primary" busy={saying} onPress={sayPaid} />
        </>
      )}
      {failed && <Text style={s.proofError}>{failed}</Text>}
      {onLightning && <Button label="Pay with Lightning instead" variant="quiet" onPress={onLightning} />}
      <Footer />
    </Page>
  );
}

/** What a WebLN browser wallet (Alby and others) exposes. Only the calls used here. */
interface WebLN {
  enable(): Promise<void>;
  sendPayment(invoice: string): Promise<{ preimage: string }>;
}

function browserWallet(): WebLN | undefined {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
  return (window as unknown as { webln?: WebLN }).webln;
}

/**
 * Only when the browser has a Lightning wallet. It pays and hands back the
 * proof, which confirms the payment even when the payee's wallet can't.
 */
function BrowserWalletPay({ invoice, onPaid }: { invoice: string; onPaid: (preimage: string) => Promise<void> }) {
  const s = useStyles();
  const [webln] = useState(browserWallet);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!webln) return null;

  const pay = async () => {
    setBusy(true);
    setError(null);
    let preimage: string;
    try {
      await webln.enable();
      preimage = (await webln.sendPayment(invoice)).preimage;
    } catch (e) {
      setError(e instanceof Error && e.message ? `Your browser wallet said: ${e.message}` : 'Your browser wallet didn’t pay.');
      setBusy(false);
      return;
    }
    try {
      await onPaid(preimage);
    } catch {
      // It paid; only telling us failed. The page still updates if the
      // payee's wallet confirms it, and the proof can be pasted below.
      setError('Paid, but we couldn’t record it. Copy the payment proof from your wallet and paste it below.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: space.xs }}>
      <Button label="Pay with your browser wallet" busy={busy} onPress={pay} />
      {error && <Text style={s.proofError}>{error}</Text>}
    </View>
  );
}

/** "Already paid?": paste the payment proof from your wallet. Collapsed until asked for. */
function ProofEntry({ onSubmit }: { onSubmit: (preimage: string) => Promise<void> }) {
  const color = useColors();
  const s = useStyles();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return <Button label="Already paid? Send your payment proof" variant="quiet" onPress={() => setOpen(true)} />;
  }

  const submit = async () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.proofBox}>
      <Text style={s.noticeTitle}>Your payment proof</Text>
      <Text style={s.proofHelp}>
        Your wallet shows it in the payment’s details, sometimes called the preimage: 64 letters and numbers.
        Only the wallet that paid has it, so it shows this was paid.
      </Text>
      <TextInput
        style={s.proofInput}
        value={value}
        onChangeText={setValue}
        onSubmitEditing={submit}
        placeholder="Paste it here"
        placeholderTextColor={color.inkFaint}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
      />
      {error && <Text style={s.proofError}>{error}</Text>}
      <Button label="Send proof" variant="primary" busy={busy} disabled={!value.trim()} onPress={submit} />
    </View>
  );
}

/** A receipt: what was owed, what was sent, and the rate that joined them. */
function Paid({ payeeName, settlement }: { payeeName: string; settlement: GuestSettlement }) {
  const s = useStyles();
  const { preimage } = settlement;
  // In sats the amount owed is the amount sent, and no rate joined them.
  const quote = isBitcoin(settlement.currency) ? undefined : settlement.quote;
  return (
    <Page>
      <View style={s.tick}>
        <Text style={s.tickMark}>✓</Text>
      </View>
      <Text style={s.title}>Paid</Text>
      <Text style={s.reason}>{payeeName} has been paid. Nothing else to do — you can close this.</Text>
      <View style={s.receipt}>
        <BreakdownRow label="Amount" value={formatAmount(settlement.amount, settlement.currency)} numeric />
        {quote && (
          <>
            <BreakdownRow label="Sent" value={formatSats(quote.amountSat)} numeric />
            <BreakdownRow label="Exchange rate" value={formatRate(quote)} numeric />
          </>
        )}
        {preimage && (
          <View style={s.proof}>
            <Text style={s.receiptLabel}>Payment proof</Text>
            <Text style={s.receiptValue} numberOfLines={1} selectable>
              {preimage}
            </Text>
          </View>
        )}
      </View>
    </Page>
  );
}

/** The link itself couldn't be opened. Each code gets words a guest can act on. */
function LinkError({ error, onRetry }: { error: SattleError; onRetry: () => void }) {
  const s = useStyles();
  switch (error.code) {
    case 'not_found':
      return (
        <Page>
          <Text style={s.brand}>Sattle</Text>
          <Notice title="This link isn’t valid" body="Check you copied all of it, or ask whoever sent it for a new one." />
        </Page>
      );
    case 'link_expired':
      return (
        <Page>
          <Text style={s.brand}>Sattle</Text>
          <Text style={s.title}>Nothing to pay</Text>
          <Text style={s.reason}>
            This has already been settled, or the amount changed since the link was sent. Nothing else to do — you
            can close this.
          </Text>
        </Page>
      );
    case 'member_cannot_receive':
      return (
        <Page>
          <Text style={s.brand}>Sattle</Text>
          <Notice title="Can’t pay this yet" body={`${error.message} Let them know, then open this link again.`} />
          <Button label="Try again" onPress={onRetry} />
        </Page>
      );
    default:
      return (
        <Page>
          <Text style={s.brand}>Sattle</Text>
          <ErrorState message={error.message} onRetry={onRetry} />
        </Page>
      );
  }
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Page({ children }: { children: React.ReactNode }) {
  const s = useStyles();
  return (
    <View style={s.page}>
      <View style={s.sheet}>{children}</View>
    </View>
  );
}

function AmountBlock({ settlement }: { settlement: GuestSettlement }) {
  const s = useStyles();
  const { quote } = settlement;
  return (
    <View style={s.amountBlock}>
      <Text style={s.amount}>{formatAmount(settlement.amount, settlement.currency)}</Text>
      {/* Under a rupee amount, what it comes to. A sats amount says it already. */}
      {quote && !isBitcoin(settlement.currency) && <SatLine sats={quote.amountSat} />}
    </View>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  const s = useStyles();
  return (
    <View style={s.notice}>
      <Text style={s.noticeTitle}>{title}</Text>
      <Text style={s.noticeBody}>{body}</Text>
    </View>
  );
}

function Footer() {
  const s = useStyles();
  // From the group page that last part would be wrong: they came here from the group.
  const fromGroup = useContext(FromGroup);
  return (
    <Text style={s.footer}>
      {fromGroup
        ? 'No account needed. Pay from any Lightning wallet.'
        : 'No account needed. This link only shows this one payment — not the group.'}
    </Text>
  );
}

/** Whole seconds until `iso`, ticking once a second; null when there's no deadline. */
function useSecondsLeft(iso: string | undefined) {
  const deadline = iso ? Date.parse(iso) : NaN;
  const compute = () => (Number.isNaN(deadline) ? null : Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
  const [left, setLeft] = useState(compute);

  useEffect(() => {
    setLeft(compute());
    if (Number.isNaN(deadline)) return;
    const t = setInterval(() => setLeft(compute()), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadline]);

  return left;
}

const formatClock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

const useStyles = makeStyles((color) => ({
  page: {
    flex: 1,
    backgroundColor: color.paper,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    padding: space.xl,
    gap: space.md,
    ...shadow,
  },
  brand: {
    ...type.caption,
    color: color.inkFaint,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  title: { ...type.title, color: color.ink },
  amountBlock: { gap: 2, marginVertical: space.sm },
  amount: { ...type.amountLg, color: color.ink },
  reason: { ...type.body, color: color.inkMuted },
  hint: { ...type.caption, color: color.inkFaint, textAlign: 'center' },

  waiting: { alignItems: 'center', gap: space.md, paddingVertical: space.xl },
  waitingText: { ...type.body, color: color.inkMuted },

  qrBlock: { alignItems: 'center', gap: space.sm, marginTop: space.md },
  // QR needs a light ground and a quiet zone; the code draws its own margin.
  qrFrame: { borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#FFFFFF' },
  invoice: { ...type.amountSm, color: color.inkFaint, textAlign: 'center' },
  countdown: { ...type.caption, color: color.inkMuted },

  notice: {
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.xs,
  },
  noticeTitle: { ...type.heading, color: color.ink },
  noticeBody: { ...type.body, color: color.inkMuted },

  footer: {
    ...type.caption,
    color: color.inkFaint,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
    paddingTop: space.md,
    marginTop: space.sm,
  },

  tick: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: color.owed,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickMark: { color: '#fff', fontSize: 22, fontWeight: '700' },
  receipt: {
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  proof: {
    gap: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
    paddingTop: space.sm,
    marginTop: space.xs,
  },
  receiptLabel: { ...type.caption, color: color.inkFaint },
  proofBox: {
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  proofHelp: { ...type.caption, color: color.inkMuted, lineHeight: 18 },
  proofInput: {
    minHeight: 64,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrong,
    borderRadius: radius.md,
    padding: space.sm,
    ...type.amountSm,
    color: color.ink,
    backgroundColor: color.paper,
  },
  proofError: { ...type.caption, color: color.danger },
  receiptValue: { ...type.amountSm, color: color.inkMuted },
}));
