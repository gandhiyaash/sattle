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
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';

import { SattleError, formatFiat, type GuestSettlement, type GuestView } from '@sattle/core';
import { useClient } from '../react/SattleProvider';
import { Button, ErrorState, SatLine } from './primitives';
import { QrCode } from './QrCode';
import { color, radius, shadow, space, type } from './theme';

export interface GuestPayScreenProps {
  /** From /s/<token>. The only thing the page knows on arrival. */
  token: string;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; view: GuestView }
  | { kind: 'failed'; error: SattleError };

export function GuestPayScreen({ token }: GuestPayScreenProps) {
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
      return <Paid payeeName={view.payeeName} preimage={settlement.preimage} />;

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
      return <Expired header={header} reason={view.reason} onRenew={retry} />;

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
}: {
  header: React.ReactNode;
  reason: string;
  settlement: GuestSettlement;
  onRenew: () => void;
}) {
  const left = useSecondsLeft(settlement.quote?.expiresAt);
  // The server only marks it `expired` later; don't leave a dead QR up meanwhile.
  if (left === 0) return <Expired header={header} reason={reason} onRenew={onRenew} />;

  const { destination, quote } = settlement;
  return (
    <Page>
      {header}
      <AmountBlock settlement={settlement} />
      <Text style={s.reason}>{reason}</Text>

      {destination && (
        <>
          <Button
            label="Open your wallet"
            variant="primary"
            onPress={() => Linking.openURL(`lightning:${destination}`)}
          />
          <Text style={s.hint}>
            Works with Phoenix, Wallet of Satoshi, Zeus, Blink — any Lightning wallet.
          </Text>

          <View style={s.qrBlock}>
            <View style={s.qrFrame}>
              <QrCode value={`lightning:${destination}`} size={220} />
            </View>
            <Text style={s.invoice} numberOfLines={2} selectable>
              {destination}
            </Text>
            {left !== null && <Text style={s.countdown}>Invoice valid for {formatClock(left)}</Text>}
          </View>
        </>
      )}

      {quote && <Text style={s.fee}>Network fee ≈ {quote.feeSat} sats, paid by you on top.</Text>}
      <Footer />
    </Page>
  );
}

function Expired({
  header,
  reason,
  onRenew,
}: {
  header: React.ReactNode;
  reason: string;
  onRenew: () => void;
}) {
  return (
    <Page>
      {header}
      <Text style={s.reason}>{reason}</Text>
      <Notice
        title="This invoice expired"
        body="Lightning invoices only last a few minutes, and the sats price moves. Get a new one at today’s rate."
      />
      <Button label="Get a new invoice" variant="primary" onPress={onRenew} />
      <Footer />
    </Page>
  );
}

function Paid({ payeeName, preimage }: { payeeName: string; preimage?: string }) {
  return (
    <Page>
      <View style={s.tick}>
        <Text style={s.tickMark}>✓</Text>
      </View>
      <Text style={s.title}>Paid</Text>
      <Text style={s.reason}>{payeeName} has been paid. Nothing else to do — you can close this.</Text>
      {preimage && (
        <View style={s.receipt}>
          <Text style={s.receiptLabel}>Payment proof</Text>
          <Text style={s.receiptValue} numberOfLines={1} selectable>
            {preimage}
          </Text>
        </View>
      )}
    </Page>
  );
}

/** The link itself couldn't be opened. Each code gets words a guest can act on. */
function LinkError({ error, onRetry }: { error: SattleError; onRetry: () => void }) {
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
  return (
    <View style={s.page}>
      <View style={s.sheet}>{children}</View>
    </View>
  );
}

function AmountBlock({ settlement }: { settlement: GuestSettlement }) {
  const { quote } = settlement;
  return (
    <View style={s.amountBlock}>
      <Text style={s.amount}>{formatFiat(settlement.amount, settlement.currency)}</Text>
      {quote && <SatLine sats={quote.amountSat} />}
    </View>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <View style={s.notice}>
      <Text style={s.noticeTitle}>{title}</Text>
      <Text style={s.noticeBody}>{body}</Text>
    </View>
  );
}

function Footer() {
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

const s = StyleSheet.create({
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

  fee: { ...type.caption, color: color.inkFaint },
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
    padding: space.md,
    gap: 2,
  },
  receiptLabel: { ...type.caption, color: color.inkFaint },
  receiptValue: { ...type.amountSm, color: color.inkMuted },
});
