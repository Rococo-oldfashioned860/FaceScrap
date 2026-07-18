import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The suite runs with cwd = repo root (scripts/test.mjs). import.meta.url can't
// be used: esbuild bundles the tests into a temp dir, so it no longer resolves
// to the repo.
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(process.cwd(), rel), 'utf8'));

test('package.json declares the Node engine the toolchain needs', () => {
  const pkg = readJson('package.json') as { engines?: { node?: string } };
  assert.ok(pkg.engines?.node, 'a from-source builder on old Node gets no guidance without an engines field');
});
