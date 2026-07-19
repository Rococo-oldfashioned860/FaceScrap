import assert from 'node:assert/strict';
import test from 'node:test';

import { diagBump, diagDrain, diagSnapshot, sanitizeDiagCounters, setDiagEnabled } from '../src/shared/diag';

// The module keeps process-wide counters (one instance per bundled context in
// production), so every test starts from a known-empty state. setDiagEnabled(false)
// clearing the counters is what makes that possible — see the module for why.
function reset(): void {
  setDiagEnabled(false);
}

test('counts nothing while disabled', () => {
  reset();

  diagBump('jsonLineTooLarge');

  assert.deepEqual(diagSnapshot(), {});
});

test('accumulates repeated bumps of the same reason once enabled', () => {
  reset();
  setDiagEnabled(true);

  diagBump('jsonLineTooLarge');
  diagBump('jsonLineTooLarge');
  diagBump('captureGraphql', 12);

  assert.deepEqual(diagSnapshot(), { jsonLineTooLarge: 2, captureGraphql: 12 });
});

test('drains the counters and leaves them empty', () => {
  reset();
  setDiagEnabled(true);
  diagBump('scanQueueEvicted', 3);

  assert.deepEqual(diagDrain(), { scanQueueEvicted: 3 });
  assert.deepEqual(diagSnapshot(), {});
});

test('drops counters carried over from before the flag was confirmed', () => {
  reset();
  setDiagEnabled(true);
  diagBump('scanQueueEvicted');

  setDiagEnabled(false);
  setDiagEnabled(true);

  assert.deepEqual(diagSnapshot(), {});
});

test('keeps only known reasons when sanitizing an untrusted payload', () => {
  assert.deepEqual(sanitizeDiagCounters({ jsonLineTooLarge: 2, notAReason: 9 }), { jsonLineTooLarge: 2 });
});

test('rejects counter values that are not usable counts', () => {
  const raw = {
    jsonLineTooLarge: -1,
    scanQueueEvicted: Number.NaN,
    harvestDepthExceeded: Number.POSITIVE_INFINITY,
    mpdParseError: 1.5,
    captureGraphql: '4',
  };

  assert.deepEqual(sanitizeDiagCounters(raw), {});
});

test('sanitizes a non-object payload to an empty report', () => {
  assert.deepEqual(sanitizeDiagCounters(null), {});
  assert.deepEqual(sanitizeDiagCounters('jsonLineTooLarge'), {});
});

test('sanitization reads only the fixed diagnostic whitelist', () => {
  const guarded = new Proxy({ captureDom: 2 }, {
    ownKeys() {
      throw new Error('must not enumerate attacker-supplied keys');
    },
  });

  assert.deepEqual(sanitizeDiagCounters(guarded), { captureDom: 2 });
});
