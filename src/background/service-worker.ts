// FaceScrap service worker.
// - Observes fbcdn media requests (video/audio streams) via non-blocking
//   webRequest and records candidates per tab.
// - Receives media found by the content script / MAIN-world page hook.
// - Orchestrates DASH remux via an offscreen ffmpeg.wasm document.
// - Keeps the toolbar badge in sync and cleans up per-tab state.
//
// Service workers are ephemeral: do minimal synchronous work in listeners and
// persist immediately. Never keep capture state in module-scope variables.

import { withHeartbeat } from '../shared/async';
import { diagBump, diagDrain } from '../shared/diag';
import {
  addDiagCounters,
  addSaved,
  addMedia,
  clearTab,
  ensureCaptureHeadroom,
  getDiagCounters,
  purgeTab,
  resetDiagCounters,
  setCaps,
  setPlayingMediaPin,
  setRecent,
  type SavedEntry,
} from '../shared/storage';
import {
  classifyNetworkRequest,
  isFbcdn,
  MAX_MEDIA_BATCH_BYTES,
  MEDIA_KINDS,
  MEDIA_SOURCES,
  sanitizeIncomingItems,
  type MediaSource,
} from '../shared/media';
import {
  MUX_PORT,
  type DownloadDirectMsg,
  type DownloadDirectResponse,
  type DownloadDashMsg,
  type DownloadDashResponse,
  type MuxMsg,
  type MuxProgress,
  type MuxProgressMsg,
  type MuxResponse,
  type RevokeMsg,
  type RuntimeMessage,
} from '../shared/messages';
import {
  dashDownloadKey,
  waitForDownloadSettlement,
  type DashDownloadIdentity,
} from '../shared/download-settlement';
import { createSuccessDeduper } from '../shared/success-deduper';
import { hasOffscreen, hasSidePanel } from '../shared/capabilities';
import { loadSettings } from '../shared/settings';
import { createDiagObserver } from './diag-observer';
import { createBindingMessageHandler } from './binding-handler';
import { persistNowPlayingMessage } from './playing-handler';
import { createRecentObserver } from './recent-observer';
import {
  ClosedTabError,
  NavigationPendingError,
  StaleDocumentError,
  StaleTabEpochError,
  createTabLifecycle,
} from './tab-lifecycle';

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

// Establish the global storage reserve before any capture write. The promise is
// reused by listeners below, so a first request cannot race worker startup.
const captureStorageReady = ensureCaptureHeadroom().then((ok) => {
  if (!ok) console.error('[FaceScrap] capture storage started without guaranteed control headroom');
});

// Publish detected capabilities so the side panel/popup can degrade gracefully.
void captureStorageReady
  .then(() => setCaps({ sidePanel: hasSidePanel(), offscreen: hasOffscreen() }))
  .catch(() => {});

// Diagnostics are opt-in at BOTH trust boundaries. Renderer reports are
// accumulated in memory and persisted at most once per interval; the worker's
// own counters join the same write instead of causing a second storage update.
const diagObserver = createDiagObserver({
  write: addDiagCounters,
  drainWorker: diagDrain,
  onError: (error) => console.error('[FaceScrap] diagnostic flush failed', error),
});

function refreshDiagSetting(): void {
  void loadSettings().then((settings) => diagObserver.setEnabled(settings.diagEnabled));
}
refreshDiagSetting();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'settings' in changes) refreshDiagSetting();
});

// Diagnostics from the worker console ("Inspect views: service worker" on
// chrome://extensions) — reachable without opening the panel, which matters
// when the question is why the panel is showing nothing.
(globalThis as { faceScrapDiag?: unknown }).faceScrapDiag = {
  async dump(): Promise<Record<string, number>> {
    await diagObserver.flush(); // include renderer + worker counts not yet flushed
    const counters = await getDiagCounters();
    console.table(counters);
    return counters as Record<string, number>;
  },
  reset: (): Promise<void> => resetDiagCounters(),
};

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

// Tabs closed this session. A capture event (webRequest or a content-script
// message) already in flight when a tab closes can otherwise be handled AFTER
// purgeTab's removal and resurrect media_/playing_/recent_<tabId> as an orphan
// key that nothing will ever clean up again (Chrome doesn't reuse tab ids in a
// session). Skipping known-dead tabs at every write entry point closes that.
const tabLifecycle = createTabLifecycle(captureStorageReady);
const handleBindingMessage = createBindingMessageHandler(tabLifecycle);

function chromeDocumentIdentity(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 128 ? `chrome:${raw}` : undefined;
}

function contentDocumentIdentity(sender: chrome.runtime.MessageSender, token: unknown): string | undefined {
  if (sender.frameId != null && sender.frameId !== 0) return undefined;
  if (sender.documentLifecycle != null && sender.documentLifecycle !== 'active') return undefined;
  const browserIdentity = chromeDocumentIdentity(sender.documentId);
  if (browserIdentity != null) return browserIdentity;
  return typeof token === 'string' && token.length >= 8 && token.length <= 128 ? `content:${token}` : undefined;
}

function isExpectedLifecycleStop(error: unknown): boolean {
  return error instanceof ClosedTabError || error instanceof StaleDocumentError || error instanceof StaleTabEpochError;
}

function sanitizeDownloadFilename(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 240 || /[\\:*?"<>|\r\n]/.test(raw)) return undefined;
  const parts = raw.split('/');
  return parts.some((part) => part.length === 0 || part === '.' || part === '..') ? undefined : raw;
}

function sanitizeDownloadReceipt(raw: unknown): SavedEntry | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const receipt = raw as Record<string, unknown>;
  if (
    typeof receipt.id !== 'string' ||
    receipt.id.length === 0 ||
    receipt.id.length > 258 ||
    typeof receipt.kind !== 'string' ||
    !MEDIA_KINDS.has(receipt.kind) ||
    typeof receipt.source !== 'string' ||
    !MEDIA_SOURCES.has(receipt.source)
  ) {
    return undefined;
  }
  const clean: SavedEntry = {
    id: receipt.id,
    kind: receipt.kind as SavedEntry['kind'],
    source: receipt.source as SavedEntry['source'],
    // The durable receipt is minted only after Chrome confirms `complete`.
    savedAt: Date.now(),
  };
  if (typeof receipt.thumbUrl === 'string' && receipt.thumbUrl.length <= 1024 && isFbcdn(receipt.thumbUrl)) {
    clean.thumbUrl = receipt.thumbUrl;
  }
  if (typeof receipt.resLabel === 'string') clean.resLabel = receipt.resLabel.slice(0, 16);
  if (typeof receipt.durationSec === 'number' && Number.isFinite(receipt.durationSec)) {
    clean.durationSec = receipt.durationSec;
  }
  return clean;
}

async function persistCompletedDownload(tabId: number, receipt: SavedEntry): Promise<void> {
  if (!tabLifecycle.isDead(tabId)) await addSaved(tabId, { ...receipt, savedAt: Date.now() });
}

// 1. Observe fbcdn media streams (reels/stories video + DASH tracks).
const recentObserver = createRecentObserver(async (tabId, url, at, documentId) => {
  try {
    return await tabLifecycle.runIfLive(tabId, () => setRecent(tabId, url, at, Date.now()), documentId);
  } catch (err) {
    if (isExpectedLifecycleStop(err) || err instanceof NavigationPendingError) return false;
    throw err;
  }
}, {
  isDead: (tabId) => tabLifecycle.isDead(tabId),
  onError: (err) => console.error('[FaceScrap] recent observation failed', err),
});

function bumpRecent(tabId: number, url: string, documentId?: string): void {
  void recentObserver.bump(tabId, url, documentId);
}

// DASH/MSE tracks are fetched as XHR (not type `media`), so we watch both request
// types for bumpRecent / now-playing only. addMedia intentionally stays gated to
// `media`: DASH video and audio XHR segments share the same URL shape and cannot
// be classified safely here. Complete linked ladders come from the passive
// GraphQL parser in page-hook.ts instead.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;
    if (/[?&](bytestart|byteend)=/.test(url) || /\.mp4(\?|$)/i.test(url)) {
      bumpRecent(details.tabId, url, chromeDocumentIdentity(details.documentId));
    }
    if (details.type === 'media' && !tabLifecycle.isDead(details.tabId)) {
      const item = classifyNetworkRequest(url, Date.now(), tabSurface.get(details.tabId) ?? 'video');
      if (item) {
        diagBump('captureNetwork');
        void tabLifecycle
          .runIfLive(details.tabId, () => addMedia(details.tabId, [item]), chromeDocumentIdentity(details.documentId))
          .then((n) => setBadge(details.tabId, n))
          .catch((err) => {
            if (!isExpectedLifecycleStop(err) && !(err instanceof NavigationPendingError)) {
              console.error('[FaceScrap] network capture write failed', err);
            }
          });
      }
    }
  },
  { urls: ['*://*.fbcdn.net/*'], types: ['media', 'xmlhttprequest'] },
);

// 2. Bind every capture to a committed top-level document. The begin/commit
//    barrier rejects old-document IPC even when it arrives after clearTab, and
//    also orders startup-delayed writes against that clear. Viewer continuations
//    retain Library rows and already-accepted prefetch work, but later messages
//    from their replaced document are still rejected.
function isViewerContinuation(url: string): boolean {
  if (!FB_URL.test(url)) return false;
  try {
    return /^\/(?:reel\/|stories\/|watch(?:\/|$)|videos\/)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
chrome.webNavigation.onBeforeNavigate.addListener(
  (details) => {
    if (details.tabId < 0 || details.frameId !== 0) return;
    tabSurface.set(details.tabId, surfaceOf(details.url));
    recentObserver.reset(details.tabId);
    tabLifecycle.beginNavigation(details.tabId, !isViewerContinuation(details.url));
  },
);

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.tabId < 0 || details.frameId !== 0) return;
  tabSurface.set(details.tabId, surfaceOf(details.url));
  tabLifecycle.commitDocument(details.tabId, chromeDocumentIdentity(details.documentId));
  if (isViewerContinuation(details.url)) return;
  void tabLifecycle
    .runIfLive(details.tabId, () => clearTab(details.tabId))
    .then(() => chrome.action.setBadgeText({ tabId: details.tabId, text: '' }))
    .catch((error) => {
      if (!isExpectedLifecycleStop(error)) console.error('[FaceScrap] navigation clear failed', error);
    });
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.tabId >= 0 && details.frameId === 0) tabLifecycle.abortNavigation(details.tabId);
});

// 3. Messages: candidates from the content script, and download requests from the side panel.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (handleBindingMessage(msg, sender, sendResponse)) return true;
  const tabId = sender.tab?.id;
  // Narrowing on the shared union couples this receiver to the senders at
  // compile time. The runtime field checks below are not redundant: content
  // scripts share a process with the page, so their messages are never
  // believed blindly.
  const m = msg as RuntimeMessage | undefined;

  if (m?.type === 'MEDIA_FOUND') {
    const documentId = contentDocumentIdentity(sender, m.documentToken);
    if (typeof tabId !== 'number' || tabLifecycle.isDead(tabId) || documentId == null || !Array.isArray(m.items)) {
      sendResponse({ ok: false, retryable: false, error: 'Invalid or closed sender tab.' });
      return true;
    }
    // The content script sanitizes too, but it shares the renderer process with
    // the page — a compromised renderer can send anything. Re-sanitize here so
    // stored items are shaped/bounded regardless of what the sender ran.
    tabLifecycle
      .runIfLive(tabId, () => addMedia(tabId, sanitizeIncomingItems(m.items, MAX_MEDIA_BATCH_BYTES)), documentId)
      .then(
        (n) => {
          void setBadge(tabId, n);
          sendResponse({ ok: true });
        },
        (err) => {
          if (err instanceof StaleTabEpochError) {
            sendResponse({ ok: true });
            return;
          }
          sendResponse({
            ok: false,
            retryable: err instanceof NavigationPendingError || !(err instanceof ClosedTabError || err instanceof StaleDocumentError),
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    return true;
  }

  if (m?.type === 'NOW_PLAYING') {
    const documentId = contentDocumentIdentity(sender, m.documentToken);
    if (typeof tabId !== 'number' || tabLifecycle.isDead(tabId) || documentId == null) {
      sendResponse({ ok: false, retryable: false, error: 'Invalid or closed sender tab.' });
      return true;
    }
    tabLifecycle.runIfLive(tabId, () => persistNowPlayingMessage(tabId, m, Date.now()), documentId).then(
      (ack) => sendResponse(ack),
      (err) =>
        sendResponse({
          ok: false,
          retryable: err instanceof NavigationPendingError || !(err instanceof ClosedTabError || err instanceof StaleDocumentError || err instanceof StaleTabEpochError),
          error: err instanceof Error ? err.message : String(err),
        }),
    );
    return true;
  }

  if (m?.type === 'DIAG_REPORT') {
    // Same defence-in-depth as MEDIA_FOUND: these counts started life in the
    // MAIN world, which shares a process with the page. The observer rejects
    // disabled, invalid, closed or over-limit senders and re-sanitizes values.
    const documentId = contentDocumentIdentity(sender, m.documentToken);
    if (typeof tabId === 'number' && documentId != null && tabLifecycle.acceptDocument(tabId, documentId)) {
      diagObserver.report(tabId, m.counters);
    }
    return undefined;
  }

  if (m?.type === 'FACESCRAP_PIN_PLAYING_MEDIA') {
    // Only an extension page may confirm a selection. Content scripts have a
    // sender.tab and must not be able to reserve arbitrary Library rows.
    if (sender.tab) {
      sendResponse({ ok: false, error: 'Unauthorized request.' });
      return true;
    }
    if (
      !Number.isInteger(m.tabId) ||
      m.tabId < 0 ||
      tabLifecycle.isDead(m.tabId) ||
      typeof m.identity !== 'string' ||
      !Array.isArray(m.groups) ||
      typeof m.playingAt !== 'number' ||
      !Number.isFinite(m.playingAt)
    ) {
      sendResponse({ ok: false, error: 'Invalid playing pin.' });
      return true;
    }
    const receivedAt = Date.now();
    tabLifecycle.runIfLive(m.tabId, () => setPlayingMediaPin(m.tabId, m.identity, m.groups, m.playingAt, receivedAt)).then(
      (ok) => sendResponse({ ok, error: ok ? undefined : 'Playing pin storage failed.' }),
      (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
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
    recentObserver.reset(wanted);
    tabLifecycle.invalidate(wanted, false);
    tabLifecycle.runIfLive(wanted, () => clearTab(wanted)).then(
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
    const { tabId: requestedTab, videoUrl, audioUrl, filename: rawFilename, saveAs, receipt: rawReceipt } = msg as {
      tabId?: unknown;
      videoUrl?: unknown;
      audioUrl?: unknown;
      filename?: unknown;
      saveAs?: unknown;
      receipt?: unknown;
    };
    const filename = sanitizeDownloadFilename(rawFilename);
    const receipt = sanitizeDownloadReceipt(rawReceipt);
    if (
      typeof requestedTab !== 'number' ||
      !Number.isInteger(requestedTab) ||
      requestedTab < 0 ||
      tabLifecycle.isDead(requestedTab) ||
      typeof videoUrl !== 'string' ||
      typeof audioUrl !== 'string' ||
      filename == null ||
      receipt == null ||
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
    downloadDash({
      tabId: requestedTab,
      receiptId: receipt.id,
      videoUrl,
      audioUrl,
      filename,
      saveAs: saveAs === true,
    })
      .then(() => persistCompletedDownload(requestedTab, receipt))
      .then(
        () => {
          sendResponse({ ok: true });
        },
        (e: unknown) => {
          sendResponse({ ok: false, error: String((e as Error)?.message ?? e) });
        },
      );
    return true; // async response
  }

  if (m?.type === 'FACESCRAP_DOWNLOAD_DIRECT') {
    if (sender.tab) {
      sendResponse({ ok: false, error: 'Unauthorized request.' } satisfies DownloadDirectResponse);
      return true;
    }
    const request = msg as Partial<DownloadDirectMsg>;
    const filename = sanitizeDownloadFilename(request.filename);
    const receipt = sanitizeDownloadReceipt(request.receipt);
    if (
      !Number.isInteger(request.tabId) ||
      (request.tabId ?? -1) < 0 ||
      tabLifecycle.isDead(request.tabId as number) ||
      typeof request.url !== 'string' ||
      !isFbcdn(request.url) ||
      filename == null ||
      receipt == null
    ) {
      sendResponse({ ok: false, error: 'Invalid download request.' } satisfies DownloadDirectResponse);
      return true;
    }
    const requestedTab = request.tabId as number;
    downloadDirect(request.url, filename, request.saveAs === true)
      .then(() => persistCompletedDownload(requestedTab, receipt))
      .then(
        () => sendResponse({ ok: true } satisfies DownloadDirectResponse),
        (error: unknown) =>
          sendResponse({ ok: false, error: String((error as Error)?.message ?? error) } satisfies DownloadDirectResponse),
      );
    return true;
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
  tabLifecycle.markDead(tabId); // before purgeTab: late in-flight events must not re-write
  diagObserver.removeTab(tabId);
  recentObserver.reset(tabId);
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
      if (!tab.url) {
        recentObserver.reset(tabId);
        tabLifecycle.invalidate(tabId, true);
        void tabLifecycle.runIfLive(tabId, () => clearTab(tabId)); // left facebook → drop its captures
      }
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
// A download normally settles in well under a second (blob → disk). Cap how long
// we will keep the SW pinned alive waiting for a terminal state, so a download
// that never reports one can't keep the worker awake forever.
const SETTLE_CAP_MS = 5 * 60_000;
// Grace before closing the idle offscreen document after a download settles —
// long enough that back-to-back quality downloads reuse the loaded ffmpeg.
const OFFSCREEN_IDLE_MS = 60_000;
// Backstop on ONE mux round-trip, measured from job START — jobs are serialized
// on dashChain below, so queue wait never burns this budget.
//
// This was a 115s WALL-CLOCK cap, justified by a bound the offscreen document
// does not actually have: it caps the IDLE gap of each track read (STALL_MS),
// deliberately, because "a whole-transfer wall-clock cap can't tell a stall
// from a large track on a slow-but-steady link" (its own words). The worker
// then reimposed exactly that cap one layer up, so a 500MB video on a 20Mbps
// link — several minutes of perfectly healthy transfer — died at 115s, and the
// catch below tore down the offscreen document, discarding every byte. Retrying
// failed identically. It was deterministic, not flaky.
//
// So: bound idleness instead, against the progress the offscreen now reports
// (MUX_PORT). A job that keeps moving is never cut off; a wedged one still dies.
// The idle window sits above the offscreen's own STALL_MS so a stalled fetch
// surfaces its specific error rather than this generic one.
const MUX_IDLE_MS = 90_000;
// The case no idle timer can see: an offscreen document that died outright
// sends neither progress nor an answer. Generous — it should only ever fire on
// a genuinely broken job, never on a slow one.
const MUX_HARD_CAP_MS = 30 * 60_000;

// Just past the longest a job can possibly run, and derived from it so the two
// cannot drift apart: a retry clicked after a long download must hit the no-op
// above, never run a second full download of a file already on disk. Derived
// from the HARD CAP rather than the panel's idle window — with progress-based
// timeouts a healthy job may now legitimately outlive that window several times
// over, and a dedup entry that expired first would let a retry duplicate it.
const DEDUP_WINDOW_MS = MUX_HARD_CAP_MS + 30_000;
const dashDeduper = createSuccessDeduper(DEDUP_WINDOW_MS, () => performance.now());

// Progress from the running mux. Jobs are serialized on dashChain, so at most
// one beat function is live; the port is opened by the offscreen when its job
// starts (see enqueueMux there).
let activeBeat: (() => void) | null = null;
chrome.runtime.onConnect.addListener((port) => {
  // Only the extension's own offscreen document — a content script's port has
  // sender.tab set. Same defence-in-depth as the message router.
  if (port.name !== MUX_PORT || port.sender?.tab) return;
  port.onMessage.addListener((p: MuxProgress) => {
    activeBeat?.();
    // Forward to the panel so ITS wait is idle-bounded too — otherwise a
    // download long enough to be worth this whole mechanism would still be
    // reported failed by the UI while the worker was happily finishing it.
    chrome.runtime.sendMessage({ type: 'FACESCRAP_MUX_PROGRESS', ...p } satisfies MuxProgressMsg).catch(() => {});
  });
});

// Every DASH job runs one at a time on this chain, whichever panel window sent
// it. The offscreen muxQueue already serializes the MUXES, but a job's
// MUX_TIMEOUT used to start at sendMessage — so a request queued behind a long
// merge burned its budget waiting and was reported failed over work that then
// completed and was thrown away. Chaining here starts each job's clock at job
// start. The trailing catch() keeps one failed job from poisoning the chain.
let dashChain: Promise<void> = Promise.resolve();

function downloadDash(request: DashDownloadIdentity): Promise<void> {
  const key = dashDownloadKey(request);
  return dashDeduper.run(key, () => {
    const job = dashChain.then(() =>
      runDownloadDash(request.videoUrl, request.audioUrl, request.filename, request.saveAs),
    );
    dashChain = job.catch(() => {});
    return job;
  });
}

async function runDownloadDash(
  videoUrl: string,
  audioUrl: string,
  filename: string,
  saveAs: boolean,
): Promise<void> {
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
  let idleCloseScheduled = false;
  const scheduleIdleClose = (): void => {
    if (idleCloseScheduled) return;
    idleCloseScheduled = true;
    setTimeout(() => {
      if (dashDeduper.inFlightCount === 0) chrome.offscreen.closeDocument().catch(() => {});
      stopOnce();
    }, OFFSCREEN_IDLE_MS);
  };

  try {
    await ensureOffscreen();
    let res: MuxResponse | undefined;
    try {
      const guarded = withHeartbeat(
        chrome.runtime.sendMessage({ type: 'FACESCRAP_MUX', videoUrl, audioUrl } satisfies MuxMsg),
        MUX_IDLE_MS,
        MUX_HARD_CAP_MS,
        'The merge timed out.',
      );
      activeBeat = guarded.beat;
      try {
        res = (await guarded.promise) as MuxResponse | undefined;
      } finally {
        activeBeat = null;
      }
    } catch (e) {
      // A timed-out mux may still be RUNNING over there — the guard above only
      // stops waiting, and there is no cancel message. Left alive, the wedged
      // exec keeps the offscreen muxQueue busy while the NEXT chained job's
      // clock runs, cascading false timeouts through everything queued behind
      // it (the queue-wait-burns-the-budget bug one layer down). Tear the
      // document down so the wedge dies with it; the next job recreates a
      // fresh one. Acceptable collateral: this job was already reported
      // failed, and a prior job's pending blob download has near-always
      // settled by now (blob→disk lands in well under a second). A rejected
      // sendMessage (offscreen already gone) takes this path too — the close
      // is then a no-op. AWAITED before the rethrow: dashChain advances the
      // moment this promise rejects (microtasks), while closeDocument is a
      // cross-process round trip — an unawaited close lets the next job's
      // ensureOffscreen see the dying document via getContexts, skip creation,
      // and send its mux into it.
      await chrome.offscreen.closeDocument().catch(() => {});
      throw e;
    }
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
    try {
      // `download()` proves only enqueue. Dedup and Saved advance only after
      // this terminal promise confirms the file actually reached `complete`.
      await waitForDownloadSettlement(chrome.downloads, downloadId, {
        timeoutMs: SETTLE_CAP_MS,
        cancelOnTimeout: true,
      });
    } finally {
      chrome.runtime.sendMessage({ type: 'FACESCRAP_REVOKE', blobUrl } satisfies RevokeMsg).catch(() => {});
    }
    scheduleIdleClose();
  } catch (e) {
    // Same idle-close path as success: a failed mux (an expired fbcdn URL is the
    // common failure) must not leave the offscreen document — and ffmpeg's heap —
    // alive indefinitely.
    scheduleIdleClose();
    throw e;
  }
}

async function downloadDirect(url: string, filename: string, saveAs: boolean): Promise<void> {
  const stopKeepalive = startKeepalive();
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs,
    });
    // A remote progressive file can be legitimately slow, so unlike the local
    // DASH blob this has no wall-clock timeout. The browser's terminal event is
    // the authority; interruption rejects and leaves Retry real.
    await waitForDownloadSettlement(chrome.downloads, downloadId);
  } finally {
    stopKeepalive();
  }
}
