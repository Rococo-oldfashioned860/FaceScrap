import assert from 'node:assert/strict';
import test from 'node:test';

import { createBindingMessageHandler } from '../src/background/binding-handler';
import { createTabLifecycle } from '../src/background/tab-lifecycle';
import type { BindState, PersistBindingsResult } from '../src/shared/storage';

const state: BindState = { coverBind: [], groupCover: [], markBind: [['d:story', 'group']] };
const message = {
  type: 'FACESCRAP_PERSIST_BINDINGS',
  tabId: 42,
  generation: 0,
  baseRevision: 0,
  state,
} as const;

test('binding handler sends its ACK only after persistence completes', async () => {
  let release!: (result: PersistBindingsResult) => void;
  const durable = new Promise<PersistBindingsResult>((resolve) => {
    release = resolve;
  });
  const handler = createBindingMessageHandler(createTabLifecycle(Promise.resolve()), async () => durable);
  let response: unknown;
  assert.equal(handler(message, {}, (value) => (response = value)), true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(response, undefined);
  release({ ok: true, generation: 0, revision: 1 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(response, { ok: true, generation: 0, revision: 1 });
});

test('binding handler rejects content-script senders without persisting', () => {
  let called = false;
  const handler = createBindingMessageHandler(createTabLifecycle(Promise.resolve()), async () => {
    called = true;
    return { ok: true, generation: 0, revision: 1 };
  });
  let response: unknown;
  assert.equal(handler(message, { tab: { id: 42 } as chrome.tabs.Tab }, (value) => (response = value)), true);
  assert.equal(called, false);
  assert.deepEqual(response, { ok: false, retryable: false, error: 'Unauthorized request.' });
});
