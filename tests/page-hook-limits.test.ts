import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBoundedCollector,
  createTextBudget,
  readClonedResponseTextLimited,
  trimQueueToBudget,
} from '../src/shared/page-hook-limits';

function streamedResponse(chunks: string[], onCancel?: () => void): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
      cancel() {
        onCancel?.();
      },
    }),
  );
}

test('hard-caps a chunked response with no Content-Length', async () => {
  const response = streamedResponse(['1234', '5678', '9']);
  const result = await readClonedResponseTextLimited(response, 8);
  assert.deepEqual(result, { ok: false, text: '', bytesRead: 9 });
  assert.equal(await response.text(), '123456789', 'the original response remains readable');
});

test('accepts a streamed response exactly at the byte cap', async () => {
  const result = await readClonedResponseTextLimited(streamedResponse(['á', '123456']), 8);
  assert.deepEqual(result, { ok: true, text: 'á123456', bytesRead: 8 });
});

test('cancels the cloned stream after crossing the cap', async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const branch = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('12345'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = {
    clone: () => ({ headers: new Headers(), body: branch }),
  } as unknown as Response;
  const result = await readClonedResponseTextLimited(response, 4);
  assert.equal(result.ok, false);
  await Promise.resolve();
  assert.equal(cancelled, true);
});

test('text budget rejects a whole part instead of exceeding its aggregate cap', () => {
  const budget = createTextBudget(9);
  assert.equal(budget.add('abcd'), true);
  assert.equal(budget.add('efgh', '\n'), true);
  assert.equal(budget.usedChars, 9);
  assert.equal(budget.add('x', '\n'), false);
  assert.equal(budget.full, true);
  assert.equal(budget.value(), 'abcd\nefgh');
});

test('collector enforces both aggregate item count and weight', () => {
  const byCount = createBoundedCollector({ maxItems: 2, maxWeight: 99, weightOf: (v: string) => v.length });
  assert.equal(byCount.add('one'), true);
  assert.equal(byCount.add('two'), true);
  assert.equal(byCount.add('three'), false);
  assert.deepEqual(byCount.items, ['one', 'two']);

  const byWeight = createBoundedCollector({ maxItems: 99, maxWeight: 5, weightOf: (v: string) => v.length });
  assert.equal(byWeight.add('1234'), true);
  assert.equal(byWeight.add('56'), false);
  assert.equal(byWeight.weight, 4);
});

test('queue budget also evicts keep and newest jobs when they are the only way under cap', () => {
  const keepQueue = [
    { id: 'old-keep', bytes: 6, keep: true },
    { id: 'new-keep', bytes: 6, keep: true },
  ];
  const droppedKeep = trimQueueToBudget({
    queue: keepQueue,
    maxItems: 8,
    maxWeight: 10,
    weightOf: (job) => job.bytes,
    isDisposable: (job) => !job.keep,
  });
  assert.deepEqual(droppedKeep.map((job) => job.id), ['old-keep']);
  assert.deepEqual(keepQueue.map((job) => job.id), ['new-keep']);

  const newQueue = [{ id: 'new', bytes: 11, keep: false }];
  const droppedNew = trimQueueToBudget({
    queue: newQueue,
    maxItems: 8,
    maxWeight: 10,
    weightOf: (job) => job.bytes,
    isDisposable: () => true,
  });
  assert.deepEqual(droppedNew.map((job) => job.id), ['new']);
  assert.deepEqual(newQueue, []);
});
