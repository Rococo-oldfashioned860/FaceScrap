import assert from 'node:assert/strict';
import test from 'node:test';

import './chrome-fake';
import { resetChromeStorage } from './chrome-fake';
import { addDiagCounters, getDiagCounters, resetDiagCounters } from '../src/shared/storage';

test('reports no counters before anything is recorded', async () => {
  await resetChromeStorage();

  assert.deepEqual(await getDiagCounters(), {});
});

test('adds up reports from separate contexts instead of replacing them', async () => {
  await resetChromeStorage();

  await addDiagCounters({ jsonLineTooLarge: 2, captureGraphql: 40 });
  await addDiagCounters({ jsonLineTooLarge: 3, captureDom: 1 });

  assert.deepEqual(await getDiagCounters(), {
    jsonLineTooLarge: 5,
    captureGraphql: 40,
    captureDom: 1,
  });
});

test('drops unknown reasons and unusable counts from an untrusted report', async () => {
  await resetChromeStorage();

  await addDiagCounters({ jsonLineTooLarge: 1, notAReason: 9, captureDom: -3 } as never);

  assert.deepEqual(await getDiagCounters(), { jsonLineTooLarge: 1 });
});

test('clears every counter on reset', async () => {
  await resetChromeStorage();
  await addDiagCounters({ scanQueueEvicted: 7 });

  await resetDiagCounters();

  assert.deepEqual(await getDiagCounters(), {});
});
