/**
 * Where a tip's pieces go (Coachmarks.tsx): the hole in the dim around what
 * the tip is about, the card with its words, and the arrow drawn from one to
 * the other. Nothing here imports React Native, so it runs under vitest.
 *
 * Everything is in the window's coordinates, as measureInWindow gives them,
 * with the window's top left at 0, 0.
 *
 * The rules are the ones a person would follow drawing it by hand: the card
 * goes under what it's about when there's room, since that's where the eye
 * goes next, and over it when there isn't; it never sits on top of it; and
 * the arrow leaves the card's edge, bows a little, and lands just short of
 * the hole, pointing in.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

/** Which side of the hole the card is on. `middle` is a card with nothing to point at. */
export type Side = 'below' | 'above' | 'middle';

/** How far the card keeps from the edges of the screen. */
export const MARGIN = 16;
/** As wide as the card gets, on a tablet or in a laptop's column. */
export const CARD_MAX = 360;
/** The room the arrow wants between the hole and the card, and the least it is drawn in. */
export const GAP = { want: 72, least: 32 } as const;
/** How far short of the hole the arrow's tip stops, so it doesn't run into the ring around it. */
const TIP_GAP = 10;
/** How far off the card's edge the arrow starts. */
const START_GAP = 6;
/** The arrowhead: how long each stroke is, and how far each opens from the line. */
const HEAD = { length: 11, angle: (28 * Math.PI) / 180 } as const;

export const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

/** Where the card may go: the overlay's own rectangle, less the margin and what the status bar and home indicator take. */
export function cardBounds(root: Rect, insets: { top: number; bottom: number }): Rect {
  return {
    x: root.x + MARGIN,
    y: root.y + insets.top + MARGIN,
    width: Math.max(0, root.width - 2 * MARGIN),
    height: Math.max(0, root.height - insets.top - insets.bottom - 2 * MARGIN),
  };
}

/** The card's width: the column a phone has, up to CARD_MAX. */
export const cardWidth = (rootWidth: number) => Math.max(0, Math.min(rootWidth - 2 * MARGIN, CARD_MAX));

/**
 * The hole: the target with `pad` of room around it, kept inside the stage,
 * so a target half off the screen still gets a hole that's all on it.
 */
export function holeAround(target: Rect, pad: number, stage: Size): Rect {
  const x = clamp(target.x - pad, 0, stage.width);
  const y = clamp(target.y - pad, 0, stage.height);
  const right = clamp(target.x + target.width + pad, x, stage.width);
  const bottom = clamp(target.y + target.height + pad, y, stage.height);
  return { x, y, width: right - x, height: bottom - y };
}

/** The hole's corner: what the step asks for, or round ends on anything shorter than that is tall. */
export const holeRadius = (hole: Size, wanted = 14) => Math.max(0, Math.min(wanted, hole.width / 2, hole.height / 2));

export interface Placement extends Point {
  side: Side;
  /** The room left between the hole and the card, which is the arrow's. */
  gap: number;
  /** Whether the card leaves the hole uncovered. */
  clear: boolean;
}

/**
 * Where the card goes. Under the hole if the arrow gets all the room it wants
 * there, else over it if it does there, else whichever side leaves the arrow
 * more. Across, it's centred on the hole and kept inside `bounds`. A card
 * that fits nowhere is kept on the screen, even if that covers the hole:
 * words that can be read beat a hole that can be seen.
 */
export function placeCard(hole: Rect | null, card: Size, bounds: Rect, gap: { want: number } = GAP): Placement {
  const middle = hole ? hole.x + hole.width / 2 : bounds.x + bounds.width / 2;
  const x = clamp(middle - card.width / 2, bounds.x, bounds.x + bounds.width - card.width);
  if (!hole) return { x, y: bounds.y + Math.max(0, (bounds.height - card.height) / 2), side: 'middle', gap: 0, clear: true };
  // What each side has left over once the card is in it.
  const below = bounds.y + bounds.height - (hole.y + hole.height) - card.height;
  const above = hole.y - bounds.y - card.height;
  const side = below >= gap.want ? 'below' : above >= gap.want ? 'above' : below >= above ? 'below' : 'above';
  const spare = side === 'below' ? below : above;
  const room = clamp(spare, 0, gap.want);
  const y = side === 'below' ? hole.y + hole.height + room : hole.y - room - card.height;
  return { x, y: clamp(y, bounds.y, bounds.y + bounds.height - card.height), side, gap: room, clear: spare >= 0 };
}

export interface Layout {
  hole: Rect | null;
  card: Placement;
  /** Which of the targets it's for. */
  target: number;
}

/**
 * The hole and the card for the first of `targets` the card fits beside
 * with room for the arrow; failing that, the first it fits beside at all;
 * failing that, the last. Give them widest first: a whole card, then the one
 * link on it that matters, so a small screen still gets a hole the card
 * doesn't cover and an arrow to it.
 */
export function layOut(targets: Array<Rect | null>, pad: number, card: Size, bounds: Rect, stage: Size): Layout {
  const all = (targets.length ? targets : [null]).map((t, target) => {
    const hole = t ? holeAround(t, pad, stage) : null;
    return { hole, card: placeCard(hole, card, bounds), target };
  });
  return (
    all.find((l) => l.card.clear && l.card.gap >= GAP.least) ?? all.find((l) => l.card.clear) ?? all[all.length - 1]!
  );
}

export interface Arrow {
  /** The line: a quadratic curve from the card's edge to just short of the hole. */
  path: string;
  /** The head's two strokes, meeting at the tip. */
  head: string;
  /** The line's length, near enough, for drawing it in with a dash. */
  length: number;
  start: Point;
  control: Point;
  tip: Point;
  /** The far ends of the head's two strokes. */
  wings: [Point, Point];
  /** Which way the line is going as it reaches the tip, as a unit vector. */
  direction: Point;
  /** All of it, with room for the stroke: where it's drawn, and what a test can find. */
  box: Rect;
}

/** How thick the arrow is drawn. */
export const STROKE = 2.5;

/**
 * The arrow from the card to the hole. It lands under (or over) the middle
 * of the hole and starts on the card's edge a little to one side, toward the
 * card's middle, so it is a curve rather than a stick: it leaves the card at
 * a slant and turns to come in nearly straight, the way a pen would. The
 * head is drawn along the line's last direction, so it points where the
 * line was going.
 */
export function arrowBetween(hole: Rect, card: Rect, side: 'below' | 'above'): Arrow {
  const below = side === 'below';
  const inset = Math.min(TIP_GAP, hole.width / 2);
  const tip = {
    x: clamp(hole.x + hole.width / 2, hole.x + inset, hole.x + hole.width - inset),
    y: below ? hole.y + hole.height + TIP_GAP : hole.y - TIP_GAP,
  };
  const startY = below ? card.y - START_GAP : card.y + card.height + START_GAP;
  const rise = Math.abs(startY - tip.y);
  // Sideways by about as much as it rises: enough to curve, not so much it lies down.
  const swing = clamp(rise * 0.8, 18, 56);
  const lo = card.x + 24;
  const hi = card.x + card.width - 24;
  const toward = tip.x <= card.x + card.width / 2 ? 1 : -1;
  let startX = clamp(tip.x + toward * swing, lo, hi);
  // Pinned against the card's end, it would come straight up: go the other way instead.
  if (Math.abs(startX - tip.x) < 12) startX = clamp(tip.x - toward * swing, lo, hi);
  const start = { x: startX, y: startY };
  // Near the tip, a little to the start's side: the line leaves at a slant and arrives nearly upright.
  const control = { x: tip.x + (start.x - tip.x) * 0.25, y: tip.y + (start.y - tip.y) * 0.7 };
  const direction = unit({ x: tip.x - control.x, y: tip.y - control.y });
  const back = { x: -direction.x, y: -direction.y };
  const wing = (turn: number) => {
    const d = rotate(back, turn);
    return { x: tip.x + d.x * HEAD.length, y: tip.y + d.y * HEAD.length };
  };
  const wings: [Point, Point] = [wing(HEAD.angle), wing(-HEAD.angle)];
  const [left, right] = wings;
  return {
    path: `M${n(start.x)} ${n(start.y)}Q${n(control.x)} ${n(control.y)} ${n(tip.x)} ${n(tip.y)}`,
    head: `M${n(left.x)} ${n(left.y)}L${n(tip.x)} ${n(tip.y)}L${n(right.x)} ${n(right.y)}`,
    length: quadLength(start, control, tip),
    start,
    control,
    tip,
    wings,
    direction,
    // A quadratic curve stays inside the triangle of its three points, so their box holds it.
    box: boxAround([start, control, tip, left, right], STROKE),
  };
}

/** The smallest rectangle holding every point, grown by `pad` all round. */
export function boxAround(points: Point[], pad = 0): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y };
}

/**
 * The dim: the whole stage, with the hole cut out of it as a rounded
 * rectangle. Drawn with fillRule evenodd, the hole is a hole whichever way
 * each part runs. With no hole there's still one, of no size, so that every
 * path this makes has the same shape and one can be animated into another.
 */
export function scrimPath(stage: Size, hole: Rect | null, radius: number): string {
  const h = hole ?? { x: stage.width / 2, y: stage.height / 2, width: 0, height: 0 };
  return `M0 0H${n(stage.width)}V${n(stage.height)}H0Z${roundedRect(h, radius)}`;
}

/** A rounded rectangle, always as four sides and four corners, however small the corners are. */
export function roundedRect({ x, y, width, height }: Rect, radius: number): string {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const corner = (toX: number, toY: number) => `A${n(r)} ${n(r)} 0 0 1 ${n(toX)} ${n(toY)}`;
  return (
    `M${n(x + r)} ${n(y)}H${n(x + width - r)}${corner(x + width, y + r)}` +
    `V${n(y + height - r)}${corner(x + width - r, y + height)}` +
    `H${n(x + r)}${corner(x, y + height - r)}` +
    `V${n(y + r)}${corner(x + r, y)}Z`
  );
}

/**
 * The four rectangles around the hole that together cover the rest of the
 * stage: above it and below it the whole width, and either side of it. A tap
 * on any of them goes nowhere; a tap in the hole reaches what's under it.
 */
export function blockersAround(stage: Size, hole: Rect | null): Rect[] {
  if (!hole) return [{ x: 0, y: 0, width: stage.width, height: stage.height }];
  const bottom = hole.y + hole.height;
  const right = hole.x + hole.width;
  return [
    { x: 0, y: 0, width: stage.width, height: hole.y },
    { x: 0, y: bottom, width: stage.width, height: Math.max(0, stage.height - bottom) },
    { x: 0, y: hole.y, width: hole.x, height: hole.height },
    { x: right, y: hole.y, width: Math.max(0, stage.width - right), height: hole.height },
  ];
}

/** Whether two rectangles share any area. Touching edges don't count. */
export const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** A number for a path: to a tenth of a point, which is finer than a screen draws, and never "-0". */
function n(v: number): string {
  const r = Math.round(v * 10) / 10;
  return String(r === 0 ? 0 : r);
}

function unit(v: Point): Point {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

function rotate(v: Point, by: number): Point {
  const c = Math.cos(by);
  const s = Math.sin(by);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** A quadratic curve's length, from enough straight pieces that the error is far under a point. */
function quadLength(a: Point, c: Point, b: Point): number {
  const at = (t: number) => ({
    x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x,
    y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y,
  });
  let length = 0;
  let last = a;
  for (let i = 1; i <= 32; i++) {
    const p = at(i / 32);
    length += Math.hypot(p.x - last.x, p.y - last.y);
    last = p;
  }
  return length;
}
