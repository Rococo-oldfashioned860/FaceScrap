// FaceScrap offscreen document.
// The service worker cannot run ffmpeg.wasm (no DOM, no URL.createObjectURL,
// killed mid-job). This offscreen page fetches the separate DASH video + audio
// tracks from fbcdn (host_permissions bypass CORS) and remuxes them into one
// MP4 with `-c copy` (lossless — no re-encode). All assets are bundled locally
// (no CDN); CSP needs only `wasm-unsafe-eval` (no SharedArrayBuffer / COI).

import { MUX_PORT, MUX_PROGRESS_MS, type MuxProgress, type MuxResponse, type RuntimeMessage } from '../shared/messages';
import { fetchDashTracks, MAX_DASH_OUTPUT_BYTES } from '../shared/track-fetch';

// Provided by the UMD ffmpeg.js loaded via <script> in offscreen.html.
declare const FFmpegWASM: { FFmpeg: new () => FFmpegInstance };

interface FFmpegInstance {
  load(opts: { coreURL: string; wasmURL: string }): Promise<boolean>;
  writeFile(name: string, data: Uint8Array): Promise<boolean>;
  readFile(name: string): Promise<Uint8Array | string>;
  deleteFile(name: string): Promise<boolean>;
  exec(args: string[]): Promise<number>;
  /** Emits while exec runs. Its only job here is to prove the remux is alive:
   *  a multi-hundred-MB `-c copy` pass sends no network traffic, so without
   *  this the worker would see the whole exec as one silent gap. */
  on(event: 'progress', cb: (e: { progress: number }) => void): void;
  createDir(path: string): Promise<boolean>;
  /** Mounts a Blob-backed read-only FS. WORKERFS reads through to the Blob by
   *  range instead of copying it into the wasm heap — see mux() for why that
   *  matters here. */
  mount(fsType: string, options: { blobs?: { name: string; data: Blob }[] }, mountPoint: string): Promise<boolean>;
  unmount(mountPoint: string): Promise<boolean>;
}

// Read-only mount point for the two fetched tracks. Output still goes to MEMFS
// at the root: WORKERFS cannot be written to.
const IN_DIR = '/in';

const BASE = chrome.runtime.getURL('assets/ffmpeg');
let ff: FFmpegInstance | null = null;
let loading: Promise<FFmpegInstance> | null = null;

// Where ffmpeg's own progress events go while an exec runs. A module variable
// rather than a parameter because the callback is registered ONCE per loaded
// instance, while the reporter belongs to the current job — and jobs are
// serialized on muxQueue, so only one is ever active.
let activeReport: ((p: MuxProgress) => void) | null = null;

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
        // Registered once, for the lifetime of the instance: a long `-c copy`
        // pass makes no network requests, so these events are the only proof
        // the remux is progressing rather than wedged.
        instance.on('progress', (e) => activeReport?.({ phase: 'remux', bytes: Math.round(e.progress * 100) }));
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

/** Opens a progress port to the worker for ONE job. Jobs are serialized on both
 *  sides (muxQueue here, dashChain there), so at most one is ever open. */
function progressPort(): { report: (p: MuxProgress) => void; close: () => void } {
  let port: chrome.runtime.Port | null = null;
  try {
    port = chrome.runtime.connect({ name: MUX_PORT });
  } catch {
    // No worker to talk to (torn down mid-job). The mux still completes; the
    // worker's hard cap covers the case where nobody is listening.
  }
  let last = 0;
  return {
    report(p) {
      const now = performance.now();
      if (now - last < MUX_PROGRESS_MS) return; // a chunk-rate port would flood the worker
      last = now;
      try {
        port?.postMessage(p);
      } catch {
        port = null;
      }
    },
    close() {
      try {
        port?.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}

// WORKERFS is the whole point of handing ffmpeg Blobs (see below), but it is one
// mount call away from being unavailable in some future core build. Fall back to
// writeFile permanently once it fails, so a bad mount degrades to the old memory
// profile instead of breaking every DASH download.
let canMount = true;

/** Hand the two tracks to ffmpeg WITHOUT copying them into the wasm heap.
 *  writeFile duplicates each track inside the heap, on top of the copy this
 *  document already holds — for a 500MB video that alone is over a gigabyte,
 *  and the heap does not give it back between jobs. WORKERFS reads through to
 *  the Blob by range instead. Returns true if the tracks live under IN_DIR. */
async function mountTracks(f: FFmpegInstance, v: Blob, a: Blob): Promise<boolean> {
  if (!canMount) return false;
  try {
    await f.createDir(IN_DIR).catch(() => {}); // survives between jobs; already-exists is fine
    await f.mount('WORKERFS', { blobs: [{ name: 'v.mp4', data: v }, { name: 'a.mp4', data: a }] }, IN_DIR);
    return true;
  } catch {
    canMount = false;
    return false;
  }
}

async function mux(videoUrl: string, audioUrl: string, report: (p: MuxProgress) => void): Promise<string> {
  const f = await ensureLoaded();
  // Each track reports its own CUMULATIVE total, which can go down when a
  // resume restarts from scratch — so track them separately and sum, rather
  // than accumulating deltas that a rewind would leave overstated forever.
  const held = { video: 0, audio: 0 };
  const post = (): void => report({ phase: 'fetch', bytes: held.video + held.audio });
  const [v, a] = await fetchDashTracks(
    videoUrl,
    audioUrl,
    (t) => {
      held.video = t;
      post();
    },
    (t) => {
      held.audio = t;
      post();
    },
  );

  const mounted = await mountTracks(f, v, a);
  if (!mounted) {
    await f.writeFile('v.mp4', new Uint8Array(await v.arrayBuffer()));
    await f.writeFile('a.mp4', new Uint8Array(await a.arrayBuffer()));
  }
  const vPath = mounted ? `${IN_DIR}/v.mp4` : 'v.mp4';
  const aPath = mounted ? `${IN_DIR}/a.mp4` : 'a.mp4';

  let out: Uint8Array | string;
  activeReport = report; // ffmpeg's progress events prove the exec is alive
  try {
    // No aac_adtstoasc: fbcdn audio is already ASC-framed inside MP4.
    // exec resolves to the process exit code (it does not reject on non-zero); a
    // failed remux writes no out.mp4, so surface the code instead of failing later
    // on a confusing "file not found" from readFile.
    const code = await f.exec(['-y', '-i', vPath, '-i', aPath, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest', 'out.mp4']);
    if (code !== 0) {
      throw new Error(`Remux failed (ffmpeg exit ${code}). A track may be mismatched or an expired fbcdn URL returned an incomplete stream — reload the Facebook page.`);
    }
    out = await f.readFile('out.mp4');
  } finally {
    activeReport = null;
    // Also on failure: the wasm FS lives as long as this document, so leftover
    // tracks would hold their megabytes until the next job overwrites them.
    if (mounted) await f.unmount(IN_DIR).catch(() => {});
    else {
      await f.deleteFile('v.mp4').catch(() => {});
      await f.deleteFile('a.mp4').catch(() => {});
    }
    await f.deleteFile('out.mp4').catch(() => {});
  }
  if (typeof out === 'string' && out.length > MAX_DASH_OUTPUT_BYTES) {
    throw new Error(`Remux output exceeds the ${MAX_DASH_OUTPUT_BYTES}-byte safety limit.`);
  }
  const bytes = typeof out === 'string' ? new TextEncoder().encode(out) : out;
  // Check before allocating the second full-size output copy or publishing a
  // Blob URL. A remux cannot legitimately exceed its combined DASH inputs.
  if (bytes.byteLength > MAX_DASH_OUTPUT_BYTES) {
    throw new Error(`Remux output exceeds the ${MAX_DASH_OUTPUT_BYTES}-byte safety limit.`);
  }
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
  // The port opens when the job STARTS, not when it is queued: the worker times
  // each job from its own start, and a queued job reporting nothing yet would
  // otherwise look idle.
  const job = muxQueue.then(async () => {
    const port = progressPort();
    try {
      return await mux(videoUrl, audioUrl, port.report);
    } finally {
      port.close();
    }
  });
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
