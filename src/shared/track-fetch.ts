// Resumable fetch for one DASH track.
//
// Kept out of offscreen.ts (which reaches for chrome.* at module scope, so it
// cannot be imported by a test) precisely so this logic — the part with
// interesting failure modes — can be exercised without a browser.
//
// No chrome.* here.

import { isFbcdn } from './media';

/** fetch() has no read timeout: a socket that connects then stalls mid-body
 *  (edge hiccup, network/VPN switch, silent middlebox) leaves the read pending
 *  forever. Bound the IDLE gap, never total duration — a whole-transfer cap
 *  cannot tell a stall from a large track on a slow-but-steady link, and
 *  aborted legitimate slow downloads. */
const STALL_MS = 60_000;

/** A dropped connection is worth retrying; an expired URL is not (see below). */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

// A 500 MB (decimal) video track still fits, as does its audio companion, while
// forged/unbounded responses cannot consume the offscreen document indefinitely.
export const MAX_DASH_TRACK_BYTES = 512 * 1024 * 1024;
export const MAX_DASH_INPUT_BYTES = 640 * 1024 * 1024;
// The remux is stream-copy only, so it must never be larger than both bounded
// inputs together. Kept distinct so the publish boundary is explicit/auditable.
export const MAX_DASH_OUTPUT_BYTES = MAX_DASH_INPUT_BYTES;

export interface FetchTrackOptions {
  /** Injected for tests; defaults to the global. */
  fetch?: typeof globalThis.fetch;
  attempts?: number;
  retryDelayMs?: number;
  stallMs?: number;
  /** Primarily useful for focused tests; production callers use the hard cap. */
  maxBytes?: number;
  signal?: AbortSignal;
}

/** Thrown for an HTTP status the server will keep returning. Retrying an
 *  expired fbcdn URL only delays the message the user actually needs. */
class HardHttpError extends Error {}
class ByteLimitError extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Buffered {
  chunks: Uint8Array[];
  bytes: number;
}

interface SharedBudget {
  used: number;
  readonly limit: number;
}

function contentLength(res: Response): number | null {
  const raw = res.headers.get('Content-Length');
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function overflow(kind: 'track' | 'combined', limit: number): ByteLimitError {
  return new ByteLimitError(`DASH ${kind} exceeds the ${limit}-byte safety limit.`);
}

/** One read attempt. Resumes from `held.bytes` when there is anything to resume
 *  from, and appends what it reads to `held`. */
async function readAttempt(
  url: string,
  held: Buffered,
  onBytes: (total: number) => void,
  doFetch: typeof globalThis.fetch,
  stallMs: number,
  maxBytes: number,
  shared: SharedBudget | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const ctrl = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctrl.abort();
    }, stallMs);
  };
  const abortFromCaller = (): void => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    arm();
    const res = await doFetch(url, {
      credentials: 'omit',
      signal: ctrl.signal,
      headers: held.bytes > 0 ? { Range: `bytes=${held.bytes}-` } : undefined,
    });
    if (!res.ok) {
      throw new HardHttpError(
        `Couldn't fetch the track (${res.status}). The fbcdn URL may have expired — reload the Facebook page.`,
      );
    }
    // Asked to resume but got a full body: 206 means "here is the range you
    // asked for", anything else means "here is the whole file". Appending it to
    // what we already hold would duplicate the head and corrupt the track, so
    // drop the old bytes and take this body as the complete one.
    if (held.bytes > 0 && res.status !== 206) {
      if (shared) shared.used -= held.bytes;
      held.chunks.length = 0;
      held.bytes = 0;
      onBytes(0);
    }
    const advertised = contentLength(res);
    if (advertised !== null) {
      if (held.bytes + advertised > maxBytes) {
        ctrl.abort();
        throw overflow('track', maxBytes);
      }
      if (shared && shared.used + advertised > shared.limit) {
        ctrl.abort();
        throw overflow('combined', shared.limit);
      }
    }
    const append = (chunk: Uint8Array): void => {
      if (held.bytes + chunk.byteLength > maxBytes) {
        ctrl.abort();
        throw overflow('track', maxBytes);
      }
      if (shared && shared.used + chunk.byteLength > shared.limit) {
        ctrl.abort();
        throw overflow('combined', shared.limit);
      }
      held.chunks.push(chunk);
      held.bytes += chunk.byteLength;
      if (shared) shared.used += chunk.byteLength;
      onBytes(held.bytes);
    };
    if (!res.body) {
      const whole = new Uint8Array(await res.arrayBuffer());
      append(whole);
      return;
    }
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(); // progress: reset the idle timer
      append(value);
    }
  } catch (e) {
    if (stalled) {
      throw new Error('The track download stalled and was aborted. The fbcdn URL may have expired — reload the Facebook page.');
    }
    if ((e as Error)?.name === 'AbortError' && signal?.aborted) {
      throw signal.reason ?? e;
    }
    throw e;
  } finally {
    clearTimeout(timer!);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

/** Download one track, resuming across dropped connections.
 *
 *  Returns a Blob rather than a flat Uint8Array: building the flat buffer means
 *  holding the chunk list AND the copy at once, doubling peak memory for the
 *  largest thing this extension touches, and the browser can back a large Blob
 *  with disk where a JS-heap buffer is always resident.
 *
 *  `onBytes` receives the CUMULATIVE byte count, which can go DOWN if a restart
 *  discards partial data — callers reporting progress must handle that rather
 *  than assume monotonicity. */
export async function fetchTrack(
  url: string,
  onBytes: (total: number) => void,
  opts: FetchTrackOptions = {},
): Promise<Blob> {
  return fetchTrackWithBudget(url, onBytes, opts);
}

async function fetchTrackWithBudget(
  url: string,
  onBytes: (total: number) => void,
  opts: FetchTrackOptions,
  shared?: SharedBudget,
): Promise<Blob> {
  // Never let the offscreen doc (extension origin, holds host_permissions) fetch
  // an arbitrary host — only fbcdn tracks. Blocks SSRF via a forged track URL.
  if (!isFbcdn(url)) throw new Error('Track URL not allowed.');
  const doFetch = opts.fetch ?? globalThis.fetch;
  const attempts = opts.attempts ?? ATTEMPTS;
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
  const stallMs = opts.stallMs ?? STALL_MS;
  const maxBytes = opts.maxBytes ?? MAX_DASH_TRACK_BYTES;

  const held: Buffered = { chunks: [], bytes: 0 };
  for (let attempt = 1; ; attempt++) {
    try {
      await readAttempt(url, held, onBytes, doFetch, stallMs, maxBytes, shared, opts.signal);
      // The cast covers ArrayBufferLike vs ArrayBuffer only: a fetch body is
      // never backed by a SharedArrayBuffer here (no cross-origin isolation).
      return new Blob(held.chunks as unknown as BlobPart[]);
    } catch (e) {
      // A status the server will repeat is not worth three round trips.
      if (e instanceof HardHttpError || e instanceof ByteLimitError || opts.signal?.aborted || attempt >= attempts) throw e;
      await sleep(retryDelayMs * attempt);
    }
  }
}

export interface FetchDashTracksOptions extends FetchTrackOptions {
  /** Primarily useful for focused tests; production callers use the hard cap. */
  maxTotalBytes?: number;
}

/** Fetches both DASH inputs under one byte budget. Failure of either side aborts
 * the sibling immediately so it cannot continue consuming network or memory. */
export async function fetchDashTracks(
  videoUrl: string,
  audioUrl: string,
  onVideoBytes: (total: number) => void,
  onAudioBytes: (total: number) => void,
  opts: FetchDashTracksOptions = {},
): Promise<[Blob, Blob]> {
  const controller = new AbortController();
  const shared: SharedBudget = { used: 0, limit: opts.maxTotalBytes ?? MAX_DASH_INPUT_BYTES };
  const abortSibling = async (promise: Promise<Blob>): Promise<Blob> => {
    try {
      return await promise;
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };
  const childOpts = { ...opts, signal: controller.signal };
  return Promise.all([
    abortSibling(fetchTrackWithBudget(videoUrl, onVideoBytes, childOpts, shared)),
    abortSibling(fetchTrackWithBudget(audioUrl, onAudioBytes, childOpts, shared)),
  ]);
}
