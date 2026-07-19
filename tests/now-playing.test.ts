import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import {
  storyCardMark,
  storyDomIdForGraphqlChild,
  storyDomIdFromGraphqlNode,
  storyDomIdFromMark,
} from '../src/shared/story-mark';
import {
  MAX_STORY_IDS,
  mediaId,
  mergeMedia,
  sanitizeIncomingItems,
  videoGroupKey,
  type MediaItem,
} from '../src/shared/media';
import { nextPlayingDetectedAt, normalizePlayingDetectedAt } from '../src/shared/messages';

const { forgetLastLive, flushBindingsNow, loadBindings, purgeTabBindings, selectPlaying } = await import(
  '../src/shared/now-playing'
);
const {
  addMedia,
  clearTab,
  getBind,
  getMedia,
  getPlaying,
  getRecent,
  playingRetentionIdentity,
  setPlaying,
  setPlayingMediaPin,
  setRecent,
} = await import('../src/shared/storage');

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

function storyVideo(asset: string, videoId: string, storyIds: string[]): MediaItem {
  return { ...video(asset, videoId), storyIds };
}

function storyDataId(storyId: string): string {
  return Buffer.from(`S:_ISC:${storyId}`).toString('base64');
}

function track(item: MediaItem): string {
  return item.url.replace('/v/t42/', '/o1/v/t42/');
}

function audioTrack(item: MediaItem): string {
  return track(item).replace('.mp4?', '-audio.mp4?');
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
  const playingAt = now;
  await setRecent(tabId, track(item), playingAt - 100);
  await setPlaying(tabId, { ids: [], hasVideo: true, mark, at: playingAt });
  now = playingAt + 100;
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

test('keeps a valid delayed PlayingRef detection timestamp', () => {
  const receivedAt = now;
  assert.equal(normalizePlayingDetectedAt(receivedAt - 750, receivedAt), receivedAt - 750);
  assert.equal(normalizePlayingDetectedAt(receivedAt - 10_001, receivedAt), receivedAt - 10_001);
});

test('uses receive time only when an older content script omits detectedAt', () => {
  assert.equal(normalizePlayingDetectedAt(undefined, now), now);
});

test('read-time canonical migration restores Now Playing for a legacy row with zero new network traffic', async () => {
  const url = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/123456789012345_n.jpg?oh=rotating';
  const legacy: MediaItem = {
    id: 'fb:123456789012345',
    url,
    kind: 'image',
    source: 'story',
    origin: 'dom',
    addedAt: now - 5_000,
  };
  await chrome.storage.session.set({ [`media_${tabId}`]: [legacy] });
  await setPlaying(tabId, { ids: [mediaId(url)], hasVideo: false, at: now }, now);

  const migrated = await getMedia(tabId);
  assert.equal(migrated[0]?.id, mediaId(url));
  assert.deepEqual(await selectPlaying(tabId, migrated), migrated);
  // The alias check also protects callers that still hold a pre-migration row
  // in memory while the serialized storage repair is landing.
  assert.deepEqual(await selectPlaying(tabId, [legacy]), [legacy]);
});

test('rejects present but invalid PlayingRef detection timestamps', () => {
  const receivedAt = now;
  for (const invalid of [receivedAt + 1_001, receivedAt - 30_001, Number.NaN, 'not-a-number', null]) {
    assert.equal(normalizePlayingDetectedAt(invalid, receivedAt), undefined);
  }
});

test('orders two different PlayingRef observations captured in the same millisecond', () => {
  const first = nextPlayingDetectedAt(0, now);
  const second = nextPlayingDetectedAt(first, now);

  assert.equal(first, now);
  assert.ok(second > first);
  assert.equal(normalizePlayingDetectedAt(second, now), second);
});

test('recovers immediately when the system clock moves backwards beyond accepted skew', () => {
  const futurePrevious = now + 60_000;

  assert.equal(nextPlayingDetectedAt(futurePrevious, now), now);
  assert.equal(normalizePlayingDetectedAt(nextPlayingDetectedAt(futurePrevious, now), now), now);
});

test('extracts the raw Story DOM token from a durable marker', () => {
  const storyDomId = storyDataId('980000000000001');
  const mark = `${storyCardMark('/stories/owner/url-card/', storyDomId)}#vm:epoch-a:1`;
  assert.equal(storyDomIdFromMark(mark), storyDomId);
});

test('extracts the raw DOM token from a real GraphQL Story node shape', () => {
  const cardId = '980000000000002';
  const storyDomId = storyDataId(cardId);

  assert.equal(
    storyDomIdFromGraphqlNode({ id: storyDomId, story_card_info: { story_card_id: cardId } }),
    storyDomId,
  );
});

test('rejects a GraphQL Story node whose decoded DOM token mismatches story_card_id', () => {
  const storyDomId = storyDataId('980000000000003');
  assert.equal(
    storyDomIdFromGraphqlNode({ id: storyDomId, story_card_info: { story_card_id: '980000000000004' } }),
    undefined,
  );
});

test('rejects malformed GraphQL Story node shapes', () => {
  const storyDomId = storyDataId('980000000000005');
  for (const malformed of [
    null,
    { id: 'not-a-story-token', story_card_info: { story_card_id: '980000000000005' } },
    { id: storyDomId },
    { id: storyDomId, story_card_info: {} },
    { id: storyDomId, story_card_info: { story_card_id: 'bad' } },
  ]) {
    assert.equal(storyDomIdFromGraphqlNode(malformed), undefined);
  }
});

test('scopes a GraphQL Story id to attachments and keeps sibling branches isolated', () => {
  const first = storyDataId('980000000000006');
  const second = storyDataId('980000000000007');

  assert.equal(storyDomIdForGraphqlChild(first, undefined, 'attachments'), first);
  assert.equal(storyDomIdForGraphqlChild(first, undefined, 'feedback'), undefined);
  assert.equal(storyDomIdForGraphqlChild(first, undefined, 'actors'), undefined);
  assert.equal(storyDomIdForGraphqlChild(undefined, first, 'media'), first);
  assert.equal(storyDomIdForGraphqlChild(second, first, 'attachments'), second);
});

test('rejects provisional and malformed Story markers', () => {
  assert.equal(storyDomIdFromMark('p:owner/url-card#vm:epoch-a:1'), undefined);
  assert.equal(storyDomIdFromMark('u:owner/not-base64#vm:epoch-a:1'), undefined);
  assert.equal(
    storyDomIdFromMark(`u:owner/${Buffer.from('wrong-prefix:980000000000001').toString('base64')}#vm:epoch-a:1`),
    undefined,
  );
});

test('mergeMedia unions, deduplicates, and keeps the newest bounded Story ids', () => {
  const storyIds = Array.from({ length: 30 }, (_value, i) => storyDataId(String(980000000000100 + i)));
  const existing = storyVideo('story-merge', '990000000000001', storyIds.slice(0, 5));
  const incoming = storyVideo('story-merge', '990000000000001', storyIds.slice(3));

  const [merged, changed] = mergeMedia([existing], [incoming]);

  assert.deepEqual(
    { changed, storyIds: merged[0]?.storyIds },
    { changed: true, storyIds: storyIds.slice(3, 3 + MAX_STORY_IDS) },
  );
});

test('mergeMedia refreshes a repeated Story id before the bounded tail evicts older associations', () => {
  const storyIds = Array.from({ length: MAX_STORY_IDS + 1 }, (_value, i) =>
    storyDataId(String(980000000000150 + i)),
  );
  const item = storyVideo('story-refresh', '990000000000009', storyIds.slice(0, MAX_STORY_IDS));

  const [refreshed, refreshChanged] = mergeMedia([item], [storyVideo('story-refresh', '990000000000009', [storyIds[0]])]);
  const [extended] = mergeMedia(refreshed, [storyVideo('story-refresh', '990000000000009', [storyIds.at(-1)!])]);

  assert.equal(refreshChanged, true);
  assert.deepEqual(extended[0]?.storyIds, [storyIds[2], storyIds[3], storyIds[4], storyIds[5], storyIds[6], storyIds[7], storyIds[0], storyIds[8]]);
});

test('sanitizeIncomingItems keeps only valid unique Story ids within the bound', () => {
  const valid = Array.from({ length: 30 }, (_value, i) => storyDataId(String(980000000000200 + i)));
  const raw = {
    ...video('story-sanitize', '990000000000002'),
    storyIds: [valid[0], 'bad', valid[0], 123, ...valid.slice(1), '9'.repeat(21)],
  };

  assert.deepEqual(sanitizeIncomingItems([raw])[0]?.storyIds, valid.slice(0, MAX_STORY_IDS));
});

test('sanitizeIncomingItems drops a malformed Story-id field without dropping the media item', () => {
  const raw = { ...video('story-sanitize-shape', '990000000000003'), storyIds: storyDataId('980000000000300') };
  const clean = sanitizeIncomingItems([raw])[0];

  assert.equal(clean?.id, raw.id);
  assert.equal(clean?.storyIds, undefined);
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

  const currentAt = now + 1_000;
  await setRecent(tabId, track(current), currentAt - 100);
  now = currentAt;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${fallback}#vm:2`, at: now });
  assert.deepEqual(await selectPlaying(tabId, [previous, current]), [previous]);

  now += 500;
  await setRecent(tabId, track(current), now);
  assert.deepEqual(await selectPlaying(tabId, [previous, current]), [current]);
});

test('hands off when the active story is detected after its first track', async () => {
  const previous = video('700000000000018', '800000000000018');
  const current = video('700000000000019', '800000000000019');
  const previousMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDE4');
  const currentMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDE5');

  await showVideo(previous, `${previousMark}#vm:epoch-a:1`);

  // The media request and Library capture can land before the 300 ms DOM poll
  // notices that the centred Story changed.
  now += 1_000;
  await setRecent(tabId, track(current), now);

  now += 300;
  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${currentMark}#vm:epoch-a:2`,
    at: now,
  });

  // Genuine playback continues across the detector boundary; a neighbour
  // prefetch that only happened before the boundary must not get this signal.
  now += 200;
  await setRecent(tabId, track(current), now);

  // Cross the handoff grace. The new Story must replace the old one instead of
  // leaving Now Playing empty while Library already contains the capture.
  now += 1_400;
  assert.deepEqual(await selectPlaying(tabId, [previous, current]), [current]);

  // The post-slide continuation confirms the association, so the durable
  // story-card binding may now be learned safely.
  flushBindingsNow();
  await flushWrites();
  const bindings = await getBind(tabId);
  assert.equal(bindings?.markBind.some(([mark]) => mark === currentMark) ?? false, true);
});

test('ranks candidates by the track closest to the new Story boundary', async () => {
  const previous = video('700000000000022', '800000000000022');
  const neighbour = video('700000000000023', '800000000000023');
  const current = video('700000000000024', '800000000000024');
  const previousMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDIy');
  const currentMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDI0');

  await showVideo(previous, `${previousMark}#vm:epoch-a:1`);

  now += 1_000;
  await setRecent(tabId, track(current), now);
  now += 450;
  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${currentMark}#vm:epoch-a:2`,
    at: now,
  });

  now += 50;
  await setRecent(tabId, track(current), now);
  now += 50;
  await setRecent(tabId, track(neighbour), now);
  now += 1_500;
  assert.deepEqual(await selectPlaying(tabId, [previous, neighbour, current]), [current]);
});

test('does not relay a lone neighbour prefetch inside the detector-skew window', async () => {
  const previous = video('700000000000025', '800000000000025');
  const neighbour = video('700000000000026', '800000000000026');
  const previousMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDI1');
  const currentMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDI2');

  await showVideo(previous, `${previousMark}#vm:epoch-a:1`);

  now += 1_000;
  await setRecent(tabId, track(neighbour), now);
  now += 300;
  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${currentMark}#vm:epoch-a:2`,
    at: now,
  });

  now += 1_600;
  assert.deepEqual(await selectPlaying(tabId, [previous, neighbour]), []);
});

test('does not relay a two-track video and audio prefetch before the active Story ref', async () => {
  const previous = video('700000000000037', '800000000000037');
  const prefetched = video('700000000000038', '800000000000038');
  const previousMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDM3');
  const currentMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDM4');

  await showVideo(previous, `${previousMark}#vm:epoch-a:1`);

  now += 1_000;
  await setRecent(tabId, track(prefetched), now);
  now += 20;
  await setRecent(tabId, audioTrack(prefetched), now);
  now += 280;
  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${currentMark}#vm:epoch-a:2`,
    at: now,
  });

  now += 1_600;
  assert.deepEqual(await selectPlaying(tabId, [previous, prefetched]), []);
});

test('does not seed an empty slot from a lone pre-ref neighbour prefetch', async () => {
  const neighbour = video('700000000000029', '800000000000029');
  const currentMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDI5');

  now += 1_000;
  await setRecent(tabId, track(neighbour), now);
  now += 300;
  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${currentMark}#vm:epoch-a:1`,
    at: now,
  });

  now += 1_600;
  assert.deepEqual(await selectPlaying(tabId, [neighbour]), []);

  // Crossing the fresh-slide window without new traffic must not turn the same
  // rejected prefetch into a valid cold-open seed.
  now += 11_500;
  assert.deepEqual(await selectPlaying(tabId, [neighbour]), []);
});

test('does not treat an older Story prefetch as part of the newly detected slide', async () => {
  const previous = video('700000000000020', '800000000000020');
  const prefetched = video('700000000000021', '800000000000021');
  const previousMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDIw');
  const currentMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDIx');

  await showVideo(previous, `${previousMark}#vm:epoch-a:1`);

  now += 1_000;
  await setRecent(tabId, track(prefetched), now);

  // This request predates the detector by more than its bounded scheduling
  // tolerance, so it remains guess-grade prefetch evidence.
  now += 800;
  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${currentMark}#vm:epoch-a:2`,
    at: now,
  });

  now += 1_600;
  assert.deepEqual(await selectPlaying(tabId, [previous, prefetched]), []);
});

test('does not select an all-pre-ref video/audio/video burst without an exact Story id', async () => {
  const first = video('700000000000032', '800000000000032');
  const second = video('700000000000033', '800000000000033');
  const current = video('700000000000034', '800000000000034');
  const firstMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDMy');
  const secondMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDMz');
  const currentMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDM0');
  const library = [first, second, current];

  await showVideo(first, `${firstMark}#vm:epoch-a:1`);

  // Real playback alternates video/audio/video requests for the same group
  // before the DOM poll publishes that card's active marker.
  now += 600;
  await setRecent(tabId, track(second), now);
  now += 20;
  await setRecent(tabId, audioTrack(second), now);
  now += 20;
  await setRecent(tabId, track(second), now);
  now += 160;
  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${secondMark}#vm:epoch-a:2`,
    at: now,
  });
  await selectPlaying(tabId, library);

  // The user advances again before the intermediate Story settles. Library has
  // every capture, but the final Story's duplicated traffic also precedes its
  // active marker rather than continuing after it.
  now += 400;
  await setRecent(tabId, track(current), now);
  now += 20;
  await setRecent(tabId, audioTrack(current), now);
  now += 20;
  await setRecent(tabId, track(current), now);
  now += 160;
  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${currentMark}#vm:epoch-a:3`,
    at: now,
  });

  now += 1_600;
  assert.deepEqual(await selectPlaying(tabId, library), []);
});

test('does not select one post-ref request without an exact Story id', async () => {
  const current = video('700000000000035', '800000000000035');
  const currentMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDM1');
  const slideAt = now;

  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${currentMark}#vm:epoch-a:1`,
    at: slideAt,
  });
  now += 100;
  await setRecent(tabId, track(current), now);

  // The ordinary recent-track tail used to hold only 24 entries. A capture
  // burst from unrelated profiles filled it after the active Story's only
  // post-slide request.
  for (let i = 0; i < 24; i++) {
    now += 10;
    const unrelated = video(`noise-${i}`, String(900000000000100 + i));
    await setRecent(tabId, track(unrelated), now);
  }
  const recent = await getRecent(tabId);
  assert.ok((recent?.tracks.length ?? 0) <= 96);
  assert.equal(recent?.tracks.some((entry) => entry.url === track(current)), true);

  now = slideAt + 4_100;
  assert.deepEqual(await selectPlaying(tabId, [current]), []);
});

test('does not select a short post-ref video/audio/video prefetch burst', async () => {
  const prefetched = video('700000000000057', '800000000000057');
  const currentMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDU3');
  const slideAt = now;

  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${currentMark}#vm:post-burst:1`, at: slideAt });
  now += 10;
  await setRecent(tabId, track(prefetched), now);
  now += 10;
  await setRecent(tabId, audioTrack(prefetched), now);
  now += 10;
  await setRecent(tabId, track(prefetched), now);
  now = slideAt + 1_600;

  assert.deepEqual(await selectPlaying(tabId, [prefetched]), []);
});

test('selects sustained playback that starts entirely after the slide marker', async () => {
  const current = video('700000000000058', '800000000000058');
  const currentMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDU4');
  const slideAt = now;

  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${currentMark}#vm:post-stream:1`, at: slideAt });
  now += 100;
  await setRecent(tabId, track(current), now);
  now += 300;
  await setRecent(tabId, audioTrack(current), now);
  now += 300;
  await setRecent(tabId, track(current), now);

  assert.deepEqual(await selectPlaying(tabId, [current]), [current]);
});

test('does not select a Story-id item for provisional, malformed, or mismatched marks', async () => {
  const storyId = '980000000000401';
  const otherStoryId = '980000000000402';
  const item = storyVideo('story-closed', '990000000000004', [storyDataId(storyId)]);
  const marks = [
    'p:owner/url-card#vm:epoch-a:1',
    'u:owner/not-base64#vm:epoch-a:2',
    `${storyCardMark('/stories/owner/url-card/', storyDataId(otherStoryId))}#vm:epoch-a:3`,
  ];

  for (const mark of marks) {
    forgetLastLive(tabId);
    await setPlaying(tabId, { ids: [], hasVideo: true, mark, at: now });
    assert.deepEqual(await selectPlaying(tabId, [item]), []);
    now += 100;
  }
});

test('selects the exact Story id when two prefetches are closer to the slide boundary', async () => {
  const storyId = '980000000000050';
  const storyDomId = storyDataId(storyId);
  const active = storyVideo('700000000000050', '800000000000050', [storyDomId]);
  const beforePrefetch = video('700000000000051', '800000000000051');
  const afterPrefetch = video('700000000000052', '800000000000052');
  const activeMark = storyCardMark('/stories/owner/url-card/', storyDomId);
  const slideAt = now + 300;

  // The active Story completes a playback-grade video/audio/video burst before
  // the 300 ms DOM detector publishes the new slide. Two one-shot neighbour
  // prefetches happen closer to that boundary, but must remain guess-grade.
  await setRecent(tabId, track(active), slideAt - 300);
  await setRecent(tabId, audioTrack(active), slideAt - 280);
  await setRecent(tabId, track(active), slideAt - 260);
  await setRecent(tabId, track(beforePrefetch), slideAt - 10);
  now = slideAt;
  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${activeMark}#vm:epoch-a:1`,
    at: slideAt,
  });
  await setRecent(tabId, track(afterPrefetch), slideAt + 10);

  const library = [active, beforePrefetch, afterPrefetch];
  now = slideAt + 5_100;
  for (let i = 0; i < 22; i++) {
    const unrelated = video(String(930000000000000 + i), String(940000000000000 + i));
    library.push(unrelated);
    await setRecent(tabId, track(unrelated), now + i * 10);
  }

  now = slideAt + 5_400;
  const selected = await selectPlaying(tabId, library);
  assert.deepEqual(selected.map((item) => item.id), [active.id]);
});

test('never retains more than 96 recent tracks during a wider request burst', async () => {
  let peak = 0;
  for (let i = 0; i < 120; i++) {
    now += 10;
    const candidate = video(`burst-${i}`, String(930000000000000 + i));
    await setRecent(tabId, track(candidate), now);
    peak = Math.max(peak, (await getRecent(tabId))?.tracks.length ?? 0);
  }

  assert.equal(peak, 96);
});

test('collapses a cooled burst without reserving the previous Story after the active ref changes', async () => {
  const old = video('700000000000040', '800000000000040');
  const oldMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDQw');
  const currentMark = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDQx');
  const slideAt = now;
  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${oldMark}#vm:epoch-a:1`,
    at: slideAt,
  });

  // Reserve enough observations that boundary retention is visible after the
  // ordinary tail fills, alternating the two real tracks of one group.
  for (let i = 0; i < 8; i++) {
    now += 10;
    await setRecent(tabId, i % 2 === 0 ? track(old) : audioTrack(old), now);
  }
  for (let i = 0; i < 40; i++) {
    now += 10;
    const unrelated = video(`cooling-${i}`, String(940000000000000 + i));
    await setRecent(tabId, track(unrelated), now);
  }

  // A later Story gets its own PlayingRef after the burst cools. The prior
  // Story's group is no longer a boundary candidate and must not stay reserved.
  now = slideAt + 12_500;
  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${currentMark}#vm:epoch-a:2`,
    at: now,
  });
  const newest = video('cooling-newest', '950000000000000');
  await setRecent(tabId, track(newest), now);

  const recent = await getRecent(tabId);
  assert.equal((recent?.tracks.length ?? Infinity) <= 24, true);
  assert.equal(
    recent?.tracks.some((entry) => entry.url === track(old) || entry.url === audioTrack(old)) ?? false,
    false,
  );
});

test('orders queued playing and recent writes before cap retention for the same tab', async () => {
  const active = video('queued-active', '800000000000056');
  const playingAt = now;
  const later = Array.from({ length: 1_500 }, (_value, i) =>
    video(`queued-later-${i}`, String(970000000000000 + i)),
  );

  // Deliberately do not await between calls: invoking each API must enqueue the
  // same-tab state in order, so addMedia sees both preceding writes when it
  // decides which oldest item may be evicted at the 1500-item cap.
  const playingWrite = setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${storyCardMark('/stories/owner/url-card/')}#vm:queued:1`,
    at: playingAt,
  });
  const recentWrite = setRecent(tabId, track(active), playingAt);
  const mediaWrite = addMedia(tabId, [active, ...later]);
  await Promise.all([playingWrite, recentWrite, mediaWrite]);

  const [stored, playing, recent] = await Promise.all([getMedia(tabId), getPlaying(tabId), getRecent(tabId)]);
  assert.deepEqual(
    {
      storedCount: stored.length,
      retainedActive: stored.some((item) => item.id === active.id),
      playingAt: playing?.at,
      recentActive: recent?.tracks.some((entry) => entry.url === track(active)) ?? false,
    },
    { storedCount: 1_500, retainedActive: true, playingAt, recentActive: true },
  );
});

test('does not let an older queued PlayingRef overwrite a newer Story boundary', async () => {
  const newer = setPlaying(tabId, { ids: [], hasVideo: true, mark: 'u:owner/newer', at: now + 100 });
  const older = setPlaying(tabId, { ids: [], hasVideo: true, mark: 'u:owner/older', at: now });
  await Promise.all([newer, older]);

  assert.deepEqual(await getPlaying(tabId), { ids: [], hasVideo: true, mark: 'u:owner/newer', at: now + 100 });
});

test('retains the active Story when 1500 later captures fill Library', async () => {
  const storyId = '980000000000036';
  const storyDomId = storyDataId(storyId);
  const current = storyVideo('700000000000036', '800000000000036', [storyDomId]);
  const currentMark = storyCardMark('/stories/owner/url-card/', storyDomId);

  await showVideo(current, `${currentMark}#vm:epoch-a:1`);
  await addMedia(tabId, [current]);

  const later: MediaItem[] = [];
  for (let i = 0; i < 1_500; i++) {
    later.push(video(`library-${i}`, String(910000000000000 + i)));
  }
  await addMedia(tabId, later);

  const stored = await getMedia(tabId);
  const storedCurrent = stored.find((item) => item.id === current.id);
  assert.deepEqual(
    {
      storedId: storedCurrent?.id,
      storyIds: storedCurrent?.storyIds,
      playingIds: (await selectPlaying(tabId, stored)).map((item) => item.id),
    },
    { storedId: current.id, storyIds: [storyDomId], playingIds: [current.id] },
  );
});

test('retains an already-confirmed Story when later captures arrive without a GraphQL Story id', async () => {
  const current = video('700000000000057', '800000000000057');
  const currentMark = storyCardMark('/stories/owner/url-card/', storyDataId('980000000000057'));

  await setPlaying(tabId, {
    ids: [current.id],
    hasVideo: true,
    mark: `${currentMark}#vm:epoch-a:1`,
    at: now,
  });
  assert.deepEqual(await selectPlaying(tabId, [current]), [current]);
  await addMedia(tabId, [current]);

  // Facebook can replace the MediaSource while keeping the same DOM Story card.
  // The replacement blob exposes no direct id and the initial GraphQL response
  // may have lacked the card association, but the selector already proved which
  // group belongs to this Story before the Library needs to shed old entries.
  now += 2_000;
  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${currentMark}#vm:epoch-b:1`,
    at: now,
  });

  const later = Array.from({ length: 1_500 }, (_value, i) =>
    video(`confirmed-later-${i}`, String(980000000100000 + i)),
  );
  await addMedia(tabId, later);

  const stored = await getMedia(tabId);
  assert.deepEqual(
    {
      retainedActive: stored.some((item) => item.id === current.id),
      playingIds: (await selectPlaying(tabId, stored)).map((item) => item.id),
    },
    { retainedActive: true, playingIds: [current.id] },
  );
});

test('a retention pin never selects a video by itself', async () => {
  const item = video('700000000000060', '800000000000060');
  const mark = storyCardMark('/stories/owner/url-card/', storyDataId('980000000000060'));
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${mark}#vm:1`, at: now });
  const identity = playingRetentionIdentity(await getPlaying(tabId));
  assert.ok(identity);

  await setPlayingMediaPin(tabId, identity, [videoGroupKey(item)], now);

  assert.deepEqual(await selectPlaying(tabId, [item]), []);
});

test('a confirmed Story pin is ignored after the DOM Story identity changes', async () => {
  const item = video('700000000000061', '800000000000061');
  const first = storyCardMark('/stories/owner/url-card/', storyDataId('980000000000061'));
  const second = storyCardMark('/stories/owner/url-card/', storyDataId('980000000000062'));
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${first}#vm:1`, at: now });
  const identity = playingRetentionIdentity(await getPlaying(tabId));
  assert.ok(identity);
  await setPlayingMediaPin(tabId, identity, [videoGroupKey(item)], now);
  await addMedia(tabId, [item]);

  now += 2_000;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${second}#vm:2`, at: now });
  const later = Array.from({ length: 1_500 }, (_value, i) =>
    video(`identity-changed-${i}`, String(980000000200000 + i)),
  );
  await addMedia(tabId, later);

  assert.equal((await getMedia(tabId)).some((stored) => stored.id === item.id), false);
});

test('a confirmed Story pin is ignored when the current card has no video', async () => {
  const item = video('700000000000063', '800000000000063');
  const mark = storyCardMark('/stories/owner/url-card/', storyDataId('980000000000063'));
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${mark}#vm:1`, at: now });
  const identity = playingRetentionIdentity(await getPlaying(tabId));
  assert.ok(identity);
  await setPlayingMediaPin(tabId, identity, [videoGroupKey(item)], now);
  await addMedia(tabId, [item]);

  now += 2_000;
  await setPlaying(tabId, { ids: [], hasVideo: false, mark, at: now });
  const later = Array.from({ length: 1_500 }, (_value, i) =>
    video(`photo-card-${i}`, String(980000000300000 + i)),
  );
  await addMedia(tabId, later);

  assert.equal((await getMedia(tabId)).some((stored) => stored.id === item.id), false);
});

test('an older pin write cannot replace a newer confirmation', async () => {
  const newer = video('700000000000064', '800000000000064');
  const older = video('700000000000065', '800000000000065');
  const mark = storyCardMark('/stories/owner/url-card/', storyDataId('980000000000064'));
  now += 200;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${mark}#vm:1`, at: now });
  const identity = playingRetentionIdentity(await getPlaying(tabId));
  assert.ok(identity);

  await setPlayingMediaPin(tabId, identity, [videoGroupKey(newer)], now);
  await setPlayingMediaPin(tabId, identity, [videoGroupKey(older)], now - 100);

  const stored = (await chrome.storage.session.get(`playing_pin_${tabId}`))[`playing_pin_${tabId}`] as {
    groups?: string[];
  };
  assert.deepEqual(stored.groups, [videoGroupKey(newer)]);
});

test('a failed pin write reports failure and can be retried after storage recovers', async () => {
  const item = video('700000000000070', '800000000000070');
  const mark = storyCardMark('/stories/owner/url-card/', storyDataId('980000000000070'));
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${mark}#vm:1`, at: now });
  const identity = playingRetentionIdentity(await getPlaying(tabId));
  assert.ok(identity);

  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let failed = false;
  session.set = async (values): Promise<void> => {
    if (!failed && `playing_pin_${tabId}` in values) {
      failed = true;
      throw new Error('simulated pin backend failure');
    }
    await realSet(values);
  };

  try {
    assert.equal(await setPlayingMediaPin(tabId, identity, [videoGroupKey(item)], now), false);
    assert.equal(await setPlayingMediaPin(tabId, identity, [videoGroupKey(item)], now), true);
  } finally {
    session.set = realSet;
  }

  const stored = (await chrome.storage.session.get(`playing_pin_${tabId}`))[`playing_pin_${tabId}`] as {
    groups?: string[];
  };
  assert.equal(failed, true);
  assert.deepEqual(stored.groups, [videoGroupKey(item)]);
});

test('clearTab removes the confirmed-media retention pin', async () => {
  const item = video('700000000000066', '800000000000066');
  const mark = storyCardMark('/stories/owner/url-card/', storyDataId('980000000000066'));
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${mark}#vm:1`, at: now });
  const identity = playingRetentionIdentity(await getPlaying(tabId));
  assert.ok(identity);
  await setPlayingMediaPin(tabId, identity, [videoGroupKey(item)], now);

  await clearTab(tabId);

  assert.equal((await chrome.storage.session.get(`playing_pin_${tabId}`))[`playing_pin_${tabId}`], undefined);
});

test('a confirmed pin survives panel-memory loss and still protects Library retention', async () => {
  const item = video('700000000000067', '800000000000067');
  const mark = storyCardMark('/stories/owner/url-card/', storyDataId('980000000000067'));
  await setPlaying(tabId, { ids: [item.id], hasVideo: true, mark: `${mark}#vm:epoch-a:1`, at: now });
  assert.deepEqual(await selectPlaying(tabId, [item]), [item]);
  await addMedia(tabId, [item]);

  purgeTabBindings(tabId);
  now += 2_000;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${mark}#vm:epoch-b:1`, at: now });
  const later = Array.from({ length: 1_500 }, (_value, i) =>
    video(`panel-restart-${i}`, String(980000000400000 + i)),
  );
  await addMedia(tabId, later);

  assert.equal((await getMedia(tabId)).some((stored) => stored.id === item.id), true);
});

test('quota fallback retains a confirmed group even when the item has no Story id', async () => {
  const item = video('700000000000068', '800000000000068');
  const mark = storyCardMark('/stories/owner/url-card/', storyDataId('980000000000068'));
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${mark}#vm:1`, at: now });
  const identity = playingRetentionIdentity(await getPlaying(tabId));
  assert.ok(identity);
  await setPlayingMediaPin(tabId, identity, [videoGroupKey(item)], now);

  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let failedMediaWrite = false;
  session.set = async (values): Promise<void> => {
    if (!failedMediaWrite && `media_${tabId}` in values) {
      failedMediaWrite = true;
      const error = new Error('QUOTA_BYTES quota exceeded');
      error.name = 'QuotaExceededError';
      throw error;
    }
    await realSet(values);
  };

  try {
    const later = Array.from({ length: 10 }, (_value, i) =>
      video(`pinned-quota-${i}`, String(980000000500000 + i)),
    );
    await addMedia(tabId, [item, ...later]);
  } finally {
    session.set = realSet;
  }

  assert.equal(failedMediaWrite, true);
  assert.equal((await getMedia(tabId)).some((stored) => stored.id === item.id), true);
});

test('retains the exact Story id at the Library cap when two prefetches are closer to the boundary', async () => {
  const storyId = '980000000000053';
  const storyDomId = storyDataId(storyId);
  const active = storyVideo('700000000000053', '800000000000053', [storyDomId]);
  const beforePrefetch = video('700000000000054', '800000000000054');
  const afterPrefetch = video('700000000000055', '800000000000055');
  const activeMark = storyCardMark('/stories/owner/url-card/', storyDomId);
  const slideAt = now + 300;

  await setRecent(tabId, track(active), slideAt - 300);
  await setRecent(tabId, audioTrack(active), slideAt - 280);
  await setRecent(tabId, track(active), slideAt - 260);
  await setRecent(tabId, track(beforePrefetch), slideAt - 10);
  now = slideAt;
  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${activeMark}#vm:epoch-a:1`,
    at: slideAt,
  });
  await setRecent(tabId, track(afterPrefetch), slideAt + 10);

  now = slideAt + 5_100;
  const later: MediaItem[] = [beforePrefetch, afterPrefetch];
  for (let i = 0; i < 1_498; i++) {
    const unrelated = video(String(950000000000000 + i), String(960000000000000 + i));
    later.push(unrelated);
    if (i < 22) await setRecent(tabId, track(unrelated), now + i * 10);
  }

  await addMedia(tabId, [active]);
  await addMedia(tabId, later);

  const stored = await getMedia(tabId);
  const storedActive = stored.find((item) => item.id === active.id);
  assert.equal(stored.length, 1_500);
  assert.deepEqual(
    {
      storedId: storedActive?.id,
      storyIds: storedActive?.storyIds,
      playingIds: (await selectPlaying(tabId, stored)).map((item) => item.id),
    },
    { storedId: active.id, storyIds: [storyDomId], playingIds: [active.id] },
  );
});

test('retains the active Story when the first Library write hits the quota fallback', async () => {
  const storyId = '980000000000039';
  const storyDomId = storyDataId(storyId);
  const current = storyVideo('700000000000039', '800000000000039', [storyDomId]);
  const currentMark = storyCardMark('/stories/owner/url-card/', storyDomId);
  await showVideo(current, `${currentMark}#vm:epoch-a:1`);

  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let failedMediaWrite = false;
  session.set = async (values): Promise<void> => {
    if (!failedMediaWrite && `media_${tabId}` in values) {
      failedMediaWrite = true;
      const error = new Error('QUOTA_BYTES quota exceeded');
      error.name = 'QuotaExceededError';
      throw error;
    }
    await realSet(values);
  };

  try {
    const later: MediaItem[] = [];
    for (let i = 0; i < 10; i++) later.push(video(`quota-${i}`, String(920000000000000 + i)));
    await addMedia(tabId, [current, ...later]);
  } finally {
    session.set = realSet;
  }

  const stored = await getMedia(tabId);
  const storedCurrent = stored.find((item) => item.id === current.id);
  assert.equal(failedMediaWrite, true);
  assert.deepEqual(
    {
      storedId: storedCurrent?.id,
      storyIds: storedCurrent?.storyIds,
      playingIds: (await selectPlaying(tabId, stored)).map((item) => item.id),
    },
    { storedId: current.id, storyIds: [storyDomId], playingIds: [current.id] },
  );
});

test('does not halve Library after a transient non-quota media write failure', async () => {
  const before = Array.from({ length: 4 }, (_value, i) =>
    video(`transient-stored-${i}`, String(960000000000000 + i)),
  );
  await addMedia(tabId, before);

  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let failedMediaWrite = false;
  session.set = async (values): Promise<void> => {
    if (!failedMediaWrite && `media_${tabId}` in values) {
      failedMediaWrite = true;
      throw new TypeError('simulated transient backend failure');
    }
    await realSet(values);
  };

  const incoming = Array.from({ length: 4 }, (_value, i) =>
    video(`transient-new-${i}`, String(970000000000000 + i)),
  );
  try {
    await addMedia(tabId, incoming);
  } finally {
    session.set = realSet;
  }

  const stored = await getMedia(tabId);
  assert.equal(failedMediaWrite, true);
  assert.deepEqual(stored.map((item) => item.id), [...before, ...incoming].map((item) => item.id));
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

test('keeps an unbound video while the same DOM Story survives a long download and MediaSource reload', async () => {
  const item = video('700000000000058', '800000000000058');
  const durable = storyCardMark('/stories/owner/url-card/', storyDataId('980000000000058'));

  // Direct DOM evidence identifies the initial video, but deliberately provide
  // no fetch evidence and no storyIds so no learned mark binding can rescue it.
  await setPlaying(tabId, {
    ids: [item.id],
    hasVideo: true,
    mark: `${durable}#vm:epoch-a:1`,
    at: now,
  });
  assert.deepEqual(await selectPlaying(tabId, [item]), [item]);

  // A large remux/download can outlive the ordinary sticky grace and Facebook
  // may replace the MSE handle. The durable card id still proves this is the
  // same Story, so neither elapsed time nor vm churn is a slide transition.
  now += 5 * 60 * 1000 + 2_000;
  const reloadedAt = now;
  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${durable}#vm:epoch-b:1`,
    at: reloadedAt,
  });
  now = reloadedAt + 2_000;

  assert.deepEqual(await selectPlaying(tabId, [item]), [item]);

  const next = storyCardMark('/stories/owner/url-card/', storyDataId('980000000000059'));
  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${next}#vm:epoch-b:2`,
    at: now,
  });
  now += 2_000;

  assert.deepEqual(await selectPlaying(tabId, [item]), []);
});

test('keeps the same durable Story through repeated polls beyond five minutes without traffic or a new PlayingRef', async () => {
  const item = video('700000000000072', '800000000000072');
  const durable = storyCardMark('/stories/owner/url-card/', storyDataId('980000000000072'));
  await setPlaying(tabId, {
    ids: [item.id],
    hasVideo: true,
    mark: `${durable}#vm:epoch-a:1`,
    at: now,
  });
  assert.deepEqual(await selectPlaying(tabId, [item]), [item]);

  // The direct id can disappear after Facebook settles the MSE element. From
  // here on there are no network tracks and no further PlayingRef writes — only
  // the panel's ordinary render polls observe that this same DOM card survives.
  now += 1_000;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${durable}#vm:epoch-a:1`, at: now });
  for (let minute = 0; minute < 7; minute++) {
    now += 60_000;
    assert.deepEqual(await selectPlaying(tabId, [item]), [item]);
  }
});

test('never falls back to a panel-local pin write when the worker declines the production request', async () => {
  const item = video('700000000000073', '800000000000073');
  const durable = storyCardMark('/stories/owner/url-card/', storyDataId('980000000000073'));
  await setPlaying(tabId, {
    ids: [item.id],
    hasVideo: true,
    mark: `${durable}#vm:epoch-a:1`,
    at: now,
  });

  const runtimeHost = chrome as unknown as { runtime?: { sendMessage: (message: unknown) => Promise<unknown> } };
  const previousRuntime = runtimeHost.runtime;
  let requests = 0;
  runtimeHost.runtime = {
    async sendMessage(): Promise<unknown> {
      requests++;
      return { ok: false };
    },
  };
  try {
    assert.deepEqual(await selectPlaying(tabId, [item]), [item]);
    assert.deepEqual(await selectPlaying(tabId, [item]), [item]);
  } finally {
    if (previousRuntime === undefined) delete runtimeHost.runtime;
    else runtimeHost.runtime = previousRuntime;
  }

  assert.equal(requests, 2);
  assert.equal((await chrome.storage.session.get(`playing_pin_${tabId}`))[`playing_pin_${tabId}`], undefined);
});

test('does not retain or pin a legacy URL-derived u: marker across MediaSource reloads', async () => {
  const item = video('700000000000071', '800000000000071');
  const legacy = 'u:owner/url-card';

  await setPlaying(tabId, {
    ids: [item.id],
    hasVideo: true,
    mark: `${legacy}#vm:epoch-a:1`,
    at: now,
  });
  assert.deepEqual(await selectPlaying(tabId, [item]), [item]);
  assert.equal((await chrome.storage.session.get(`playing_pin_${tabId}`))[`playing_pin_${tabId}`], undefined);

  now += 2_000;
  await setPlaying(tabId, {
    ids: [],
    hasVideo: true,
    mark: `${legacy}#vm:epoch-b:1`,
    at: now - 2_000,
  });

  assert.deepEqual(await selectPlaying(tabId, [item]), []);
  assert.equal((await chrome.storage.session.get(`playing_pin_${tabId}`))[`playing_pin_${tabId}`], undefined);
});

test('clears an unbound video when the same durable Story stably reports no video', async () => {
  const item = video('700000000000069', '800000000000069');
  const durable = storyCardMark('/stories/owner/url-card/', storyDataId('980000000000069'));
  await setPlaying(tabId, {
    ids: [item.id],
    hasVideo: true,
    mark: `${durable}#vm:epoch-a:1`,
    at: now,
  });
  assert.deepEqual(await selectPlaying(tabId, [item]), [item]);

  now += 2_000;
  await setPlaying(tabId, { ids: [], hasVideo: false, mark: durable, at: now });

  assert.deepEqual(await selectPlaying(tabId, [item]), []);
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

test('persists a durable Story binding from direct DOM evidence without Story ids or network traffic', async () => {
  const item = video('700000000000108', '800000000000108');
  const durable = storyCardMark('/stories/owner/url-card/', storyDataId('980000000000108'));

  await setPlaying(tabId, { ids: [item.id], hasVideo: true, mark: `${durable}#vm:epoch-a:1`, at: now });
  assert.deepEqual(await selectPlaying(tabId, [item]), [item]);
  flushBindingsNow();
  await flushWrites();
  assert.equal((await getBind(tabId))?.markBind.some(([mark]) => mark === durable), true);

  purgeTabBindings(tabId);
  await loadBindings(tabId);
  now += 20_000;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${durable}#vm:epoch-b:1`, at: now });

  assert.deepEqual(await selectPlaying(tabId, [item]), [item]);
});

test('keeps a buffered revisit despite a lone pre-ref neighbour prefetch', async () => {
  const item = video('700000000000027', '800000000000027');
  const neighbour = video('700000000000028', '800000000000028');
  const durable = storyCardMark('/stories/owner/url-card/', 'UzM6NzAwMDAwMDAwMDAwMDI3');

  assert.deepEqual(await showVideo(item, `${durable}#vm:epoch-a:1`), [item]);
  await flushWrites();

  purgeTabBindings(tabId);
  await chrome.storage.session.remove(`recent_${tabId}`);
  await loadBindings(tabId);

  now += 20_000;
  await setRecent(tabId, track(neighbour), now);
  now += 300;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${durable}#vm:epoch-b:1`, at: now });

  assert.deepEqual(await selectPlaying(tabId, [item, neighbour]), [item]);
});

test('does not let legacy URL-derived u: bindings match a new provisional fallback', async () => {
  const legacy = video('700000000000009', '800000000000009');
  const currentStoryDomId = storyDataId('700000000000010');
  const current = storyVideo('700000000000010', '800000000000010', [currentStoryDomId]);
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

  const currentDomMark = storyCardMark('/stories/owner/url-card/', currentStoryDomId);
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

  const secondAt = now + 1_000;
  await setRecent(tabId, track(second), secondAt - 100);
  now = secondAt;
  await setPlaying(tabId, { ids: [], hasVideo: true, mark: `${provisional}#vm:epoch-a:2`, at: now });
  assert.deepEqual(await selectPlaying(tabId, all), [first]);
  now += 500;
  await setRecent(tabId, track(second), now);
  assert.deepEqual(await selectPlaying(tabId, all), [second]);

  const thirdAt = now + 1_000;
  await setRecent(tabId, track(third), thirdAt - 100);
  now = thirdAt;
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

// --- Reels: the surface that actually fails, and had no coverage at all ---

test('follows the reel named by the page URL without any cover or mark', async () => {
  const reel = video('asset-r1', '900000000000001');
  await setPlaying(tabId, { ids: [], hasVideo: true, vid: '900000000000001', at: now });

  assert.deepEqual(await selectPlaying(tabId, [reel]), [reel]);
});

test('does not follow a reel whose id the URL does not name', async () => {
  const other = video('asset-r2', '900000000000002');
  await setPlaying(tabId, { ids: [], hasVideo: true, vid: '900000000000001', at: now });

  assert.deepEqual(await selectPlaying(tabId, [other]), []);
});

test('swaps reels on the URL id even when the slide mark never advances', async () => {
  // The videoMark failure mode: Facebook reuses the MediaSourceHandle, so the
  // mark is identical across two different reels. The URL id must still move.
  const first = video('asset-r1', '900000000000001');
  const second = video('asset-r2', '900000000000002');
  const stuck = 'vm:reused';
  await setPlaying(tabId, { ids: [], hasVideo: true, vid: '900000000000001', mark: stuck, at: now });
  assert.deepEqual(await selectPlaying(tabId, [first, second]), [first]);

  now += 2_000;
  await setPlaying(tabId, { ids: [], hasVideo: true, vid: '900000000000002', mark: stuck, at: now });

  assert.deepEqual(await selectPlaying(tabId, [first, second]), [second]);
});

// --- coverBind poisoning ---
// endorse() writes coverBind, domMatch reads it as DOM-grade, and DOM-grade wins
// the cascade unconditionally — so a binding learned from a wrong guess confirms
// itself forever. The code comments record this being observed in the wild.

/** Seed coverBind[cover] = group(item) the way endorse() does: the cover is the
 *  centered id while `item` is the anchored stream, so the binding is learned
 *  from association alone. Deliberately NO thumbUrl link — with one the item
 *  would keep matching on this tick's own evidence, which is never poisoned and
 *  is not what this guards. */
async function poison(item: MediaItem, coverUrl: string): Promise<void> {
  const playingAt = now;
  await setRecent(tabId, track(item), playingAt - 100);
  await setPlaying(tabId, { ids: [mediaId(coverUrl)], hasVideo: true, at: playingAt });
  now = playingAt + 100;
  await setRecent(tabId, track(item), now);
  await selectPlaying(tabId, [item]);
  flushBindingsNow();
}

test('drops a poisoned cover binding once another video keeps streaming under it', async () => {
  const cover = photo('cover-1');
  const wrong = video('asset-w', '900000000000010');
  const real = video('asset-t', '900000000000011');
  await poison(wrong, cover.url);
  assert.deepEqual(await selectPlaying(tabId, [wrong, real]), [wrong]);

  // Same cover still centred, but every fresh track belongs to `real`.
  for (let tick = 0; tick < 3; tick++) {
    const playingAt = now + 2_000;
    await setRecent(tabId, track(real), playingAt - 100);
    now = playingAt;
    await setPlaying(tabId, { ids: [mediaId(cover.url)], hasVideo: true, at: now });
    now += 100;
    await setRecent(tabId, track(real), now);
    await selectPlaying(tabId, [wrong, real]);
  }

  assert.deepEqual(await selectPlaying(tabId, [wrong, real]), [real]);
});

test('keeps a cover binding through a single contradicting burst', async () => {
  // One tick cannot tell the watched video from a deep bucket's prefetch — the
  // ambiguity endorse() already documents. Only a sustained contradiction counts.
  const cover = photo('cover-2');
  const bound = video('asset-b', '900000000000020');
  const blip = video('asset-p', '900000000000021');
  await poison(bound, cover.url);

  const playingAt = now + 2_000;
  await setRecent(tabId, track(blip), playingAt - 100);
  now = playingAt;
  await setPlaying(tabId, { ids: [mediaId(cover.url)], hasVideo: true, at: now });
  now += 100;
  await setRecent(tabId, track(blip), now);

  assert.deepEqual(await selectPlaying(tabId, [bound, blip]), [bound]);

  // Re-reading the same recent-track snapshot is still one burst, not a second
  // contradiction. Poll frequency must never evict a valid binding by itself.
  now += 2_000;
  assert.deepEqual(await selectPlaying(tabId, [bound, blip]), [bound]);
});

test('does not combine binding contradictions from different Story slides', async () => {
  const firstCover = photo('cover-3');
  const secondCover = photo('cover-4');
  const bound = video('asset-c', '900000000000030');
  const blip = video('asset-q', '900000000000031');

  await poison(bound, firstCover.url);
  forgetLastLive(tabId);
  now += 1_000;
  await poison(bound, secondCover.url);

  const firstAt = now + 2_000;
  await setRecent(tabId, track(blip), firstAt - 100);
  now = firstAt;
  await setPlaying(tabId, { ids: [mediaId(firstCover.url)], hasVideo: true, mark: 'vm:slide-a', at: firstAt });
  now += 100;
  await setRecent(tabId, track(blip), now);
  assert.deepEqual(await selectPlaying(tabId, [bound, blip]), [bound]);

  const secondAt = now + 2_000;
  await setRecent(tabId, track(blip), secondAt - 100);
  now = secondAt;
  await setPlaying(tabId, { ids: [mediaId(secondCover.url)], hasVideo: true, mark: 'vm:slide-b', at: secondAt });
  now += 100;
  await setRecent(tabId, track(blip), now);
  assert.deepEqual(await selectPlaying(tabId, [bound, blip]), [bound]);
});
