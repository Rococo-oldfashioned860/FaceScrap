// Per-tab captured-media storage, backed by chrome.storage.session.
// Only trusted contexts (service worker, side panel) touch this — content scripts
// relay via messages instead. Writes are serialized per key family (one promise
// chain each) so bursty fbcdn read-modify-write cycles can't lose updates, while
// unrelated keys never wait on each other.

import { mergeMedia, type MediaItem } from './media';
import { DEFAULT_SETTINGS, loadSettings } from './settings';

const keyFor = (tabId: number): string => `media_${tabId}`;

// Per-tab retention cap (Settings.maxItems). One reels-feed GraphQL burst can carry
// ~1200 reels (several DASH items each), so the cap must exceed a burst or oldest-first
// eviction drops the watched reel. Cached so addMedia doesn't read storage on every
// capture; refreshed when the setting changes. 0/unset → Infinity (unlimited).
let maxItemsCache: number = DEFAULT_SETTINGS.maxItems;
function refreshMaxItems(): void {
  loadSettings()
    .then((s) => {
      maxItemsCache = s.maxItems > 0 ? s.maxItems : Infinity;
    })
    .catch(() => {});
}
refreshMaxItems();
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'settings' in changes) refreshMaxItems();
  });
} catch {
  /* storage.onChanged unavailable — the cap stays at its default */
}

const readKey = async <T>(key: string, fallback: T): Promise<T> =>
  ((await chrome.storage.session.get(key))[key] as T | undefined) ?? fallback;

// One task queue per key family: read-modify-write cycles on a key must run one
// at a time, but unrelated keys must never wait on each other's writes.
function serialQueue(): (task: () => Promise<void>, onError: (err: unknown) => void) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return (task, onError) => {
    chain = chain.then(task).catch(onError);
    return chain;
  };
}

const enqueueWrite = serialQueue();

/** Merge new captures for a tab; resolves with the stored item count (for the
 *  badge) so callers don't re-read the whole array right after writing it. */
export function addMedia(tabId: number, items: MediaItem[]): Promise<number> {
  let count = 0;
  return enqueueWrite(
    async () => {
      const key = keyFor(tabId);
      const stored = await readKey<MediaItem[]>(key, []);
      const [merged, changed] = mergeMedia(stored, items);
      if (changed && merged.length > maxItemsCache) merged.splice(0, merged.length - maxItemsCache);
      // Default the badge count to what is ALREADY stored: a failed set() is an
      // atomic no-op, so if both writes below throw the tab still holds `stored`
      // and the badge must not flip to 0 (which reads as "no captures"). count is
      // raised to merged.length only once a write actually lands.
      count = stored.length;
      if (changed) {
        try {
          await chrome.storage.session.set({ [key]: merged });
          count = merged.length;
        } catch {
          // The count cap can't see bytes: storage.session holds ~10MB across all
          // tabs and URL-heavy items can exceed it well under the cap. Evict the
          // oldest half and retry once so new captures keep landing instead of
          // failing silently forever; a second failure hits the queue's onError.
          merged.splice(0, Math.ceil(merged.length / 2));
          await chrome.storage.session.set({ [key]: merged });
          count = merged.length;
        }
      }
    },
    (err) => {
      console.error('[FaceScrap] storage write failed', err);
    },
  ).then(() => count);
}

export async function getMedia(tabId: number): Promise<MediaItem[]> {
  return readKey<MediaItem[]>(keyFor(tabId), []);
}

// --- "Now playing" pointer: which video is currently playing in the tab ---

export interface PlayingRef {
  /** Asset ids of the media centered in the viewport (what you're watching). */
  ids: string[];
  /** True when a <video> is centered — enables the network-recency fallback. */
  hasVideo: boolean;
  /** Video id parsed from the page URL (/reel/<id>, /watch?v=<id>) — an exact,
   *  prefetch-proof anchor: it matches the efg `vid:` key of every representation
   *  of the watched video and nothing else. Absent on feed/story surfaces. */
  vid?: string;
  /** fbcdn URLs of the cover image(s) centered right now. The panel displays one
   *  as the playing group's thumbnail when the capture carried none, and LEARNS
   *  the cover↔video binding so returning to an already-buffered video (which
   *  fetches nothing) still matches instantly. */
  coverUrls?: string[];
  /** Opaque slide marker: a combined story-card URL id + per-video-load id (see
   *  content.ts videoMark/storyCardMark). Never fetched; only COMPARED, so the
   *  panel can tell "the video under the centre changed" on surfaces that expose
   *  no cover/poster ids at all. */
  mark?: string;
  at: number;
}

const playingKey = (tabId: number): string => `playing_${tabId}`;

const enqueuePlaying = serialQueue();

export function setPlaying(tabId: number, ref: PlayingRef): Promise<void> {
  return enqueuePlaying(() => chrome.storage.session.set({ [playingKey(tabId)]: ref }), () => {});
}

export async function getPlaying(tabId: number): Promise<PlayingRef | null> {
  return readKey<PlayingRef | null>(playingKey(tabId), null);
}

// --- Recently requested fbcdn media tracks (the video being fetched now) ---

export interface RecentTrack {
  /** Widened URL of a fetched track; the side panel derives match keys
   *  (fbAssetKeys/mediaId/trackKey) from it, since a single id can't survive
   *  fbcdn's base64 filenames and rotating origin prefixes. */
  url: string;
  at: number;
}

export interface RecentRef {
  /** Last few fetched tracks, oldest→newest. A window (not one slot) because fbcdn
   *  prefetches neighbours; the streamed video re-appends (video/audio alternate) and dominates. */
  tracks: RecentTrack[];
}

const recentKey = (tabId: number): string => `recent_${tabId}`;
const RECENT_MAX = 8;
const enqueueRecent = serialQueue();

export function setRecent(tabId: number, url: string, at: number): Promise<void> {
  return enqueueRecent(async () => {
    const key = recentKey(tabId);
    const cur = ((await chrome.storage.session.get(key))[key] as RecentRef | undefined)?.tracks ?? [];
    cur.push({ url, at });
    if (cur.length > RECENT_MAX) cur.splice(0, cur.length - RECENT_MAX);
    await chrome.storage.session.set({ [key]: { tracks: cur } satisfies RecentRef });
  }, () => {});
}

export async function getRecent(tabId: number): Promise<RecentRef | null> {
  const key = recentKey(tabId);
  const raw = (await chrome.storage.session.get(key))[key] as RecentRef | undefined;
  return raw && Array.isArray(raw.tracks) ? raw : null;
}

// --- Learned now-playing bindings, persisted so a reopened panel re-matches ---
// The panel learns cover→group, group→cover and mark→group while it runs; those
// live in panel-local memory wiped on panel close. Persist per tab so reopening on
// an already-buffered video re-matches WITHOUT new fbcdn traffic. Written only by
// the panel (a trusted context); the SW never touches this key. lastLive is
// intentionally NOT persisted — restoring it resurrects a stale/neighbour video on
// reopen (the reopen should re-derive from live evidence + these bindings instead).

export interface BindState {
  coverBind: [string, string][];
  groupCover: [string, string][];
  markBind: [string, string][];
}

const bindKey = (tabId: number): string => `bind_${tabId}`;
const enqueueBind = serialQueue();

export function setBind(tabId: number, state: BindState): Promise<void> {
  return enqueueBind(async () => {
    await chrome.storage.session.set({ [bindKey(tabId)]: state });
  }, () => {});
}

export async function getBind(tabId: number): Promise<BindState | null> {
  const key = bindKey(tabId);
  const raw = (await chrome.storage.session.get(key))[key] as BindState | undefined;
  if (!raw || !Array.isArray(raw.coverBind) || !Array.isArray(raw.groupCover) || !Array.isArray(raw.markBind)) {
    return null;
  }
  return raw;
}

// --- Ids already downloaded from this tab (the panel's "Saved" filter) ---
// Ids only, never items: the media list already holds those, and this must stay
// cheap enough to keep for a whole session. Persisted (not panel-local) so the
// filter still tells the truth after the panel is closed and reopened.

const savedKey = (tabId: number): string => `saved_${tabId}`;
// Insertion-ordered, so the cap below evicts the oldest saves first.
const SAVED_MAX = 2000;
const enqueueSaved = serialQueue();

/** Mark ids as downloaded. Idempotent: re-saving an id keeps its first position. */
export function addSaved(tabId: number, ids: string[]): Promise<void> {
  return enqueueSaved(
    async () => {
      const key = savedKey(tabId);
      const cur = await readKey<string[]>(key, []);
      const next = [...new Set([...cur, ...ids])];
      if (next.length > SAVED_MAX) next.splice(0, next.length - SAVED_MAX);
      await chrome.storage.session.set({ [key]: next });
    },
    (err) => console.error('[FaceScrap] saved write failed', err),
  );
}

export async function getSaved(tabId: number): Promise<string[]> {
  const raw = await readKey<unknown>(savedKey(tabId), []);
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/** Remove the per-tab CAPTURE state (media list + now-playing + recent + bindings).
 *  Each key's removal is serialized through the SAME chain that writes it: an
 *  in-flight read-merge-write that started before the wipe must not land after
 *  it (resurrecting cleared items), nor may a late clear erase captures from
 *  the page just navigated to.
 *
 *  saved_ is deliberately NOT touched: it is the tab's download history, which
 *  outlives both a page navigation and the "Clear captured list" button (whose
 *  UI promises "Saved stays"). It is bounded by SAVED_MAX and, being in
 *  storage.session, cleared when the browser session ends. */
export function clearTab(tabId: number): Promise<void> {
  const fail = (err: unknown): void => console.error('[FaceScrap] storage clear failed', err);
  return Promise.all([
    enqueueWrite(() => chrome.storage.session.remove(keyFor(tabId)), fail),
    enqueuePlaying(() => chrome.storage.session.remove(playingKey(tabId)), fail),
    enqueueRecent(() => chrome.storage.session.remove(recentKey(tabId)), fail),
    enqueueBind(() => chrome.storage.session.remove(bindKey(tabId)), fail),
  ]).then(() => undefined);
}

// --- Runtime capability flags (published by the SW, read by the panel/popup) ---

export interface Caps {
  sidePanel: boolean;
  offscreen: boolean;
}

const CAPS_KEY = 'caps';

export async function setCaps(caps: Caps): Promise<void> {
  await chrome.storage.session.set({ [CAPS_KEY]: caps });
}

export async function getCaps(): Promise<Caps | null> {
  return readKey<Caps | null>(CAPS_KEY, null);
}

