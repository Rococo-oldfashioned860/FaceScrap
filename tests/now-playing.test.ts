import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import { storyCardMark } from '../src/shared/story-mark';
import { videoGroupKey, type MediaItem } from '../src/shared/media';

const { flushBindingsNow, loadBindings, purgeTabBindings, selectPlaying } = await import('../src/shared/now-playing');
const { getBind, setPlaying, setRecent } = await import('../src/shared/storage');

const realNow = Date.now;
let now = 1_800_000_000_000;
let nextTab = 100;
let tabId = nextTab++;

function efg(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function video(asset: string, videoId: string): MediaItem {
  return {
    id: `video-${asset}`,
    url: `https://video.xx.fbcdn.net/v/t42/${asset}.mp4?efg=${efg({ xpv_asset_id: asset, video_id: videoId })}`,
    kind: 'video',
    source: 'story',
    origin: 'graphql',
    addedAt: now,
  };
}

function track(item: MediaItem): string {
  return item.url.replace('/v/t42/', '/o1/v/t42/');
}

function photo(id: string): MediaItem {
  return {
    id,
    url: `https://scontent.xx.fbcdn.net/v/t39/${id}.jpg`,
    kind: 'image',
    source: 'story',
    origin: 'graphql',
    addedAt: now,
  };
}

async function showVideo(item: MediaItem, mark: string): Promise<MediaItem[]> {
  await setPlaying(tabId, { ids: [], hasVideo: true, mark, at: now });
  await setRecent(tabId, track(item), now);
  const selected = await selectPlaying(tabId, [item]);
  flushBindingsNow();
  return selected;
}

// Let a flushed setBind() write land in the fake storage before reading it back.
async function flushWrites(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
  tabId = nextTab++;
  now += 100_000;
  Date.now = () => now;
  await resetChromeStorage();
});

afterEach(() => {
  flushBindingsNow();
  purgeTabBindings(tabId);
  Date.now = realNow;
});

test('drops a stale video binding when a new card has only the tray-pinned URL fallback', async () => {
  const item = video('700000000000001', '800000000000001');
  const fallback = storyCardMark('/stories/owner/url-card/');

  assert.deepEqual(await showVideo(item, `${fallback}#vm:1`), [item]);

  now += 2_000;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${fallback}#vm:2`, at: now - 2_000 });

  assert.deepEqual(await selectPlaying(tabId, [item]), []);
});

test('keeps the last confirmed story until the new fallback-marked video streams', async () => {
  const previous = video('700000000000006', '800000000000006');
  const current = video('700000000000007', '800000000000007');
  const previousMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDA2');
  const fallback = storyCardMark('/stories/owner/url-card/');

  assert.deepEqual(await showVideo(previous, `${previousMark}#vm:1`), [previous]);

  now += 1_000;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${fallback}#vm:2`, at: now });
  assert.deepEqual(await selectPlaying(tabId, [previous, current]), [previous]);

  now += 500;
  await setRecent(tabId, track(current), now);
  assert.deepEqual(await selectPlaying(tabId, [previous, current]), [current]);
});

test('does not restore an identical provisional full marker from persisted bindings', async () => {
  const item = video('700000000000004', '800000000000004');
  const provisional = 'p:owner/url-card#vm:1';

  await chrome.storage.session.set({
    [`bind_${tabId}`]: {
      coverBind: [],
      groupCover: [],
      markBind: [[provisional, videoGroupKey(item)]],
    },
  });
  await loadBindings(tabId);
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: provisional, at: now });

  assert.deepEqual(await selectPlaying(tabId, [item]), []);
});

test('does not persist a provisional full marker as a durable binding', async () => {
  const item = video('700000000000005', '800000000000005');
  const provisional = 'p:owner/url-card#vm:1';

  assert.deepEqual(await showVideo(item, provisional), [item]);
  await flushWrites();

  const bindings = await getBind(tabId);
  assert.equal(bindings?.markBind.some(([mark]) => mark === provisional) ?? false, false);
});

test('reuses a valid DOM-card binding for a buffered revisit with a new video load marker', async () => {
  const item = video('700000000000002', '800000000000002');
  const durable = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDAy');

  assert.deepEqual(await showVideo(item, `${durable}#vm:1`), [item]);

  now += 20_000;
  await chrome.storage.session.remove(`recent_${tabId}`);
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${durable}#vm:2`, at: now });

  assert.deepEqual(await selectPlaying(tabId, [item]), [item]);
});

test('reloads a persisted DOM-card binding for a zero-network buffered revisit', async () => {
  const item = video('700000000000008', '800000000000008');
  const durable = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDA4');

  assert.deepEqual(await showVideo(item, `${durable}#vm:epoch-a:1`), [item]);
  await flushWrites();
  assert.equal((await getBind(tabId))?.markBind.some(([mark]) => mark === durable), true);

  purgeTabBindings(tabId);
  await chrome.storage.session.remove(`recent_${tabId}`);
  await loadBindings(tabId);
  now += 20_000;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${durable}#vm:epoch-b:1`, at: now });

  assert.deepEqual(await selectPlaying(tabId, [item]), [item]);
});

test('does not let legacy URL-derived u: bindings match a new provisional fallback', async () => {
  const legacy = video('700000000000009', '800000000000009');
  const current = video('700000000000010', '800000000000010');
  const legacyPortion = 'u:owner/url-card';
  const legacyFull = `${legacyPortion}#vm:1`;
  const provisional = storyCardMark('/stories/owner/url-card/');

  await chrome.storage.session.set({
    [`bind_${tabId}`]: {
      coverBind: [],
      groupCover: [],
      markBind: [
        [legacyPortion, videoGroupKey(legacy)],
        [legacyFull, videoGroupKey(legacy)],
      ],
    },
  });
  await loadBindings(tabId);
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${provisional}#vm:epoch-new:1`, at: now });

  assert.deepEqual(await selectPlaying(tabId, [legacy, current]), []);

  const currentDomMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDEw');
  now += 1_000;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${currentDomMark}#vm:epoch-new:2`, at: now });
  await setRecent(tabId, track(current), now);

  assert.deepEqual(await selectPlaying(tabId, [legacy, current]), [current]);
});

test('hands off A to B to C when three videos share one pinned provisional path', async () => {
  const first = video('700000000000011', '800000000000011');
  const second = video('700000000000012', '800000000000012');
  const third = video('700000000000013', '800000000000013');
  const firstMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDEx');
  const provisional = storyCardMark('/stories/owner/url-card/');
  const all = [first, second, third];

  assert.deepEqual(await showVideo(first, `${firstMark}#vm:epoch-a:1`), [first]);

  now += 1_000;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${provisional}#vm:epoch-a:2`, at: now });
  assert.deepEqual(await selectPlaying(tabId, all), [first]);
  now += 500;
  await setRecent(tabId, track(second), now);
  assert.deepEqual(await selectPlaying(tabId, all), [second]);

  now += 1_000;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${provisional}#vm:epoch-b:1`, at: now });
  assert.deepEqual(await selectPlaying(tabId, all), [second]);
  now += 500;
  await setRecent(tabId, track(third), now);
  assert.deepEqual(await selectPlaying(tabId, all), [third]);

  flushBindingsNow();
  await flushWrites();
  assert.equal((await getBind(tabId))?.markBind.some(([mark]) => mark.startsWith('p:')) ?? false, false);
});

test('clears a remembered video on a direct transition to a DOM-proven photo', async () => {
  const item = video('700000000000014', '800000000000014');
  const image = photo('fb:900000000000014');
  const videoMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDE0');
  const photoMark = storyCardMark('/stories/owner/url-card/', 'UzM6OTAwMDAwMDAwMDAwMDE0');

  assert.deepEqual(await showVideo(item, `${videoMark}#vm:epoch-a:1`), [item]);
  now += 2_000;
  await setPlaying(tabId, { ids: [image.id], hasVideo: false, mark: photoMark, at: now });

  assert.deepEqual(await selectPlaying(tabId, [item, image]), [image]);
});

test('clears a remembered video on a direct transition to a DOM-proven dead card', async () => {
  const item = video('700000000000015', '800000000000015');
  const videoMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDE1');
  const deadMark = storyCardMark('/stories/owner/url-card/', 'UzM6OTAwMDAwMDAwMDAwMDE1');

  assert.deepEqual(await showVideo(item, `${videoMark}#vm:epoch-a:1`), [item]);
  now += 2_000;
  await setPlaying(tabId, { ids: [], hasVideo: false, mark: deadMark, at: now });

  assert.deepEqual(await selectPlaying(tabId, [item]), []);
});

test('a provisional photo selects only its centered image and never revives the previous video', async () => {
  const item = video('700000000000016', '800000000000016');
  const image = photo('fb:900000000000016');
  const videoMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDE2');
  const provisional = storyCardMark('/stories/owner/url-card/');

  assert.deepEqual(await showVideo(item, `${videoMark}#vm:epoch-a:1`), [item]);
  now += 2_000;
  await setPlaying(tabId, { ids: [image.id], hasVideo: false, mark: provisional, at: now });

  assert.deepEqual(await selectPlaying(tabId, [item, image]), [image]);
});

test('a stable provisional dead-card emission clears the previous video without a durable binding', async () => {
  const item = video('700000000000017', '800000000000017');
  const videoMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDE3');
  const provisional = storyCardMark('/stories/owner/url-card/');

  assert.deepEqual(await showVideo(item, `${videoMark}#vm:epoch-a:1`), [item]);
  now += 2_000;
  await setPlaying(tabId, { ids: [], hasVideo: false, mark: provisional, at: now });

  assert.deepEqual(await selectPlaying(tabId, [item]), []);
});

test('does not pin a remembered video across video, photo, dead-card, and video transitions', async () => {
  const item = video('700000000000003', '800000000000003');
  const image = photo('fb:900000000000003');
  const first = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDAz');
  const photoMark = storyCardMark('/stories/owner/url-card/', 'UzM6OTAwMDAwMDAwMDAwMDAz');
  const deadMark = storyCardMark('/stories/owner/url-card/', 'UzM6OTAwMDAwMDAwMDAwMDA0');

  assert.deepEqual(await showVideo(item, `${first}#vm:1`), [item]);

  now += 2_000;
  await setPlaying(tabId, { ids: [image.id], hasVideo: false, mark: photoMark, at: now });
  assert.deepEqual(await selectPlaying(tabId, [item, image]), [image]);

  now += 2_000;
  await setPlaying(tabId, { ids: [], hasVideo: false, mark: deadMark, at: now });
  assert.deepEqual(await selectPlaying(tabId, [item, image]), []);

  now += 2_000;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${first}#vm:2`, at: now });
  assert.deepEqual(await selectPlaying(tabId, [item, image]), [item]);
});
