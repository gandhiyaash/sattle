/**
 * An invoice someone has to pay from their own wallet: the button that
 * opens it, a QR code for paying from another device, the invoice text with
 * a way to copy it, and how long it has left.
 *
 * Calls `onExpired` once the quote lapses, so the screen can swap the dead
 * QR for a way to get a new one. The server only marks it expired a moment
 * later.
 */

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { openAppLink } from './openLink';
import { Button } from './primitives';
import { QrCode } from './QrCode';
import { copyText } from './share';
import { makeStyles, radius, space, type } from './theme';

export function InvoicePanel({
  invoice,
  expiresAt,
  onExpired,
  qrSize = 200,
  sats,
}: {
  invoice: string;
  expiresAt?: string;
  onExpired?: () => void;
  qrSize?: number;
  /** The debt is in sats already, so the countdown is the invoice's alone: no rate was locked. */
  sats?: boolean;
}) {
  const s = useStyles();
  const left = useSecondsLeft(expiresAt);

  useEffect(() => {
    if (left === 0) onExpired?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left === 0]);

  return (
    <View style={s.panel}>
      <Button label="Open your wallet" variant="primary" onPress={() => openAppLink(`lightning:${invoice}`).catch(() => {})} />
      <Text style={s.hint}>Or scan this from Phoenix, Wallet of Satoshi, Zeus, Blink — any Lightning wallet.</Text>
      <View style={s.qrFrame}>
        <QrCode value={`lightning:${invoice}`} size={qrSize} />
      </View>
      <Text style={s.invoice} numberOfLines={2} selectable>
        {invoice}
      </Text>
      <CopyInvoice invoice={invoice} />
      {left !== null && left > 0 && (
        <Text style={s.countdown}>
          {sats ? 'Invoice good for' : 'Rate and invoice locked for'} {formatClock(left)}
        </Text>
      )}
    </View>
  );
}

/**
 * Copies the whole invoice, for a wallet that can't be opened from here or
 * is on another device. The text on screen is cut to two lines, so selecting
 * it by hand wouldn't get all of it.
 */
export function CopyInvoice({ invoice }: { invoice: string }) {
  const s = useStyles();
  const [note, setNote] = useState<string | null>(null);
  // A new invoice hasn't been copied yet.
  useEffect(() => setNote(null), [invoice]);
  return (
    <>
      <Button label="Copy invoice" onPress={async () => setNote(await copyText(invoice))} />
      {note && <Text style={s.hint}>{note}</Text>}
    </>
  );
}

/** Whole seconds until `iso`, ticking once a second; null when there's no deadline. */
export function useSecondsLeft(iso: string | undefined) {
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
  panel: { alignItems: 'stretch', gap: space.sm },
  hint: { ...type.caption, color: color.inkMuted, textAlign: 'center' },
  // QR needs a light ground and a quiet zone; the code draws its own margin.
  qrFrame: { alignSelf: 'center', borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#FFFFFF' },
  invoice: { ...type.amountSm, color: color.inkFaint, textAlign: 'center' },
  countdown: { ...type.caption, color: color.inkMuted, textAlign: 'center' },
}));
