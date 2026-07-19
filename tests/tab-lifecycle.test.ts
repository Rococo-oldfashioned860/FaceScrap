import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ClosedTabError,
  NavigationPendingError,
  StaleDocumentError,
  StaleTabEpochError,
  createTabLifecycle,
} from '../src/background/tab-lifecycle';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('a tab closed while storage initializes cannot run a late capture write', async () => {
  const ready = deferred();
  const lifecycle = createTabLifecycle(ready.promise);
  let writes = 0;

  const pending = lifecycle.runIfLive(17, () => {
    writes++;
  });
  lifecycle.markDead(17);
  ready.resolve();

  await assert.rejects(pending, ClosedTabError);
  assert.equal(writes, 0);
});

test('a live tab runs immediately after readiness and a later close cannot cancel it', async () => {
  const lifecycle = createTabLifecycle(Promise.resolve());
  const calls: number[] = [];

  await lifecycle.runIfLive(21, () => {
    calls.push(21);
  });
  lifecycle.markDead(21);

  assert.deepEqual(calls, [21]);
  await assert.rejects(lifecycle.runIfLive(21, () => calls.push(99)), ClosedTabError);
});

test('dead-tab bookkeeping stays bounded', () => {
  const lifecycle = createTabLifecycle(Promise.resolve(), 2);
  lifecycle.markDead(1);
  lifecycle.markDead(2);
  lifecycle.markDead(3);

  assert.equal(lifecycle.isDead(1), false);
  assert.equal(lifecycle.isDead(2), true);
  assert.equal(lifecycle.isDead(3), true);
});

test('navigation invalidates a blocked old-document write and accepts the new document', async () => {
  const ready = deferred();
  const lifecycle = createTabLifecycle(ready.promise);
  const writes: string[] = [];

  const oldWrite = lifecycle.runIfLive(31, () => writes.push('old'), 'document-old');
  lifecycle.invalidate(31, true);
  const clear = lifecycle.runIfLive(31, () => writes.push('clear'));
  const staleAfterClear = lifecycle.runIfLive(31, () => writes.push('stale'), 'document-old');
  const newWrite = lifecycle.runIfLive(31, () => writes.push('new'), 'document-new');
  ready.resolve();

  await assert.rejects(oldWrite, StaleTabEpochError);
  await assert.rejects(staleAfterClear, StaleDocumentError);
  await Promise.all([clear, newWrite]);
  assert.deepEqual(writes, ['clear', 'new']);
});

test('same-document clear rejects pending work but permits fresh work from that document', async () => {
  const ready = deferred();
  const lifecycle = createTabLifecycle(ready.promise);
  const writes: string[] = [];

  const pending = lifecycle.runIfLive(41, () => writes.push('pending'), 'document-current');
  lifecycle.invalidate(41, false);
  const clear = lifecycle.runIfLive(41, () => writes.push('clear'));
  const fresh = lifecycle.runIfLive(41, () => writes.push('fresh'), 'document-current');
  ready.resolve();

  await assert.rejects(pending, StaleTabEpochError);
  await Promise.all([clear, fresh]);
  assert.deepEqual(writes, ['clear', 'fresh']);
});

test('a stale document cannot reclaim a tab through the diagnostic fast path', () => {
  const lifecycle = createTabLifecycle(Promise.resolve());
  assert.equal(lifecycle.acceptDocument(51, 'document-old'), true);
  lifecycle.invalidate(51, true);
  assert.equal(lifecycle.acceptDocument(51, 'document-old'), false);
  assert.equal(lifecycle.acceptDocument(51, 'document-new'), true);
});

test('viewer navigation keeps accepted prefetch work, waits before commit and rejects later old-document messages', async () => {
  const ready = deferred();
  const lifecycle = createTabLifecycle(ready.promise);
  const writes: string[] = [];

  const prefetched = lifecycle.runIfLive(61, () => writes.push('prefetched'), 'document-old');
  lifecycle.beginNavigation(61, false);
  const pending = lifecycle.runIfLive(61, () => writes.push('pending'), 'document-new');
  lifecycle.commitDocument(61, 'document-new');
  const stale = lifecycle.runIfLive(61, () => writes.push('stale'), 'document-old');
  const current = lifecycle.runIfLive(61, () => writes.push('current'), 'document-new');
  ready.resolve();

  await prefetched;
  await assert.rejects(pending, NavigationPendingError);
  await assert.rejects(stale, StaleDocumentError);
  await current;
  assert.deepEqual(writes, ['prefetched', 'current']);
});

test('an aborted navigation restores the original document identity', async () => {
  const lifecycle = createTabLifecycle(Promise.resolve());
  assert.equal(lifecycle.acceptDocument(71, 'document-current'), true);
  lifecycle.beginNavigation(71, true);
  lifecycle.abortNavigation(71);

  await lifecycle.runIfLive(71, () => undefined, 'document-current');
  await assert.rejects(
    lifecycle.runIfLive(71, () => undefined, 'document-aborted'),
    StaleDocumentError,
  );
});
