/**
 * The back button: Android's, and the browser's.
 *
 * Whatever is showing says what going back means for it: a screen its
 * `onBack`, a sheet or dialog its `onClose`. A press goes to the newest sheet
 * open, else to the newest screen. With nothing registered, Android leaves the
 * app, as it would anyway.
 *
 * A browser has no back button to listen to, only its history. The navigator
 * says how deep it is (`useHistoryDepth`), and the history is kept one entry
 * per step of that: pushed as someone goes in, which is always on a tap, and
 * taken back off when they leave by the app's own arrow. Going back in the
 * browser takes one off, and that is the press. Chrome passes over entries a
 * page adds without a tap, which is why they're added going in and never
 * put back after a press. The address doesn't change.
 */

import { useEffect, useRef } from 'react';
import { BackHandler, Platform } from 'react-native';

type Entry = { run: () => void; overlay: boolean };

const entries: Entry[] = [];

function press(): boolean {
  const overlays = entries.filter((e) => e.overlay);
  const top = overlays[overlays.length - 1] ?? entries[entries.length - 1];
  if (!top) return false;
  top.run();
  return true;
}

/**
 * Sends the back button to `onBack` while this is mounted and it's given. An
 * `overlay` (a sheet, a dialog) takes the press before any screen does.
 */
export function useBack(onBack: (() => void) | undefined, overlay = false) {
  const latest = useRef(onBack);
  latest.current = onBack;
  const active = onBack !== undefined;
  useEffect(() => {
    if (!active) return;
    const entry: Entry = { run: () => latest.current?.(), overlay };
    entries.push(entry);
    return () => {
      entries.splice(entries.indexOf(entry), 1);
    };
  }, [active, overlay]);
}

// -- the browser's history ---------------------------------------------------

const web = Platform.OS === 'web' && typeof window !== 'undefined';

function depthIn(state: unknown): number {
  const n = (state as { sattleDepth?: unknown } | null)?.sattleDepth;
  return typeof n === 'number' ? n : 0;
}

/** Our entries above the one the app was opened on, as far as the browser is along them. After a reload, the app starts over and walks it back. */
let at = web ? depthIn(window.history.state) : 0;
/** How deep the navigator is showing. */
let depth = 0;
/** A step back we took ourselves, so its popstate isn't a press. */
let undoing = false;

function reconcile() {
  if (undoing) return;
  while (at < depth) {
    at += 1;
    window.history.pushState({ sattleDepth: at }, '');
  }
  if (at > depth) {
    undoing = true;
    const steps = depth - at;
    at = depth;
    window.history.go(steps);
  }
}

if (web) {
  window.addEventListener('popstate', (event) => {
    const now = depthIn(event.state);
    if (undoing) {
      undoing = false;
      at = now;
      reconcile();
      return;
    }
    const back = now < at;
    at = now;
    // The navigator's next depth settles the rest. Forward, there's nowhere to go, so that puts it back.
    if (back) press();
    else reconcile();
  });
} else {
  BackHandler.addEventListener('hardwareBackPress', press);
}

/** How many steps in from the start the app is showing, for the browser's back button to walk back through. */
export function useHistoryDepth(steps: number) {
  useEffect(() => {
    if (!web) return;
    depth = steps;
    reconcile();
  }, [steps]);
}
