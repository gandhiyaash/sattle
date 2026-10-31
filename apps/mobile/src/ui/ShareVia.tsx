/**
 * Sending a message from whatever app someone uses: WhatsApp, their text
 * messages, the clipboard, or the phone's own share sheet for anything else.
 * Not everyone has WhatsApp, so it is one way of four, never the only one.
 *
 * Nothing is sent by Sattle. Each way opens an app with the message in it,
 * and the person sends it, or not, from there.
 */

import React from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';

import { analytics } from '../analytics/analytics';
import { Glyph, type GlyphName } from './primitives';
import { copyText, sendOrCopy } from './share';
import { makeStyles, space, useColors } from './theme';

export type Via = 'whatsapp' | 'text' | 'copy' | 'more';

const WAYS: ReadonlyArray<{ via: Via; label: string; glyph: GlyphName }> = [
  { via: 'whatsapp', label: 'WhatsApp', glyph: 'chat' },
  { via: 'text', label: 'Text', glyph: 'text' },
  { via: 'copy', label: 'Copy', glyph: 'copy' },
  { via: 'more', label: 'More', glyph: 'share' },
];

/**
 * The four ways, side by side. `copy` is what Copy puts on the clipboard, when
 * that should be less than the whole message: a link on its own. `onDone` is
 * told which way was used and gets a line saying what happened.
 */
export function ShareVia({
  message,
  copy,
  label,
  onDone,
}: {
  message: string;
  copy?: string;
  /** What the row is for, for a screen reader: "Send with". */
  label: string;
  onDone: (via: Via, note: string) => void;
}) {
  const color = useColors();
  const s = useStyles();
  const fill: Record<Via, [string, string]> = {
    whatsapp: ['#1F7A4D', '#FFFFFF'],
    text: [color.accent, color.onAccent],
    copy: [color.surfaceSunken, color.ink],
    more: [color.surfaceSunken, color.ink],
  };

  const send = async (via: Via) => {
    analytics.tap(via, { control: 'share' });
    const text = encodeURIComponent(message);
    switch (via) {
      case 'whatsapp':
        await open(Platform.OS === 'web' ? `https://wa.me/?text=${text}` : `whatsapp://send?text=${text}`, `https://wa.me/?text=${text}`);
        return onDone(via, 'WhatsApp opened with the message.');
      case 'text':
        await open(`sms:?&body=${text}`);
        return onDone(via, 'Messages opened with the message.');
      case 'copy': {
        const note = await copyText(copy ?? message);
        return onDone(via, note === 'Copied.' ? 'Copied. Paste it into any chat.' : note);
      }
      case 'more': {
        const outcome = await sendOrCopy(message);
        return onDone(
          via,
          outcome === 'sent'
            ? 'Sent.'
            : outcome === 'copied'
              ? 'Copied. Paste it into any chat.'
              : outcome === 'not-sent'
                ? 'Not sent.'
                : 'Couldn’t open the share menu here. Try Copy.'
        );
      }
    }
  };

  return (
    <View style={s.row} accessibilityRole="toolbar" accessibilityLabel={label}>
      {WAYS.map((w) => (
        <Pressable
          key={w.via}
          onPress={() => void send(w.via)}
          accessibilityRole="button"
          accessibilityLabel={w.label}
          style={({ pressed }) => [s.way, pressed && { opacity: 0.7 }]}
        >
          <View style={[s.circle, { backgroundColor: fill[w.via][0] }]}>
            <Glyph name={w.glyph} ink={fill[w.via][1]} size={22} weight={1.9} />
          </View>
          <Text style={s.label}>{w.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Opens another app's link. On the web, a new tab for a web address and the page itself for an app's scheme. */
async function open(url: string, fallback?: string) {
  if (Platform.OS === 'web') {
    if (url.startsWith('http')) window.open(url, '_blank', 'noopener');
    else window.location.href = url;
    return;
  }
  try {
    await Linking.openURL(url);
  } catch {
    if (fallback) await Linking.openURL(fallback).catch(() => {});
  }
}

const useStyles = makeStyles((color) => ({
  row: { flexDirection: 'row', gap: space.sm },
  way: { flex: 1, minHeight: 80, alignItems: 'center', justifyContent: 'center', gap: 6 },
  circle: { width: 48, height: 48, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 13, fontWeight: '500', color: color.ink },
}));
