/**
 * Whether the payer has come back from a UPI app this screen handed them to.
 *
 * Only an Android app that opened the UPI app itself is told what happened
 * there (upi/launchUpi.android.ts). An iPhone and a browser are told nothing:
 * the link is opened, and that is all. What they can know is that the payer
 * went away and is back, which is the moment to ask whether the payment went
 * through, before they wonder why nothing on the screen has changed.
 *
 * With a `scope`, on the web, the fact is kept for the tab as well
 * (upi/upiReturn.ts), so a page that was reloaded while they were away still
 * asks.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { forgetLeftForUpi, leftForUpi, noteLeftForUpi } from '../upi/upiReturn';

export interface BackFromUpi {
  /** What they left to pay, as `leaving` was given it, once they're back. Null until then, and after `answered`. */
  back: string | null;
  /** Call as the link is handed to the UPI app. `what` names the debt, on a screen with more than one. */
  leaving: (what?: string) => void;
  /** They've said what happened, or moved on. Stops asking. */
  answered: () => void;
}

export function useBackFromUpi(scope?: string): BackFromUpi {
  // A tab that was reloaded while they were away starts out already back.
  const [back, setBack] = useState<string | null>(() => (scope ? leftForUpi(scope) : null));
  const left = useRef<string | null>(null);
  const away = useRef(false);

  useEffect(() => {
    // In a browser this follows the page being hidden and shown again.
    const sub = AppState.addEventListener('change', (state) => {
      // Not 'inactive': an iPhone reports that while it asks "Open in GPay?", and they haven't left yet.
      if (state === 'background') {
        away.current = left.current !== null;
      } else if (state === 'active' && away.current) {
        away.current = false;
        setBack(left.current);
        left.current = null;
      }
    });
    return () => sub?.remove();
  }, []);

  const leaving = useCallback(
    (what = '') => {
      left.current = what;
      if (scope) noteLeftForUpi(scope, what);
    },
    [scope]
  );
  const answered = useCallback(() => {
    left.current = null;
    away.current = false;
    if (scope) forgetLeftForUpi();
    setBack(null);
  }, [scope]);

  return { back, leaving, answered };
}
