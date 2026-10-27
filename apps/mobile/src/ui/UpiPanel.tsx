/**
 * What to pay over UPI, and the way to do it that this device has.
 *
 *   Android   the phone's UPI apps, each a button. The one tapped is opened on
 *             the link and reports back, or, when it refuses links, has the
 *             UPI ID copied for it (useSettleFlow payWith). A build without
 *             the native module gets the iPhone's button instead
 *   iPhone    a button that opens a UPI app, which says nothing back
 *   web       a QR code to scan from a phone, and on a phone's browser the
 *             same button
 *
 * The UPI ID is on screen everywhere, with Copy beside it, so it can be
 * pasted into a UPI app by hand whatever opens.
 *
 * The icons are the phone's own, read from each installed app the way
 * Android's chooser reads them. Nothing of those apps' ships in this one.
 */

import React, { useState } from 'react';
import { Image, Platform, Pressable, Text, View } from 'react-native';

import type { UpiPayee } from '@sattle/core';
import type { UpiApp } from '../upi/upiApps';
import { openAppLink } from './openLink';
import { Button, IconButton } from './primitives';
import { QrCode } from './QrCode';
import { copyText } from './share';
import { makeStyles, radius, space, type } from './theme';

/** A phone's browser can open a UPI app from a link; a computer's can't, and scans instead. */
const onPhoneBrowser = () =>
  Platform.OS === 'web' && typeof navigator !== 'undefined' && /Android|iPhone|iPad/i.test(navigator.userAgent);

export function UpiPanel({
  payee,
  uri,
  busy,
  apps,
  onPay,
  onOpened,
}: {
  payee: UpiPayee;
  uri: string;
  busy?: boolean;
  /** Android: the UPI apps on the phone, one button each. Null or absent: the one button that opens whatever takes the link. */
  apps?: UpiApp[] | null;
  /** Android: pays in the app tapped, or in the phone's pick of one when there is no list. Absent elsewhere: the link is just opened. */
  onPay?: (app: UpiApp | null) => void;
  /**
   * Elsewhere: the link is being handed to a UPI app, which will say nothing back. Whoever shows
   * this can ask the payer what happened once they return (useBackFromUpi).
   */
  onOpened?: () => void;
}) {
  const s = useStyles();
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const web = Platform.OS === 'web';

  const open = () => {
    if (onPay) return onPay(null);
    setFailed(false);
    // Before the link goes: in a browser the page can be gone from the foreground the moment it does.
    onOpened?.();
    openAppLink(uri).catch(() => setFailed(true));
  };

  return (
    <View style={s.panel}>
      {web && (
        <>
          <View style={s.qrFrame}>
            <QrCode value={uri} size={200} />
          </View>
          <Text style={s.hint}>Scan with any UPI app.</Text>
        </>
      )}

      <View style={s.idBlock}>
        <View style={s.idText}>
          <Text style={s.idLabel}>{payee.name}’s UPI ID</Text>
          <Text style={s.id} selectable>
            {payee.upiId}
          </Text>
          {copied && <Text style={s.copied}>{copied}</Text>}
        </View>
        <IconButton icon="copy" label="Copy UPI ID" onPress={() => void copyText(payee.upiId).then(setCopied)} />
      </View>

      {apps ? (
        apps.length ? (
          <View style={s.apps}>
            {apps.map((app) => (
              <Pressable
                key={app.packageName}
                disabled={busy}
                onPress={() => onPay?.(app)}
                accessibilityRole="button"
                accessibilityLabel={`Pay with ${app.name}`}
                style={({ pressed }) => [s.app, pressed && { opacity: 0.7 }, busy && { opacity: 0.4 }]}
              >
                {app.icon ? (
                  <Image source={{ uri: app.icon }} style={s.appIcon} />
                ) : (
                  <View style={[s.appIcon, s.appIconBlank]}>
                    <Text style={s.appInitial}>{app.name.slice(0, 1)}</Text>
                  </View>
                )}
                <Text style={s.appName} numberOfLines={2}>
                  {app.name}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={s.hint}>No UPI app here. Pay the UPI ID above from another phone.</Text>
        )
      ) : (
        (!web || onPhoneBrowser()) && (
          <Button label={web ? 'Open a UPI app on this phone' : 'Open UPI app'} variant={web ? 'secondary' : 'primary'} busy={busy} onPress={open} />
        )
      )}
      {failed && <Text style={s.error}>No UPI app opened. Pay the UPI ID above instead.</Text>}
    </View>
  );
}

const useStyles = makeStyles((color) => ({
  panel: { gap: space.sm, marginBottom: space.sm },
  qrFrame: { alignSelf: 'center', padding: space.md, borderRadius: radius.md, backgroundColor: '#FFFFFF' },
  hint: { ...type.caption, color: color.inkFaint, textAlign: 'center' },
  idBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.surfaceSunken,
    borderRadius: radius.md,
    padding: space.md,
  },
  idText: { flex: 1, gap: 2 },
  idLabel: { ...type.caption, color: color.inkFaint },
  id: { ...type.amountMd, color: color.ink },
  copied: { ...type.caption, color: color.inkMuted },
  apps: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  app: { width: 76, alignItems: 'center', gap: space.xs, paddingVertical: space.sm, borderRadius: radius.md },
  appIcon: { width: 48, height: 48, borderRadius: 12 },
  appIconBlank: { backgroundColor: color.surfaceSunken, alignItems: 'center', justifyContent: 'center' },
  appInitial: { ...type.heading, color: color.ink },
  appName: { ...type.caption, color: color.ink, textAlign: 'center' },
  error: { ...type.caption, color: color.danger },
}));
