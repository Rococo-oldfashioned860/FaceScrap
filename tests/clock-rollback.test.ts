import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { persistNowPlayingMessage } from '../src/background/playing-handler';
import { mediaId, type MediaItem } from '../src/shared/media';
import { forgetLastLive, selectPlaying } from '../src/shared/now-playing';
import {
  getPlaying,
  getRecent,
  setPlaying,
  setPlayingMediaPin,
  setRecent,
} from '../src/shared/storage';
import { resetChromeStorage } from './chrome-fake';

const realNow = Date.now;
let tabId = 31_000;
let now = 1_900_000_000_000;

function video(name: string): MediaItem {
  const url = `https://video.xx.fbcdn.net/v/t42/${name}.mp4?sig=rotating`;
  return {
    id: mediaId(url),
    url,
    kind: 'video',
    source: 'story',
    origin: 'graphql',
    addedAt: now,
  };
}

beforeEach(async () => {
  tabId++;
  now += 100_000;
  Date.now = () => now;
  await resetChromeStorage();
});

afterEach(() => {
  forgetLastLive(tabId);
  Date.now = realNow;
});

test('NOW_PLAYING replaces a stored future clock epoch and repairs its related control state', async () => {
  const future = now + 60_000;
  const currentTrack = video('clock-current').url;
  const futureTrack = video('clock-future').url;
  await chrome.storage.session.set({
    [`playing_${tabId}`]: { ids: ['old'], hasVideo: true, mark: 'old-story', at: future },
    [`recent_${tabId}`]: {
      tracks: [
        { url: currentTrack, at: now - 10 },
        { url: futureTrack, at: future },
      ],
    },
    [`playing_pin_${tabId}`]: { identity: 'story:old', groups: ['old-group'], playingAt: future },
  });

  assert.deepEqual(
    await persistNowPlayingMessage(
      tabId,
      { type: 'NOW_PLAYING', ids: ['new'], hasVideo: true, mark: 'new-story', detectedAt: now },
      now,
    ),
    { ok: true },
  );
  assert.deepEqual(await getPlaying(tabId), {
    ids: ['new'],
    hasVideo: true,
    vid: undefined,
    coverUrls: undefined,
    mark: 'new-story',
    at: now,
  });
  assert.deepEqual(await getRecent(tabId), { tracks: [{ url: currentTrack, at: now - 10 }] });
  assert.equal((await chrome.storage.session.get(`playing_pin_${tabId}`))[`playing_pin_${tabId}`] ?? null, null);
});

test('ordinary out-of-order state inside the accepted clock skew remains monotonic', async () => {
  const newer = { ids: ['newer'], hasVideo: true, mark: 'newer', at: now + 500 };
  await setPlaying(tabId, newer);

  assert.deepEqual(
    await persistNowPlayingMessage(
      tabId,
      { type: 'NOW_PLAYING', ids: ['older'], hasVideo: true, mark: 'older', detectedAt: now },
      now,
    ),
    { ok: true },
  );
  assert.deepEqual(await getPlaying(tabId), newer);
});

test('future recent tracks cannot seed Now Playing after a clock rollback', async () => {
  const item = video('future-track');
  await chrome.storage.session.set({
    [`playing_${tabId}`]: { ids: [], hasVideo: true, at: now },
    [`recent_${tabId}`]: { tracks: [{ url: item.url, at: now + 60_000 }] },
  });

  assert.deepEqual(await selectPlaying(tabId, [item]), []);
});

test('a remembered live selection from a future epoch is invalidated immediately', async () => {
  const item = video('future-memory');
  const future = now + 60_000;
  Date.now = () => future;
  await chrome.storage.session.set({
    [`playing_${tabId}`]: { ids: [item.id], hasVideo: true, mark: 'old', at: future },
  });
  assert.deepEqual(await selectPlaying(tabId, [item]), [item]);

  Date.now = () => now;
  await chrome.storage.session.set({
    [`playing_${tabId}`]: { ids: [], hasVideo: true, mark: 'new', at: now },
    [`recent_${tabId}`]: { tracks: [] },
  });
  assert.deepEqual(await selectPlaying(tabId, [item]), []);
});

test('clock-epoch repair spends reserved headroom under quota and still acknowledges durability', async () => {
  const future = now + 60_000;
  await chrome.storage.session.set({
    [`playing_${tabId}`]: { ids: ['old'], hasVideo: true, at: future },
  });

  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let failedOnce = false;
  let usedHeadroom = false;
  session.set = async (values): Promise<void> => {
    if (`playing_${tabId}` in values && !failedOnce) {
      failedOnce = true;
      const error = new Error('QUOTA_BYTES quota exhausted');
      error.name = 'QuotaExceededError';
      throw error;
    }
    if (`playing_${tabId}` in values && 'capture_control_headroom_v1' in values) usedHeadroom = true;
    await realSet(values);
  };

  try {
    assert.deepEqual(
      await persistNowPlayingMessage(
        tabId,
        { type: 'NOW_PLAYING', ids: ['new'], hasVideo: true, detectedAt: now },
        now,
      ),
      { ok: true },
    );
  } finally {
    session.set = realSet;
  }
  assert.equal(failedOnce, true);
  assert.equal(usedHeadroom, true);
  assert.equal((await getPlaying(tabId))?.at, now);
});

test('delayed future pin cannot resurrect the pre-rollback retention epoch', async () => {
  const current = video('pin-current');
  const future = now + 60_000;
  await setPlaying(tabId, { ids: [current.id], hasVideo: true, mark: 'story-current', at: now }, now);

  assert.equal(
    await setPlayingMediaPin(tabId, 'story:story-current', ['future-group'], future, now),
    false,
  );
  assert.equal((await chrome.storage.session.get(`playing_pin_${tabId}`))[`playing_pin_${tabId}`] ?? null, null);
});

test('delayed future recent observation cannot reappear after clock-epoch repair', async () => {
  const stale = video('recent-stale');
  const future = now + 60_000;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: 'story-current', at: now }, now);

  assert.equal(await setRecent(tabId, stale.url, future, now), false);
  assert.equal(await getRecent(tabId), null);
});
