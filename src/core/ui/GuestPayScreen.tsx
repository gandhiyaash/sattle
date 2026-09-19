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
 * - The invoice is fetched when this page loads, not when the link was
 *   created. BOLT11 expires in minutes; half of pre-generated links would
 *   be dead on arrival.
 * - Nothing on this page reveals the rest of the group. The token grants
 *   one debt, not the ledger.
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';

import { formatFiat } from '../domain/ledger';
import type { Settlement } from '../domain/types';
import { useClient } from '../react/SattleProvider';
import { Button, Card, ErrorState, SatLine } from './primitives';
import { color, radius, shadow, space, type } from './theme';

export interface GuestPayScreenProps {
  settlementId: string;
  /** Names are passed in by the server render; the token itself reveals nothing. */
  payerName: string;
  payeeName: string;
  reason: string;
}

export function GuestPayScreen({
  settlementId,
  payerName,
  payeeName,
  reason,
}: GuestPayScreenProps) {
  const client = useClient();
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    client
      .getSettlement(settlementId)
      .then((s) => {
        setSettlement(s);
        unsub = client.onSettlementUpdate(settlementId, setSettlement);
      })
      .catch(() => setError('This link is no longer valid.'));
    return () => unsub?.();
  }, [client, settlementId]);

  if (error) {
    return (
      <View style={s.page}>
        <View style={s.sheet}>
          <ErrorState message={error} />
        </View>
      </View>
    );
  }

  if (!settlement) {
    return (
      <View style={s.page}>
        <View style={s.sheet}>
          <ActivityIndicator color={color.accent} />
        </View>
      </View>
    );
  }

  const done = settlement.status === 'confirmed' || settlement.status === 'manually_confirmed';
  const quote = settlement.quote;

  if (done) {
    return (
      <View style={s.page}>
        <View style={s.sheet}>
          <View style={s.tick}>
            <Text style={s.tickMark}>✓</Text>
          </View>
          <Text style={s.title}>Paid</Text>
          <Text style={s.reason}>
            {payeeName} has been paid. Nothing else to do — you can close this.
          </Text>
          {settlement.preimage && (
            <View style={s.receipt}>
              <Text style={s.receiptLabel}>Payment proof</Text>
              <Text style={s.receiptValue} numberOfLines={1}>
                {settlement.preimage}
              </Text>
            </View>
          )}
        </View>
      </View>
    );
  }

  const waiting = settlement.status === 'in_flight';

  return (
    <View style={s.page}>
      <View style={s.sheet}>
        <Text style={s.brand}>Sattle</Text>

        <Text style={s.title}>
          {payerName}, you owe {payeeName}
        </Text>

        {quote && (
          <View style={s.amountBlock}>
            <Text style={s.amount}>{formatFiat(quote.amountFiat, quote.currency)}</Text>
            <SatLine sats={quote.amountSat} />
          </View>
        )}

        <Text style={s.reason}>{reason}</Text>

        {waiting ? (
          <View style={s.waiting}>
            <ActivityIndicator color={color.accent} />
            <Text style={s.waitingText}>Waiting for the payment to confirm…</Text>
          </View>
        ) : (
          <>
            <Button
              label="Open your wallet"
              variant="primary"
              onPress={() =>
                settlement.destination &&
                Linking.openURL(`lightning:${settlement.destination}`)
              }
            />
            <Text style={s.hint}>
              Works with Phoenix, Wallet of Satoshi, Zeus, Blink — any Lightning wallet.
            </Text>

            {settlement.destination && (
              <View style={s.qrBlock}>
                <View style={s.qrPlaceholder}>
                  <Text style={s.qrNote}>QR</Text>
                </View>
                <Text style={s.invoice} numberOfLines={2}>
                  {settlement.destination}
                </Text>
              </View>
            )}
          </>
        )}

        {quote && (
          <Text style={s.fee}>
            Network fee ≈ {quote.feeSat} sats, paid by you on top.
          </Text>
        )}

        <Text style={s.footer}>
          No account needed. This link only shows this one payment — not the group.
        </Text>
      </View>
    </View>
  );
}

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
  qrPlaceholder: {
    width: 160,
    height: 160,
    borderRadius: radius.md,
    backgroundColor: color.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrNote: { ...type.caption, color: color.inkFaint },
  invoice: { ...type.amountSm, color: color.inkFaint, textAlign: 'center' },

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
