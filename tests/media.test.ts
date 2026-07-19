import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_MEDIA_ITEM_BYTES,
  MAX_MEDIA_BATCH_BYTES,
  MAX_TRACK_IDS,
  mediaId,
  mediaItemWeight,
  mergeMedia,
  sanitizeIncomingItems,
  type MediaItem,
} from '../src/shared/media';

const URL = 'https://video.xx.fbcdn.net/v/t42.1790-2/12345678901234567_n.mp4';

function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'fb:12345678901234567',
    url: URL,
    kind: 'video',
    source: 'story',
    origin: 'graphql',
    addedAt: 1,
    ...overrides,
  };
}

test('sanitizeIncomingItems inspects only the bounded track-id prefix', () => {
  const backing = Array.from({ length: MAX_TRACK_IDS + 10_000 }, (_, index) => `track-${index}`);
  const guarded = new Proxy(backing, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property) && Number(property) >= MAX_TRACK_IDS) {
        throw new Error('read beyond bounded prefix');
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const clean = sanitizeIncomingItems([item({ trackIds: guarded })]);
  assert.equal(clean.length, 1);
  assert.equal(clean[0].trackIds?.length, MAX_TRACK_IDS);
});

test('sanitizeIncomingItems rejects a MediaItem above the serialized byte bound', () => {
  const oversized = item({
    id: 'á'.repeat(256),
    url: `${URL}?x=${'á'.repeat(8_000)}`,
    audioUrl: `${URL}?a=${'á'.repeat(8_000)}`,
    thumbUrl: `https://scontent.xx.fbcdn.net/v/t1.0-9/12345678901234567_n.jpg?t=${'á'.repeat(8_000)}`,
    trackIds: Array.from({ length: MAX_TRACK_IDS }, () => 'á'.repeat(512)),
  });

  assert.ok(mediaItemWeight(oversized) > MAX_MEDIA_ITEM_BYTES);
  assert.deepEqual(sanitizeIncomingItems([oversized]), []);
});

test('sanitizeIncomingItems enforces an aggregate runtime-message byte budget', () => {
  const first = item({ id: 'first', trackIds: Array.from({ length: 4 }, () => 'a'.repeat(512)) });
  const second = item({ id: 'second', trackIds: Array.from({ length: 4 }, () => 'b'.repeat(512)) });
  const now = 1_800_000_000_000;
  const canonicalFirst = sanitizeIncomingItems([first], Number.POSITIVE_INFINITY, now)[0];
  const firstBytes = mediaItemWeight(canonicalFirst);

  assert.ok(firstBytes < MAX_MEDIA_BATCH_BYTES);
  assert.deepEqual(
    sanitizeIncomingItems([first, second], firstBytes + 10, now).map((entry) => entry.id),
    [mediaId(URL)],
  );
});

test('mergeMedia bounds track ids and rejects oversized persisted candidates defensively', () => {
  const bounded = mergeMedia([], [item({
    trackIds: Array.from({ length: MAX_TRACK_IDS + 50 }, (_, index) => `track-${index}`),
  })])[0];
  assert.equal(bounded[0].trackIds?.length, MAX_TRACK_IDS);

  const oversized = item({ extra: 'á'.repeat(MAX_MEDIA_ITEM_BYTES) } as Partial<MediaItem>);
  assert.deepEqual(mergeMedia([], [oversized]), [[], false]);
});

test('sanitizeIncomingItems derives one canonical id for the same URL regardless of forged ids', () => {
  const now = 1_800_000_000_000;
  const [first, second] = sanitizeIncomingItems([
    item({ id: 'forged-a', addedAt: now }),
    item({ id: 'forged-b', addedAt: now }),
  ], Number.POSITIVE_INFINITY, now);

  assert.equal(first.id, mediaId(URL));
  assert.equal(second.id, first.id);
});

test('canonical media ids do not collide when two URLs carry the same forged id', () => {
  const now = 1_800_000_000_000;
  const otherUrl = 'https://video.xx.fbcdn.net/v/t42.1790-2/22345678901234567_n.mp4';
  const clean = sanitizeIncomingItems([
    item({ id: 'shared-forgery', addedAt: now }),
    item({ id: 'shared-forgery', url: otherUrl, addedAt: now }),
  ], Number.POSITIVE_INFINITY, now);

  assert.equal(clean.length, 2);
  assert.notEqual(clean[0].id, clean[1].id);

  const [merged] = mergeMedia([], clean, now);
  assert.equal(merged.length, 2);
});

test('mediaId keeps DASH representations distinct but ignores routing and signature rotation', () => {
  const first = 'https://video.xx.fbcdn.net/v/t42/12345678901234567/video-720.mp4?bytestart=0&byteend=99&oh=a&oe=1';
  const routed = 'https://video-other.xx.fbcdn.net/o1/v/t42/12345678901234567/video-720.mp4?bytestart=100&byteend=199&oh=b&oe=2';
  const otherRepresentation = 'https://video.xx.fbcdn.net/v/t42/12345678901234567/video-1080.mp4?oh=c&oe=3';

  assert.equal(mediaId(first), mediaId(routed));
  assert.notEqual(mediaId(first), mediaId(otherRepresentation));
});

test('sanitizeIncomingItems normalizes remote and future dates while preserving in-flight dates', () => {
  const now = 1_800_000_000_000;
  const legitimate = now - 30_000;
  const urls = [
    URL,
    'https://video.xx.fbcdn.net/v/t42.1790-2/22345678901234567_n.mp4',
    'https://video.xx.fbcdn.net/v/t42.1790-2/32345678901234567_n.mp4',
  ];
  const clean = sanitizeIncomingItems([
    item({ url: urls[0], addedAt: legitimate }),
    item({ url: urls[1], addedAt: now - 86_400_000 }),
    item({ url: urls[2], addedAt: now + 86_400_000 }),
  ], Number.POSITIVE_INFINITY, now);

  assert.deepEqual(clean.map((entry) => entry.addedAt), [legitimate, now, now]);
});

test('mergeMedia canonicalizes ids and dates even when callers bypass sanitization', () => {
  const now = 1_800_000_000_000;
  const [merged] = mergeMedia([], [
    item({ id: 'first-forgery', addedAt: now - 86_400_000 }),
    item({ id: 'second-forgery', addedAt: now + 86_400_000 }),
  ], now);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, mediaId(URL));
  assert.equal(merged[0].addedAt, now);
});

test('mergeMedia compacts legacy rows that assigned different ids to the same URL', () => {
  const now = 1_800_000_000_000;
  const [merged, changed] = mergeMedia([
    item({ id: 'legacy-a', addedAt: now }),
    item({ id: 'legacy-b', addedAt: now }),
  ], [], now);

  assert.equal(changed, true);
  assert.deepEqual(merged.map((entry) => entry.id), [mediaId(URL)]);
});

test('mergeMedia enriches near-limit rows transactionally without dropping stored fields', () => {
  const now = 1_800_000_000_000;
  const largeUrl = `${URL}?stable=${'á'.repeat(7_000)}`;
  const storedThumb = `https://scontent.xx.fbcdn.net/v/t1.0-9/12345678901234567_n.jpg?thumb=${'á'.repeat(7_000)}`;
  const incomingAudio = `https://video.xx.fbcdn.net/v/t42.1790-2/92345678901234567_n.mp4?audio=${'á'.repeat(7_000)}`;
  const incomingTracks = Array.from({ length: 28 }, (_, index) => `${index}-${'á'.repeat(508)}`);
  const storyId = Buffer.from('S:_ISC:980000000009999').toString('base64');
  const stored = item({
    id: 'stored-id-is-not-authority',
    url: largeUrl,
    thumbUrl: storedThumb,
    addedAt: now,
  });
  const incoming = item({
    id: 'incoming-id-is-not-authority',
    url: largeUrl,
    audioUrl: incomingAudio,
    trackIds: incomingTracks,
    storyIds: [storyId],
    addedAt: now,
  });

  assert.ok(mediaItemWeight(stored) <= MAX_MEDIA_ITEM_BYTES);
  assert.ok(mediaItemWeight(incoming) <= MAX_MEDIA_ITEM_BYTES);
  assert.ok(mediaItemWeight({ ...stored, ...incoming, thumbUrl: storedThumb }) > MAX_MEDIA_ITEM_BYTES);

  const [merged, changed] = mergeMedia([stored], [incoming], now);
  const result = merged[0];

  assert.equal(changed, true);
  assert.ok(mediaItemWeight(result) <= MAX_MEDIA_ITEM_BYTES);
  assert.equal(result.thumbUrl, storedThumb, 'an existing low-priority field is never discarded');
  assert.deepEqual(result.storyIds, [storyId], 'the strongest exact association is retained');
  assert.equal(result.audioUrl, incomingAudio, 'linked audio is preferred before new low-priority metadata');
  assert.ok((result.trackIds?.length ?? 0) > 0, 'a useful bounded track prefix is retained');
  assert.ok((result.trackIds?.length ?? 0) < incomingTracks.length, 'the overweight track tail is dropped');
});
