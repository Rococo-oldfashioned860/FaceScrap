import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCounterCoalescer,
  createMediaIngressBudget,
  createNavIngressBudget,
  createTokenBudget,
} from '../src/content/content-ingress-limits';

test('token budget admits two complete bounded hook scans and limits sustained traffic', () => {
  const budget = createMediaIngressBudget(1_000);

  assert.equal(budget.tryTake(2_500, 16 * 1024 * 1024, 1_000), true);
  assert.equal(budget.tryTake(2_500, 16 * 1024 * 1024, 1_000), true);
  assert.equal(budget.tryTake(1, 1, 1_000), false);
  assert.equal(budget.tryTake(5_000, 32 * 1024 * 1024, 21_000), true);
  assert.equal(budget.tryTake(1, 1, 21_000), false);
});

test('navigation budget allows a small route-change burst then throttles forged triggers', () => {
  const budget = createNavIngressBudget(1_000);

  assert.equal(budget.tryTake(1, 1, 1_000), true);
  assert.equal(budget.tryTake(1, 1, 1_000), true);
  assert.equal(budget.tryTake(1, 1, 1_000), true);
  assert.equal(budget.tryTake(1, 1, 1_000), false);
  assert.equal(budget.tryTake(1, 1, 2_999), false);
  assert.equal(budget.tryTake(1, 1, 3_000), true);
});

test('token budget requires both item and byte tokens and rejects impossible charges', () => {
  const budget = createTokenBudget({
    capacityItems: 10,
    capacityBytes: 100,
    refillItemsPerMs: 0,
    refillBytesPerMs: 0,
  });

  assert.equal(budget.tryTake(1, 101, 0), false);
  assert.equal(budget.tryTake(11, 1, 0), false);
  assert.equal(budget.tryTake(Number.POSITIVE_INFINITY, 1, 0), false);
  assert.equal(budget.tryTake(10, 100, 0), true);
});

test('counter coalescer combines reports, saturates, and drains once', () => {
  type Reason = 'graphql' | 'dom';
  const coalescer = createCounterCoalescer<Reason>();

  coalescer.add({ graphql: Number.MAX_SAFE_INTEGER - 2, dom: 1 });
  coalescer.add({ graphql: 10, dom: 2 });

  assert.deepEqual(coalescer.drain(), {
    graphql: Number.MAX_SAFE_INTEGER,
    dom: 3,
  });
  assert.deepEqual(coalescer.drain(), {});
});
