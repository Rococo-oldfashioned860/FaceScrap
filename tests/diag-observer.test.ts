import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiagObserver } from '../src/background/diag-observer';
import type { DiagCounters } from '../src/shared/diag';

function harness(options: { maxTabs?: number; maxCountPerReason?: number } = {}) {
  const writes: DiagCounters[] = [];
  const scheduled: Array<() => void> = [];
  const observer = createDiagObserver({
    write: async (delta) => {
      writes.push({ ...delta });
    },
    schedule: (task) => {
      scheduled.push(task);
      return task;
    },
    cancel: (handle) => {
      const index = scheduled.indexOf(handle as () => void);
      if (index >= 0) scheduled.splice(index, 1);
    },
    ...options,
  });
  return { observer, scheduled, writes };
}

test('ignores page reports while diagnostics are disabled', async () => {
  const { observer, scheduled, writes } = harness();

  assert.equal(observer.report(1, { captureGraphql: 5 }), false);
  assert.equal(scheduled.length, 0);
  await observer.flush();
  assert.deepEqual(writes, []);
});

test('coalesces tabs and worker counters into one bounded write', async () => {
  const writes: DiagCounters[] = [];
  const observer = createDiagObserver({
    maxCountPerReason: 10,
    drainWorker: () => ({ captureNetwork: 4 }),
    write: async (delta) => {
      writes.push({ ...delta });
    },
    schedule: () => 1,
    cancel: () => {},
  });
  observer.setEnabled(true);

  assert.equal(observer.report(1, { captureGraphql: 6, notAReason: 99 }), true);
  assert.equal(observer.report(1, { captureGraphql: 7 }), true);
  assert.equal(observer.report(2, { captureDom: 3 }), true);
  await observer.flush();

  assert.deepEqual(writes, [{ captureGraphql: 10, captureDom: 3, captureNetwork: 4 }]);
});

test('bounds pending tabs and removes a closed tab before flush', async () => {
  const { observer, writes } = harness({ maxTabs: 2 });
  observer.setEnabled(true);

  assert.equal(observer.report(10, { captureDom: 1 }), true);
  assert.equal(observer.report(11, { captureDom: 2 }), true);
  assert.equal(observer.report(12, { captureDom: 4 }), false);
  observer.removeTab(10);
  await observer.flush();

  assert.deepEqual(writes, [{ captureDom: 2 }]);
});

test('disabling clears pending reports and the scheduled flush', async () => {
  const { observer, scheduled, writes } = harness();
  observer.setEnabled(true);
  observer.report(1, { scanQueueEvicted: 2 });
  assert.equal(scheduled.length, 1);

  observer.setEnabled(false);
  assert.equal(scheduled.length, 0);
  await observer.flush();
  assert.deepEqual(writes, []);
});

test('retains the aggregate when a storage write fails transiently', async () => {
  const writes: DiagCounters[] = [];
  let attempts = 0;
  const observer = createDiagObserver({
    write: async (delta) => {
      attempts++;
      if (attempts === 1) throw new Error('local storage busy');
      writes.push({ ...delta });
    },
    schedule: () => 1,
    cancel: () => {},
  });
  observer.setEnabled(true);
  observer.report(1, { captureGraphql: 3 });

  await assert.rejects(observer.flush(), /local storage busy/);
  await observer.flush();
  assert.deepEqual(writes, [{ captureGraphql: 3 }]);
});
