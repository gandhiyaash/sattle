/**
 * What to pay over UPI, and the way to do it that this device has.
 *
 *   Android   the UPI app is opened for them and reports back (launchUpi), so
 *             this only offers to open it again
 *   iPhone    a button that opens a UPI app, which says nothing back
 *   web       a QR code to scan from a phone, and on a phone's browser the
 *             same button
 *
 * The UPI ID is on screen everywhere, so it can be typed into a UPI app by
 * hand if nothing opens.
 */

import React, { useState } from 'react';
import { Platform, Text, View } from 'react-native';

import type { UpiPayee } from '@sattle/core';
import { openAppLink } from './openLink';
import { Button } from './primitives';
import { QrCode } from './QrCode';
import { makeStyles, radius, space, type } from './theme';

/** A phone's browser can open a UPI app from a link; a computer's can't, and scans instead. */
const onPhoneBrowser = () =>
  Platform.OS === 'web' && typeof navigator !== 'undefined' && /Android|iPhone|iPad/i.test(navigator.userAgent);

export function UpiPanel({
  payee,
  uri,
  busy,
  onOpen,
}: {
  payee: UpiPayee;
  uri: string;
  busy?: boolean;
  /** Android only: opens the UPI app and waits for what it says. Elsewhere the link is just opened. */
  onOpen?: () => void;
}) {
  const s = useStyles();
  const [failed, setFailed] = useState(false);
  const web = Platform.OS === 'web';

  const open = () => {
    if (onOpen) return onOpen();
    setFailed(false);
    openAppLink(uri).catch(() => setFailed(true));
  };

  return (
    <View style={s.panel}>
      {web && (
        <>
          <View style={s.qrFrame}>
            <QrCode value={uri} size={200} />
          </View>
          <Text style={s.hint}>Scan this with GPay, PhonePe, Paytm or any UPI app.</Text>
        </>
      )}

      <View style={s.idBlock}>
        <Text style={s.idLabel}>{payee.name}’s UPI ID</Text>
        <Text style={s.id} selectable>
          {payee.upiId}
        </Text>
      </View>

      {(!web || onPhoneBrowser()) && (
        <Button label={web ? 'Open a UPI app on this phone' : 'Open UPI app'} variant={web ? 'secondary' : 'primary'} busy={busy} onPress={open} />
      )}
      {failed && <Text style={s.error}>No UPI app opened. Pay the UPI ID above from your UPI app.</Text>}
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  panel: { gap: space.sm, marginBottom: space.sm },
  qrFrame: { alignSelf: 'center', padding: space.md, borderRadius: radius.md, backgroundColor: '#FFFFFF' },
  hint: { ...type.caption, color: color.inkFaint, textAlign: 'center' },
  idBlock: { backgroundColor: color.surfaceSunken, borderRadius: radius.md, padding: space.md, gap: 2 },
  idLabel: { ...type.caption, color: color.inkFaint },
  id: { ...type.amountMd, color: color.ink },
  error: { ...type.caption, color: color.danger },
}));
