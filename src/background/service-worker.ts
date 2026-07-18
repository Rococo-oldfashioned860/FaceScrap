// FaceScrap service worker.
// - Observes fbcdn media requests (video/audio streams) via non-blocking
//   webRequest and records candidates per tab.
// - Receives media found by the content script / MAIN-world page hook.
// - Orchestrates DASH remux via an offscreen ffmpeg.wasm document.
// - Keeps the toolbar badge in sync and cleans up per-tab state.
//
// Service workers are ephemeral: do minimal synchronous work in listeners and
// persist immediately. Never keep capture state in module-scope variables.

import { withTimeout } from '../shared/async';
import { addMedia, clearTab, purgeTab, setCaps, setPlaying, setRecent } from '../shared/storage';
import { classifyNetworkRequest, isFbcdn, sanitizeIncomingItems, widenDashUrl, type MediaSource } from '../shared/media';
import { DASH_UI_TIMEOUT_MS, type MuxMsg, type MuxResponse, type RevokeMsg, type RuntimeMessage } from '../shared/messages';
import { hasOffscreen, hasSidePanel } from '../shared/capabilities';

// 0. Open the UI on toolbar click, adapting to the browser. sidePanel is
//    Chrome/Edge only; where it is missing (Opera/forks) fall back to opening the
//    SAME sidepanel.html as a toolbar popup. hasSidePanel() guards the property
//    access so this never throws at SW eval on a browser without the API.
if (hasSidePanel()) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error('[FaceScrap] setPanelBehavior', e));
  // Clear any stale popup (e.g. after a browser update) so it can't shadow the panel.
  chrome.action.setPopup({ popup: '' }).catch(() => {});
} else {
  chrome.action.setPopup({ popup: 'sidepanel/sidepanel.html' }).catch((e) => console.error('[FaceScrap] setPopup', e));
}

// Publish detected capabilities so the side panel/popup can degrade gracefully.
setCaps({ sidePanel: hasSidePanel(), offscreen: hasOffscreen() }).catch(() => {});

// 0b. FaceScrap only operates on Facebook. Keep the toolbar action + side panel ENABLED
//     on facebook.com tabs and DISABLED everywhere else, so on any other site the
//     extension is inert: the icon is greyed and unclickable and the panel can't
//     open. tab.url is exposed only for host-permitted origins even without the
//     "tabs" permission, so its absence already means "not our site"; we also
//     require a facebook.com host (an fbcdn.net media tab is host-permitted but is
//     not a UI surface).
const FB_URL = /^https?:\/\/([^/]+\.)?facebook\.com(?:[/?#]|$)/i;

// Last-seen viewer surface per tab, so network captures are labeled with what
// the user is actually browsing (reel/story) instead of a flat "video". Unlike
// capture state, this is derived and self-healing: a SW restart only costs
// label precision until the next navigation or tab activation re-derives it.
const tabSurface = new Map<number, MediaSource>();

// Path tests mirror the page hook's pageSource() (same precedence), on a
// host-verified URL so an embedded "facebook.com/reel/…" substring elsewhere
// can't mislabel the tab.
function surfaceOf(url: string | undefined): MediaSource {
  if (url == null || !FB_URL.test(url)) return 'video';
  try {
    const p = new URL(url).pathname;
    if (/highlight/i.test(p)) return 'highlight';
    if (/\/stories\//.test(p)) return 'story';
    if (/\/reel\//.test(p)) return 'reel';
  } catch {
    /* unparseable — keep the default */
  }
  return 'video';
}

function gateTab(tabId: number, url: string | undefined): void {
  const onFb = url != null && FB_URL.test(url);
  tabSurface.set(tabId, surfaceOf(url));
  if (onFb) chrome.action.enable(tabId).catch(() => {});
  else chrome.action.disable(tabId).catch(() => {});
  chrome.action.setTitle({ tabId, title: onFb ? 'FaceScrap' : 'FaceScrap — only works on Facebook' }).catch(() => {});
  if (hasSidePanel()) {
    chrome.sidePanel
      .setOptions(onFb ? { tabId, path: 'sidepanel/sidepanel.html', enabled: true } : { tabId, enabled: false })
      .catch(() => {});
  }
}

function gateAllTabs(): void {
  chrome.tabs
    .query({})
    .then((tabs) => {
      for (const t of tabs) if (typeof t.id === 'number') gateTab(t.id, t.url);
    })
    .catch(() => {});
}

// Disabled by DEFAULT (a fresh/unseen tab stays inert until proven to be on
// Facebook), then flip the currently-open tabs to their correct state.
chrome.action.disable().catch(() => {});
if (hasSidePanel()) chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
gateAllTabs();
chrome.runtime.onStartup.addListener(gateAllTabs);
chrome.runtime.onInstalled.addListener(gateAllTabs);
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs
    .get(tabId)
    .then((tab) => gateTab(tabId, tab.url))
    .catch(() => {});
});

// 1. Observe fbcdn media streams (reels/stories video + DASH tracks).
let lastRecentKey = '';
function bumpRecent(tabId: number, url: string): void {
  const widened = widenDashUrl(url);
  const k = `${tabId}:${widened}`;
  if (k === lastRecentKey) return; // same track being segmented → skip
  lastRecentKey = k;
  void setRecent(tabId, widened, Date.now());
}

// DASH/MSE video is fetched as XHR (not type `media`), so we watch both. Any
// fbcdn request that looks like a video/audio track (byte-range segment or an
// .mp4) marks that track as "playing now" for the now-playing filter.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;
    if (/[?&](bytestart|byteend)=/.test(url) || /\.mp4(\?|$)/i.test(url)) {
      bumpRecent(details.tabId, url);
    }
    if (details.type === 'media') {
      const item = classifyNetworkRequest(url, Date.now(), tabSurface.get(details.tabId) ?? 'video');
      if (item) void addMedia(details.tabId, [item]).then((n) => setBadge(details.tabId, n));
    }
  },
  { urls: ['*://*.fbcdn.net/*'], types: ['media', 'xmlhttprequest'] },
);

// 2. Reset a tab's captures on top-level navigation, EXCEPT media-viewer
//    continuations: the reels feed and stories tray advance via real top-level
//    navigations (/reel/<a> → /reel/<b>), and wiping there orphans the video
//    being watched (its GraphQL burst arrived before the wipe).
const VIEWER_CONTINUATION = /\bfacebook\.com\/(?:reel\/|stories\/|watch|videos\/)/;
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    tabSurface.set(details.tabId, surfaceOf(details.url));
    if (VIEWER_CONTINUATION.test(details.url)) return;
    void clearTab(details.tabId).then(() => chrome.action.setBadgeText({ tabId: details.tabId, text: '' }));
  },
  { urls: ['*://*.facebook.com/*'], types: ['main_frame'] },
);

// 3. Messages: candidates from the content script, and download requests from the side panel.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  // Narrowing on the shared union couples this receiver to the senders at
  // compile time. The runtime field checks below are not redundant: content
  // scripts share a process with the page, so their messages are never
  // believed blindly.
  const m = msg as RuntimeMessage | undefined;

  if (m?.type === 'MEDIA_FOUND' && typeof tabId === 'number' && Array.isArray(m.items)) {
    // The content script sanitizes too, but it shares the renderer process with
    // the page — a compromised renderer can send anything. Re-sanitize here so
    // stored items are shaped/bounded regardless of what the sender ran.
    void addMedia(tabId, sanitizeIncomingItems(m.items)).then((n) => setBadge(tabId, n));
    return undefined;
  }

  if (m?.type === 'NOW_PLAYING' && typeof tabId === 'number') {
    void setPlaying(tabId, {
      ids: Array.isArray(m.ids) ? m.ids.slice(0, 24).map((x) => String(x).slice(0, 256)) : [],
      hasVideo: Boolean(m.hasVideo),
      // URL-derived video id (reel/watch pages): exact anchor for the panel.
      vid: typeof m.vid === 'string' && /^\d{5,20}$/.test(m.vid) ? m.vid : undefined,
      // Centered cover URLs — fbcdn-only (untrusted content-script input).
      coverUrls: Array.isArray(m.covers)
        ? (m.covers as unknown[])
            .filter((c): c is string => typeof c === 'string' && c.length <= 8192 && isFbcdn(c))
            .slice(0, 3)
        : undefined,
      // Opaque slide marker — compared only, never fetched; just bound its size.
      mark: typeof m.mark === 'string' && m.mark.length > 0 ? m.mark.slice(0, 256) : undefined,
      at: Date.now(),
    });
    return undefined;
  }

  if (m?.type === 'FACESCRAP_CLEAR_TAB') {
    // Only the extension's own pages (side panel / popup) may wipe a tab. A
    // content script has sender.tab set; reject it so a compromised page can't
    // clear an arbitrary tab's captures. Routed here (not run in the panel) so
    // the removal serializes on the same write chain as addMedia — see ClearTabMsg.
    if (sender.tab) {
      sendResponse({ ok: false, error: 'Unauthorized request.' });
      return true;
    }
    const wanted = (msg as { tabId?: unknown }).tabId;
    if (typeof wanted !== 'number') {
      sendResponse({ ok: false, error: 'Invalid clear request.' });
      return true;
    }
    clearTab(wanted).then(
      () => {
        void setBadge(wanted, 0);
        sendResponse({ ok: true });
      },
      (e: unknown) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) }),
    );
    return true; // async response
  }

  if (m?.type === 'FACESCRAP_DOWNLOAD_DASH') {
    // Only the extension's own pages (side panel / popup) may drive a download.
    // A content script has sender.tab set; reject it so a compromised page can't
    // request a remux/download of an arbitrary URL.
    if (sender.tab) {
      sendResponse({ ok: false, error: 'Unauthorized request.' });
      return true;
    }
    const { videoUrl, audioUrl, filename, saveAs } = msg as {
      videoUrl?: unknown;
      audioUrl?: unknown;
      filename?: unknown;
      saveAs?: unknown;
    };
    if (
      typeof videoUrl !== 'string' ||
      typeof audioUrl !== 'string' ||
      typeof filename !== 'string' ||
      !isFbcdn(videoUrl) ||
      !isFbcdn(audioUrl)
    ) {
      sendResponse({ ok: false, error: 'Invalid download request.' });
      return true;
    }
    if (!hasOffscreen()) {
      sendResponse({
        ok: false,
        error: 'This browser can\'t merge audio and video (no offscreen API). Download the direct version.',
      });
      return true;
    }
    downloadDash(videoUrl, audioUrl, filename, saveAs === true).then(
      () => {
        sendResponse({ ok: true });
      },
      (e: unknown) => {
        sendResponse({ ok: false, error: String((e as Error)?.message ?? e) });
      },
    );
    return true; // async response
  }

  return undefined;
});

// 4. Toolbar badge = number of captured items for that tab (count comes from
//    addMedia's write, so this never re-reads the array).
async function setBadge(tabId: number, n: number): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: '#1877F2' });
  await chrome.action.setBadgeText({ tabId, text: n > 0 ? String(Math.min(n, 999)) : '' });
}

// 5. Clean up when a tab closes — the one path that also drops the download
//    history (navigation and the Clear button keep it; see purgeTab).
chrome.tabs.onRemoved.addListener((tabId) => {
  tabSurface.delete(tabId);
  void purgeTab(tabId);
});

// 6. Clear per-tab state once a tab has left facebook.com. `changeInfo.url` is
//    an unreliable signal (absent on same-URL reloads, prerender activations and
//    bfcache restores), so read the settled tab.url instead: without the "tabs"
//    permission it is exposed only for host-permitted (facebook) origins, so an
//    invisible url means the tab genuinely left the site.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // SPA navigations (feed → /reel/<id> via pushState) fire neither a main_frame
  // request nor a 'complete' status — only this url delta keeps tabSurface and
  // the gate current there. Exposed without the "tabs" permission only for
  // host-permitted (facebook) origins, which is exactly the set we label.
  if (changeInfo.url) gateTab(tabId, changeInfo.url);
  if (changeInfo.status !== 'complete') return;
  chrome.tabs
    .get(tabId)
    .then((tab) => {
      gateTab(tabId, tab.url); // enable on facebook, disable (and inert) elsewhere
      if (!tab.url) void clearTab(tabId); // left facebook → drop its captures
    })
    .catch(() => {});
});

// --- DASH remux via the offscreen ffmpeg.wasm document ---

let creatingOffscreen: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: 'offscreen/offscreen.html',
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: 'Remux split DASH video+audio tracks into one MP4.',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

// ffmpeg.wasm remux can take a while; a service worker that goes idle mid-job is
// killed, orphaning the offscreen reply and hanging the panel's button forever.
// Pinging a cheap API on an interval resets the idle timer while a job runs.
// (chrome.downloads is unavailable in offscreen docs, so the SW must stay alive
// to receive the blob URL and start the download itself.)
function startKeepalive(): () => void {
  const id = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  return () => clearInterval(id);
}

// A DASH download is identified by its (video, audio) track pair. The panel's
// UI timeout (DASH_UI_TIMEOUT_MS) does NOT cancel the SW job, and once the
// panel gives up its button turns clickable again, so duplicates are collapsed:
// a concurrent request shares the one in-flight job, and a request shortly
// after a completed download is an idempotent no-op.
const inflightDownloads = new Map<string, Promise<void>>();
const recentlyDownloaded = new Map<string, number>();
// Just past the panel's give-up point, and derived from it so the two can't
// drift apart again: a retry clicked after a UI timeout must hit the no-op
// above, never run a second full download of a file already on disk.
const DEDUP_WINDOW_MS = DASH_UI_TIMEOUT_MS + 30_000;
// A download normally settles in well under a second (blob → disk). Cap how long
// we will keep the SW pinned alive waiting for a terminal state, so a download
// that never reports one can't keep the worker awake forever.
const SETTLE_CAP_MS = 5 * 60_000;
// Grace before closing the idle offscreen document after a download settles —
// long enough that back-to-back quality downloads reuse the loaded ffmpeg.
const OFFSCREEN_IDLE_MS = 60_000;
// Backstop on ONE mux round-trip, measured from job START — jobs are serialized
// on dashChain below, so queue wait never burns this budget. The offscreen
// already bounds each track fetch (FETCH_TIMEOUT_MS=90s ×2 concurrent + a short
// exec ≈ 95s worst case), but if the offscreen dies outright — a lost message, a
// wedged ffmpeg exec — the SW would await forever and stay pinned by the
// keepalive. On expiry runDownloadDash throws, downloadDash's .finally clears
// inflightDownloads, and a retry is no longer a no-op against a dead in-flight
// promise. The panel's own timeout is a much larger hang backstop (360s), sized
// for a queue of jobs, so a queued job no longer times out over work that was
// going to land.
const MUX_TIMEOUT_MS = 115_000;

function pairKey(videoUrl: string, audioUrl: string): string {
  return `${videoUrl}\n${audioUrl}`;
}

// Every DASH job runs one at a time on this chain, whichever panel window sent
// it. The offscreen muxQueue already serializes the MUXES, but a job's
// MUX_TIMEOUT used to start at sendMessage — so a request queued behind a long
// merge burned its budget waiting and was reported failed over work that then
// completed and was thrown away. Chaining here starts each job's clock at job
// start. The trailing catch() keeps one failed job from poisoning the chain.
let dashChain: Promise<void> = Promise.resolve();

function downloadDash(videoUrl: string, audioUrl: string, filename: string, saveAs: boolean): Promise<void> {
  const key = pairKey(videoUrl, audioUrl);
  const existing = inflightDownloads.get(key);
  if (existing) return existing; // concurrent duplicate → share the one job

  const doneAt = recentlyDownloaded.get(key);
  if (doneAt !== undefined && Date.now() - doneAt < DEDUP_WINDOW_MS) {
    return Promise.resolve(); // already saved moments ago → idempotent no-op
  }

  const job = dashChain
    .then(() => runDownloadDash(videoUrl, audioUrl, filename, saveAs))
    .then(() => {
      recentlyDownloaded.set(key, Date.now());
      for (const [k, t] of recentlyDownloaded) {
        if (Date.now() - t > DEDUP_WINDOW_MS) recentlyDownloaded.delete(k);
      }
    })
    .finally(() => {
      inflightDownloads.delete(key);
    });
  dashChain = job.catch(() => {});
  inflightDownloads.set(key, job);
  return job;
}

async function runDownloadDash(videoUrl: string, audioUrl: string, filename: string, saveAs: boolean): Promise<void> {
  const stopKeepalive = startKeepalive();
  let keepaliveStopped = false;
  const stopOnce = (): void => {
    if (keepaliveStopped) return;
    keepaliveStopped = true;
    stopKeepalive();
  };
  // Release ffmpeg.wasm's memory (~100MB high-water mark) once idle: hold the
  // keepalive one grace period longer, then close the offscreen document if
  // no other mux is running. The next download simply recreates it.
  const scheduleIdleClose = (): void => {
    setTimeout(() => {
      if (inflightDownloads.size === 0) chrome.offscreen.closeDocument().catch(() => {});
      stopOnce();
    }, OFFSCREEN_IDLE_MS);
  };

  try {
    await ensureOffscreen();
    const res = (await withTimeout(
      chrome.runtime.sendMessage({ type: 'FACESCRAP_MUX', videoUrl, audioUrl } satisfies MuxMsg),
      MUX_TIMEOUT_MS,
      'The merge timed out.',
    )) as MuxResponse | undefined;
    if (res?.ok !== true || !res.blobUrl) {
      throw new Error((res?.ok === false ? res.error : undefined) || 'Could not merge audio and video.');
    }

    const blobUrl = res.blobUrl;
    let downloadId: number;
    try {
      downloadId = await chrome.downloads.download({ url: blobUrl, filename, saveAs });
    } catch (e) {
      // The mux succeeded but the download couldn't start — release the
      // offscreen-owned blob instead of leaking it until the doc closes.
      chrome.runtime.sendMessage({ type: 'FACESCRAP_REVOKE', blobUrl } satisfies RevokeMsg).catch(() => {});
      throw e;
    }
    // download() resolves when the download is *enqueued*, not when the file is
    // written. Keep the keepalive running until the download actually settles,
    // THEN revoke the blob and stop pinging; the capped timer is the safety
    // valve for a download that never reports a terminal state.
    let finishTimer: ReturnType<typeof setTimeout>;
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(finishTimer);
      chrome.runtime.sendMessage({ type: 'FACESCRAP_REVOKE', blobUrl } satisfies RevokeMsg).catch(() => {});
      scheduleIdleClose();
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== downloadId || !delta.state) return;
      const state = delta.state.current;
      if (state === 'complete' || state === 'interrupted') cleanup();
    };
    finishTimer = setTimeout(cleanup, SETTLE_CAP_MS);
    chrome.downloads.onChanged.addListener(onChanged);
    // A blob→disk download can settle before the listener above registers; poll
    // once so a missed event can't pin the keepalive until SETTLE_CAP_MS.
    chrome.downloads
      .search({ id: downloadId })
      .then((results) => {
        const state = results[0]?.state;
        if (state === 'complete' || state === 'interrupted') cleanup();
      })
      .catch(() => {});
  } catch (e) {
    // Same idle-close path as success: a failed mux (an expired fbcdn URL is the
    // common failure) must not leave the offscreen document — and ffmpeg's heap —
    // alive indefinitely.
    scheduleIdleClose();
    throw e;
  }
}
