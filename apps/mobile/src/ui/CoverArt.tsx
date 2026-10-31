/**
 * What's drawn on a group's cover band: two rounded shapes in the cover's
 * lighter and darker shade, and a dotted zigzag, so the band reads as the
 * group's own and not a plain bar. Laid over the band, behind what's on it.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import type { Cover } from './theme';

export function CoverArt({ cover }: { cover: Cover }) {
  return (
    <Svg
      style={StyleSheet.absoluteFill}
      width="100%"
      height="100%"
      viewBox="0 0 390 230"
      preserveAspectRatio="xMaxYMin slice"
      pointerEvents="none"
    >
      <Rect x={230} y={-40} width={210} height={150} rx={22} fill={cover.light} rotation={18} origin="335, 35" />
      <Rect x={262} y={70} width={190} height={140} rx={22} fill={cover.dark} rotation={-12} origin="357, 140" />
      <Path
        d="M-20 206 L40 174 L100 206 L160 174 L220 206 L280 174 L340 206 L400 174"
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity={0.3}
        strokeWidth={2}
        strokeDasharray="2 8"
        strokeLinecap="round"
      />
    </Svg>
  );
}
