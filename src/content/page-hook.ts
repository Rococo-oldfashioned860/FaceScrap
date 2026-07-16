// FaceScrap page hook (MAIN world).
// Runs in the page's own JS context so it can read the responses of the
// GraphQL calls Facebook already makes. We NEVER re-issue queries with a
// hardcoded doc_id (Meta rotates those every 2-4 weeks) — we only passively
// read what the client fetches, plus embedded JSON in the initial document.

import { fbAssetKeys, isFbcdn, makeItem, MAX_ITEMS_PER_MESSAGE, trackKey, type MediaItem, type MediaSource } from '../shared/media';
import { decodeMpd, fromMpdXml, fromPrefetchReps, type DashPair } from '../shared/dash';

function post(items: MediaItem[]): void {
  // The receiver hard-caps each message at MAX_ITEMS_PER_MESSAGE to bound a hostile
  // co-resident script. One real reels-feed response harvests well past that
  // (~1248 items measured), so posting it as a single message would silently drop
  // everything past the cap — typically the DASH ladders of reels nested deepest,
  // i.e. exactly the one being watched. Chunk our own legitimate batch to cap size.
  for (let i = 0; i < items.length; i += MAX_ITEMS_PER_MESSAGE) {
    window.postMessage({ __facescrap: true, items: items.slice(i, i + MAX_ITEMS_PER_MESSAGE) }, '*');
  }
}

// Keys under which a DASH MPD XML string may arrive in Facebook's GraphQL.
const MPD_STRING_KEYS = ['dash_manifest', 'dash_manifest_xml', 'dash_manifest_xml_string', 'manifest_xml', 'playlist'];

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

function pushPair(pair: DashPair, source: MediaSource, out: MediaItem[], now: number, thumb?: string): void {
  const item = makeItem(pair.videoUrl, 'video', source, 'graphql', now, true);
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
  out.push(item);
}

// Detect a DASH source on a single object node and emit one linked pair per
// video quality in the ladder (the side panel groups them into one row with a
// quality picker via videoGroupKey/resolutionOf).
function harvestDash(rec: Record<string, unknown>, source: MediaSource, out: MediaItem[], now: number): void {
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
      pushPair(pair, source, out, now, poster());
    }
  }
  for (const key of MPD_STRING_KEYS) {
    const val = rec[key];
    if (typeof val === 'string' && val.length > 40) {
      const found = fromMpdXml(decodeMpd(val));
      if (found.length > 0) {
        for (const pair of found) pushPair(pair, source, out, now, poster());
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

const VIDEO_KEYS = /^(playable_url|playable_url_quality_hd|browser_native_hd_url|browser_native_sd_url|hd_src|sd_src)$/;

// Recursively collect media URLs from a parsed GraphQL/JSON object.
// The depth cap only guards against pathological payloads (parsed JSON has no
// cycles); it must comfortably exceed Facebook's feed nesting, where a home-feed
// video node sits ~13-19 levels deep (arrays count too).
function harvest(obj: unknown, source: MediaSource, out: MediaItem[], now: number, depth = 0): void {
  if (!obj || depth > 48) return;
  if (Array.isArray(obj)) {
    for (const v of obj) harvest(v, source, out, now, depth + 1);
    return;
  }
  if (typeof obj !== 'object') return;

  harvestDash(obj as Record<string, unknown>, source, out, now);

  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === 'string' && isFbcdn(v)) {
      if (VIDEO_KEYS.test(k)) {
        const item = makeItem(v, 'video', source, 'graphql', now);
        const th = findThumb(obj as Record<string, unknown>) ?? (xpvOf(v) ? posterByXpv.get(xpvOf(v)!) : undefined);
        if (th) item.thumbUrl = th;
        rememberPoster(v, th);
        out.push(item);
      } else if (k === 'audio_url') out.push(makeItem(v, 'audio', source, 'graphql', now, true));
    } else if (v && typeof v === 'object') {
      const node = v as Record<string, unknown>;
      // Image node shape: { uri, width, height }.
      if (typeof node.uri === 'string' && isFbcdn(node.uri) && typeof node.height === 'number') {
        out.push(makeItem(node.uri, 'image', source, 'graphql', now));
      }
      harvest(v, source, out, now, depth + 1);
    }
  }
}

function jsonUnescape(body: string): string {
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body.replace(/\\\//g, '/');
  }
}

function processScan(text: string, source: MediaSource): void {
  // Callers pre-gate on fbcdn in scanText(), so text here already contains media candidates.
  const out: MediaItem[] = [];
  const now = Date.now();

  // Regex fallback — robust to GraphQL shape changes.
  const re = /"(playable_url(?:_quality_hd)?|browser_native_(?:hd|sd)_url)":"(https:[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const url = jsonUnescape(m[2]);
    if (isFbcdn(url)) out.push(makeItem(url, 'video', source, 'graphql', now));
  }

  // Manifest fallback — the full DASH ladder (every resolution + audio) ships as an
  // escaped MPD string under videoDeliveryResponseResult.dash_manifests[].manifest_xml,
  // sometimes framed so the per-line parser can't split it or nested past the
  // recursion guard; pull it straight from the raw text.
  const mpdRe = /"manifest_xml":"((?:\\.|[^"\\])+)"/g;
  const seenMpd = new Set<string>();
  let mpd: RegExpExecArray | null;
  while ((mpd = mpdRe.exec(text))) {
    const xml = decodeMpd(jsonUnescape(mpd[1]));
    // Dedupe signature must span more than the head: MPD headers are mostly
    // fixed boilerplate, and two same-duration videos would collide (dropping
    // one ladder). Length + head + tail (per-video BaseURLs) is collision-safe.
    const sig = `${xml.length}:${xml.slice(0, 120)}:${xml.slice(-120)}`;
    if (seenMpd.has(sig)) continue;
    seenMpd.add(sig);
    for (const pair of fromMpdXml(xml)) pushPair(pair, source, out, now);
  }

  // Structured parse — GraphQL streams one JSON object per line. Skip a
  // pathologically large single line (>16 MB): JSON.parse + harvest on it would
  // stall the main thread against the MSE player's buffer appends, and the regex
  // passes above already recover its playable_url/manifest_xml media.
  const MAX_JSON_LINE = 16 * 1024 * 1024;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (s.length < 2 || s[0] !== '{') continue;
    if (s.length > MAX_JSON_LINE) continue;
    try {
      harvest(JSON.parse(s), source, out, now);
    } catch {
      /* partial/non-JSON line */
    }
  }

  post(out);
}

// The hook shares the main thread with Facebook's MSE video player; parsing a
// multi-MB GraphQL response synchronously starves its buffer appends. Queue each
// response and process one per macrotask, evicting the oldest DISPOSABLE entries
// during bursts. `source` is stamped at ENQUEUE time — an SPA navigation before
// drain must not relabel items captured on the previous surface. Document scans
// (`keep`) are the primary capture path for standalone reel/watch pages and are
// exempt from eviction.
interface ScanJob {
  text: string;
  source: MediaSource;
  keep?: boolean;
}
const scanQueue: ScanJob[] = [];
// Bound the queue by BOTH entry count and total retained bytes: a handful of
// multi-MB feed bodies matters far more than many tiny ones. queuedBytes tracks the
// live sum so a scroll burst can't pin tens of MB of response text waiting to drain.
const SCAN_QUEUE_MAX = 8;
const SCAN_QUEUE_MAX_BYTES = 8 * 1024 * 1024;
let queuedBytes = 0;
let draining = false;
function scanText(text: string, keep = false): void {
  if (!text || text.length < 20) return;
  // Pre-gate at ENQUEUE: every parser needs isFbcdn on each URL, so a body with no
  // fbcdn host yields nothing, and media-less GraphQL (typing/presence/notifs) never
  // takes a queue slot or schedules a drain. Escaped JSON keeps the bare `fbcdn.net`
  // host intact, so this never hides media behind an unlisted key.
  if (!text.includes('fbcdn.net')) return;
  scanQueue.push({ text, source: pageSource(), keep });
  queuedBytes += text.length;
  // Evict oldest DISPOSABLE entries until back under both caps; never drop a `keep`
  // (document) job, and NEVER the job just pushed: the byte cap bounds the BACKLOG,
  // not a single in-flight body — one reels-feed response can alone exceed it, and
  // evicting it would silently drop every ladder it carries.
  while (queuedBytes > SCAN_QUEUE_MAX_BYTES || scanQueue.length > SCAN_QUEUE_MAX) {
    const i = scanQueue.findIndex((j) => !j.keep);
    if (i < 0 || i === scanQueue.length - 1) break; // only keeps left / only the new job
    const [dropped] = scanQueue.splice(i, 1);
    queuedBytes -= dropped.text.length;
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
  if (scanQueue.length) setTimeout(drainScans, 0);
  else draining = false;
}

// Skip buffering a pathologically large response body (compressed size); normal
// feed/reels responses are a few MB, well under this — this only guards against a
// multi-hundred-MB outlier forcing a full JS-string materialization.
const MAX_BODY_BYTES = 24 * 1024 * 1024;

// --- Patch fetch ---
const origFetch = window.fetch;
window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
  const p = origFetch.apply(this as typeof globalThis, args);
  try {
    const input = args[0];
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url && url.includes('/api/graphql')) {
      p.then((res) => {
        // content-length is the COMPRESSED size, so this ceiling is conservative;
        // absent (chunked/gzip streamed) → Number(null ?? 0)=0 → proceed normally.
        const len = Number(res.headers.get('content-length') ?? 0);
        if (len > MAX_BODY_BYTES) return '';
        return res.clone().text();
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

// --- Scan embedded JSON in the initial document (reel/watch standalone pages). ---
// Facebook ships the media (DASH ladders, playable_urls) inside <script> JSON blobs,
// NOT the rendered markup; scanning only fbcdn-mentioning script contents (rather
// than the whole outerHTML) avoids retaining megabytes of DOM/CSS/SVG. Rendered
// <img>/<video> covers are captured by the content script's DOM scan.
function scanDocument(): void {
  try {
    let text = '';
    for (const s of document.querySelectorAll('script')) {
      const c = s.textContent;
      if (c && c.length > 40 && c.includes('fbcdn.net')) text += c + '\n';
    }
    if (text) scanText(text, true);
  } catch {
    /* ignore */
  }
}
scanDocument();
window.addEventListener('load', () => {
  scanDocument();
  window.setTimeout(scanDocument, 2500);
});
