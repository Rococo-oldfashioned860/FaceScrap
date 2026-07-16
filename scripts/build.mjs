// Build script: bundles TypeScript with esbuild and copies static assets
// into dist/. Run `node scripts/build.mjs` or add `--watch` for dev mode.

import * as esbuild from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync, watch as fsWatch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');
const watch = process.argv.includes('--watch');

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const ctx = await esbuild.context({
  entryPoints: {
    'service-worker': join(ROOT, 'src/background/service-worker.ts'),
    content: join(ROOT, 'src/content/content.ts'),
    'page-hook': join(ROOT, 'src/content/page-hook.ts'),
    'sidepanel/sidepanel': join(ROOT, 'src/sidepanel/sidepanel.ts'),
    'offscreen/offscreen': join(ROOT, 'src/offscreen/offscreen.ts'),
  },
  outdir: OUT,
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  logLevel: 'info',
});

async function copyStatic() {
  await cp(join(ROOT, 'manifest.json'), join(OUT, 'manifest.json'));
  await cp(join(ROOT, 'src/sidepanel/sidepanel.html'), join(OUT, 'sidepanel/sidepanel.html'));
  await cp(join(ROOT, 'src/sidepanel/sidepanel.css'), join(OUT, 'sidepanel/sidepanel.css'));
  await cp(join(ROOT, 'src/sidepanel/fonts'), join(OUT, 'sidepanel/fonts'), { recursive: true });
  await cp(join(ROOT, 'src/offscreen/offscreen.html'), join(OUT, 'offscreen/offscreen.html'));
  await cp(join(ROOT, 'rules'), join(OUT, 'rules'), { recursive: true });
  if (existsSync(join(ROOT, 'icons'))) {
    await cp(join(ROOT, 'icons'), join(OUT, 'icons'), { recursive: true });
  }
  await copyFfmpegAssets();
}

// Ship the prebuilt @ffmpeg UMD build + worker chunk verbatim: esbuild can't emit the
// worker, and ffmpeg.js auto-loads the exact sibling chunk as a CLASSIC worker — passing
// classWorkerURL would spawn a MODULE worker, breaking the chunk's importScripts().
async function copyFfmpegAssets() {
  const dst = join(OUT, 'assets/ffmpeg');
  await mkdir(dst, { recursive: true });

  const ffUmd = join(ROOT, 'node_modules/@ffmpeg/ffmpeg/dist/umd');
  const coreUmd = join(ROOT, 'node_modules/@ffmpeg/core/dist/umd');

  await cp(join(ffUmd, 'ffmpeg.js'), join(dst, 'ffmpeg.js'));
  // Worker chunk has a hashed name (e.g. 814.ffmpeg.js) that varies by version;
  // ship it under that SAME name so ffmpeg.js's classic-worker auto-load finds it.
  const workerFile = (await readdir(ffUmd)).find((f) => /\.ffmpeg\.js$/.test(f) && f !== 'ffmpeg.js');
  if (!workerFile) throw new Error(`ffmpeg worker chunk not found in ${ffUmd}`);
  await cp(join(ffUmd, workerFile), join(dst, workerFile));

  await cp(join(coreUmd, 'ffmpeg-core.js'), join(dst, 'ffmpeg-core.js'));
  await cp(join(coreUmd, 'ffmpeg-core.wasm'), join(dst, 'ffmpeg-core.wasm'));

  console.log(`📦 copied ffmpeg assets (worker: ${workerFile})`);
}

await ctx.rebuild();
await copyStatic();

if (watch) {
  await ctx.watch();
  // esbuild only rebuilds the TS bundles — re-copy static assets (manifest,
  // HTML/CSS, fonts, rules) ourselves when their sources change.
  let copyTimer;
  const requestCopy = () => {
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyStatic()
        .then(() => console.log('📄 static assets re-copied'))
        .catch((e) => console.error('static copy failed', e));
    }, 200);
  };
  for (const p of ['manifest.json', 'src/sidepanel', 'src/offscreen', 'rules', 'icons']) {
    const abs = join(ROOT, p);
    if (existsSync(abs)) fsWatch(abs, { recursive: true }, requestCopy);
  }
  console.log('👀 watching for changes… (Ctrl+C to stop)');
} else {
  await ctx.dispose();
  console.log('✅ build complete → dist/');
}
