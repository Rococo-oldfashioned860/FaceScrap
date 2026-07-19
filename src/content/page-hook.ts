// FaceScrap page hook (MAIN world).
// Runs in the page's own JS context so it can read the responses of the
// GraphQL calls Facebook already makes. We NEVER re-issue queries with a
// hardcoded doc_id (Meta rotates those every 2-4 weeks) — we only passively
// read what the client fetches, plus embedded JSON in the initial document.

import {
  fbAssetKeys,
  isFbcdn,
  isProfilePicCrop,
  makeItem,
  MAX_ITEMS_PER_MESSAGE,
  trackKey,
  type MediaItem,
  type MediaSource,
} from '../shared/media';
import {
  decodeMpd,
  extractPrefetchPairs,
  extractStringsByKey,
  extractUrlsByKey,
  fromMpdXml,
  fromPrefetchReps,
  MPD_STRING_KEYS,
  VIDEO_KEYS,
  type DashPair,
} from '../shared/dash';
import { diagBump, diagDrain, setDiagEnabled } from '../shared/diag';
import { storyDomIdForGraphqlChild, storyDomIdFromGraphqlNode } from '../shared/story-mark';
import {
  createBoundedCollector,
  createTextBudget,
  readClonedResponseTextLimited,
  trimQueueToBudget,
  type BoundedCollector,
} from '../shared/page-hook-limits';

// --- Diagnostics control channel (see diag.ts) ---
// This world has no chrome.*, so the flag has to be handed over by the content
// script. Ask for it rather than waiting to be told: the hook is injected as a
// separate <script> and either side can win the load race, and delaying the
// fetch/XHR patches below to await an answer would miss early traffic — the one
// cost never worth paying.
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const d = e.data as { __facescrapCtl?: boolean; diag?: unknown } | null;
  if (d && d.__facescrapCtl === true && typeof d.diag === 'boolean') setDiagEnabled(d.diag);
});
window.postMessage({ __facescrapCtl: true, query: true }, '*');

/** Hand this world's counts to the content script, which owns chrome.storage. */
function flushDiag(): void {
  const counters = diagDrain();
  if (Object.keys(counters).length > 0) window.postMessage({ __facescrap: true, diag: counters }, '*');
}

function post(items: readonly MediaItem[]): void {
  // The receiver hard-caps each message at MAX_ITEMS_PER_MESSAGE to bound a hostile
  // co-resident script. One real reels-feed response harvests well past that
  // (~1248 items measured), so posting it as a single message would silently drop
  // everything past the cap — typically the DASH ladders of reels nested deepest,
  // i.e. exactly the one being watched. Chunk our own legitimate batch to cap size.
  for (let i = 0; i < items.length; i += MAX_ITEMS_PER_MESSAGE) {
    window.postMessage({ __facescrap: true, items: items.slice(i, i + MAX_ITEMS_PER_MESSAGE) }, '*');
  }
}

// Keys under which a video's thumbnail/poster image may sit in the same node.
const THUMB_KEYS = [
  'preferred_thumbnail',
  'image',
  'thumbnailImage',
  'preview_image',
  'thumbnail',
  'poster_image',
  'first_frame_thumbnail',
  'video_thumbnail',
  'thumbnail_image',
  'previewImage',
  'thumbnail_src',
];

/** Find a poster/thumbnail fbcdn image URL within a video node. */
function findThumb(rec: Record<string, unknown>): string | undefined {
  for (const key of THUMB_KEYS) {
    const v = rec[key];
    if (typeof v === 'string' && isFbcdn(v)) return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.uri === 'string' && isFbcdn(o.uri)) return o.uri;
      const img = o.image as Record<string, unknown> | undefined;
      if (img && typeof img.uri === 'string' && isFbcdn(img.uri)) return img.uri;
    }
  }
  return undefined;
}

// A video's poster and its DASH manifest often arrive in DIFFERENT GraphQL
// responses, and the raw-text manifest fallback has no structured node to read a
// poster from. Key posters by the STABLE xpv asset id (survives rotating fbcdn
// filenames) so pairs captured without one still get their cover.
const posterByXpv = new Map<string, string>();
// The map lives as long as the Facebook tab; cap it so an hours-long scroll
// session can't grow it unboundedly (FIFO — Map preserves insertion order).
const POSTER_MAX = 400;

function xpvOf(url: string): string | undefined {
  return fbAssetKeys(url).find((k) => k.startsWith('xpv:'));
}

function rememberPoster(videoUrl: string, thumb: string | undefined): void {
  if (!thumb) return;
  const x = xpvOf(videoUrl);
  if (!x || posterByXpv.has(x)) return;
  posterByXpv.set(x, thumb);
  if (posterByXpv.size > POSTER_MAX) {
    posterByXpv.delete(posterByXpv.keys().next().value as string);
  }
}

function tagStory(item: MediaItem, storyId: string | undefined): MediaItem {
  if (storyId != null) item.storyIds = [storyId];
  return item;
}

function pushPair(
  pair: DashPair,
  source: MediaSource,
  out: BoundedCollector<MediaItem>,
  now: number,
  thumb?: string,
  storyId?: string,
): void {
  const item = makeItem(pair.videoUrl, 'video', source, 'graphql', now, true);
  tagStory(item, storyId);
  item.audioUrl = pair.audioUrl;
  const x = xpvOf(pair.videoUrl);
  const poster = thumb ?? (x ? posterByXpv.get(x) : undefined);
  if (poster) item.thumbUrl = poster;
  rememberPoster(pair.videoUrl, poster);
  // Keep the key of every quality so the now-playing filter matches whichever
  // adaptive-bitrate track the player actually streams (see MediaItem.trackIds).
  item.trackIds = pair.trackUrls.map(trackKey);
  if (pair.height != null) item.height = pair.height;
  if (pair.durationSec != null) item.durationSec = pair.durationSec;
  out.add(item);
}

// Detect a DASH source on a single object node and emit one linked pair per
// video quality in the ladder (the side panel groups them into one row with a
// quality picker via videoGroupKey/resolutionOf).
function harvestDash(
  rec: Record<string, unknown>,
  source: MediaSource,
  out: BoundedCollector<MediaItem>,
  now: number,
  storyId?: string,
): void {
  // findThumb scans 11 keys on the node; harvest visits EVERY object in a multi-MB
  // payload, and the vast majority carry no DASH. Resolve the poster lazily so the
  // scan runs only on the few nodes that actually emit a pair.
  let thumb: string | undefined;
  let thumbDone = false;
  const poster = (): string | undefined => {
    if (!thumbDone) {
      thumb = findThumb(rec);
      thumbDone = true;
    }
    return thumb;
  };
  if ('all_video_dash_prefetch_representations' in rec) {
    for (const pair of fromPrefetchReps(rec.all_video_dash_prefetch_representations)) {
      if (out.full) break;
      pushPair(pair, source, out, now, poster(), storyId);
    }
  }
  for (const key of MPD_STRING_KEYS) {
    const val = rec[key];
    if (typeof val === 'string' && val.length > 40) {
      const found = fromMpdXml(decodeMpd(val));
      if (found.length > 0) {
        for (const pair of found) {
          if (out.full) break;
          pushPair(pair, source, out, now, poster(), storyId);
        }
        break;
      }
    }
  }
}

function pageSource(): MediaSource {
  const p = location.pathname;
  if (/highlight/i.test(p)) return 'highlight';
  if (/\/stories\//.test(p)) return 'story';
  if (/\/reel\//.test(p)) return 'reel';
  return 'video';
}

const VIDEO_KEY_SET: ReadonlySet<string> = new Set(VIDEO_KEYS);

// Recursively collect media URLs from a parsed GraphQL/JSON object.
// The depth cap only guards against pathological payloads (parsed JSON has no
// cycles); it must comfortably exceed Facebook's feed nesting, where a home-feed
// video node sits ~13-19 levels deep (arrays count too).
function harvest(
  obj: unknown,
  source: MediaSource,
  out: BoundedCollector<MediaItem>,
  now: number,
  depth = 0,
  inheritedStoryId?: string,
): void {
  if (!obj || out.full) return;
  if (depth > 48) {
    diagBump('harvestDepthExceeded');
    return;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) {
      if (out.full) break;
      harvest(v, source, out, now, depth + 1, inheritedStoryId);
    }
    return;
  }
  if (typeof obj !== 'object') return;

  const rec = obj as Record<string, unknown>;
  // The rendered Story card and its GraphQL node expose the same opaque `Uz...`
  // id. Carry it only through this node's descendants so media from prefetched
  // neighbouring cards remains distinguishable even when request timing is not.
  const directStoryId = storyDomIdFromGraphqlNode(rec);
  const storyId = directStoryId ?? inheritedStoryId;
  harvestDash(rec, source, out, now, storyId);

  for (const [k, v] of Object.entries(rec)) {
    if (out.full) break;
    if (typeof v === 'string' && isFbcdn(v)) {
      if (VIDEO_KEY_SET.has(k)) {
        const item = tagStory(makeItem(v, 'video', source, 'graphql', now), storyId);
        const th = findThumb(rec) ?? (xpvOf(v) ? posterByXpv.get(xpvOf(v)!) : undefined);
        if (th) item.thumbUrl = th;
        rememberPoster(v, th);
        out.add(item);
      } else if (k === 'audio_url') out.add(makeItem(v, 'audio', source, 'graphql', now, true));
    } else if (v && typeof v === 'object') {
      const node = v as Record<string, unknown>;
      // Image node shape: { uri, width, height }. This branch is promiscuous —
      // it fires on EVERY image node in EVERY response — so it carries two
      // noise gates the deliberate capture paths don't: profile-picture crops
      // (path type `tXX.Y-1`) are UI chrome — the stories tray's Create-story
      // tile ships the viewer's own face this way, which the panel then showed
      // as "a story from my profile" that was never posted — and sub-200px
      // renditions are avatars and tray previews of stories never opened (the
      // DOM scan applies the same 200px floor). Video posters are unaffected:
      // they ride THUMB_KEYS, not this branch.
      if (
        typeof node.uri === 'string' &&
        isFbcdn(node.uri) &&
        typeof node.height === 'number' &&
        node.height >= 200 &&
        (typeof node.width !== 'number' || node.width >= 200) &&
        !isProfilePicCrop(node.uri)
      ) {
        out.add(makeItem(node.uri, 'image', source, 'graphql', now));
      }
      harvest(
        v,
        source,
        out,
        now,
        depth + 1,
        storyDomIdForGraphqlChild(directStoryId, inheritedStoryId, k),
      );
    }
  }
}

function processScan(text: string, source: MediaSource): void {
  // Callers pre-gate on fbcdn in scanText(), so text here already contains media candidates.
  // 2,500 leaves ample room above the measured ~1,248-item reels feed while
  // preventing a hostile/changed response from growing work and postMessage
  // payloads without bound. Aggregate weight catches fewer but giant items.
  const out = createBoundedCollector<MediaItem>({
    maxItems: 2_500,
    maxWeight: 16 * 1024 * 1024,
    weightOf: (item) => JSON.stringify(item).length,
  });
  const now = Date.now();

  // Regex fallback — robust to GraphQL shape changes.
  for (const url of extractUrlsByKey(text)) {
    if (out.full) break;
    out.add(makeItem(url, 'video', source, 'graphql', now));
  }

  // Manifest fallback — the full DASH ladder (every resolution + audio) ships as an
  // escaped MPD string under videoDeliveryResponseResult.dash_manifests[].manifest_xml,
  // sometimes framed so the per-line parser can't split it or nested past the
  // recursion guard; pull it straight from the raw text.
  const seenMpd = new Set<string>();
  for (const raw of extractStringsByKey(text)) {
    if (out.full) break;
    const xml = decodeMpd(raw);
    // Dedupe signature must span more than the head: MPD headers are mostly
    // fixed boilerplate, and two same-duration videos would collide (dropping
    // one ladder). Length + head + tail (per-video BaseURLs) is collision-safe.
    const sig = `${xml.length}:${xml.slice(0, 120)}:${xml.slice(-120)}`;
    if (seenMpd.has(sig)) continue;
    seenMpd.add(sig);
    for (const pair of fromMpdXml(xml)) {
      if (out.full) break;
      pushPair(pair, source, out, now);
    }
  }

  // Structured parse — GraphQL streams one JSON object per line. Skip a
  // pathologically large single line (>16 MB): JSON.parse + harvest on it would
  // stall the main thread against the MSE player's buffer appends, and the regex
  // passes above already recover its named video URLs and MPD strings. The
  // prefetch ladder is a structured array, so recover just that bounded slice
  // below instead of parsing the whole oversized line.
  const MAX_JSON_LINE = 16 * 1024 * 1024;
  for (const line of text.split('\n')) {
    if (out.full) break;
    const s = line.trim();
    if (s.length < 2 || s[0] !== '{') continue;
    if (s.length > MAX_JSON_LINE) {
      diagBump('jsonLineTooLarge');
      for (const pair of extractPrefetchPairs(s)) {
        if (out.full) break;
        pushPair(pair, source, out, now);
      }
      continue;
    }
    try {
      harvest(JSON.parse(s), source, out, now);
    } catch {
      diagBump('jsonLineParseError'); /* partial/non-JSON line */
    }
  }

  if (out.full) diagBump('scanOutputCapped');
  diagBump('captureGraphql', out.items.length);
  post(out.items);
}

// The hook shares the main thread with Facebook's MSE video player; parsing a
// multi-MB GraphQL response synchronously starves its buffer appends. Queue each
// response and process one per macrotask, preferring the oldest disposable entries
// during bursts. `source` is stamped at ENQUEUE time — an SPA navigation before
// drain must not relabel items captured on the previous surface. Document scans
// (`keep`) are the primary capture path for standalone reel/watch pages, but are
// still subject to the same hard aggregate caps.
interface ScanJob {
  text: string;
  source: MediaSource;
  keep?: boolean;
}
const scanQueue: ScanJob[] = [];
// Hard per-body/per-job cap. It is enforced while fetch clones stream and again
// at enqueue so XHR and document scans cannot bypass it.
const MAX_BODY_BYTES = 24 * 1024 * 1024;
// Bound the queue by BOTH entry count and total retained bytes: a handful of
// multi-MB feed bodies matters far more than many tiny ones. queuedBytes tracks the
// live sum so a scroll burst can't pin tens of MB of response text waiting to drain.
const SCAN_QUEUE_MAX = 8;
const SCAN_QUEUE_MAX_BYTES = MAX_BODY_BYTES;
let queuedBytes = 0;
let draining = false;
function scanText(text: string, keep = false): void {
  if (!text || text.length < 20) return;
  if (text.length > MAX_BODY_BYTES) {
    diagBump('graphqlBodyTooLarge');
    return;
  }
  // Pre-gate at ENQUEUE: every parser needs isFbcdn on each URL, so a body with no
  // fbcdn host yields nothing, and media-less GraphQL (typing/presence/notifs) never
  // takes a queue slot or schedules a drain. Escaped JSON keeps the bare `fbcdn.net`
  // host intact, so this never hides media behind an unlisted key.
  if (!text.includes('fbcdn.net')) return;
  scanQueue.push({ text, source: pageSource(), keep });
  queuedBytes += text.length;
  // Prefer dropping disposable traffic, but a burst made only of document
  // (`keep`) jobs is still bounded. No job, including the newly queued one, is
  // exempt from the aggregate cap.
  const droppedJobs = trimQueueToBudget({
    queue: scanQueue,
    maxItems: SCAN_QUEUE_MAX,
    maxWeight: SCAN_QUEUE_MAX_BYTES,
    weightOf: (job) => job.text.length,
    isDisposable: (job) => !job.keep,
  });
  for (const dropped of droppedJobs) {
    queuedBytes -= dropped.text.length;
    // A whole response, not one item: every ladder it carried is gone.
    diagBump('scanQueueEvicted');
  }
  if (!draining) {
    draining = true;
    setTimeout(drainScans, 0);
  }
}
function drainScans(): void {
  const job = scanQueue.shift();
  if (job === undefined) {
    draining = false;
    return;
  }
  queuedBytes -= job.text.length;
  try {
    processScan(job.text, job.source);
  } catch {
    /* ignore */
  }
  job.text = ''; // release the body for GC before the next macrotask runs
  // Macrotask boundary: a natural flush point that needs no timer of its own.
  flushDiag();
  if (scanQueue.length) setTimeout(drainScans, 0);
  else draining = false;
}

// --- Patch fetch ---
const origFetch = window.fetch;
window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
  const p = origFetch.apply(this as typeof globalThis, args);
  try {
    const input = args[0];
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url && url.includes('/api/graphql')) {
      p.then(async (res) => {
        const result = await readClonedResponseTextLimited(res, MAX_BODY_BYTES);
        if (!result.ok) {
          diagBump('graphqlBodyTooLarge');
          return '';
        }
        return result.text;
      })
        .then(scanText)
        .catch(() => {});
    }
  } catch {
    /* ignore */
  }
  return p;
} as typeof fetch;

// --- Patch XHR ---
const origOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, _method: string, url: string | URL) {
  const self = this as XMLHttpRequest & { __facescrapUrl?: string; __facescrapHooked?: boolean };
  self.__facescrapUrl = String(url); // refresh the URL on every open()...
  if (!self.__facescrapHooked) {
    // ...but attach the load listener only ONCE per instance. If Facebook reuses a
    // long-lived XHR (open() called again), a per-open listener would stack and
    // re-scan/enqueue the same multi-MB body once per prior open().
    self.__facescrapHooked = true;
    this.addEventListener('load', function (this: XMLHttpRequest & { __facescrapUrl?: string }) {
      try {
        if (this.__facescrapUrl?.includes('/api/graphql') && typeof this.responseText === 'string') {
          scanText(this.responseText);
        }
      } catch {
        /* ignore */
      }
    });
  }
  // eslint-disable-next-line prefer-rest-params
  return origOpen.apply(this, arguments as unknown as Parameters<typeof origOpen>);
} as typeof XMLHttpRequest.prototype.open;

// --- Tell the content script when the SPA navigates ---
// Facebook advances feed → /reel/<id> with pushState, which fires no popstate
// and no main_frame request (the service worker's own comment notes this). The
// content script had no navigation signal at all: it waited for its 300ms
// poller or a media event, and a slide transition detected late restamps
// slideAt, which is what the anchoring window in now-playing.ts measures
// against. Patching history has to happen HERE — an isolated content script
// sees its own History object, not the page's.
//
// This does NOT change how the id is resolved: reelVideoId (data-video-id)
// still outranks the URL, which lags the scroll. It only makes the content
// script look sooner.
function notifyNav(): void {
  try {
    window.postMessage({ __facescrap: true, nav: true }, '*');
  } catch {
    /* ignore */
  }
}
for (const name of ['pushState', 'replaceState'] as const) {
  const original = history[name];
  history[name] = function (this: History, ...args: Parameters<typeof original>) {
    const result = original.apply(this, args);
    notifyNav();
    return result;
  } as typeof original;
}
// pushState/replaceState do not fire popstate; back/forward do not call them.
window.addEventListener('popstate', notifyNav);

// --- Scan embedded JSON in the initial document (reel/watch standalone pages). ---
// Facebook ships the media (DASH ladders, playable_urls) inside <script> JSON blobs,
// NOT the rendered markup; scanning only fbcdn-mentioning script contents (rather
// than the whole outerHTML) avoids retaining megabytes of DOM/CSS/SVG. Rendered
// <img>/<video> covers are captured by the content script's DOM scan.
let documentScanRunning = false;
async function scanDocument(): Promise<void> {
  if (documentScanRunning) return;
  documentScanRunning = true;
  try {
    const budget = createTextBudget(MAX_BODY_BYTES);
    const scripts = document.querySelectorAll('script');
    for (let i = 0; i < scripts.length; i += 1) {
      const c = scripts[i]?.textContent;
      if (c && c.length > 40 && c.includes('fbcdn.net') && !budget.add(c, '\n')) {
        diagBump('documentScanCapped');
        break;
      }
      // Large initial documents can contain thousands of script tags. Yield
      // between small batches so the Facebook player can append MSE buffers.
      if (i > 0 && i % 32 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const text = budget.value();
    if (text) scanText(text, true);
  } catch {
    /* ignore */
  } finally {
    documentScanRunning = false;
  }
}
void scanDocument();
window.addEventListener('load', () => {
  void scanDocument();
  window.setTimeout(() => void scanDocument(), 2500);
});
// Counts bumped after the last drain would otherwise die with the page.
window.addEventListener('pagehide', flushDiag);
