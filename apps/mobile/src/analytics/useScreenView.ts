import { useEffect } from 'react';

import { analytics } from './analytics';
import type { Props } from './tracker';

/**
 * This screen is showing. Called once at the top of each screen, sheet and
 * page, with what tells one showing from another: a group id, a tab, a step.
 * A change in those is a new showing. Taps until it goes are on this screen.
 */
export function useScreenView(name: string, props?: Props) {
  const key = JSON.stringify(props ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => analytics.screenView(name, props), [name, key]);
}
