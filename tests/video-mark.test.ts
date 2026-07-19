import assert from 'node:assert/strict';
import test from 'node:test';

import { combineVideoMark, createVideoMarkFactory } from '../src/shared/video-mark';

test('keeps one marker per load and advances for a new load', () => {
  const mark = createVideoMarkFactory('epoch-a');
  const firstLoad = {};

  assert.equal(mark(firstLoad, 'blob:first'), 'vm:epoch-a:1');
  assert.equal(mark(firstLoad, 'blob:first'), 'vm:epoch-a:1');
  assert.equal(mark({}, 'blob:second'), 'vm:epoch-a:2');
});

test('does not recycle vm:1 across content-script epochs', () => {
  const key = {};

  assert.notEqual(createVideoMarkFactory('epoch-a')(key, ''), createVideoMarkFactory('epoch-b')(key, ''));
});

test('preserves and bounds progressive source markers', () => {
  const mark = createVideoMarkFactory('epoch-a');
  const source = `https://video.xx.fbcdn.net/${'a'.repeat(220)}`;

  assert.equal(mark({}, source), source.slice(0, 200));
});

test('advances the mark between reels even when the load key is reused', () => {
  const mark = createVideoMarkFactory('epoch-a');
  // Facebook can hand two different reels the SAME MediaSourceHandle (or, mid
  // transition, a pooled <video> with srcObject still null) — the WeakMap then
  // mints one id for both slides and the panel stays pinned to the first.
  const reusedKey = {};
  const first = combineVideoMark(mark(reusedKey, ''), '111111111');
  const second = combineVideoMark(mark(reusedKey, ''), '222222222');

  assert.notEqual(first, second);
});

test('leaves the mark untouched where no reel id exists', () => {
  // Stories have no data-video-id; folding in `undefined` must not perturb the
  // marker their whole binding scheme is keyed on.
  assert.equal(combineVideoMark('vm:epoch-a:1', undefined), 'vm:epoch-a:1');
});

test('keeps the reel id clear of the story/video mark separator', () => {
  // detectPlaying joins the story and video marks with '#', and storage bounds
  // an overlong mark by its LAST '#'. An inner '#' would move that cut point.
  assert.equal(combineVideoMark('vm:epoch-a:1', '123456789').includes('#'), false);
});
