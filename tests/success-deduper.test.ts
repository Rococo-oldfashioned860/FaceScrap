import assert from 'node:assert/strict';
import test from 'node:test';

import { createSuccessDeduper } from '../src/shared/success-deduper';

test('an interrupted attempt is never cached and Retry invokes the task again', async () => {
  let calls = 0;
  let clock = 10;
  const deduper = createSuccessDeduper(1_000, () => clock);
  const task = async (): Promise<void> => {
    calls++;
    if (calls === 1) throw new Error('interrupted');
  };

  await assert.rejects(deduper.run('pair', task), /interrupted/);
  await deduper.run('pair', task);
  assert.equal(calls, 2);
  assert.equal(deduper.inFlightCount, 0);

  await deduper.run('pair', task);
  assert.equal(calls, 2, 'a genuinely completed attempt is deduplicated');
  clock += 1_001;
  await deduper.run('pair', task);
  assert.equal(calls, 3);
});

test('concurrent duplicates share one terminal promise', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const deduper = createSuccessDeduper(1_000, () => 100);
  const first = deduper.run('pair', async () => {
    calls++;
    await gate;
  });
  const second = deduper.run('pair', async () => {
    calls++;
  });

  assert.equal(first, second);
  assert.equal(deduper.inFlightCount, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('a backwards clock sample invalidates success suppression', async () => {
  let clock = 100;
  let calls = 0;
  const deduper = createSuccessDeduper(1_000, () => clock);
  await deduper.run('pair', async () => {
    calls++;
  });
  clock = 50;
  await deduper.run('pair', async () => {
    calls++;
  });
  assert.equal(calls, 2);
});
