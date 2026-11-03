/**
 * A tip drawn over the screen about one thing on it. Everything else is
 * dimmed; the thing itself shows through a hole in the dim, ringed in the
 * accent; and a card says what it's for, with an arrow drawn from the card
 * to the hole, so there's no doubt which thing the words mean. A tour is a
 * few of these in a row, with Skip, Back and Next.
 *
 * What shows through the hole is the real thing, not a picture of it: a tap
 * in the hole reaches it, so a step can ask for a tap and see it done. A tap
 * anywhere else lands on one of four clear blockers around the hole and goes
 * nowhere, so nothing else is changed by accident.
 *
 * Where things are comes from measureInWindow, and the overlay measures
 * itself the same way and is drawn from the window's corner. That's what
 * keeps it right inside a sheet, whose Modal is a window of its own on
 * Android: the overlay and what it points at are measured in the same one.
 * It also lets the dim run past the overlay to the window's edges, so a tip
 * over a screen in a laptop's middle column dims the whole window.
 *
 * Something still sliding in, like a sheet, isn't pointed at until it has
 * stopped moving: the first step waits `delay`, then measures until three
 * readings in a row agree. After that the hole travels from each step to the next,
 * the card fades in beside it, and the arrow draws itself in. While it's up
 * it measures again every half second and follows anything that moved. With
 * Reduce Motion on, nothing pulses, travels or draws itself in.
 *
 * For a screen reader it's a dialog named `label`, and each step's words are
 * read as they change. On a phone what's behind it is out of reach while it's
 * up. In a browser it's a dialog without aria-modal: the sheet it sits in
 * already is one, and the tests find a sheet as the last aria-modal on the
 * page. Its buttons are named for what they do to the tip ("Next tip",
 * "Skip the guide"), so none is taken for a screen's own Next or Skip. The
 * back button and Escape end it, as Skip does, before they close anything
 * under it.
 *
 * In a browser the spotlight, its halo, the arrow and the card carry
 * data-coach, so a test can check where each is drawn against what it points
 * at, and what Reduce Motion leaves out.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { useBack } from './backNavigation';
import {
  GAP,
  MARGIN,
  STROKE,
  arrowBetween,
  blockersAround,
  cardBounds,
  cardWidth,
  holeRadius,
  layOut,
  scrimPath,
  type Arrow,
  type Placement,
  type Rect,
} from './coachmarkLayout';
import { Glyph, Pill } from './primitives';
import { makeStyles, radius, shadow, space, type, useColors } from './theme';

export interface Coachmark {
  /** Tells one step from another. */
  key: string;
  /**
   * What the step is about. It's measured, so give a View that native layout
   * can't flatten away: `collapsable={false}`.
   */
  target: React.RefObject<View | null>;
  /**
   * The part of the target that matters most, spotlit in its place when the
   * card can't sit beside the whole of it with room for the arrow: on a small
   * screen, the link on a card rather than the card.
   */
  narrow?: React.RefObject<View | null>;
  title: string;
  body?: string;
  /** Short lines under the body, each led by a word in bold, like the ways to split. */
  lines?: ReadonlyArray<{ lead: string; text: string }>;
  /** What the person just did in the hole, said back to them, and read out. */
  ack?: string | null;
  /** Room around the target, inside the hole. */
  pad?: number;
  /** The hole's corner. Never more than half its height, so a big number makes a pill. */
  radius?: number;
}

export interface CoachmarksProps {
  steps: ReadonlyArray<Coachmark>;
  /** Which step is showing. The caller moves it, when onAt asks. */
  at: number;
  onAt?: (at: number) => void;
  /** Got it on the last step is `done`; Skip, the back button and Escape are `skipped`. */
  onEnd: (how: 'done' | 'skipped') => void;
  /** For a single tip that asks something: two answers in place of Skip, Back and Next. */
  answers?: { yes: Answer; no: Answer };
  /** How long to wait before the first measure, for something still sliding in. */
  delay?: number;
  /** The first step is on the screen. */
  onShow?: () => void;
  /** What a screen reader calls it. */
  label?: string;
}

interface Answer {
  label: string;
  onPress: () => void;
}

/** Everything one step needs to be drawn, in the window's coordinates. */
interface Frame {
  at: number;
  /** The overlay's own place in the window. */
  root: Rect;
  /** The window, as far as the dim reaches. */
  stage: { width: number; height: number };
  hole: Rect | null;
  radius: number;
  card: Placement & { height: number };
  arrow: Arrow | null;
  /** The hole this step's travels from: the step before's. */
  from: { hole: Rect | null; radius: number } | null;
}

/** The arrow and its head: light, to read on the dim in either mode. */
const INK = '#FFFFFF';
/** How far past the ring its halo grows as it fades. */
const HALO = 9;
/** On the web Animated has no native side; there it runs in JavaScript without being told. */
const native = Platform.OS !== 'web';
const AnimatedPath = Animated.createAnimatedComponent(Path);
/** data-coach in a browser, for the tests (see the top). React Native's types don't have dataSet. */
const mark = (name: 'spotlight' | 'halo' | 'arrow' | 'card') => (native ? null : ({ dataSet: { coach: name } } as object));

export function Coachmarks({ steps, at, onAt, onEnd, answers, delay = 0, onShow, label = 'Tip' }: CoachmarksProps) {
  const color = useColors();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const reduce = useReducedMotion();
  const index = Math.max(0, Math.min(at, steps.length - 1));
  const step = steps[index]!;
  const last = index === steps.length - 1;

  const root = useRef<View>(null);
  const card = useRef<View>(null);
  const [rootWidth, setRootWidth] = useState<number | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  // The same, for the measuring loop, which outlives renders.
  const placed = useRef<Frame | null>(null);
  const latest = useRef({ onEnd, onShow, reduce });
  latest.current = { onEnd, onShow, reduce };

  const width = rootWidth === null ? null : cardWidth(rootWidth);
  const shown = frame !== null;
  // Placed for the step that's asked for. Until it is, the card and the ring wait out of sight.
  const current = frame !== null && frame.at === index;

  const dim = useRef(new Animated.Value(0)).current;
  const cardIn = useRef(new Animated.Value(0)).current;
  const ringIn = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const draw = useRef(new Animated.Value(0)).current;
  // A fresh one for each step, made with the frame that uses it, so the hole never shows a step early.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const travel = useMemo(() => new Animated.Value(0), [frame?.at]);

  // Not before it's showing: a sheet opening registers its own close in the same moment, and the
  // newest one is what the back button reaches, so this waits to be the newer.
  useBack(shown ? () => latest.current.onEnd('skipped') : undefined, true);

  useEffect(() => {
    if (width === null) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const begun = Date.now();
    let reading = '';
    let still = 0;
    const tick = async () => {
      const [r, t, c, n] = await Promise.all([
        measure(root),
        measure(step.target),
        measure(card),
        step.narrow ? measure(step.narrow) : null,
      ]);
      if (!alive) return;
      const prev = placed.current;
      if (r && c) {
        const now = JSON.stringify([r, t, n, c.height].map((v) => (typeof v === 'number' ? v : roundRect(v))));
        still = now === reading ? still + 1 : 0;
        reading = now;
        // The first time, only once it has stopped moving, or has had long enough to.
        if (prev || still >= 2 || Date.now() - begun > 1500) {
          const stage = { width: Math.max(win.width, r.x + r.width), height: Math.max(win.height, r.y + r.height) };
          const size = { width, height: c.height };
          const { hole, card: spot } = layOut(n ? [t, n] : [t], step.pad ?? 6, size, cardBounds(r, insets), stage);
          const arrow =
            hole && spot.side !== 'middle' && spot.gap >= GAP.least ? arrowBetween(hole, { ...spot, ...size }, spot.side) : null;
          const fresh = !prev || prev.at !== index;
          const next: Frame = {
            at: index,
            root: r,
            stage,
            hole,
            radius: hole ? holeRadius(hole, step.radius) : 0,
            card: { ...spot, height: c.height },
            arrow,
            from: fresh ? (prev ? { hole: prev.hole, radius: prev.radius } : null) : prev.from,
          };
          if (fresh || !sameFrame(prev, next)) {
            // Out of sight already (see `current`), so starting them again from nothing shows nothing.
            if (fresh) {
              cardIn.setValue(0);
              ringIn.setValue(0);
              draw.setValue(0);
            }
            placed.current = next;
            setFrame(next);
          }
        }
      }
      timer = setTimeout(tick, placed.current?.at === index ? 500 : 60);
    };
    timer = setTimeout(tick, placed.current ? 0 : delay);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // The step's target and words are what it measures; the rest is where it fits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, step.target, step.narrow, step.ack, step.title, width, win.width, win.height, insets.top, insets.bottom]);

  // A step has been placed: bring it in.
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    const f = placed.current;
    if (!f || shownAt.current === f.at) return;
    const first = shownAt.current === null;
    shownAt.current = f.at;
    const motion = !latest.current.reduce;
    if (first) {
      // The keyboard would cover what it points at.
      Keyboard.dismiss();
      latest.current.onShow?.();
      if (motion) Animated.timing(dim, { toValue: 1, duration: 220, useNativeDriver: native }).start();
      else dim.setValue(1);
    }
    const arrive = () => {
      if (!motion) {
        cardIn.setValue(1);
        ringIn.setValue(1);
        draw.setValue(1);
        return;
      }
      Animated.parallel([
        Animated.timing(cardIn, { toValue: 1, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: native }),
        Animated.timing(ringIn, { toValue: 1, duration: 200, easing: Easing.out(Easing.quad), useNativeDriver: native }),
      ]).start();
      Animated.timing(draw, {
        toValue: 1,
        duration: 460,
        delay: 90,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: false,
      }).start();
    };
    if (f.from && motion) {
      const move = Animated.timing(travel, {
        toValue: 1,
        duration: 320,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: false,
      });
      move.start(({ finished }) => finished && arrive());
      return () => move.stop();
    }
    travel.setValue(1);
    arrive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame?.at]);

  // The halo: a ring that leaves the hole's edge and fades, every couple of seconds.
  useEffect(() => {
    if (reduce || !shown) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad), useNativeDriver: native }),
        Animated.delay(600),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, shown, pulse]);

  // Escape ends it, rather than closing the sheet under it, which listens for the key too.
  useEffect(() => {
    if (!shown || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      latest.current.onEnd('skipped');
    };
    window.addEventListener('keyup', key, true);
    return () => window.removeEventListener('keyup', key, true);
  }, [shown]);

  // iOS has no live regions: each step, and what was done in it, is said aloud instead.
  useEffect(() => {
    if (Platform.OS === 'ios' && current) {
      AccessibilityInfo.announceForAccessibility([step.title, step.body].filter(Boolean).join('. '));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, index]);
  useEffect(() => {
    if (Platform.OS === 'ios' && step.ack) AccessibilityInfo.announceForAccessibility(step.ack);
  }, [step.ack]);

  const hole = frame?.hole ?? null;
  const path = useMemo(() => {
    if (!frame) return null;
    const to = scrimPath(frame.stage, frame.hole, frame.radius);
    if (!frame.from) return to;
    const from = scrimPath(frame.stage, frame.from.hole, frame.from.radius);
    return travel.interpolate({ inputRange: [0, 1], outputRange: [from, to] });
  }, [frame, travel]);

  // The card is anchored by the edge that faces the hole, so a line added to it grows away from the arrow.
  const slot =
    frame && current
      ? frame.card.side === 'above'
        ? {
            left: frame.card.x - frame.root.x,
            bottom: frame.root.y + frame.root.height - (frame.card.y + frame.card.height),
          }
        : { left: frame.card.x - frame.root.x, top: frame.card.y - frame.root.y }
      : { left: MARGIN, top: 0 };
  const rise = frame?.card.side === 'above' ? -8 : 8;

  return (
    <View
      ref={root}
      collapsable={false}
      style={StyleSheet.absoluteFill}
      pointerEvents="box-none"
      onLayout={(e) => setRootWidth(e.nativeEvent.layout.width)}
      role="dialog"
      // On a phone: modal, and no label, which would be read in place of what's in it. In a browser:
      // a name, and not aria-modal (see the top).
      {...(native ? { accessibilityViewIsModal: true } : { 'aria-label': label })}
    >
      {frame && (
        <Animated.View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: -frame.root.x,
            top: -frame.root.y,
            width: frame.stage.width,
            height: frame.stage.height,
            opacity: dim,
          }}
        >
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <Svg width={frame.stage.width} height={frame.stage.height}>
              <AnimatedPath d={path!} fill={color.scrimStrong} fillRule="evenodd" />
            </Svg>
          </View>
          {current && frame.arrow && <ArrowLine arrow={frame.arrow} draw={draw} />}
          {blockersAround(frame.stage, hole).map((b, i) => (
            <View
              key={i}
              style={{ position: 'absolute', left: b.x, top: b.y, width: b.width, height: b.height }}
              onStartShouldSetResponder={() => true}
            />
          ))}
          {current && hole && (
            <Ring hole={hole} radius={frame.radius} ringIn={ringIn} pulse={pulse} halo={!reduce} accent={color.accent} />
          )}
        </Animated.View>
      )}

      <View
        ref={card}
        collapsable={false}
        style={[s.slot, { width: width ?? 0 }, slot, !current && s.waiting]}
        pointerEvents={current ? 'box-none' : 'none'}
        {...mark('card')}
      >
        <Animated.View
          style={[s.card, { opacity: cardIn, transform: [{ translateY: cardIn.interpolate({ inputRange: [0, 1], outputRange: [rise, 0] }) }] }]}
          accessibilityLiveRegion="polite"
        >
          {steps.length > 1 && (
            <Text style={s.count}>
              {index + 1} of {steps.length}
            </Text>
          )}
          <Text style={s.title} accessibilityRole="header">
            {step.title}
          </Text>
          {!!step.body && <Text style={s.body}>{step.body}</Text>}
          {!!step.lines?.length && (
            <View style={s.lines}>
              {step.lines!.map((l) => (
                <Text key={l.lead} style={s.line}>
                  <Text style={s.lead}>{l.lead}</Text> {l.text}
                </Text>
              ))}
            </View>
          )}
          {!!step.ack && (
            <View style={s.ack}>
              <Glyph name="check" ink={color.accent} size={16} weight={2.6} />
              <Text style={s.ackText}>{step.ack}</Text>
            </View>
          )}
          <View style={s.footer}>
            {answers ? (
              <>
                <View style={{ flex: 1 }} />
                <Pill label={answers.no.label} onPress={answers.no.onPress} />
                <Pill label={answers.yes.label} variant="primary" onPress={answers.yes.onPress} />
              </>
            ) : (
              <>
                <Pill label="Skip" variant="soft" accessibilityLabel="Skip the guide" onPress={() => onEnd('skipped')} />
                <View style={{ flex: 1 }} />
                {index > 0 && <Pill label="Back" accessibilityLabel="Previous tip" onPress={() => onAt?.(index - 1)} />}
                {last ? (
                  <Pill label="Got it" variant="primary" onPress={() => onEnd('done')} />
                ) : (
                  <Pill label="Next" variant="primary" accessibilityLabel="Next tip" onPress={() => onAt?.(index + 1)} />
                )}
              </>
            )}
          </View>
        </Animated.View>
      </View>
    </View>
  );
}

/**
 * The arrow, drawn in from the card's end with a dash that shortens to
 * nothing; the head comes last. It has a box of its own, the size of what it
 * covers, with the window's points kept by the viewBox.
 */
function ArrowLine({ arrow, draw }: { arrow: Arrow; draw: Animated.Value }) {
  const length = Math.ceil(arrow.length) + 1;
  const { x, y, width, height } = arrow.box;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: x, top: y, width, height }} {...mark('arrow')}>
      <Svg width={width} height={height} viewBox={`${x} ${y} ${width} ${height}`}>
        <AnimatedPath
          d={arrow.path}
          fill="none"
          stroke={INK}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={[length, length]}
          strokeDashoffset={draw.interpolate({ inputRange: [0, 1], outputRange: [length, 0] })}
          // A round cap would show as a dot at the start before anything is drawn.
          opacity={draw.interpolate({ inputRange: [0, 0.02, 1], outputRange: [0, 1, 1] })}
        />
        <AnimatedPath
          d={arrow.head}
          fill="none"
          stroke={INK}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={draw.interpolate({ inputRange: [0, 0.8, 1], outputRange: [0, 0, 1] })}
        />
      </Svg>
    </View>
  );
}

/** The accent ring just outside the hole, and the halo that leaves it and fades. */
function Ring({
  hole,
  radius: r,
  ringIn,
  pulse,
  halo,
  accent,
}: {
  hole: Rect;
  radius: number;
  ringIn: Animated.Value;
  pulse: Animated.Value;
  halo: boolean;
  accent: string;
}) {
  const out = 3;
  const box = {
    position: 'absolute' as const,
    left: hole.x - out,
    top: hole.y - out,
    width: hole.width + 2 * out,
    height: hole.height + 2 * out,
    borderRadius: r + out,
    borderWidth: 2,
    borderColor: accent,
  };
  // Scaled in each direction by what grows it the same few points all round, whatever its shape.
  const grow = (side: number) => pulse.interpolate({ inputRange: [0, 1], outputRange: [1, (side + 2 * HALO) / Math.max(side, 1)] });
  return (
    <>
      {halo && (
        <Animated.View
          pointerEvents="none"
          style={[
            box,
            {
              opacity: Animated.multiply(ringIn, pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] })),
              transform: [{ scaleX: grow(box.width) }, { scaleY: grow(box.height) }],
            },
          ]}
          {...mark('halo')}
        />
      )}
      <Animated.View pointerEvents="none" style={[box, { opacity: ringIn }]} {...mark('spotlight')} />
    </>
  );
}

/** Whether the device asks for less motion. Until it has said, it doesn't. */
function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then(
      (on) => live && setReduce(on),
      () => {}
    );
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (on) => setReduce(on));
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/** Where a view is in the window, or null if it isn't on the screen. A view that isn't there may never answer. */
function measure(ref: React.RefObject<View | null>): Promise<Rect | null> {
  return new Promise((resolve) => {
    const node = ref.current;
    if (!node) return resolve(null);
    const late = setTimeout(() => resolve(null), 300);
    node.measureInWindow((x, y, width, height) => {
      clearTimeout(late);
      const ok = [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0;
      resolve(ok ? { x, y, width, height } : null);
    });
  });
}

const roundRect = (r: Rect | null) => r && [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 2) / 2);

/** Whether two frames would draw the same, to half a point. */
function sameFrame(a: Frame | null, b: Frame): boolean {
  if (!a) return false;
  const key = (f: Frame) =>
    JSON.stringify([f.at, roundRect(f.root), roundRect(f.hole), f.radius, f.card.x, f.card.y, f.card.side, f.card.height].map((v) =>
      typeof v === 'number' ? Math.round(v * 2) / 2 : v
    ));
  return key(a) === key(b);
}

const useStyles = makeStyles((color) => ({
  slot: { position: 'absolute' },
  // Laid out, so its height can be measured, but not seen or touched until it's placed.
  waiting: { opacity: 0 },
  card: {
    gap: space.sm,
    padding: space.lg,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    backgroundColor: color.surface,
    ...shadow,
  },
  count: { ...type.caption, color: color.inkFaint },
  title: { ...type.heading, color: color.ink },
  body: { ...type.body, color: color.inkMuted },
  lines: { gap: space.xs + 2 },
  line: { ...type.body, fontSize: 14, lineHeight: 20, color: color.inkMuted },
  lead: { fontWeight: '600', color: color.ink },
  ack: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    paddingVertical: space.xs + 2,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.md,
    backgroundColor: color.accentWash,
  },
  ackText: { ...type.label, fontSize: 14, color: color.accent, flexShrink: 1 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xs },
}));
