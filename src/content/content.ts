// FaceScrap content script (ISOLATED world).
// - Injects the MAIN-world page hook so we can read Facebook's own GraphQL
//   responses (an isolated content script cannot patch page fetch/XHR).
// - Relays media the hook reports to the service worker.
// - Scans the rendered DOM (<video>/<img>/poster) as a fallback.

import { createAckedLatest, type AckedLatestOutcome } from '../shared/acked-latest';
import { createAckedBatch } from '../shared/acked-batch';
import { withTimeout } from '../shared/async';
import {
  diagBump,
  diagDrain,
  sanitizeDiagCounters,
  setDiagEnabled,
  type DiagReason,
} from '../shared/diag';
import {
  isFbcdn,
  isStaticFbAsset,
  makeItem,
  MAX_ITEMS_PER_MESSAGE,
  MAX_MEDIA_BATCH_BYTES,
  mediaItemWeight,
  mediaId,
  mergeMedia,
  sanitizeIncomingItems,
  type MediaItem,
} from '../shared/media';
import {
  nextPlayingDetectedAt,
  type MediaFoundAck,
  type NowPlayingAck,
  type NowPlayingMsg,
  type RuntimeMessage,
} from '../shared/messages';
import { loadSettings } from '../shared/settings';
import { isStoryDomId, isStoryPath, storyCardMark as formatStoryCardMark } from '../shared/story-mark';
import {
  discardPlaceholderCoverEvidence,
  pickBestVideoIndex,
  type VideoCandidate,
} from '../shared/centre-video';
import { combineVideoMark, createVideoMarkFactory } from '../shared/video-mark';
import {
  createCounterCoalescer,
  createMediaIngressBudget,
  createNavIngressBudget,
} from './content-ingress-limits';

// After the extension is reloaded/updated, this content script keeps running in
// the already-open page but its chrome.* context is dead — calls then throw
// "Extension context invalidated" SYNCHRONOUSLY (so .catch() can't help). Guard
// every chrome.* call and tear our timers/observers down once the context dies.
let disposed = false;
let poller: number | undefined;
let observer: MutationObserver | undefined;
let mediaRetryTimer: number | undefined;
let diagReportTimer: number | undefined;
let scanTimer: number | undefined;
let initialScanTimer: number | undefined;
let scrollTimer: number | undefined;
// Every DOM/window listener below registers with this signal, so teardown()
// detaches them all at once instead of leaving them firing into a dead context.
const listeners = new AbortController();
const documentToken =
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16).padStart(8, '0')).join('-');

function alive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function teardown(): void {
  if (disposed) return;
  disposed = true;
  if (poller !== undefined) clearInterval(poller);
  if (mediaRetryTimer !== undefined) clearTimeout(mediaRetryTimer);
  if (diagReportTimer !== undefined) clearTimeout(diagReportTimer);
  if (scanTimer !== undefined) clearTimeout(scanTimer);
  if (initialScanTimer !== undefined) clearTimeout(initialScanTimer);
  if (scrollTimer !== undefined) clearTimeout(scrollTimer);
  observer?.disconnect();
  listeners.abort();
}

function send(message: RuntimeMessage): void {
  if (disposed) return;
  if (!alive()) {
    teardown();
    return;
  }
  try {
    void chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    teardown();
  }
}

const MEDIA_ACK_TIMEOUT_MS = 5_000;
const MEDIA_RETRY_BASE_MS = 500;
const MEDIA_RETRY_MAX_MS = 10_000;
const MEDIA_BATCH_MAX_ITEMS = 64;
const MEDIA_QUEUE_MAX_ITEMS = 2_000;
const MEDIA_QUEUE_MAX_BYTES = 8 * 1024 * 1024;
const mediaIngressBudget = createMediaIngressBudget(performance.now());
const navIngressBudget = createNavIngressBudget(performance.now());
let mediaRetryFailures = 0;
const mediaDelivery = createAckedBatch<MediaItem, string>({
  maxBatch: MEDIA_BATCH_MAX_ITEMS,
  maxPending: MEDIA_QUEUE_MAX_ITEMS,
  weight: mediaItemWeight,
  maxBatchWeight: MAX_MEDIA_BATCH_BYTES,
  maxPendingWeight: MEDIA_QUEUE_MAX_BYTES,
  splitOnFailure: true,
  rotateAfterFailures: 3,
  // When a sleeping worker meets an unusually wide feed burst, retain the
  // newest cards (including the one the user just opened) over old prefetches.
  overflow: 'drop-oldest',
  key: (item) => item.id,
  merge: (queued, incoming) => mergeMedia([queued], [incoming])[0][0] ?? incoming,
});

async function deliverMedia(items: readonly MediaItem[]): Promise<boolean> {
  if (disposed || !alive()) {
    teardown();
    return false;
  }
  try {
    const response = (await withTimeout(
      chrome.runtime.sendMessage({ type: 'MEDIA_FOUND', items: [...items], documentToken }),
      MEDIA_ACK_TIMEOUT_MS,
      'MEDIA_FOUND acknowledgement timed out.',
    )) as MediaFoundAck | undefined;
    if (response?.ok === true) return true;
    // The only permanent rejection is a closed/invalid sender tab. Its content
    // context has no useful recovery path, so stop its observers instead of
    // retaining a queue that can never be acknowledged.
    if (response?.retryable === false) teardown();
    return false;
  } catch {
    if (!alive()) teardown();
    return false;
  }
}

async function pumpMedia(): Promise<void> {
  // A scheduled retry owns the next attempt. Fresh page traffic may add newer
  // work behind the failed entry, but cannot defeat the quota backoff by
  // repeatedly calling relay().
  if (disposed || mediaRetryTimer !== undefined) return;
  const before = mediaDelivery.pending;
  const drained = await mediaDelivery.pump(deliverMedia);
  if (drained || disposed || mediaDelivery.pending === 0) {
    mediaRetryFailures = 0;
    return;
  }
  // Concurrent callers share AckedBatch's one pump. Only the first continuation
  // schedules/increments; the rest see this timer and return.
  if (mediaRetryTimer !== undefined) return;
  mediaRetryFailures = mediaDelivery.pending < before ? 0 : Math.min(mediaRetryFailures + 1, 16);
  const retryMs = Math.min(
    MEDIA_RETRY_MAX_MS,
    MEDIA_RETRY_BASE_MS * (2 ** Math.min(Math.max(0, mediaRetryFailures - 1), 5)),
  );
  mediaRetryTimer = window.setTimeout(() => {
    mediaRetryTimer = undefined;
    void pumpMedia();
  }, retryMs);
}

function relay(items: MediaItem[]): void {
  if (items.length === 0) return;
  const result = mediaDelivery.enqueueMany(items);
  if (result.dropped > 0) console.warn(`[FaceScrap] media relay queue dropped ${result.dropped} items`);
  void pumpMedia();
}

// --- Diagnostics (see diag.ts) ---
// This script is the only one of the three capture contexts that can both read
// settings and talk to the worker, so it owns the flag for the MAIN-world hook
// as well as for its own DOM scan.
let diagnosticsEnabled = false;
const DIAG_REPORT_INTERVAL_MS = 1_000;
const diagReports = createCounterCoalescer<DiagReason>();

function clearPendingDiagReports(): void {
  if (diagReportTimer !== undefined) {
    clearTimeout(diagReportTimer);
    diagReportTimer = undefined;
  }
  diagReports.drain();
}

function flushDiagReports(): void {
  diagReportTimer = undefined;
  if (!diagnosticsEnabled || disposed) {
    diagReports.drain();
    return;
  }
  const counters = diagReports.drain();
  if (Object.keys(counters).length > 0) send({ type: 'DIAG_REPORT', counters, documentToken });
}

function publishDiagFlag(): void {
  if (!alive()) return;
  void loadSettings()
    .then((s) => {
      if (disposed) return;
      diagnosticsEnabled = s.diagEnabled;
      setDiagEnabled(s.diagEnabled);
      if (!s.diagEnabled) clearPendingDiagReports();
      window.postMessage({ __facescrapCtl: true, diag: s.diagEnabled }, '*');
    })
    .catch(() => {
      diagnosticsEnabled = false;
      setDiagEnabled(false);
      clearPendingDiagReports();
    });
}

function announceDiagFlag(): void {
  if (!alive()) return;
  window.postMessage({ __facescrapCtl: true, diag: diagnosticsEnabled }, '*');
}
publishDiagFlag();
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'settings' in changes) publishDiagFlag();
  });
} catch {
  /* context gone — the flag stays off */
}

function reportDiag(counters: unknown): void {
  // window.postMessage is shared with the page. Never let a co-resident page
  // script turn this opt-in maintenance channel on by forging hook messages.
  if (!diagnosticsEnabled) return;
  const clean = sanitizeDiagCounters(counters);
  if (Object.keys(clean).length === 0) return;
  diagReports.add(clean);
  if (diagReportTimer === undefined) {
    diagReportTimer = window.setTimeout(flushDiagReports, DIAG_REPORT_INTERVAL_MS);
  }
}

// --- Inject the MAIN-world hook (must be an external file; page CSP blocks inline). ---
function injectHook(): void {
  if (!alive()) return;
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('page-hook.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch {
    /* context gone */
  }
}
injectHook();

// --- Receive media from the page hook. ---
// The hook posts on the shared window, so `e.source === window` cannot prove the
// sender is our hook — sanitize every item so a hostile page script cannot forge media.
window.addEventListener(
  'message',
  (e) => {
    if (e.source !== window) return;
    const data = e.data;
    // The hook asks for the flag on load — whichever of us loaded second, this
    // answers it. Only `query` is honoured: `diag` on this channel is the hook
    // reading its own announcement back, not a request.
    if (data && data.__facescrapCtl === true && data.query === true) {
      // This query crosses the page boundary and is forgeable. Answer from the
      // cached setting; re-reading storage here would let a page script create
      // an unbounded stream of extension storage operations.
      announceDiagFlag();
      return;
    }
    if (data && data.__facescrap === true) {
      if (data.diag !== undefined) {
        reportDiag(data.diag);
        return;
      }
      // SPA navigation: re-detect now instead of waiting up to a poller tick.
      // Forgeable by a co-resident script, but the worst it buys is an extra
      // call that only reads already-visible DOM — the same reach a synthetic
      // scroll event would already have.
      if (data.nav === true) {
        if (navIngressBudget.tryTake(1, 1, performance.now())) detectPlaying();
        return;
      }
      // The real hook chunks at this exact bound. Reject an oversized forged
      // array before sanitization so even calculating its charge stays bounded.
      if (!Array.isArray(data.items) || data.items.length > MAX_ITEMS_PER_MESSAGE) return;
      const items = sanitizeIncomingItems(data.items, MEDIA_QUEUE_MAX_BYTES);
      if (items.length === 0) return;
      let bytes = 0;
      for (const item of items) bytes += mediaItemWeight(item);
      if (!mediaIngressBudget.tryTake(items.length, bytes, performance.now())) return;
      relay(items);
    }
  },
  { signal: listeners.signal },
);

// --- DOM scan fallback for currently rendered media. ---
function scanDom(): void {
  const out: MediaItem[] = [];
  const now = Date.now();

  document.querySelectorAll('video').forEach((v) => {
    const src = v.currentSrc || v.src;
    const poster = v.poster && isFbcdn(v.poster) ? v.poster : undefined;
    // blob: URLs from MSE cannot be saved — skip them (see README limitations).
    if (src && !src.startsWith('blob:') && isFbcdn(src)) {
      const item = makeItem(src, 'video', 'video', 'dom', now);
      if (poster) item.thumbUrl = poster;
      out.push(item);
    }
    if (poster) out.push(makeItem(poster, 'image', 'video', 'dom', now));
  });

  document.querySelectorAll('img').forEach((img) => {
    const src = img.currentSrc || img.src;
    // isStaticFbAsset: rsrc.php sprites/emoji are fbcdn-hosted UI chrome, not media.
    if (src && isFbcdn(src) && !isStaticFbAsset(src) && img.naturalWidth >= 200 && img.naturalHeight >= 200) {
      out.push(makeItem(src, 'image', 'page', 'dom', now));
    }
  });

  diagBump('captureDom', out.length);
  reportDiag(diagDrain());
  relay(out);
}

function throttledScan(): void {
  if (scanTimer !== undefined) return;
  scanTimer = window.setTimeout(() => {
    scanTimer = undefined;
    scanDom();
  }, 1200);
}

observer = new MutationObserver(throttledScan);
observer.observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('DOMContentLoaded', scanDom, { signal: listeners.signal });
window.addEventListener(
  'load',
  () => {
    initialScanTimer = window.setTimeout(() => {
      initialScanTimer = undefined;
      scanDom();
    }, 1500);
  },
  { signal: listeners.signal },
);

// --- Detect what's being watched and report it to the worker so the side panel
//     can show only that. Heuristic: the topmost fbcdn media element at the viewport
//     centre is what's on screen — elementsFromPoint() returns hits top-first, so the
//     viewer's active (top-stacked) slide wins over buried previous slides. Works for
//     photo stories too, and is independent of Facebook's class names. ---
const playingDelivery = createAckedLatest<NowPlayingMsg>();
const PLAYING_ACK_TIMEOUT_MS = 5_000;
let lastPlayingDetectedAt = 0;
let emptySince: number | undefined;

async function deliverPlaying(message: NowPlayingMsg): Promise<AckedLatestOutcome> {
  if (disposed) return 'retry';
  if (!alive()) {
    teardown();
    return 'retry';
  }
  try {
    const response = (await withTimeout(
      chrome.runtime.sendMessage(message),
      PLAYING_ACK_TIMEOUT_MS,
      'NOW_PLAYING acknowledgement timed out.',
    )) as NowPlayingAck | undefined;
    if (response?.ok === true) return 'accepted';
    return response?.ok === false && response.retryable === false ? 'refresh' : 'retry';
  } catch {
    // A sleeping/restarting worker or a busy storage lane is recoverable. The
    // next detector poll reuses this message and its original detectedAt.
    if (!alive()) teardown();
    return 'retry';
  }
}

/** An fbcdn cover URL from an <img> src or a CSS background-image. */
function fbcdnCoverUrl(el: Element): string | undefined {
  // Static UI assets (rsrc.php sprites/emoji) are fbcdn-hosted but not media — exclude.
  if (el instanceof HTMLImageElement) {
    const s = el.currentSrc || el.src;
    return s && isFbcdn(s) && !isStaticFbAsset(s) ? s : undefined;
  }
  if (el instanceof HTMLElement) {
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none') {
      const m = bg.match(/url\(["']?(https?:[^"')]+)["']?\)/);
      if (m && isFbcdn(m[1]) && !isStaticFbAsset(m[1])) return m[1];
    }
  }
  return undefined;
}

/** Is any reasonably-sized <video> currently playing and visible?
 *  No readyState gate: under Facebook's MSE-in-Workers the element's buffer
 *  lives in the worker and the main-thread <video> reports readyState 0
 *  FOREVER, even mid-playback — `!paused && !ended` is the only signal the
 *  element still tells the truth about. */
function anyVideoPlaying(): boolean {
  for (const v of document.querySelectorAll('video')) {
    if (v.paused || v.ended) continue;
    const r = v.getBoundingClientRect();
    if (
      r.width >= 100 &&
      r.height >= 100 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < window.innerHeight &&
      r.left < window.innerWidth
    ) {
      return true;
    }
  }
  return false;
}

function closestAttrValue(
  start: Element,
  attr: string,
  ok: (v: string) => boolean,
): string | undefined {
  let el: Element | null = start;
  for (let d = 0; el != null && d < 12; d++, el = el.parentElement) {
    const v = el.getAttribute(attr);
    if (v != null && ok(v)) return v;
  }
  return undefined;
}

// The current story card's own id: the story viewer tags each card container with
// data-id=<base64 story id> ("Uz…"). Unlike the URL path — which stays pinned to the
// card the tray was opened on — this advances as you move through the tray. The
// anchor can be ANY element inside the card (the playing video, or the topmost
// centre element when the card has no video at all — a photo card, or a dead
// "story no longer available" bucket).
function storyCardDomId(anchor: Element): string | undefined {
  return closestAttrValue(anchor, 'data-id', isStoryDomId);
}

// Story-card marker: a DOM-proven id is durable (`u:<owner>/<card>`), while the
// URL fallback is provisional (`p:<owner>/<card>`). The URL stays pinned to the
// card that opened the tray even across BUCKETS, so its value may distinguish a
// video load but must never become a durable cover/video binding.
function storyCardMark(anchor?: Element): string {
  // Pathname gate BEFORE the ancestor walk: detectPlaying runs this several
  // times a second on every facebook.com surface, and off /stories the walk's
  // result is discarded unconditionally.
  if (!isStoryPath(location.pathname)) return '';
  const domId = anchor ? storyCardDomId(anchor) : undefined;
  return formatStoryCardMark(location.pathname, domId);
}

// The played reel's real numeric video id: the reels feed tags each reel's container
// with data-video-id — per-reel and accurate, unlike the page URL's /reel/<id>, which
// lags the scroll. It equals the efg `vid:` key of the reel's captured representations,
// letting the panel link the video being watched.
function reelVideoId(video: HTMLVideoElement): string | undefined {
  return closestAttrValue(video, 'data-video-id', (id) => /^\d{5,20}$/.test(id));
}

// Per-video-load marker. Under Facebook's MSE-in-Workers the <video> streams via a
// MediaSourceHandle on srcObject, so currentSrc/src stay empty; key a WeakMap by the
// per-load srcObject handle (a fresh object per slide, element as fallback) and mint
// one synthetic id per handle — stable while a slide plays, new on the next slide.
// Progressive videos still expose a real src → use it directly.
// A fresh epoch per content-script lifetime prevents a story viewer/page reload
// from recycling `vm:1` while the side panel still remembers the prior slide.
const markVideoLoad = createVideoMarkFactory(crypto.randomUUID());
function videoMark(v: HTMLVideoElement): string {
  const src = v.currentSrc || v.src;
  const key: object = (v.srcObject as object | null) ?? v;
  // Fold in the reel id: the WeakMap above keys on object identity, which
  // Facebook may reuse across slides — see combineVideoMark for what that broke.
  return combineVideoMark(markVideoLoad(key, src), reelVideoId(v));
}

function centreMedia(): {
  ids: string[];
  hasVideo: boolean;
  covers: string[];
  mark: string;
  videoEl?: HTMLVideoElement;
  centreEl?: Element;
} {
  const ids = new Set<string>();
  const covers: string[] = [];
  const coverIds = new Set<string>();
  // Opaque slide marker (see videoMark/storyCardMark): a per-slide id that CHANGES
  // when the video under the centre changes, on surfaces that expose no cover/poster
  // ids at all (video→video slides otherwise look identical). Compared, never fetched.
  let mark = '';
  let hasVideo = false;
  // The chosen <video> element, exposed so detectPlaying can read its per-card
  // (storyCardDomId) / per-reel (reelVideoId) DOM id for an accurate now-playing anchor.
  let videoEl: HTMLVideoElement | undefined;
  // Topmost element at the centre — the card-id anchor of last resort for slides
  // with NO video at all (photo cards, dead "no longer available" buckets): the
  // viewer URL never advances, so without a DOM anchor those slides would be
  // indistinguishable from the previous one and the panel would keep the
  // previous profile's story endorsed while the user looks at something else.
  let centreEl: Element | undefined;
  const cx = Math.round(window.innerWidth / 2);
  const cy = Math.round(window.innerHeight / 2);

  // `overCover`: this video was adopted DESPITE a cover being hit-tested at the
  // centre, so that cover belongs to a placeholder, not to what is playing. The
  // panel learns groupCover from covers[0], so the adopted video's own poster
  // has to lead or it would durably learn the wrong thumbnail.
  const adoptVideo = (el: HTMLVideoElement, overCover = false): void => {
    hasVideo = true;
    videoEl = el;
    const src = el.currentSrc || el.src;
    mark = videoMark(el);
    if (overCover) discardPlaceholderCoverEvidence(ids, covers, coverIds);
    if (src && !src.startsWith('blob:') && isFbcdn(src)) ids.add(mediaId(src));
    if (el.poster && isFbcdn(el.poster)) {
      ids.add(mediaId(el.poster));
      if (overCover) covers.unshift(el.poster);
      else covers.push(el.poster);
    }
  };

  // Walk the stack at the centre top-first: the topmost <video> (its src/poster)
  // AND the topmost large fbcdn cover behind it (an <img> OR a background-image
  // div — Facebook uses both). The cover's asset id links the unreadable blob:
  // video to its captured item via that item's thumbnail; its URL is also sent
  // so the panel can display it and LEARN the cover↔video binding.
  let gotVideo = false;
  let gotCover = false;
  for (const el of document.elementsFromPoint(cx, cy)) {
    centreEl ??= el;
    if (!gotVideo && el instanceof HTMLVideoElement) {
      // A PAUSED video below the topmost large cover is the previous slide
      // buried under the active photo (the story viewer keeps old slides
      // stacked and pauses them) — not what the user is watching.
      //
      // A PLAYING one is the opposite case: the new slide's video with a
      // residual blur-up placeholder still fading out on top of it. Breaking
      // there adopted the stale cover and showed the wrong thumbnail while the
      // real video played underneath. Distinguish by playback state, not by
      // stacking order.
      if (gotCover && (el.paused || el.ended)) break;
      gotVideo = true;
      adoptVideo(el, gotCover);
      continue;
    }
    if (!gotCover) {
      const r = el.getBoundingClientRect();
      if (r.width >= 160 && r.height >= 160) {
        const url = fbcdnCoverUrl(el);
        if (url) {
          const id = mediaId(url);
          ids.add(id);
          coverIds.add(id);
          covers.push(url);
          gotCover = true;
        }
      }
    }
    if (gotVideo && gotCover) break;
  }

  // elementsFromPoint() only returns hit-testable elements, and the story/reel viewer
  // sets pointer-events:none on the <video> (taps go to the nav overlay), so the walk
  // above can miss video slides. Fall back to scoring every video on screen.
  //
  // This used to be skipped whenever a cover was hit-tested, which meant a
  // playing reel under a residual placeholder produced NO adopted video at all.
  // The cover now only suppresses PAUSED candidates (see pickBestVideoIndex),
  // so the ranking itself decides. Geometry here, decision there — the decision
  // is the part worth testing without a browser.
  if (!gotVideo) {
    const els: HTMLVideoElement[] = [];
    const candidates: VideoCandidate[] = [];
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      els.push(v);
      candidates.push({
        vw: Math.min(r.right, window.innerWidth) - Math.max(r.left, 0),
        vh: Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0),
        paused: v.paused,
        ended: v.ended,
        containsCentre: cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom,
      });
    }
    const best = pickBestVideoIndex(candidates, gotCover);
    if (best !== undefined) adoptVideo(els[best], gotCover);
  }
  return {
    ids: [...ids],
    hasVideo: hasVideo || anyVideoPlaying(),
    covers: covers.slice(0, 3),
    mark,
    videoEl,
    centreEl,
  };
}

/** Video id from the page URL (/reel/<id>, /videos/<id>, /watch?v=<id>) — an
 *  exact anchor: it equals the efg `vid:` key of every representation of the
 *  watched video, immune to fbcdn prefetch noise. Absent on feed/stories. */
function urlVideoId(): string | undefined {
  // Lookahead, not consume: the id may be followed by /, ?query, #hash, or end
  // (e.g. the reels tab navigates to /reel/<id>?s=…).
  const m = location.pathname.match(/\/(?:reel|videos?)\/(\d{5,20})(?=[/?#]|$)/);
  if (m) return m[1];
  try {
    const v = new URLSearchParams(location.search).get('v');
    if (v && /^\d{5,20}$/.test(v)) return v;
  } catch {
    /* ignore */
  }
  return undefined;
}

function detectPlaying(): void {
  if (disposed) return;
  const { ids, hasVideo, covers, mark: videoMk, videoEl, centreEl } = centreMedia();
  const detectedAt = nextPlayingDetectedAt(lastPlayingDetectedAt, Date.now());
  lastPlayingDetectedAt = detectedAt;
  // Combine the story-card signal with the per-video-load marker so the mark
  // changes if either does. Story prefixes are durable `u:` for DOM-proven cards
  // or provisional `p:` for the pinned-path fallback; reels/feed use the bare
  // video marker. The card anchor prefers the playing video, else the topmost
  // centre element — a photo card or dead bucket can still advance the mark.
  const mark = [storyCardMark(videoEl ?? centreEl), videoMk].filter(Boolean).join('#');
  // Debounce transient empties during slide transitions to avoid flicker.
  if (ids.length === 0 && !hasVideo) {
    const monotonicNow = performance.now();
    if (emptySince === undefined) emptySince = monotonicNow;
    if (monotonicNow - emptySince < 1200) return;
  } else {
    emptySince = undefined;
  }
  // Prefer the reels feed's DOM data-video-id (accurate, per-reel) over location's
  // /reel/<id>, which lags the scroll; fall back to the URL on watch pages.
  const vid = (videoEl != null ? reelVideoId(videoEl) : undefined) ?? (hasVideo ? urlVideoId() : undefined);
  const key = `${hasVideo ? 'v' : '-'}|${vid ?? ''}|${mark}|${ids.slice().sort().join(',')}`;
  const message = { type: 'NOW_PLAYING', ids, hasVideo, vid, covers, mark, detectedAt, documentToken } satisfies NowPlayingMsg;
  if (!playingDelivery.offer(key, message)) return;
  void playingDelivery.pump(deliverPlaying);
}

for (const evt of ['play', 'playing', 'pause', 'seeked', 'loadeddata'] as const) {
  document.addEventListener(evt, detectPlaying, { capture: true, signal: listeners.signal });
}
// Trailing edge, re-armed on every event. The old guard (`if armed, return`)
// made this fire 200ms after the FIRST scroll of a burst, not the last — so a
// fast flick through reels sampled a slide mid-transition, and every such
// emission restamps PlayingRef.at. A slideAt that keeps moving stops any track
// from ever counting as anchored, which pushes the panel to honest-empty
// instead of relaying to the new video.
document.addEventListener(
  'scroll',
  () => {
    if (scrollTimer !== undefined) clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => {
      scrollTimer = undefined;
      detectPlaying();
    }, 200);
  },
  { capture: true, signal: listeners.signal },
);
// The browser knows when momentum and scroll-snap actually settled; a fixed
// delay only guesses. Chrome 114+, and the manifest requires 116.
document.addEventListener(
  'scrollend',
  () => {
    if (scrollTimer !== undefined) {
      clearTimeout(scrollTimer);
      scrollTimer = undefined;
    }
    detectPlaying(); // idempotent via lastPlayingKey, so racing the debounce is harmless
  },
  { capture: true, signal: listeners.signal },
);
// 300ms, not a lazy 1s: media events fire DURING slide transitions — when the
// viewport centre still shows the outgoing slide — so the change-guard swallows
// that emission and the poller is what actually detects the settled new slide.
// Every ms of detection lag also shifts PlayingRef.at (slideAt) late, which
// misclassifies the new video's first tracks as pre-slide evidence and makes
// the panel's anti-prefetch relay hold bite when it shouldn't. centreMedia is
// one elementsFromPoint walk plus a <video> scan — cheap at this rate.
poller = window.setInterval(detectPlaying, 300);

// Returning to the tab fires no media event (the video is already loaded) and the 1s
// poller is throttled while the tab is hidden, so force a fresh emit (clear the
// change-guard) whenever the tab becomes visible/focused.
function reassertPlaying(): void {
  if (disposed) return;
  playingDelivery.invalidateCommitted();
  detectPlaying();
}
document.addEventListener(
  'visibilitychange',
  () => {
    if (!document.hidden) reassertPlaying();
  },
  { signal: listeners.signal },
);
window.addEventListener('focus', reassertPlaying, { signal: listeners.signal });
window.addEventListener('pageshow', reassertPlaying, { signal: listeners.signal });
