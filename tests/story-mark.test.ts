import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isDurableStoryMark,
  isProvisionalStoryMark,
  isStoryPath,
  storyCardMark,
} from '../src/shared/story-mark';

test('uses a durable u: marker when the active story card exposes a DOM id', () => {
  assert.equal(
    storyCardMark('/stories/owner-name/url-card-id/', 'UzM6NTU1NTU1NTU1NTU1NTU1'),
    'u:owner-name/UzM6NTU1NTU1NTU1NTU1NTU1',
  );
});

test('uses a provisional p: marker when only the tray-pinned URL card is available', () => {
  assert.equal(storyCardMark('/stories/owner-name/url-card-id/'), 'p:owner-name/url-card-id');
});

test('returns no story marker away from a story path', () => {
  assert.equal(storyCardMark('/reel/123456789/'), '');
});

test('isStoryPath agrees with storyCardMark on which paths yield a marker', () => {
  assert.equal(isStoryPath('/stories/owner-name/url-card-id/'), true);
  assert.equal(isStoryPath('/reel/123456789/'), false);
  assert.equal(isStoryPath('/'), false);
});

test('classifies durable and provisional marks by their minted prefix', () => {
  const durable = storyCardMark('/stories/owner/card/', 'UzM6NTU1NTU1NTU1NTU1NTU1');
  const provisional = storyCardMark('/stories/owner/card/');

  assert.equal(isDurableStoryMark(durable), true);
  assert.equal(isProvisionalStoryMark(durable), false);
  assert.equal(isDurableStoryMark(provisional), false);
  assert.equal(isProvisionalStoryMark(provisional), true);
});

test('an undefined or empty mark is neither durable nor provisional', () => {
  assert.equal(isDurableStoryMark(undefined), false);
  assert.equal(isProvisionalStoryMark(undefined), false);
  assert.equal(isDurableStoryMark(''), false);
  assert.equal(isProvisionalStoryMark(''), false);
});
