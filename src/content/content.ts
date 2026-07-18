// FaceScrap content script (ISOLATED world).
// - Injects the MAIN-world page hook so we can read Facebook's own GraphQL
//   responses (an isolated content script cannot patch page fetch/XHR).
// - Relays media the hook reports to the service worker.
// - Scans the rendered DOM (<video>/<img>/poster) as a fallback.

import { isFbcdn, isStaticFbAsset, makeItem, mediaId, sanitizeIncomingItems, type MediaItem } from '../shared/media';
import type { RuntimeMessage } from '../shared/messages';

// After the extension is reloaded/updated, this content script keeps running in
// the already-open page but its chrome.* context is dead — calls then throw
// "Extension context invalidated" SYNCHRONOUSLY (so .catch() can't help). Guard
// every chrome.* call and tear our timers/observers down once the context dies.
let disposed = false;
let poller: number | undefined;
let observer: MutationObserver | undefined;
// Every DOM/window listener below registers with this signal, so teardown()
// detaches them all at once instead of leaving them firing into a dead context.
const listeners = new AbortController();

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

function relay(items: MediaItem[]): void {
  if (items.length) send({ type: 'MEDIA_FOUND', items });
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
    if (data && data.__facescrap === true) {
      relay(sanitizeIncomingItems(data.items));
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

  relay(out);
}

let scanTimer: number | undefined;
function throttledScan(): void {
  if (scanTimer !== undefined) return;
  scanTimer = window.setTimeout(() => {
    scanTimer = undefined;
    scanDom();
  }, 1200);
}

observer = new MutationObserver(throttledScan);
observer.observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('DOMContentLoaded', scanDom);
window.addEventListener('load', () => window.setTimeout(scanDom, 1500));

// --- Detect what's being watched and report it to the worker so the side panel
//     can show only that. Heuristic: the topmost fbcdn media element at the viewport
//     centre is what's on screen — elementsFromPoint() returns hits top-first, so the
//     viewer's active (top-stacked) slide wins over buried previous slides. Works for
//     photo stories too, and is independent of Facebook's class names. ---
let lastPlayingKey = '';
let emptySince = 0;
let scrollTimer: number | undefined;

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
// card the tray was opened on — this advances as you move through the tray.
function storyCardDomId(video: HTMLVideoElement): string | undefined {
  return closestAttrValue(video, 'data-id', (id) => id.startsWith('Uz') && id.length > 12);
}

// Durable per-story-card marker: `u:<owner>/<card>`. Survives panel reopen and page
// reload; immune to fbcdn prefetch; empty off /stories. Prefer the DOM card id over
// the URL's <card> segment — the URL segment stays constant across the whole tray —
// falling back to the URL when the video is off-DOM.
function storyCardMark(video?: HTMLVideoElement): string {
  const m = location.pathname.match(/\/stories\/([^/]+)\/([^/]+)/);
  if (!m) return '';
  const domId = video ? storyCardDomId(video) : undefined;
  return `u:${m[1]}/${domId ?? m[2]}`;
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
const videoMarks = new WeakMap<object, string>();
let markSeq = 0;
function videoMark(v: HTMLVideoElement): string {
  const src = v.currentSrc || v.src;
  if (src && !src.startsWith('blob:')) return src.slice(0, 200);
  const key: object = (v.srcObject as object | null) ?? v;
  let m = videoMarks.get(key);
  if (m === undefined) {
    m = `vm:${++markSeq}`;
    videoMarks.set(key, m);
  }
  return m;
}

function centreMedia(): {
  ids: string[];
  hasVideo: boolean;
  covers: string[];
  mark: string;
  videoEl?: HTMLVideoElement;
} {
  const ids = new Set<string>();
  const covers: string[] = [];
  // Opaque slide marker (see videoMark/storyCardMark): a per-slide id that CHANGES
  // when the video under the centre changes, on surfaces that expose no cover/poster
  // ids at all (video→video slides otherwise look identical). Compared, never fetched.
  let mark = '';
  let hasVideo = false;
  // The chosen <video> element, exposed so detectPlaying can read its per-card
  // (storyCardDomId) / per-reel (reelVideoId) DOM id for an accurate now-playing anchor.
  let videoEl: HTMLVideoElement | undefined;
  const cx = Math.round(window.innerWidth / 2);
  const cy = Math.round(window.innerHeight / 2);

  const adoptVideo = (el: HTMLVideoElement): void => {
    hasVideo = true;
    videoEl = el;
    const src = el.currentSrc || el.src;
    mark = videoMark(el);
    if (src && !src.startsWith('blob:') && isFbcdn(src)) ids.add(mediaId(src));
    if (el.poster && isFbcdn(el.poster)) {
      ids.add(mediaId(el.poster));
      covers.push(el.poster);
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
    if (!gotVideo && el instanceof HTMLVideoElement) {
      // A video BELOW the topmost large cover is the previous slide buried under
      // the active photo (the story viewer keeps old slides stacked) — it is not
      // what the user is watching. Only the video ABOVE the cover counts.
      if (gotCover) break;
      gotVideo = true;
      adoptVideo(el);
      continue;
    }
    if (!gotCover) {
      const r = el.getBoundingClientRect();
      if (r.width >= 160 && r.height >= 160) {
        const url = fbcdnCoverUrl(el);
        if (url) {
          ids.add(mediaId(url));
          covers.push(url);
          gotCover = true;
        }
      }
    }
    if (gotVideo && gotCover) break;
  }

  // elementsFromPoint() only returns hit-testable elements, and the story/reel viewer
  // sets pointer-events:none on the <video> (taps go to the nav overlay), so the walk
  // above can miss video slides. Fall back to the dominant playing video by visible
  // area — not the geometric centre, which often lands beside the left-offset reel in
  // the comments/profile panel. Playing outranks paused (stacked previous and preloaded
  // next slides are paused); containing the centre only breaks ties. Skipped when a
  // cover was hit-tested: that's a photo slide, and a video underneath is the buried
  // previous slide, not what's being watched.
  if (!gotVideo && !gotCover) {
    let best: HTMLVideoElement | undefined;
    let bestScore = -1;
    for (const v of document.querySelectorAll('video')) {
      // Only `ended` disqualifies. readyState is a lie under MSE-in-Workers
      // (permanently 0 — see anyVideoPlaying), and it used to kill this whole
      // fallback: the reels viewer routinely leaves the centre point over
      // overlay DIVs (mid-snap, side rails), so the hit-test walk misses and
      // THIS loop is the only path that can adopt the playing video. Paused,
      // data-less prefetch slides still lose: the play boost below dominates.
      if (v.ended) continue;
      const r = v.getBoundingClientRect();
      const vw = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
      const vh = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
      if (vw < 100 || vh < 100) continue; // must be substantially on screen
      const contains = cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
      // Area maxes around ~2e6 px², so the play/centre boosts always dominate it.
      const score = vw * vh + (v.paused ? 0 : 4e9) + (contains ? 2e9 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    if (best) adoptVideo(best);
  }
  return { ids: [...ids], hasVideo: hasVideo || anyVideoPlaying(), covers: covers.slice(0, 3), mark, videoEl };
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
  const { ids, hasVideo, covers, mark: videoMk, videoEl } = centreMedia();
  // Combine the durable story-card signal with the per-video-load marker so the mark
  // changes if either does. Format: `u:<owner>/<card>#<videoMark>` on stories, bare
  // `<videoMark>` on reels/feed (storyCardMark is empty there).
  const mark = [storyCardMark(videoEl), videoMk].filter(Boolean).join('#');
  // Debounce transient empties during slide transitions to avoid flicker.
  if (ids.length === 0 && !hasVideo) {
    if (emptySince === 0) emptySince = Date.now();
    if (Date.now() - emptySince < 1200) return;
  } else {
    emptySince = 0;
  }
  // Prefer the reels feed's DOM data-video-id (accurate, per-reel) over location's
  // /reel/<id>, which lags the scroll; fall back to the URL on watch pages.
  const vid = (videoEl != null ? reelVideoId(videoEl) : undefined) ?? (hasVideo ? urlVideoId() : undefined);
  const key = `${hasVideo ? 'v' : '-'}|${vid ?? ''}|${mark}|${ids.slice().sort().join(',')}`;
  if (key === lastPlayingKey) return;
  lastPlayingKey = key;
  send({ type: 'NOW_PLAYING', ids, hasVideo, vid, covers, mark });
}

for (const evt of ['play', 'playing', 'pause', 'seeked', 'loadeddata'] as const) {
  document.addEventListener(evt, detectPlaying, { capture: true, signal: listeners.signal });
}
document.addEventListener(
  'scroll',
  () => {
    if (scrollTimer !== undefined) return;
    scrollTimer = window.setTimeout(() => {
      scrollTimer = undefined;
      detectPlaying();
    }, 400);
  },
  { capture: true, signal: listeners.signal },
);
poller = window.setInterval(detectPlaying, 1000);

// Returning to the tab fires no media event (the video is already loaded) and the 1s
// poller is throttled while the tab is hidden, so force a fresh emit (clear the
// change-guard) whenever the tab becomes visible/focused.
function reassertPlaying(): void {
  if (disposed) return;
  lastPlayingKey = '';
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
