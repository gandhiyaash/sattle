/**
 * In-app updates: Google Play downloads the new version while the app stays
 * open, and installing it is one tap. Android only.
 *
 *   idle ──update found──▶ Play asks ──accepted──▶ downloading ──▶ ready ──restart()──▶ new version
 *                             │                         │
 *                             └──declined──▶ available ◀┘ failed
 *                                            (banner offers it; update() asks again)
 *
 * Play asks once per version. A "no" is remembered on the device, and after
 * that the banner is the only reminder.
 *
 * A release marked urgent in Play (in-app update priority 4 or 5) skips the
 * question: Play takes over the screen, installs and restarts the app. Backing
 * out of that leaves the banner on Update, the way back in, and the next
 * launch takes over again.
 *
 * This file decides; the native module (modules/in-app-updates) only reports
 * and does what it's told. Nothing here imports React Native, so it runs
 * under vitest against a fake.
 */

export type InstallStatus =
  | 'pending'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'installed'
  | 'failed'
  | 'canceled'
  | 'unknown';

/** What Play says about this install. */
export interface UpdateInfo {
  /** `in_progress`: an update this app started is still under way. */
  availability: 'none' | 'available' | 'in_progress';
  status: InstallStatus;
  /** Version code of the newest release on Play. */
  versionCode: number;
  /** Play's in-app update priority for the newest release, 0 to 5. Set per release. */
  priority: number;
  flexibleAllowed: boolean;
  immediateAllowed: boolean;
  /** The person already said no to this version. */
  declined: boolean;
}

export interface InstallProgress {
  status: InstallStatus;
  bytesDownloaded: number;
  totalBytes: number;
}

export type FlowResult = 'accepted' | 'declined' | 'failed';

/** The native seam. See nativeUpdates.android.ts. */
export interface NativeUpdates {
  check(): Promise<UpdateInfo>;
  /** Shows Play's update UI. `immediate` is the full-screen, blocking one. */
  start(immediate: boolean): Promise<FlowResult>;
  /** Installs a downloaded update. Play restarts the app. */
  install(): Promise<void>;
  onProgress(listener: (progress: InstallProgress) => void): () => void;
}

/** At or above this Play priority, the update takes over the screen. */
export const URGENT_PRIORITY = 4;

export type Step = 'nothing' | 'ask' | 'offer' | 'urgent' | 'downloading' | 'ready';

/** What to do about what Play reported. */
export function nextStep(info: UpdateInfo): Step {
  const live = info.availability !== 'none';
  // Before anything else: an urgent update that was backed out of still ends in
  // the takeover, even once Play has finished downloading it. Starting it again resumes it.
  if (live && info.priority >= URGENT_PRIORITY && info.immediateAllowed) return 'urgent';
  if (info.status === 'downloaded') return 'ready';
  if (info.status === 'pending' || info.status === 'downloading' || info.status === 'installing') {
    return 'downloading';
  }
  if (!live || !info.flexibleAllowed) return 'nothing';
  // in_progress with nothing downloading is an update that stalled. Starting it again resumes it.
  if (info.availability === 'in_progress' || info.declined) return 'offer';
  return 'ask';
}

export interface UpdateState {
  phase: 'idle' | 'available' | 'downloading' | 'ready';
  /** 0 to 1 while downloading, once Play knows the size. */
  progress: number | null;
}

export interface Updater {
  getState(): UpdateState;
  subscribe(listener: () => void): () => void;
  /** Asks Play what's new and acts on it. Cheap, and safe to call on every foreground. */
  check(): Promise<void>;
  /** The banner's Update button. */
  update(): Promise<void>;
  /** The banner's Restart button. */
  restart(): Promise<void>;
}

const IDLE: UpdateState = { phase: 'idle', progress: null };
const AVAILABLE: UpdateState = { phase: 'available', progress: null };

/** `native` is null wherever Play in-app updates don't exist; then nothing ever happens. */
export function createUpdater(native: NativeUpdates | null): Updater {
  let state = IDLE;
  const listeners = new Set<() => void>();

  let listening = false;
  let checking = false;
  let flowOpen = false;
  let installing = false;
  let urgent = false;
  // What Play's UI has opened for by itself this launch: once per version, and
  // once more if that version turns urgent. Closing Play's UI brings the app
  // back to the foreground, which checks again, and that must not reopen it.
  const asked = new Set<string>();

  const set = (next: UpdateState) => {
    state = next;
    listeners.forEach((l) => l());
  };

  const onProgress = (p: InstallProgress) => {
    // An urgent update keeps the banner on Update, the way back into Play's takeover.
    if (urgent) return;
    switch (p.status) {
      case 'pending':
      case 'downloading':
        return set({
          phase: 'downloading',
          progress: p.totalBytes > 0 ? Math.min(1, p.bytesDownloaded / p.totalBytes) : null,
        });
      case 'downloaded':
        return set({ phase: 'ready', progress: null });
      case 'failed':
      case 'canceled':
        return set(AVAILABLE);
      // installing, installed: Play is about to restart the app.
    }
  };

  const open = async (immediate: boolean) => {
    if (!native || flowOpen) return;
    flowOpen = true;
    try {
      const result = await native.start(immediate);
      if (result !== 'accepted') {
        set(AVAILABLE);
      } else if (!immediate && (state.phase === 'idle' || state.phase === 'available')) {
        // Otherwise progress events got here first, and they know more than "accepted" does.
        set({ phase: 'downloading', progress: null });
      }
    } catch {
      // Play couldn't show its UI. Whatever was on screen stays.
    } finally {
      flowOpen = false;
    }
  };

  const check = async () => {
    if (!native || checking) return;
    checking = true;
    // This runs at launch and when the app comes back to the front, so Play's UI
    // is off the screen by now, even if it never said how it ended: reopening the
    // app from the launcher closes it without a result.
    flowOpen = false;
    if (!listening) {
      listening = true;
      native.onProgress(onProgress);
    }

    let info: UpdateInfo;
    try {
      info = await native.check();
    } catch {
      // Not installed by Play (a sideloaded APK, a debug build) or Play is
      // unreachable. Nothing to offer; the next foreground asks again.
      return;
    } finally {
      checking = false;
    }

    const step = nextStep(info);
    urgent = step === 'urgent';
    switch (step) {
      case 'nothing':
        return set(IDLE);
      case 'ready':
        return set({ phase: 'ready', progress: null });
      case 'downloading':
        // Keep the percentage the progress events have been reporting.
        if (state.phase !== 'downloading') set({ phase: 'downloading', progress: null });
        return;
      case 'offer':
        return set(AVAILABLE);
      case 'ask':
      case 'urgent': {
        const key = `${info.versionCode}:${step}`;
        if (asked.has(key)) return set(AVAILABLE);
        asked.add(key);
        return open(urgent);
      }
    }
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    check,

    update: () => open(urgent),

    async restart() {
      if (!native || installing) return;
      installing = true;
      try {
        await native.install();
      } catch {
        // The download is gone. See what Play says now.
        await check();
      } finally {
        installing = false;
      }
    },
  };
}
