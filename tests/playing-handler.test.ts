import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import { persistNowPlayingMessage } from '../src/background/playing-handler';
import { getPlaying } from '../src/shared/storage';

beforeEach(resetChromeStorage);

test('the NOW_PLAYING handler acknowledges only after the PlayingRef is durably stored', async () => {
  const tabId = 9_001;
  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  session.set = async (values): Promise<void> => {
    if (`playing_${tabId}` in values) await gate;
    await realSet(values);
  };

  let settled = false;
  const work = persistNowPlayingMessage(
    tabId,
    { type: 'NOW_PLAYING', ids: ['active'], hasVideo: true, mark: 'vm:active', detectedAt: 1_000 },
    1_100,
  ).then((ack) => {
    settled = true;
    return ack;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  release();
  try {
    assert.deepEqual(await work, { ok: true });
  } finally {
    session.set = realSet;
  }
  assert.deepEqual(await getPlaying(tabId), {
    ids: ['active'],
    hasVideo: true,
    vid: undefined,
    coverUrls: undefined,
    mark: 'vm:active',
    at: 1_000,
  });
});

test('the NOW_PLAYING handler makes an expired observation terminal so content can refresh it', async () => {
  assert.deepEqual(
    await persistNowPlayingMessage(
      9_002,
      { type: 'NOW_PLAYING', ids: [], hasVideo: true, detectedAt: 1_000 },
      40_000,
    ),
    { ok: false, retryable: false, error: 'Invalid or expired playing observation.' },
  );
  assert.equal(await getPlaying(9_002), null);
});
