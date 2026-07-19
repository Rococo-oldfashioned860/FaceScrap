import assert from 'node:assert/strict';
import test from 'node:test';

import { createAckedLatest } from '../src/shared/acked-latest';

interface Signal {
  key: string;
  detectedAt: number;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('retries one state with the original observation timestamp until it is acknowledged', async () => {
  const delivery = createAckedLatest<Signal>();
  const seen: Signal[] = [];
  delivery.offer('story-a', { key: 'story-a', detectedAt: 100 });
  await delivery.pump(async (signal) => {
    seen.push(signal);
    return 'retry';
  });

  // A new DOM poll constructs a fresh value, but the delivery state must keep
  // the original boundary while retrying this same logical Story.
  delivery.offer('story-a', { key: 'story-a', detectedAt: 200 });
  await delivery.pump(async (signal) => {
    seen.push(signal);
    return 'accepted';
  });

  assert.deepEqual(seen.map((signal) => signal.detectedAt), [100, 100]);
  assert.equal(delivery.offer('story-a', { key: 'story-a', detectedAt: 300 }), false);
});

test('does not send the same pending state twice while its acknowledgement is in flight', async () => {
  const delivery = createAckedLatest<Signal>();
  const ack = deferred<'accepted'>();
  let sends = 0;
  delivery.offer('story-a', { key: 'story-a', detectedAt: 100 });
  const first = delivery.pump(async () => {
    sends++;
    return ack.promise;
  });
  const duplicate = delivery.pump(async () => {
    sends++;
    return 'accepted';
  });

  assert.equal(sends, 1);
  ack.resolve('accepted');
  await Promise.all([first, duplicate]);
  assert.equal(sends, 1);
});

test('a late acknowledgement for Story A cannot commit over newer Story B', async () => {
  const delivery = createAckedLatest<Signal>();
  const ackA = deferred<'accepted'>();
  const ackB = deferred<'accepted'>();

  delivery.offer('story-a', { key: 'story-a', detectedAt: 100 });
  const first = delivery.pump((signal) => (signal.key === 'story-a' ? ackA.promise : ackB.promise));
  delivery.offer('story-b', { key: 'story-b', detectedAt: 200 });
  const second = delivery.pump((signal) => (signal.key === 'story-a' ? ackA.promise : ackB.promise));

  ackA.resolve('accepted');
  await first;
  // B is still the pending state; another B poll neither recreates nor loses it.
  delivery.offer('story-b', { key: 'story-b', detectedAt: 300 });
  ackB.resolve('accepted');
  await second;

  assert.equal(delivery.offer('story-b', { key: 'story-b', detectedAt: 400 }), false);
  assert.equal(delivery.offer('story-a', { key: 'story-a', detectedAt: 500 }), true);
});

test('A to B to A sends a compensating A while the remote B write is still in flight', async () => {
  const delivery = createAckedLatest<Signal>();
  let remote = '';
  delivery.offer('story-a', { key: 'story-a', detectedAt: 100 });
  await delivery.pump(async (signal) => {
    remote = signal.key;
    return 'accepted';
  });

  const ackB = deferred<'accepted'>();
  delivery.offer('story-b', { key: 'story-b', detectedAt: 200 });
  const writeB = delivery.pump(async (signal) => {
    remote = signal.key;
    return ackB.promise;
  });
  assert.equal(remote, 'story-b');

  // Returning to the locally committed A cannot merely cancel the callback:
  // B has already changed the remote state and must be overwritten by fresh A.
  assert.equal(delivery.offer('story-a', { key: 'story-a', detectedAt: 300 }), true);
  await delivery.pump(async (signal) => {
    remote = signal.key;
    return 'accepted';
  });
  ackB.resolve('accepted');
  await writeB;

  assert.equal(remote, 'story-a');
  assert.equal(delivery.offer('story-a', { key: 'story-a', detectedAt: 400 }), false);
});

test('a terminal stale-timestamp acknowledgement refreshes the observation on the next poll', async () => {
  const delivery = createAckedLatest<Signal>();
  const seen: number[] = [];
  delivery.offer('story-a', { key: 'story-a', detectedAt: 100 });
  await delivery.pump(async (signal) => {
    seen.push(signal.detectedAt);
    return 'refresh';
  });
  delivery.offer('story-a', { key: 'story-a', detectedAt: 200 });
  await delivery.pump(async (signal) => {
    seen.push(signal.detectedAt);
    return 'accepted';
  });

  assert.deepEqual(seen, [100, 200]);
});
