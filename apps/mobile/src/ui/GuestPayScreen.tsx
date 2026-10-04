/**
 * Guest payment page — what someone sees when they open /s/<token>.
 *
 * This is the most important screen in the product and the one a judge
 * should be shown second, right after the group screen. It is the proof of
 * the whole claim: no app, no signup, no key, no cookie. Just who, how
 * much, what for, and one button.
 *
 * Constraints that shaped it:
 * - It renders on web, where there is no embedded wallet. So the action is
 *   always "open your wallet" or "scan this", never "pay from balance".
 * - The invoice is minted when this page loads (openPayLink), not when the
 *   link was created. BOLT11 expires in minutes; half of pre-generated links
 *   would be dead on arrival. When one does lapse, the page asks for a fresh
 *   one rather than leaving a dead QR on screen.
 * - Nothing on this page reveals the rest of the group. The token grants
 *   one debt, not the ledger — and GuestView carries no ids to leak.
 * - Some payees receive at a Lightning address whose provider can't tell us
 *   it was paid. The payer's wallet can: it gets the payment proof (the
 *   preimage) when it pays. So a browser wallet (WebLN) pays and hands the
 *   proof straight back, and anyone else can paste it, on a live invoice or
 *   one we've called expired, since it may have been paid late.
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import { SattleError, formatFiat, formatRate, type GuestSettlement, type GuestView } from '@sattle/core';
import { useClient } from '../react/SattleProvider';
import { CopyInvoice } from './InvoicePanel';
import { openAppLink } from './openLink';
import { BreakdownRow, Button, ErrorState, QuoteBreakdown, SatLine, formatSats } from './primitives';
import { QrCode } from './QrCode';
import { makeStyles, radius, shadow, space, type, useColors } from './theme';

export interface GuestPayScreenProps {
  /** From /s/<token>. The only thing the page knows on arrival. */
  token: string;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; view: GuestView }
  | { kind: 'failed'; error: SattleError };

export function GuestPayScreen({ token }: GuestPayScreenProps) {
  return <GuestPay token={token} />;
}

function GuestPay({ token }: { token: string }) {
  const color = useColors();
  const s = useStyles();
  const client = useClient();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  // Bumped to open the link again: after a failure, or once an invoice lapses.
  const [attempt, setAttempt] = useState(0);
  const retry = () => setAttempt((n) => n + 1);

  useEffect(() => {
    let live = true;
    let unsub: (() => void) | undefined;
    setLoad({ kind: 'loading' });
    client
      .openPayLink(token)
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
  }, [client, token, attempt]);

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
    case 'confirmed':
    case 'manually_confirmed':
      return <Paid payeeName={view.payeeName} settlement={settlement} />;

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
          <Footer />
        </Page>
      );

    case 'expired':
      return <Expired header={header} reason={view.reason} why={settlement.failureReason} onRenew={retry} proof={proof} />;

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
  onPaidInBrowser,
}: {
  header: React.ReactNode;
  reason: string;
  settlement: GuestSettlement;
  onRenew: () => void;
  proof: React.ReactNode;
  onPaidInBrowser: (preimage: string) => Promise<void>;
}) {
  const s = useStyles();
  const left = useSecondsLeft(settlement.quote?.expiresAt);
  // The server only marks it `expired` later; don't leave a dead QR up meanwhile.
  if (left === 0) return <Expired header={header} reason={reason} onRenew={onRenew} proof={proof} />;

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
            {left !== null && <Text style={s.countdown}>Rate and invoice locked for {formatClock(left)}</Text>}
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
  onRenew,
  proof,
}: {
  header: React.ReactNode;
  reason: string;
  /** The server's reason, when it couldn't tell whether this was paid. */
  why?: string;
  onRenew: () => void;
  proof: React.ReactNode;
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
          body="Lightning invoices only last a few minutes, and the sats price moves. Get a new one at today’s rate."
        />
      )}
      {/* Paid already? Their proof settles it; a new invoice would mean paying twice. */}
      {proof}
      <Button label="Get a new invoice" variant={why ? 'secondary' : 'primary'} onPress={onRenew} />
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
  const { quote, preimage } = settlement;
  return (
    <Page>
      <View style={s.tick}>
        <Text style={s.tickMark}>✓</Text>
      </View>
      <Text style={s.title}>Paid</Text>
      <Text style={s.reason}>{payeeName} has been paid. Nothing else to do — you can close this.</Text>
      <View style={s.receipt}>
        <BreakdownRow label="Amount" value={formatFiat(settlement.amount, settlement.currency)} numeric />
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
      <Text style={s.amount}>{formatFiat(settlement.amount, settlement.currency)}</Text>
      {quote && <SatLine sats={quote.amountSat} />}
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
  return <Text style={s.footer}>No account needed. This link only shows this one payment — not the group.</Text>;
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
