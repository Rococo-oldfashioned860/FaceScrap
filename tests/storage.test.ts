import assert from 'node:assert/strict';
import test from 'node:test';

import './chrome-fake';
import { boundPlayingMark } from '../src/shared/storage';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

test('keeps a mark at or under the persistence bound unchanged', () => {
  const mark = `u:owner/UzM6NzAwMDAwMDAwMDAwMDAy#vm:${UUID}:7`;
  assert.equal(boundPlayingMark(mark), mark);
});

test('bounds an overlong mark without collapsing consecutive video loads', () => {
  const longCard = `u:owner-name/${'Uz'.padEnd(230, 'x')}`;
  const first = `${longCard}#vm:${UUID}:1`;
  const second = `${longCard}#vm:${UUID}:2`;
  assert.equal(first.length > 256, true);

  const boundedFirst = boundPlayingMark(first);
  const boundedSecond = boundPlayingMark(second);

  assert.equal(boundedFirst.length <= 256, true);
  assert.equal(boundedSecond.length <= 256, true);
  assert.notEqual(boundedFirst, boundedSecond);
  assert.equal(boundedFirst.endsWith(`:1`), true);
});

test('preserves the durable story head and the # separator of an overlong mark', () => {
  const mark = `u:owner-name/${'Uz'.padEnd(300, 'y')}#vm:${UUID}:3`;

  const bounded = boundPlayingMark(mark);

  assert.equal(bounded.startsWith('u:owner-name/'), true);
  assert.equal(bounded.includes('#vm:'), true);
});

test('keeps the derived story portion stable across loads of an overlong mark', () => {
  const longCard = `u:owner/${'Uz'.padEnd(300, 'x')}`;
  const ninth = boundPlayingMark(`${longCard}#vm:${UUID}:9`);
  const tenth = boundPlayingMark(`${longCard}#vm:${UUID}:10`);

  assert.equal(ninth.slice(0, ninth.indexOf('#')), tenth.slice(0, tenth.indexOf('#')));
  assert.notEqual(ninth, tenth);
});
