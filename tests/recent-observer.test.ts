import assert from 'node:assert/strict';
import test from 'node:test';

import { createRecentObserver } from '../src/background/recent-observer';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const TRACK = 'https://video.xx.fbcdn.net/v/t42/current.mp4?bytestart=0&byteend=999';

test('collapses duplicate in-flight tracks and commits dedupe only after success', async () => {
  const gate = deferred<boolean>();
  let writes = 0;
  const observer = createRecentObserver(async () => {
    writes++;
    return gate.promise;
  });

  const first = observer.bump(1, TRACK);
  assert.ok(first);
  assert.equal(observer.bump(1, TRACK), undefined);
  assert.equal(writes, 1);
  gate.resolve(true);
  assert.equal(await first, true);
  assert.equal(observer.bump(1, TRACK), undefined);
});

test('a failed track write remains eligible for the next real request', async () => {
  const results = [false, true];
  let writes = 0;
  const observer = createRecentObserver(async () => results[writes++] ?? true);

  assert.equal(await observer.bump(2, TRACK), false);
  assert.equal(await observer.bump(2, TRACK), true);
  assert.equal(writes, 2);
  assert.equal(observer.bump(2, TRACK), undefined);
});

test('two tabs never share recent-track dedupe state', async () => {
  const tabs: number[] = [];
  const observer = createRecentObserver(async (tabId) => {
    tabs.push(tabId);
    return true;
  });

  await Promise.all([observer.bump(3, TRACK), observer.bump(4, TRACK)]);
  assert.deepEqual(tabs.sort(), [3, 4]);
});

test('reset invalidates an old acknowledgement and allows the same track in the new epoch', async () => {
  const oldAck = deferred<boolean>();
  const newAck = deferred<boolean>();
  let writes = 0;
  const observer = createRecentObserver(async () => (++writes === 1 ? oldAck.promise : newAck.promise));

  const oldWork = observer.bump(5, TRACK);
  assert.ok(oldWork);
  observer.reset(5);
  const newWork = observer.bump(5, TRACK);
  assert.ok(newWork);

  oldAck.resolve(true);
  assert.equal(await oldWork, true);
  // The old success did not commit into the new epoch while its replacement is pending.
  assert.equal(observer.bump(5, TRACK), undefined);
  newAck.resolve(true);
  assert.equal(await newWork, true);
  assert.equal(observer.bump(5, TRACK), undefined);
  assert.equal(writes, 2);
});

test('A confirmed then B pending then A schedules a compensation for an out-of-order B acknowledgement', async () => {
  const trackB = TRACK.replace('current.mp4', 'next.mp4');
  const gates = Array.from({ length: 4 }, () => deferred<boolean>());
  const urls: string[] = [];
  const observer = createRecentObserver(async (_tabId, url) => {
    const index = urls.push(url) - 1;
    return gates[index].promise;
  });

  const confirmedA = observer.bump(6, TRACK);
  assert.ok(confirmedA);
  gates[0].resolve(true);
  assert.equal(await confirmedA, true);

  const pendingB = observer.bump(6, trackB);
  const returnedA = observer.bump(6, TRACK);
  assert.ok(pendingB);
  assert.ok(returnedA);
  assert.equal(urls.length, 3);

  // A lands first, then the older B overwrites it. B's stale acknowledgement
  // must enqueue one final A write to restore the latest observation.
  gates[2].resolve(true);
  assert.equal(await returnedA, true);
  gates[1].resolve(true);
  assert.equal(await pendingB, true);
  assert.equal(urls.length, 4);
  assert.equal(urls[3], urls[0]);

  gates[3].resolve(true);
  await Promise.resolve();
  assert.equal(observer.bump(6, TRACK), undefined);
});

test('A pending then B pending then A is a new transition and stale ACKs cannot replace it', async () => {
  const trackB = TRACK.replace('current.mp4', 'middle.mp4');
  const gates = Array.from({ length: 4 }, () => deferred<boolean>());
  const urls: string[] = [];
  const observer = createRecentObserver(async (_tabId, url) => {
    const index = urls.push(url) - 1;
    return gates[index].promise;
  });

  const firstA = observer.bump(7, TRACK);
  const middleB = observer.bump(7, trackB);
  const latestA = observer.bump(7, TRACK);
  assert.ok(firstA);
  assert.ok(middleB);
  assert.ok(latestA);
  assert.equal(urls.length, 3);
  assert.equal(urls[0], urls[2]);

  // Latest A succeeds before both old writes. B then lands stale and schedules
  // one A compensation. The even older A must not schedule a duplicate while
  // that compensation remains active.
  gates[2].resolve(true);
  assert.equal(await latestA, true);
  gates[1].resolve(true);
  assert.equal(await middleB, true);
  assert.equal(urls.length, 4);
  gates[0].resolve(true);
  assert.equal(await firstA, true);
  assert.equal(urls.length, 4);

  gates[3].resolve(true);
  await Promise.resolve();
  assert.equal(observer.bump(7, TRACK), undefined);
});
