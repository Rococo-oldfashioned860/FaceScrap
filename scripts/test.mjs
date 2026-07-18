import * as esbuild from 'esbuild';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = join(ROOT, 'tests');

const entries = (await readdir(TESTS))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => `tests/${name}`);

if (entries.length === 0) {
  throw new Error('No tests found in tests/*.test.ts');
}

const OUT = await mkdtemp(join(tmpdir(), 'facescrap-tests-'));

try {
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: entries,
    outdir: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: 'inline',
    logLevel: 'silent',
  });

  const bundles = (await readdir(OUT))
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => join(OUT, name));
  const result = spawnSync(process.execPath, ['--test', ...bundles], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  // A launch failure leaves status null and the reason only in result.error;
  // with inherited stdio there is no child output, so throwing is the only
  // way this run reports anything at all.
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(OUT, { recursive: true, force: true });
}
