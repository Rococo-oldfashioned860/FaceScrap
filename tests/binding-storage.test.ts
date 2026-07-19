import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import {
  clearTab,
  getBind,
  getBindRecord,
  persistBindings,
  sanitizeBindState,
  type BindState,
} from '../src/shared/storage';

const tabId = 771;
const first: BindState = {
  coverBind: [['cover-a', 'group-a']],
  groupCover: [['group-a', 'https://scontent.xx.fbcdn.net/a.jpg']],
  markBind: [['d:story-a', 'group-a']],
};
const second: BindState = {
  coverBind: [['cover-b', 'group-b']],
  groupCover: [],
  markBind: [['d:story-b', 'group-b']],
};

beforeEach(resetChromeStorage);

test('persistBindings resolves only after the durable storage set resolves', async () => {
  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  session.set = async (values): Promise<void> => {
    if (!intercepted && `bind_${tabId}` in values) {
      intercepted = true;
      await blocked;
    }
    await realSet(values);
  };
  let settled = false;
  const pending = persistBindings(tabId, { generation: 0, baseRevision: 0, state: first }).then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await pending;
  session.set = realSet;
  assert.deepEqual(await getBind(tabId), first);
});

test('recovers a transient binding set failure before acknowledging', async () => {
  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let attempts = 0;
  session.set = async (values): Promise<void> => {
    if (`bind_${tabId}` in values && attempts++ === 0) throw new TypeError('temporary backend failure');
    await realSet(values);
  };
  try {
    assert.deepEqual(await persistBindings(tabId, { generation: 0, baseRevision: 0, state: first }), {
      ok: true,
      generation: 0,
      revision: 1,
    });
  } finally {
    session.set = realSet;
  }
  assert.equal(attempts, 2);
  assert.deepEqual(await getBind(tabId), first);
});

test('accepts a lost acknowledgement retry idempotently', async () => {
  const request = { generation: 0, baseRevision: 0, state: first };
  const initial = await persistBindings(tabId, request);
  const retry = await persistBindings(tabId, request);
  assert.deepEqual(retry, initial);
  assert.equal((await getBindRecord(tabId)).revision, 1);
});

test('a clear tombstone rejects the old generation and prevents resurrection', async () => {
  await persistBindings(tabId, { generation: 0, baseRevision: 0, state: first });
  await clearTab(tabId);
  const tombstone = await getBindRecord(tabId);
  assert.deepEqual(tombstone, { version: 1, generation: 1, revision: 0, state: null });

  const stale = await persistBindings(tabId, { generation: 0, baseRevision: 1, state: second });
  assert.equal(stale.ok, false);
  assert.deepEqual(await getBindRecord(tabId), tombstone);
});

test('a persist request already queued before clear cannot land after its tombstone', async () => {
  const write = persistBindings(tabId, { generation: 0, baseRevision: 0, state: first });
  const clear = clearTab(tabId);
  await Promise.all([write, clear]);
  assert.deepEqual(await getBindRecord(tabId), { version: 1, generation: 1, revision: 0, state: null });
});

test('reports revision conflicts without overwriting the durable winner', async () => {
  await persistBindings(tabId, { generation: 0, baseRevision: 0, state: first });
  const conflict = await persistBindings(tabId, { generation: 0, baseRevision: 0, state: second });
  assert.equal(conflict.ok, false);
  assert.deepEqual(await getBind(tabId), first);
});

test('reads legacy BindState and migrates it on the next CAS write', async () => {
  await chrome.storage.session.set({ [`bind_${tabId}`]: first });
  assert.deepEqual(await getBindRecord(tabId), { version: 1, generation: 0, revision: 0, state: first });
  await persistBindings(tabId, { generation: 0, baseRevision: 0, state: second });
  assert.deepEqual(await getBindRecord(tabId), { version: 1, generation: 0, revision: 1, state: second });
});

test('sanitizes bounds and discards provisional marks', () => {
  const state = sanitizeBindState({
    coverBind: Array.from({ length: 350 }, (_, i) => [`cover-${i}`, `group-${i}`]),
    groupCover: [],
    markBind: [['p:synthetic', 'bad'], ['d:durable', 'good']],
  });
  assert.equal(state?.coverBind.length, 300);
  assert.deepEqual(state?.markBind, [['d:durable', 'good']]);
});
