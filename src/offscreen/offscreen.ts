// FaceScrap offscreen document.
// The service worker cannot run ffmpeg.wasm (no DOM, no URL.createObjectURL,
// killed mid-job). This offscreen page fetches the separate DASH video + audio
// tracks from fbcdn (host_permissions bypass CORS) and remuxes them into one
// MP4 with `-c copy` (lossless — no re-encode). All assets are bundled locally
// (no CDN); CSP needs only `wasm-unsafe-eval` (no SharedArrayBuffer / COI).

import { isFbcdn } from '../shared/media';
import type { MuxResponse, RuntimeMessage } from '../shared/messages';

// Provided by the UMD ffmpeg.js loaded via <script> in offscreen.html.
declare const FFmpegWASM: { FFmpeg: new () => FFmpegInstance };

interface FFmpegInstance {
  load(opts: { coreURL: string; wasmURL: string }): Promise<boolean>;
  writeFile(name: string, data: Uint8Array): Promise<boolean>;
  readFile(name: string): Promise<Uint8Array | string>;
  deleteFile(name: string): Promise<boolean>;
  exec(args: string[]): Promise<number>;
}

const BASE = chrome.runtime.getURL('assets/ffmpeg');
let ff: FFmpegInstance | null = null;
let loading: Promise<FFmpegInstance> | null = null;

function ensureLoaded(): Promise<FFmpegInstance> {
  if (ff) return Promise.resolve(ff);
  if (!loading) {
    const instance = new FFmpegWASM.FFmpeg();
    loading = instance
      // No classWorkerURL on purpose: it forces a MODULE worker, but the bundled
      // worker chunk uses importScripts() (classic-only); omitting it takes the
      // classic-worker path, which loads the UMD core cleanly.
      .load({
        coreURL: `${BASE}/ffmpeg-core.js`,
        wasmURL: `${BASE}/ffmpeg-core.wasm`,
      })
      .then(() => {
        ff = instance;
        return instance;
      })
      .catch((e: unknown) => {
        // Never cache a rejected load: a transient core-load failure would
        // otherwise poison every future mux until the extension reloads.
        loading = null;
        throw e;
      });
  }
  return loading;
}

// fetch() has no read timeout: a socket that connects then stalls mid-body (edge
// hiccup, network/VPN switch, silent middlebox) leaves the read pending forever,
// which — because mux jobs are serialized on muxQueue — would wedge EVERY later
// DASH download. A whole-transfer wall-clock cap can't tell a stall from a large
// track on a slow-but-steady link, so it aborted legitimate slow downloads too.
// Instead, bound the IDLE gap: reset the timer on every chunk, abort only when no
// bytes arrive for STALL_MS. A steady stream downloads for as long as it needs.
const STALL_MS = 60_000;

async function fetchTrack(url: string): Promise<Uint8Array> {
  // Never let the offscreen doc (extension origin, holds host_permissions) fetch
  // an arbitrary host — only fbcdn tracks. Blocks SSRF via a forged audio/video URL.
  if (!isFbcdn(url)) throw new Error('Track URL not allowed.');
  const ctrl = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctrl.abort();
    }, STALL_MS);
  };
  try {
    arm();
    const res = await fetch(url, { credentials: 'omit', signal: ctrl.signal });
    if (!res.ok) throw new Error(`Couldn't fetch the track (${res.status}). The fbcdn URL may have expired — reload the Facebook page.`);
    if (!res.body) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(); // progress: reset the idle timer
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  } catch (e) {
    if (stalled || (e as Error)?.name === 'AbortError') {
      throw new Error('The track download stalled and was aborted. The fbcdn URL may have expired — reload the Facebook page.');
    }
    throw e;
  } finally {
    clearTimeout(timer!);
  }
}

async function mux(videoUrl: string, audioUrl: string): Promise<string> {
  const f = await ensureLoaded();
  const [v, a] = await Promise.all([fetchTrack(videoUrl), fetchTrack(audioUrl)]);
  await f.writeFile('v.mp4', v);
  await f.writeFile('a.mp4', a);
  let out: Uint8Array | string;
  try {
    // No aac_adtstoasc: fbcdn audio is already ASC-framed inside MP4.
    // exec resolves to the process exit code (it does not reject on non-zero); a
    // failed remux writes no out.mp4, so surface the code instead of failing later
    // on a confusing "file not found" from readFile.
    const code = await f.exec(['-y', '-i', 'v.mp4', '-i', 'a.mp4', '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest', 'out.mp4']);
    if (code !== 0) {
      throw new Error(`Remux failed (ffmpeg exit ${code}). A track may be mismatched or an expired fbcdn URL returned an incomplete stream — reload the Facebook page.`);
    }
    out = await f.readFile('out.mp4');
  } finally {
    // Also on failure: the wasm FS lives as long as this document, so leftover
    // tracks would hold their megabytes until the next job overwrites them.
    await f.deleteFile('v.mp4').catch(() => {});
    await f.deleteFile('a.mp4').catch(() => {});
    await f.deleteFile('out.mp4').catch(() => {});
  }
  const bytes = typeof out === 'string' ? new TextEncoder().encode(out) : out;
  // Copy into a fresh ArrayBuffer-backed view so it's a valid BlobPart.
  const buf = new Uint8Array(bytes.byteLength);
  buf.set(bytes);
  return publishBlob(buf);
}

// The SW revokes each blob via FACESCRAP_REVOKE once its download settles; if the SW
// is torn down first, self-revoke after a generous TTL so a full MP4 can't leak
// for the lifetime of this never-closed offscreen document.
const BLOB_TTL_MS = 10 * 60_000;
const pendingRevokes = new Map<string, ReturnType<typeof setTimeout>>();

function publishBlob(buf: Uint8Array<ArrayBuffer>): string {
  const url = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
  pendingRevokes.set(url, setTimeout(() => revokeBlob(url), BLOB_TTL_MS));
  return url;
}

function revokeBlob(url: string): void {
  const timer = pendingRevokes.get(url);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingRevokes.delete(url);
  }
  URL.revokeObjectURL(url);
}

// ffmpeg.wasm is a single instance with fixed FS filenames, so concurrent remuxes
// would clobber each other's files and silently corrupt output; serialize all jobs.
let muxQueue: Promise<unknown> = Promise.resolve();
function enqueueMux(videoUrl: string, audioUrl: string): Promise<string> {
  const job = muxQueue.then(() => mux(videoUrl, audioUrl));
  // Keep the chain alive even if this job throws, without swallowing the result
  // handed back to the caller.
  muxQueue = job.catch(() => {});
  return job;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only the extension's own pages (the SW) drive the mux; a content script has
  // sender.tab set. Defense in depth — mux inputs are fbcdn-gated anyway.
  if (sender.tab) return undefined;
  const m = msg as RuntimeMessage | undefined;
  if (m?.type === 'FACESCRAP_MUX') {
    (async () => {
      try {
        const blobUrl = await enqueueMux(m.videoUrl, m.audioUrl);
        sendResponse({ ok: true, blobUrl } satisfies MuxResponse);
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message ?? e) } satisfies MuxResponse);
      }
    })();
    return true; // keep the channel open for the async response
  }
  if (m?.type === 'FACESCRAP_REVOKE' && typeof m.blobUrl === 'string') {
    revokeBlob(m.blobUrl);
  }
  return undefined;
});
