/**
 * A QR code drawn as one SVG path, so it renders the same on iOS, Android
 * and web.
 *
 * BOLT11 is case-insensitive, and an all-caps `LIGHTNING:LNBC…` fits QR's
 * alphanumeric mode, which needs noticeably fewer modules than byte mode for
 * the same invoice — easier to scan off a laptop screen. Anything with
 * characters outside that set (a Lightning address, say) falls back to bytes.
 */

import qrcode from 'qrcode-generator';
import React, { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';

/** The quiet zone the spec asks for, in modules. */
const MARGIN = 4;
const ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]*$/;

export function QrCode({ value, size = 220 }: { value: string; size?: number }) {
  const { path, count } = useMemo(() => encode(value), [value]);
  const box = count + MARGIN * 2;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${box} ${box}`}>
      <Rect width={box} height={box} fill="#FFFFFF" />
      <Path d={path} fill="#000000" />
    </Svg>
  );
}

function encode(value: string) {
  const upper = value.toUpperCase();
  const qr = qrcode(0, 'M');
  if (ALPHANUMERIC.test(upper)) qr.addData(upper, 'Alphanumeric');
  else qr.addData(value, 'Byte');
  qr.make();

  const count = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; ) {
      if (!qr.isDark(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < count && qr.isDark(row, col)) col++;
      path += `M${start + MARGIN} ${row + MARGIN}h${col - start}v1h-${col - start}z`;
    }
  }
  return { path, count };
}
