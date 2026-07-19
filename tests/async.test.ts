import assert from 'node:assert/strict';
import test from 'node:test';

import { withHeartbeat } from '../src/shared/async';

/** A promise that never settles — stands in for a mux the offscreen is still working on. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('resolves with the work when it finishes before going idle', async () => {
  const { promise } = withHeartbeat(Promise.resolve('done'), 50, 1000, 'timed out');

  assert.equal(await promise, 'done');
});

test('rejects once no progress arrives for the idle window', async () => {
  const { promise } = withHeartbeat(pending<string>(), 30, 1000, 'timed out');

  await assert.rejects(promise, { message: 'timed out' });
});

test('keeps waiting while progress keeps arriving', async () => {
  const { promise, beat } = withHeartbeat(pending<string>(), 40, 1000, 'timed out');
  // Three beats inside the idle window carry this well past a 40ms wall-clock cap —
  // the case the old MUX_TIMEOUT_MS killed: a large track on a slow-but-steady link.
  for (let i = 0; i < 3; i++) {
    await wait(20);
    beat();
  }

  const raced = await Promise.race([promise.then(() => 'settled', () => 'rejected'), wait(1).then(() => 'still running')]);
  assert.equal(raced, 'still running');
});

test('gives up at the hard cap even while progress keeps arriving', async () => {
  const { promise, beat } = withHeartbeat(pending<string>(), 1000, 60, 'timed out');
  const beating = setInterval(beat, 10);

  await assert.rejects(promise, { message: 'timed out' });
  clearInterval(beating);
});

test('surfaces the work’s own rejection unchanged', async () => {
  const { promise } = withHeartbeat(Promise.reject(new Error('remux failed')), 50, 1000, 'timed out');

  await assert.rejects(promise, { message: 'remux failed' });
});

test('ignores beats after settling so a late report cannot rearm the timer', async () => {
  const { promise, beat } = withHeartbeat(Promise.resolve('done'), 20, 1000, 'timed out');
  await promise;

  // Past the idle window. A beat that rearmed the timer would fire into an
  // already-settled promise, surfacing as an unhandled rejection.
  beat();
  await wait(40);

  assert.equal(await promise, 'done');
});
