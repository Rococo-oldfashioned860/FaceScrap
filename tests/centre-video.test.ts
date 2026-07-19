import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discardPlaceholderCoverEvidence,
  pickBestVideoIndex,
  type VideoCandidate,
} from '../src/shared/centre-video';

function candidate(over: Partial<VideoCandidate> = {}): VideoCandidate {
  return { vw: 400, vh: 400, paused: true, ended: false, containsCentre: false, ...over };
}

test('picks the largest visible video when none is playing', () => {
  const picked = pickBestVideoIndex([candidate({ vw: 200, vh: 200 }), candidate({ vw: 600, vh: 600 })], false);

  assert.equal(picked, 1);
});

test('prefers a playing video over a larger paused one', () => {
  // Stacked previous slides and preloaded next slides are paused, and either can
  // be larger on screen mid-scroll than the reel actually playing.
  const picked = pickBestVideoIndex([candidate({ vw: 900, vh: 900 }), candidate({ vw: 300, vh: 300, paused: false })], false);

  assert.equal(picked, 1);
});

test('breaks a tie between playing videos by which one holds the centre', () => {
  const picked = pickBestVideoIndex(
    [candidate({ paused: false }), candidate({ paused: false, containsCentre: true })],
    false,
  );

  assert.equal(picked, 1);
});

test('ignores an ended video', () => {
  const picked = pickBestVideoIndex([candidate({ paused: false, ended: true }), candidate({ vw: 200, vh: 200 })], false);

  assert.equal(picked, 1);
});

test('ignores a video that is barely on screen', () => {
  const picked = pickBestVideoIndex([candidate({ vw: 80, vh: 400 }), candidate({ vw: 120, vh: 120 })], false);

  assert.equal(picked, 1);
});

test('lets a playing video win even when a cover was hit-tested at the centre', () => {
  // The regression this fixes: a residual blur-up cover still painted over a
  // reel that is ALREADY playing used to suppress the fallback entirely, so no
  // video was adopted at all.
  const picked = pickBestVideoIndex([candidate({ paused: false, containsCentre: true })], true);

  assert.equal(picked, 0);
});

test('does not replace a centred photo cover with an unrelated playing video off-centre', () => {
  const picked = pickBestVideoIndex([candidate({ paused: false, containsCentre: false })], true);

  assert.equal(picked, undefined);
});

test('discarding a playing-video placeholder removes only its stale cover evidence', () => {
  const ids = new Set(['unrelated', 'stale-cover']);
  const covers = ['https://scontent.xx.fbcdn.net/stale.jpg'];

  discardPlaceholderCoverEvidence(ids, covers, ['stale-cover']);

  assert.deepEqual([...ids], ['unrelated']);
  assert.deepEqual(covers, []);
});

test('keeps a paused video buried under a cover out of the running', () => {
  // With a cover on top, a paused video below it is the previous slide the
  // viewer keeps stacked — adopting it would show the wrong video.
  const picked = pickBestVideoIndex([candidate({ vw: 900, vh: 900 })], true);

  assert.equal(picked, undefined);
});

test('reports no candidate for an empty list', () => {
  assert.equal(pickBestVideoIndex([], false), undefined);
});
