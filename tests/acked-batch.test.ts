import assert from 'node:assert/strict';
import test from 'node:test';

import { createAckedBatch } from '../src/shared/acked-batch';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('bounds the queue and reports unique arrivals that do not fit', () => {
  const delivery = createAckedBatch<number>({ maxBatch: 2, maxPending: 3 });

  assert.deepEqual(delivery.enqueueMany([1, 2, 3, 4, 5]), {
    added: 3,
    merged: 0,
    dropped: 2,
  });
  assert.equal(delivery.pending, 3);
});

test('can evict the oldest unsent item so the newest observation survives overflow', async () => {
  const delivery = createAckedBatch<number>({
    maxBatch: 2,
    maxPending: 3,
    overflow: 'drop-oldest',
  });
  delivery.enqueueMany([1, 2, 3, 4]);
  const sent: number[][] = [];

  await delivery.pump(async (batch) => {
    sent.push([...batch]);
    return true;
  });

  assert.deepEqual(sent, [[2, 3], [4]]);
});

test('deduplicates and merges queued values with configurable identity', async () => {
  const delivery = createAckedBatch<{ id: string; urls: string[] }, string>({
    maxBatch: 500,
    maxPending: 2_000,
    key: (item) => item.id,
    merge: (queued, incoming) => ({ ...queued, urls: [...queued.urls, ...incoming.urls] }),
  });
  const result = delivery.enqueueMany([
    { id: 'a', urls: ['one'] },
    { id: 'a', urls: ['two'] },
    { id: 'b', urls: ['three'] },
  ]);
  const sent: Array<readonly { id: string; urls: string[] }[]> = [];

  await delivery.pump(async (batch) => {
    sent.push(batch);
    return true;
  });

  assert.deepEqual(result, { added: 2, merged: 1, dropped: 0 });
  assert.deepEqual(sent, [[
    { id: 'a', urls: ['one', 'two'] },
    { id: 'b', urls: ['three'] },
  ]]);
});

test('removes a batch only after a true acknowledgement and retries it unchanged', async () => {
  const delivery = createAckedBatch<number>({ maxBatch: 2, maxPending: 10 });
  delivery.enqueueMany([1, 2, 3]);
  const attempts: number[][] = [];

  assert.equal(await delivery.pump(async (batch) => {
    attempts.push([...batch]);
    return false;
  }), false);
  assert.equal(delivery.pending, 3);

  assert.equal(await delivery.pump(async (batch) => {
    attempts.push([...batch]);
    return true;
  }), true);
  assert.deepEqual(attempts, [[1, 2], [1, 2], [3]]);
  assert.equal(delivery.pending, 0);
});

test('keeps a failed front batch ahead of items arriving during its send', async () => {
  const delivery = createAckedBatch<number>({ maxBatch: 2, maxPending: 10 });
  const firstAck = deferred<boolean>();
  const seen: number[][] = [];
  delivery.enqueueMany([1, 2]);
  const firstPump = delivery.pump(async (batch) => {
    seen.push([...batch]);
    return firstAck.promise;
  });

  delivery.enqueueMany([3, 4]);
  firstAck.resolve(false);
  assert.equal(await firstPump, false);
  await delivery.pump(async (batch) => {
    seen.push([...batch]);
    return true;
  });

  assert.deepEqual(seen, [[1, 2], [1, 2], [3, 4]]);
});

test('drains items enqueued during an acknowledged send without another pump', async () => {
  const delivery = createAckedBatch<number>({ maxBatch: 2, maxPending: 10 });
  const firstAck = deferred<boolean>();
  const seen: number[][] = [];
  delivery.enqueueMany([1, 2]);
  const pumping = delivery.pump(async (batch) => {
    seen.push([...batch]);
    if (seen.length === 1) return firstAck.promise;
    return true;
  });

  delivery.enqueueMany([3, 4, 5]);
  firstAck.resolve(true);
  assert.equal(await pumping, true);

  assert.deepEqual(seen, [[1, 2], [3, 4], [5]]);
  assert.equal(delivery.pending, 0);
});

test('concurrent pumps share one drain and never duplicate a send', async () => {
  const delivery = createAckedBatch<number>({ maxBatch: 2, maxPending: 10 });
  const ack = deferred<boolean>();
  let sends = 0;
  delivery.enqueueMany([1, 2]);
  const first = delivery.pump(async () => {
    sends++;
    return ack.promise;
  });
  const second = delivery.pump(async () => {
    sends++;
    return true;
  });

  assert.equal(first, second);
  assert.equal(sends, 1);
  ack.resolve(true);
  assert.equal(await second, true);
  assert.equal(sends, 1);
});

test('an in-flight item is immutable and a same-key update drains behind it', async () => {
  interface Item { id: string; version: number }
  const delivery = createAckedBatch<Item, string>({
    maxBatch: 1,
    maxPending: 10,
    key: (item) => item.id,
    merge: (_queued, incoming) => incoming,
  });
  const ack = deferred<boolean>();
  const seen: Item[][] = [];
  delivery.enqueue({ id: 'a', version: 1 });
  const pumping = delivery.pump(async (batch) => {
    seen.push(batch.map((item) => ({ ...item })));
    if (seen.length === 1) return ack.promise;
    return true;
  });

  assert.deepEqual(delivery.enqueue({ id: 'a', version: 2 }), {
    added: 1,
    merged: 0,
    dropped: 0,
  });
  delivery.enqueue({ id: 'a', version: 3 });
  ack.resolve(true);
  await pumping;

  assert.deepEqual(seen, [
    [{ id: 'a', version: 1 }],
    [{ id: 'a', version: 3 }],
  ]);
});

test('a thrown send is retryable and preserves the front batch', async () => {
  const delivery = createAckedBatch<number>({ maxBatch: 2, maxPending: 10 });
  delivery.enqueueMany([1, 2]);

  assert.equal(await delivery.pump(async () => {
    throw new Error('worker asleep');
  }), false);
  assert.equal(delivery.pending, 2);
  assert.equal(await delivery.pump(async () => true), true);
  assert.equal(delivery.pending, 0);
});

test('splits a rejected front batch adaptively until individual items can progress', async () => {
  const delivery = createAckedBatch<number>({
    maxBatch: 8,
    maxPending: 20,
    splitOnFailure: true,
  });
  delivery.enqueueMany([1, 2, 3, 4, 5, 6, 7, 8]);
  const attempts: number[][] = [];

  for (let retry = 0; retry < 3; retry++) {
    assert.equal(await delivery.pump(async (batch) => {
      attempts.push([...batch]);
      return false;
    }), false);
  }
  assert.equal(await delivery.pump(async (batch) => {
    attempts.push([...batch]);
    return true;
  }), true);

  assert.deepEqual(attempts.slice(0, 4).map((batch) => batch.length), [8, 4, 2, 1]);
  assert.equal(delivery.pending, 0);
});

test('bounds send batches and pending work by configured item weight', async () => {
  const delivery = createAckedBatch<string>({
    maxBatch: 10,
    maxPending: 10,
    weight: (item) => item.length,
    maxBatchWeight: 5,
    maxPendingWeight: 8,
  });

  assert.deepEqual(delivery.enqueueMany(['aaa', 'bb', 'cc', 'dd']), {
    added: 3,
    merged: 0,
    dropped: 1,
  });
  assert.equal(delivery.pendingWeight, 7);
  const sent: string[][] = [];
  await delivery.pump(async (batch) => {
    sent.push([...batch]);
    return true;
  });
  assert.deepEqual(sent, [['aaa', 'bb'], ['cc']]);
  assert.equal(delivery.pendingWeight, 0);
});

test('weight overflow can evict only the oldest unsent item', async () => {
  const delivery = createAckedBatch<string>({
    maxBatch: 1,
    maxPending: 10,
    weight: (item) => item.length,
    maxPendingWeight: 5,
    overflow: 'drop-oldest',
  });
  const ack = deferred<boolean>();
  delivery.enqueue('aaa');
  const pumping = delivery.pump(async () => ack.promise);

  assert.deepEqual(delivery.enqueueMany(['bb', 'cccc']), {
    added: 1,
    merged: 0,
    dropped: 2,
  });
  assert.equal(delivery.pendingWeight, 3);
  ack.resolve(true);
  await pumping;
});

test('a weighted enrichment evicts older unsent media instead of losing new metadata', async () => {
  interface Media {
    id: string;
    storyIds: string[];
    audio: string[];
    weight: number;
  }
  const delivery = createAckedBatch<Media, string>({
    maxBatch: 10,
    maxPending: 10,
    weight: (item) => item.weight,
    maxPendingWeight: 10,
    overflow: 'drop-oldest',
    key: (item) => item.id,
    merge: (queued, incoming) => ({
      ...queued,
      storyIds: [...queued.storyIds, ...incoming.storyIds],
      audio: [...queued.audio, ...incoming.audio],
      weight: incoming.weight,
    }),
  });
  delivery.enqueueMany([
    { id: 'old-a', storyIds: [], audio: [], weight: 3 },
    { id: 'current', storyIds: ['story-1'], audio: [], weight: 3 },
    { id: 'old-b', storyIds: [], audio: [], weight: 3 },
  ]);

  assert.deepEqual(delivery.enqueue({
    id: 'current',
    storyIds: ['story-2'],
    audio: ['audio-track'],
    weight: 7,
  }), {
    added: 0,
    merged: 1,
    dropped: 1,
  });
  assert.equal(delivery.pendingWeight, 10);

  const sent: Media[][] = [];
  await delivery.pump(async (batch) => {
    sent.push(batch.map((item) => ({ ...item })));
    return true;
  });
  assert.deepEqual(sent, [[
    {
      id: 'current',
      storyIds: ['story-1', 'story-2'],
      audio: ['audio-track'],
      weight: 7,
    },
    { id: 'old-b', storyIds: [], audio: [], weight: 3 },
  ]]);
});

test('weighted merge eviction never removes the in-flight prefix', async () => {
  interface Item { id: string; metadata: string[]; weight: number }
  const delivery = createAckedBatch<Item, string>({
    maxBatch: 1,
    maxPending: 10,
    weight: (item) => item.weight,
    maxPendingWeight: 10,
    overflow: 'drop-oldest',
    key: (item) => item.id,
    merge: (queued, incoming) => ({
      ...queued,
      metadata: [...queued.metadata, ...incoming.metadata],
      weight: incoming.weight,
    }),
  });
  const ack = deferred<boolean>();
  delivery.enqueueMany([
    { id: 'in-flight', metadata: [], weight: 2 },
    { id: 'old-unsent', metadata: [], weight: 3 },
    { id: 'current', metadata: ['story'], weight: 2 },
    { id: 'newer', metadata: [], weight: 3 },
  ]);
  const sent: Item[][] = [];
  const pumping = delivery.pump(async (batch) => {
    sent.push(batch.map((item) => ({ ...item })));
    if (sent.length === 1) return ack.promise;
    return true;
  });

  assert.deepEqual(delivery.enqueue({ id: 'current', metadata: ['audio'], weight: 5 }), {
    added: 0,
    merged: 1,
    dropped: 1,
  });
  assert.equal(delivery.pendingWeight, 10);
  ack.resolve(true);
  await pumping;

  assert.deepEqual(sent, [
    [{ id: 'in-flight', metadata: [], weight: 2 }],
    [{ id: 'current', metadata: ['story', 'audio'], weight: 5 }],
    [{ id: 'newer', metadata: [], weight: 3 }],
  ]);
});

test('an impossible weighted enrichment preserves the original item and all queued media', async () => {
  interface Item { id: string; version: number; weight: number }
  const delivery = createAckedBatch<Item, string>({
    maxBatch: 10,
    maxPending: 10,
    weight: (item) => item.weight,
    maxPendingWeight: 10,
    overflow: 'drop-oldest',
    key: (item) => item.id,
    merge: (_queued, incoming) => incoming,
  });
  delivery.enqueueMany([
    { id: 'target', version: 1, weight: 4 },
    { id: 'other', version: 1, weight: 3 },
  ]);

  assert.deepEqual(delivery.enqueue({ id: 'target', version: 2, weight: 11 }), {
    added: 0,
    merged: 0,
    dropped: 1,
  });
  assert.equal(delivery.pendingWeight, 7);

  const sent: Item[][] = [];
  await delivery.pump(async (batch) => {
    sent.push(batch.map((item) => ({ ...item })));
    return true;
  });
  assert.deepEqual(sent, [[
    { id: 'target', version: 1, weight: 4 },
    { id: 'other', version: 1, weight: 3 },
  ]]);
});

test('an individually overweight arrival cannot evict healthy queued work', async () => {
  const delivery = createAckedBatch<string>({
    maxBatch: 10,
    maxPending: 10,
    weight: (item) => item.length,
    maxPendingWeight: 5,
    overflow: 'drop-oldest',
  });
  delivery.enqueueMany(['aa', 'bb']);

  assert.deepEqual(delivery.enqueue('too-heavy'), {
    added: 0,
    merged: 0,
    dropped: 1,
  });
  const sent: string[][] = [];
  await delivery.pump(async (batch) => {
    sent.push([...batch]);
    return true;
  });
  assert.deepEqual(sent, [['aa', 'bb']]);
});

test('rotates an irreducible rejected item so newer work is not head-of-line blocked', async () => {
  const delivery = createAckedBatch<number>({
    maxBatch: 1,
    maxPending: 10,
    rotateAfterFailures: 2,
  });
  delivery.enqueueMany([1, 2, 3]);
  const attempts: number[] = [];

  for (let retry = 0; retry < 2; retry++) {
    assert.equal(await delivery.pump(async ([item]) => {
      attempts.push(item);
      return false;
    }), false);
  }
  assert.equal(await delivery.pump(async (batch) => {
    attempts.push(...batch);
    return true;
  }), true);

  assert.deepEqual(attempts, [1, 1, 2, 3, 1]);
  assert.equal(delivery.pending, 0);
});
