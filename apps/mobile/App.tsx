import React, { useState } from 'react';
import { Platform } from 'react-native';

import { SattleProvider } from './src/react/SattleProvider';
import { DemoApp } from './src/ui/DemoApp';
import { GuestPayScreen } from './src/ui/GuestPayScreen';

/** The path payLinkPath() builds: /s/<token>. */
const GUEST_PATH = /^\/s\/([^/]+)\/?$/;

/**
 * The token when this page was opened from a pay link. Web only: that's
 * where a guest with no app lands. Everything else gets the app.
 */
function guestToken(): string | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const m = GUEST_PATH.exec(window.location.pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export default function App() {
  const [token] = useState(guestToken);
  if (token) {
    // Nothing but the one payment: no navigator, no demo bar, no app state.
    return (
      <SattleProvider>
        <GuestPayScreen token={token} />
      </SattleProvider>
    );
  }
  return <DemoApp />;
}
