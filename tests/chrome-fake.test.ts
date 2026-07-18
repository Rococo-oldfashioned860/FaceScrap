import assert from 'node:assert/strict';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';

test('storage.local drops undefined-valued properties like real Chrome serialization', async () => {
  await resetChromeStorage();
  await chrome.storage.local.set({ k: { a: 1, b: undefined } });

  const got = await chrome.storage.local.get('k');

  assert.equal('b' in (got.k as Record<string, unknown>), false);
  assert.deepEqual(got, { k: { a: 1 } });
});

test('storage.local mangles Date values like real Chrome serialization', async () => {
  await resetChromeStorage();
  await chrome.storage.local.set({ k: { at: new Date(0) } });

  const got = await chrome.storage.local.get('k');

  assert.equal((got.k as Record<string, unknown>).at, '1970-01-01T00:00:00.000Z');
});

test('storage.session keeps structured-clone semantics', async () => {
  await resetChromeStorage();
  await chrome.storage.session.set({ k: { a: 1, b: undefined } });

  const got = await chrome.storage.session.get('k');

  assert.equal('b' in (got.k as Record<string, unknown>), true);
});

test('get returns independent copies, not live references into the store', async () => {
  await resetChromeStorage();
  await chrome.storage.session.set({ k: { tracks: [1] } });

  const first = await chrome.storage.session.get('k');
  (first.k as { tracks: number[] }).tracks.push(2);

  const second = await chrome.storage.session.get('k');
  assert.deepEqual(second, { k: { tracks: [1] } });
});
