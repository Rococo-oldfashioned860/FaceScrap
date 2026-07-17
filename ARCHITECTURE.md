# FaceScrap

Chrome MV3 extension (TypeScript, esbuild). Personal use, load-unpacked only.

Read [README.md](README.md) first — it documents the architecture, the DASH/remux
flow, settings, and browser compatibility. This file only carries the rules that
file doesn't make obvious.

## Invariants — breaking these breaks the extension

**The GraphQL hook is passive. Keep it passive.** `src/content/page-hook.ts`
reads responses to requests Facebook itself made. It must never re-issue a
`doc_id` query or synthesize its own GraphQL request: Meta rotates `doc_id`
every 2–4 weeks (so it breaks) and an extension originating queries is the
signal that gets accounts actioned. Patch, observe, extract — never call.

**Remux only, never re-encode.** `src/offscreen/offscreen.ts` merges the video
and audio tracks with `-c copy -shortest`. A re-encode would be slow, lossy, and
would blow up RAM on long videos. `-shortest` is deliberate — it trims the merge
so the file can't end on frozen video or silence.

**DRM is out of scope.** `<ContentProtection>` entries in the DASH manifest are
detected and discarded on purpose. Widevine cannot be decrypted by any
extension; do not add code that tries.

**The ffmpeg assets in `scripts/build.mjs` are copied verbatim, not bundled.**
The worker chunk's hashed filename (e.g. `814.ffmpeg.js`) must be preserved —
`ffmpeg.js` auto-loads that exact sibling as a *classic* worker. Renaming it,
bundling it, or passing `classWorkerURL` spawns a module worker and breaks
`importScripts()`. The comment above `copyFfmpegAssets()` says this too; believe it.

## Working here

- **Edit `src/`, never `dist/`.** `dist/` is gitignored and `rm -rf`'d at the
  start of every build.
- **No new dependencies** unless there's no alternative. `@ffmpeg/core` alone is
  ~31 MB of the unpacked extension; that's the budget spent.
- Facebook internals shift. Expect selector/GraphQL-shape breakage roughly
  monthly — that's maintenance, not a regression you introduced.

## Verifying a change

There is no test framework. Verification is, in order:

```bash
npm run typecheck   # tsc --noEmit
npm run build       # must succeed; icons + bundle → dist/
```

Then load unpacked from `dist/` at `chrome://extensions` and play a reel on a
facebook.com tab with the side panel open. Typecheck passing is not evidence the
capture path works — the GraphQL and DOM layers are only exercised in a real
browser against real Facebook.
