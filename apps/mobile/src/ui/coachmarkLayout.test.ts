import { describe, expect, it } from 'vitest';

import {
  CARD_MAX,
  GAP,
  MARGIN,
  arrowBetween,
  blockersAround,
  boxAround,
  cardBounds,
  cardWidth,
  holeAround,
  holeRadius,
  layOut,
  overlaps,
  placeCard,
  scrimPath,
  type Rect,
} from './coachmarkLayout';

/** A Pixel 7 in a browser, as the browser tests have it. */
const phone = { width: 412, height: 839 };
const root: Rect = { x: 0, y: 0, ...phone };
const bounds = cardBounds(root, { top: 0, bottom: 0 });
const card = { width: cardWidth(phone.width), height: 180 };
const bottom = (r: Rect) => r.y + r.height;
const right = (r: Rect) => r.x + r.width;

/** Where the card is, as a rectangle. */
const cardAt = (hole: Rect | null, size = card) => {
  const p = placeCard(hole, size, bounds);
  return { ...p, rect: { x: p.x, y: p.y, ...size } };
};

describe('cardBounds and cardWidth', () => {
  it('keeps the card off every edge, and clear of the status bar and the home indicator', () => {
    expect(cardBounds({ x: 340, y: 0, width: 720, height: 900 }, { top: 24, bottom: 34 })).toEqual({
      x: 340 + MARGIN,
      y: 24 + MARGIN,
      width: 720 - 2 * MARGIN,
      height: 900 - 24 - 34 - 2 * MARGIN,
    });
  });

  it('is the width of a phone’s column, up to CARD_MAX', () => {
    expect(cardWidth(360)).toBe(360 - 2 * MARGIN);
    expect(cardWidth(412)).toBe(CARD_MAX);
    expect(cardWidth(720)).toBe(CARD_MAX);
  });
});

describe('holeAround', () => {
  it('leaves room all round the target', () => {
    expect(holeAround({ x: 100, y: 200, width: 80, height: 44 }, 6, phone)).toEqual({ x: 94, y: 194, width: 92, height: 56 });
  });

  it('stays on the screen for a target that runs off it', () => {
    const hole = holeAround({ x: -20, y: 800, width: 100, height: 80 }, 6, phone);
    expect(hole).toEqual({ x: 0, y: 794, width: 86, height: phone.height - 794 });
  });
});

describe('holeRadius', () => {
  it('is what the step asks for, but never more than half the hole: a big one makes a pill', () => {
    expect(holeRadius({ width: 300, height: 64 })).toBe(14);
    expect(holeRadius({ width: 300, height: 64 }, 22)).toBe(22);
    expect(holeRadius({ width: 100, height: 56 }, 999)).toBe(28);
    expect(holeRadius({ width: 20, height: 56 }, 999)).toBe(10);
  });
});

describe('placeCard', () => {
  it('goes under the hole when there’s room, with all the arrow wants between them', () => {
    const hole = { x: 20, y: 200, width: 372, height: 160 };
    const { side, gap, rect } = cardAt(hole);
    expect(side).toBe('below');
    expect(gap).toBe(GAP.want);
    expect(rect.y).toBe(bottom(hole) + GAP.want);
  });

  it('goes over it when there isn’t room under it', () => {
    const hole = { x: 20, y: 600, width: 372, height: 64 };
    const { side, gap, rect } = cardAt(hole);
    expect(side).toBe('above');
    expect(gap).toBe(GAP.want);
    expect(bottom(rect)).toBe(hole.y - GAP.want);
  });

  it('takes the side with more room when neither has all the arrow wants', () => {
    // A small phone: 640 tall, and the hole in the middle.
    const small = cardBounds({ x: 0, y: 0, width: 360, height: 640 }, { top: 0, bottom: 0 });
    const hole = { x: 20, y: 250, width: 320, height: 100 };
    const p = placeCard(hole, { width: 328, height: 240 }, small);
    // Under: 640 - 16 - 350 - 240 = 34 to spare. Over: 250 - 16 - 240 = -6.
    expect(p.side).toBe('below');
    expect(p.gap).toBe(34);
    expect(p.gap).toBeGreaterThanOrEqual(GAP.least);
  });

  it('is centred on the hole, and kept on the screen beside one at the edge', () => {
    const wide = cardBounds({ x: 0, y: 0, width: 1400, height: 900 }, { top: 0, bottom: 0 });
    const middle = placeCard({ x: 600, y: 100, width: 200, height: 40 }, { width: 360, height: 150 }, wide);
    expect(middle.x + 180).toBe(700);
    const edge = placeCard({ x: 1300, y: 100, width: 90, height: 40 }, { width: 360, height: 150 }, wide);
    expect(edge.x).toBe(1400 - MARGIN - 360);
    const start = placeCard({ x: 0, y: 100, width: 40, height: 40 }, { width: 360, height: 150 }, wide);
    expect(start.x).toBe(MARGIN);
  });

  it('never covers the hole when the card fits on either side of it', () => {
    for (let y = 0; y + 60 <= phone.height; y += 17) {
      for (const height of [44, 60]) {
        const hole = { x: 24, y, width: 364, height };
        const fits = y - bounds.y >= card.height || bottom(bounds) - (y + height) >= card.height;
        if (!fits) continue;
        const { rect } = cardAt(hole);
        expect(overlaps(rect, hole), `hole at ${y}`).toBe(false);
        expect(rect.y).toBeGreaterThanOrEqual(bounds.y);
        expect(bottom(rect)).toBeLessThanOrEqual(bottom(bounds));
      }
    }
  });

  it('sits in the middle when there’s nothing to point at', () => {
    const p = placeCard(null, card, bounds);
    expect(p.side).toBe('middle');
    expect(p.y).toBe(bounds.y + (bounds.height - card.height) / 2);
  });

  it('says when it can’t help covering the hole', () => {
    expect(cardAt({ x: 20, y: 300, width: 372, height: 60 }).clear).toBe(true);
    const tall = placeCard({ x: 20, y: 150, width: 372, height: 500 }, card, bounds);
    expect(tall.clear).toBe(false);
    expect(tall.gap).toBe(0);
  });
});

describe('layOut', () => {
  // The split card on Add expense, and Split differently at its foot.
  const size = { width: 328, height: 220 };
  const whole = { x: 20, y: 188, width: 320, height: 192 };
  const link = { x: 20, y: 336, width: 320, height: 44 };

  it('spotlights the whole target when the card fits beside it with room for the arrow', () => {
    const tall = cardBounds({ x: 0, y: 0, width: 412, height: 780 }, { top: 0, bottom: 0 });
    const l = layOut([whole, link], 6, size, tall, phone);
    expect(l.target).toBe(0);
    expect(l.hole).toEqual(holeAround(whole, 6, phone));
    expect(l.card.side).toBe('below');
  });

  it('narrows to the part that matters when the card would cover the whole of it', () => {
    // A 360 by 640 phone: the card fits neither under the whole split card nor over it.
    const small = cardBounds({ x: 0, y: 0, width: 360, height: 584 }, { top: 0, bottom: 0 });
    expect(placeCard(holeAround(whole, 6, phone), size, small).clear).toBe(false);
    const l = layOut([whole, link], 6, size, small, phone);
    expect(l.target).toBe(1);
    expect(l.card.side).toBe('above');
    expect(l.card.gap).toBeGreaterThanOrEqual(GAP.least);
    expect(overlaps({ x: l.card.x, y: l.card.y, ...size }, l.hole!)).toBe(false);
  });

  it('takes the last when the card fits beside none of them, and the middle with no target', () => {
    const huge = { width: 328, height: 700 };
    expect(layOut([whole, link], 6, huge, bounds, phone).target).toBe(1);
    const none = layOut([null], 6, size, bounds, phone);
    expect(none.hole).toBeNull();
    expect(none.card.side).toBe('middle');
  });
});

describe('arrowBetween', () => {
  const hole = { x: 26, y: 300, width: 360, height: 60 };
  const below = cardAt(hole).rect;
  const high = { x: 26, y: 640, width: 360, height: 60 };
  const above = cardAt(high).rect;

  it('runs from just off the top of a card under the hole to just under the hole', () => {
    const a = arrowBetween(hole, below, 'below');
    expect(a.start.y).toBeLessThan(below.y);
    expect(below.y - a.start.y).toBeLessThanOrEqual(8);
    expect(a.tip.y).toBeGreaterThan(bottom(hole));
    expect(a.tip.y - bottom(hole)).toBeLessThanOrEqual(12);
    expect(a.tip.x).toBeGreaterThan(hole.x);
    expect(a.tip.x).toBeLessThan(right(hole));
  });

  it('runs from the bottom of a card over the hole down to just over it', () => {
    const a = arrowBetween(high, above, 'above');
    expect(a.start.y).toBeGreaterThan(bottom(above));
    expect(a.tip.y).toBeLessThan(high.y);
    expect(high.y - a.tip.y).toBeLessThanOrEqual(12);
  });

  it('arrives pointing into the hole, nearly upright, with its head opening back along the line', () => {
    for (const [h, c, side] of [
      [hole, below, 'below'],
      [high, above, 'above'],
    ] as const) {
      const a = arrowBetween(h, c, side);
      // Up into a hole over the card, down into one under it.
      expect(Math.sign(a.direction.y)).toBe(side === 'below' ? -1 : 1);
      expect(Math.abs(a.direction.y)).toBeGreaterThan(Math.abs(a.direction.x));
      for (const w of a.wings) {
        // Each stroke of the head is behind the tip, along the way the line came.
        const back = (w.x - a.tip.x) * a.direction.x + (w.y - a.tip.y) * a.direction.y;
        expect(back).toBeLessThan(0);
      }
      // The two strokes open to either side of the line.
      const cross = (p: { x: number; y: number }) => (p.x - a.tip.x) * a.direction.y - (p.y - a.tip.y) * a.direction.x;
      expect(Math.sign(cross(a.wings[0]))).toBe(-Math.sign(cross(a.wings[1])));
    }
  });

  it('is a curve, not a stick: it starts off to one side of where it lands', () => {
    const a = arrowBetween(hole, below, 'below');
    expect(Math.abs(a.start.x - a.tip.x)).toBeGreaterThanOrEqual(12);
    // Longer than the straight line between its ends, and not by much.
    const straight = Math.hypot(a.start.x - a.tip.x, a.start.y - a.tip.y);
    expect(a.length).toBeGreaterThan(straight);
    expect(a.length).toBeLessThan(straight * 1.3);
  });

  it('starts on the card for a hole at the far edge of the screen', () => {
    for (const x of [16, 330]) {
      const pill = { x, y: 100, width: 66, height: 56 };
      const c = cardAt(pill).rect;
      const a = arrowBetween(pill, c, 'below');
      expect(a.start.x).toBeGreaterThanOrEqual(c.x + 24);
      expect(a.start.x).toBeLessThanOrEqual(right(c) - 24);
      expect(a.tip.x).toBeGreaterThan(pill.x);
      expect(a.tip.x).toBeLessThan(right(pill));
    }
  });

  it('has a box that holds all of it, between the hole and the card', () => {
    const a = arrowBetween(hole, below, 'below');
    for (const p of [a.start, a.tip, a.control, ...a.wings]) {
      expect(p.x).toBeGreaterThanOrEqual(a.box.x);
      expect(p.x).toBeLessThanOrEqual(right(a.box));
      expect(p.y).toBeGreaterThanOrEqual(a.box.y);
      expect(p.y).toBeLessThanOrEqual(bottom(a.box));
    }
    expect(overlaps(a.box, hole)).toBe(false);
    expect(overlaps(a.box, below)).toBe(false);
  });
});

describe('boxAround', () => {
  it('is the smallest box round the points, grown by the pad', () => {
    expect(
      boxAround(
        [
          { x: 10, y: 40 },
          { x: 30, y: 5 },
        ],
        2
      )
    ).toEqual({ x: 8, y: 3, width: 24, height: 39 });
  });
});

describe('scrimPath', () => {
  /** What Animated's string interpolation keeps fixed: everything but the numbers. */
  const shape = (d: string) => d.replace(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g, '#');

  it('is the whole screen, then the hole as a rounded rectangle inside it', () => {
    const d = scrimPath(phone, { x: 20, y: 100, width: 200, height: 50 }, 12);
    expect(d.startsWith('M0 0H412V839H0Z')).toBe(true);
    expect(d).toContain('M32 100H208A12 12 0 0 1 220 112V138');
    expect(d.endsWith('Z')).toBe(true);
  });

  it('has the same shape whatever the hole, so one step’s can be animated into the next', () => {
    const a = scrimPath(phone, { x: 20, y: 100, width: 200, height: 50 }, 12);
    const b = scrimPath(phone, { x: 300.25, y: 7.5, width: 66, height: 56 }, 999);
    const none = scrimPath(phone, null, 0);
    const flat = scrimPath(phone, { x: 20, y: 100, width: 200, height: 50 }, 0);
    expect(shape(b)).toBe(shape(a));
    expect(shape(none)).toBe(shape(a));
    expect(shape(flat)).toBe(shape(a));
    expect(a).not.toContain('e-');
    expect(none).not.toMatch(/-0\b/);
  });
});

describe('blockersAround', () => {
  const area = (r: Rect) => r.width * r.height;

  it('covers everything but the hole, and nothing of it', () => {
    const hole = { x: 30, y: 200, width: 120, height: 56 };
    const blockers = blockersAround(phone, hole);
    expect(blockers).toHaveLength(4);
    for (const b of blockers) expect(overlaps(b, hole)).toBe(false);
    const covered = blockers.reduce((sum, b) => sum + area(b), 0);
    expect(covered).toBe(phone.width * phone.height - area(hole));
  });

  it('covers all of it when there’s no hole', () => {
    expect(blockersAround(phone, null)).toEqual([{ x: 0, y: 0, ...phone }]);
  });
});
