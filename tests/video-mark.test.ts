import assert from 'node:assert/strict';
import test from 'node:test';

import { createVideoMarkFactory } from '../src/shared/video-mark';

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
