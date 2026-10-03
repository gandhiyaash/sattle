import { describe, expect, it } from 'vitest';

import {
  createUpdater,
  nextStep,
  type FlowResult,
  type InstallProgress,
  type NativeUpdates,
  type UpdateInfo,
} from './updater';

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  availability: 'available',
  status: 'unknown',
  versionCode: 12,
  priority: 0,
  flexibleAllowed: true,
  immediateAllowed: true,
  declined: false,
  ...over,
});

/** Play, scripted: `info` is what check() reports, `answer` what the person does with Play's UI. */
function fakePlay(initial: UpdateInfo, answer: FlowResult | Error = 'accepted') {
  const play = {
    info: initial,
    answer,
    started: [] as boolean[],
    installed: 0,
    emit: (_p: InstallProgress) => {},
    native: null as unknown as NativeUpdates,
  };
  play.native = {
    check: async () => play.info,
    start: async (immediate) => {
      play.started.push(immediate);
      if (play.answer instanceof Error) throw play.answer;
      return play.answer;
    },
    install: async () => {
      play.installed++;
    },
    onProgress: (listener) => {
      play.emit = listener;
      return () => {
        play.emit = () => {};
      };
    },
  };
  return play;
}

describe('nextStep', () => {
  it('does nothing when Play has no update', () => {
    expect(nextStep(info({ availability: 'none' }))).toBe('nothing');
  });

  it('asks about a new version, and only offers one already turned down', () => {
    expect(nextStep(info())).toBe('ask');
    expect(nextStep(info({ declined: true }))).toBe('offer');
  });

  it('takes over the screen from priority 4, even for a version turned down before', () => {
    expect(nextStep(info({ priority: 3 }))).toBe('ask');
    expect(nextStep(info({ priority: 4, declined: true }))).toBe('urgent');
    expect(nextStep(info({ priority: 5, availability: 'in_progress' }))).toBe('urgent');
  });

  it('still takes over when an urgent update finished downloading in the background', () => {
    expect(nextStep(info({ priority: 5, availability: 'in_progress', status: 'downloaded' }))).toBe('urgent');
  });

  it('falls back to asking when Play rules out the full-screen update', () => {
    expect(nextStep(info({ priority: 5, immediateAllowed: false }))).toBe('ask');
  });

  it('stays quiet when Play allows neither kind', () => {
    expect(nextStep(info({ flexibleAllowed: false, immediateAllowed: false }))).toBe('nothing');
  });

  it('picks up a download from an earlier launch', () => {
    expect(nextStep(info({ availability: 'in_progress', status: 'downloading' }))).toBe('downloading');
    expect(nextStep(info({ availability: 'in_progress', status: 'downloaded' }))).toBe('ready');
  });

  it('goes by what the install is doing, whatever the availability says', () => {
    expect(nextStep(info({ status: 'pending' }))).toBe('downloading');
    expect(nextStep(info({ availability: 'none', status: 'downloaded' }))).toBe('ready');
  });

  it('offers a stalled update again instead of claiming it is downloading', () => {
    expect(nextStep(info({ availability: 'in_progress', status: 'failed' }))).toBe('offer');
    expect(nextStep(info({ availability: 'in_progress', status: 'unknown' }))).toBe('offer');
  });
});

describe('createUpdater', () => {
  it('goes from asking, through the download, to installing on restart', async () => {
    const play = fakePlay(info());
    const updater = createUpdater(play.native);

    await updater.check();
    expect(play.started).toEqual([false]);
    expect(updater.getState()).toEqual({ phase: 'downloading', progress: null });

    play.emit({ status: 'downloading', bytesDownloaded: 25, totalBytes: 100 });
    expect(updater.getState()).toEqual({ phase: 'downloading', progress: 0.25 });

    play.emit({ status: 'downloaded', bytesDownloaded: 100, totalBytes: 100 });
    expect(updater.getState().phase).toBe('ready');

    await updater.restart();
    expect(play.installed).toBe(1);
  });

  it('tells subscribers when the state changes, until they leave', async () => {
    const play = fakePlay(info());
    const updater = createUpdater(play.native);
    let calls = 0;
    const stop = updater.subscribe(() => calls++);

    await updater.check();
    expect(calls).toBe(1);
    stop();
    play.emit({ status: 'downloaded', bytesDownloaded: 1, totalBytes: 1 });
    expect(calls).toBe(1);
  });

  it('keeps the percentage when a foreground check lands mid-download', async () => {
    const play = fakePlay(info());
    const updater = createUpdater(play.native);
    await updater.check();
    play.emit({ status: 'downloading', bytesDownloaded: 40, totalBytes: 100 });

    play.info = info({ availability: 'in_progress', status: 'downloading' });
    await updater.check();
    expect(updater.getState()).toEqual({ phase: 'downloading', progress: 0.4 });
  });

  it('never reports more than the whole download', async () => {
    const play = fakePlay(info());
    const updater = createUpdater(play.native);
    await updater.check();

    play.emit({ status: 'downloading', bytesDownloaded: 120, totalBytes: 100 });
    expect(updater.getState()).toEqual({ phase: 'downloading', progress: 1 });
  });

  it('keeps what the progress events said when "accepted" arrives after them', async () => {
    const play = fakePlay(info());
    let accept!: (r: FlowResult) => void;
    play.native.start = () => new Promise<FlowResult>((r) => (accept = r));
    const updater = createUpdater(play.native);

    const checking = updater.check();
    await Promise.resolve();
    await Promise.resolve();
    play.emit({ status: 'downloaded', bytesDownloaded: 1, totalBytes: 1 });
    accept('accepted');
    await checking;
    expect(updater.getState().phase).toBe('ready');
  });

  it('offers a declined update in the banner without opening Play again', async () => {
    const play = fakePlay(info(), 'declined');
    const updater = createUpdater(play.native);

    await updater.check();
    expect(updater.getState().phase).toBe('available');

    // Closing Play's sheet foregrounds the app, which checks again.
    play.info = info({ declined: true });
    await updater.check();
    expect(play.started).toEqual([false]);

    play.answer = 'accepted';
    await updater.update();
    expect(play.started).toEqual([false, false]);
    expect(updater.getState().phase).toBe('downloading');
  });

  it('opens Play by itself only once per version, however the first try ended', async () => {
    for (const answer of ['failed', new Error('Play said no')] as const) {
      const play = fakePlay(info(), answer);
      const updater = createUpdater(play.native);
      await updater.check();
      await updater.check();
      await updater.check();
      expect(play.started).toEqual([false]);
      expect(updater.getState().phase).toBe('available');
    }
  });

  it('asks again in the same launch for a newer version, and takes over once one turns urgent', async () => {
    const play = fakePlay(info(), 'declined');
    const updater = createUpdater(play.native);
    await updater.check();

    play.info = info({ versionCode: 13 });
    await updater.check();
    expect(play.started).toEqual([false, false]);

    play.info = info({ versionCode: 13, priority: 5 });
    await updater.check();
    await updater.check();
    expect(play.started).toEqual([false, false, true]);
  });

  it('runs an urgent update full-screen, and from the banner if that was backed out of', async () => {
    const play = fakePlay(info({ priority: 5 }), 'declined');
    const updater = createUpdater(play.native);

    await updater.check();
    await updater.check();
    expect(play.started).toEqual([true]);
    expect(updater.getState().phase).toBe('available');

    // Play keeps downloading in the background; the banner stays on Update.
    play.emit({ status: 'downloading', bytesDownloaded: 40, totalBytes: 100 });
    expect(updater.getState().phase).toBe('available');

    await updater.update();
    expect(play.started).toEqual([true, true]);
  });

  it("recovers when Play's UI goes away without an answer", async () => {
    const play = fakePlay(info());
    const realStart = play.native.start;
    // Reopening the app from the launcher closes Play's sheet, and nothing ever reports back.
    play.native.start = (immediate) => {
      play.started.push(immediate);
      return new Promise<FlowResult>(() => {});
    };
    const updater = createUpdater(play.native);
    void updater.check();
    await Promise.resolve();
    await Promise.resolve();
    expect(play.started).toEqual([false]);

    await updater.check();
    expect(updater.getState().phase).toBe('available');

    play.native.start = realStart;
    await updater.update();
    expect(play.started).toEqual([false, false]);
    expect(updater.getState().phase).toBe('downloading');
  });

  it('does not open Play twice when checks overlap', async () => {
    const play = fakePlay(info());
    const updater = createUpdater(play.native);
    await Promise.all([updater.check(), updater.check()]);
    expect(play.started).toEqual([false]);
  });

  it('offers the update again when the download fails', async () => {
    const play = fakePlay(info());
    const updater = createUpdater(play.native);
    await updater.check();

    play.emit({ status: 'failed', bytesDownloaded: 0, totalBytes: 0 });
    expect(updater.getState().phase).toBe('available');
  });

  it('installs once when Restart is tapped twice', async () => {
    const play = fakePlay(info({ availability: 'in_progress', status: 'downloaded' }));
    let finish!: () => void;
    play.native.install = () => {
      play.installed++;
      return new Promise<void>((r) => (finish = r));
    };
    const updater = createUpdater(play.native);
    await updater.check();

    const first = updater.restart();
    await updater.restart();
    finish();
    await first;
    expect(play.installed).toBe(1);
  });

  it('shows nothing when Play cannot answer, as in a sideloaded build', async () => {
    const play = fakePlay(info());
    play.native.check = async () => {
      throw new Error('ERROR_APP_NOT_OWNED');
    };
    const updater = createUpdater(play.native);
    await updater.check();
    expect(updater.getState().phase).toBe('idle');
    expect(play.started).toEqual([]);
  });

  it('does nothing at all without Play: iOS and the web', async () => {
    const updater = createUpdater(null);
    await updater.check();
    await updater.update();
    await updater.restart();
    expect(updater.getState().phase).toBe('idle');
  });
});
