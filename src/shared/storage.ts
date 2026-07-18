// Per-tab captured-media storage, backed by chrome.storage.session.
// Only trusted contexts (service worker, side panel) touch this — content scripts
// relay via messages instead. Writes are serialized per key family (one promise
// chain each) so bursty fbcdn read-modify-write cycles can't lose updates, while
// unrelated keys never wait on each other.

import {
  isFbcdn,
  MEDIA_KINDS,
  MEDIA_SOURCES,
  mergeMedia,
  type MediaItem,
  type MediaKind,
  type MediaSource,
} from './media';
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
// Sized with now-playing's TRACK_MATCH_WINDOW_MS in mind: the stories tray
// prefetches several upcoming cards at open (video+audio track per card), and
// at 8 slots a card's tracks were evicted long before the user reached it —
// leaving the relay nothing to match. The panel derives keys lazily per
// selectPlaying call, so the wider window costs a slightly longer scan, not
// storage churn.
const RECENT_MAX = 24;
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

// --- Download receipts for this tab (the panel's "Saved" history) ---
// One SavedEntry per completed download: enough to RENDER a Saved card after
// media_<tabId> is wiped (Clear, navigation, eviction), never enough to
// re-download — media URLs carry rotating fbcdn signatures, so a stored one
// would be a download button that lies. The receipt's `id` is the panel card id
// (`v:${groupKey}` / `i:${itemId}`): content-derived, so when the user replays
// the content the rebuilt live card carries the same id and the receipt
// re-links to it automatically. That id format is a persisted contract now —
// change it only with a migration.
// Per-tab keys, not one global ledger: a serialQueue orders writes only within
// its own JS context, so a shared key written from two panel windows would race
// read-modify-write cycles.

export interface SavedEntry {
  id: string;
  kind: MediaKind;
  source: MediaSource;
  /** Download time — the Saved view's sort key. Frozen on the first save. */
  savedAt: number;
  /** fbcdn poster/self URL. Its signature expires; the card's <img> error path
   *  degrades it to the kind icon. Shed first under quota pressure. */
  thumbUrl?: string;
  resLabel?: string;
  durationSec?: number;
}

const savedKey = (tabId: number): string => `saved_${tabId}`;
// Insertion-ordered, so the cap below evicts the oldest receipts first.
const SAVED_MAX = 2000;
// Soft byte budget for one tab's serialized ledger (Chrome bills key length +
// JSON length against the ~10MB shared area). Past it, thumbnails are shed
// oldest-first: the history row is the promise, the thumb is decoration whose
// signature has usually expired by then anyway.
const SAVED_BYTE_BUDGET = 262_144;
const SAVED_THUMB_MAX = 1024; // fbcdn image URLs run 300–500 chars; drop outliers
const SAVED_LABEL_MAX = 16;
const enqueueSaved = serialQueue();

function isSavedEntry(x: unknown): x is SavedEntry {
  if (x == null || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    typeof e.kind === 'string' &&
    MEDIA_KINDS.has(e.kind) &&
    typeof e.source === 'string' &&
    MEDIA_SOURCES.has(e.source) &&
    typeof e.savedAt === 'number' &&
    Number.isFinite(e.savedAt)
  );
}

/** Clamp one receipt to its stored bounds — applied to every entry that enters
 *  the ledger, whether new or refreshing an existing row. */
function sanitizeEntry(e: SavedEntry): SavedEntry {
  const out: SavedEntry = {
    // The card-id contract: a 2-char 'v:'/'i:' prefix over media.ts's 256-char
    // item-id bound. Slicing at 256 truncated a max-length id, and a truncated
    // receipt can never re-link to its live card.
    id: e.id.slice(0, 258),
    kind: e.kind,
    source: e.source,
    savedAt: e.savedAt,
  };
  // Optional fields are NOT validated by isSavedEntry, and this runs on every
  // persisted row (readSaved), so each check must also carry the type test — a
  // malformed field from a corrupt or foreign write must degrade to absent,
  // never throw and take the whole ledger read down with it.
  if (typeof e.thumbUrl === 'string' && e.thumbUrl.length <= SAVED_THUMB_MAX && isFbcdn(e.thumbUrl)) {
    out.thumbUrl = e.thumbUrl;
  }
  if (typeof e.resLabel === 'string') out.resLabel = e.resLabel.slice(0, SAVED_LABEL_MAX);
  if (typeof e.durationSec === 'number' && Number.isFinite(e.durationSec)) out.durationSec = e.durationSec;
  return out;
}

async function readSaved(key: string): Promise<SavedEntry[]> {
  const raw = await readKey<unknown>(key, []);
  return Array.isArray(raw) ? raw.filter(isSavedEntry).map(sanitizeEntry) : [];
}

/** Enforce the byte budget by stripping thumbnails oldest-first — never rows.
 *  The serialized length is computed once and decremented by an estimate of each
 *  shed thumb's JSON footprint (field, quotes, separator) instead of
 *  re-stringifying per iteration; the budget is soft, the estimate is enough. */
function shedThumbs(key: string, entries: SavedEntry[]): void {
  let bytes = key.length + JSON.stringify(entries).length;
  for (const e of entries) {
    if (bytes <= SAVED_BYTE_BUDGET) return;
    if (e.thumbUrl == null) continue;
    bytes -= `"thumbUrl":${JSON.stringify(e.thumbUrl)},`.length;
    delete e.thumbUrl;
  }
}

/** Record one download receipt (each save persists as it lands — see runBulk).
 *  Idempotent: re-saving an id keeps its first position and original savedAt,
 *  refreshing only the display fields (a re-download carries a newer-signed
 *  thumb that will live longer). */
export function addSaved(tabId: number, entry: SavedEntry): Promise<void> {
  return enqueueSaved(
    async () => {
      const key = savedKey(tabId);
      const cur = await readSaved(key);
      const e = sanitizeEntry(entry);
      const kept = cur.find((x) => x.id === e.id);
      if (kept) Object.assign(kept, e, { savedAt: kept.savedAt });
      else cur.push(e);
      if (cur.length > SAVED_MAX) cur.splice(0, cur.length - SAVED_MAX);
      shedThumbs(key, cur);
      try {
        await chrome.storage.session.set({ [key]: cur });
      } catch {
        // The byte budget is an estimate against a SHARED quota another tab may
        // have filled: as a last resort drop the oldest half of the history and
        // retry once (the same pattern addMedia uses); a second failure hits the
        // queue's onError. Never the receipt being written: on a short ledger
        // the "oldest half" IS the new entry (or the row it refreshed), and
        // dropping it would resolve as success while losing the row. Re-append
        // the MERGED row (kept) when one existed — it carries the original
        // savedAt this function's contract preserves; e still holds the
        // caller's fresh timestamp.
        cur.splice(0, Math.ceil(cur.length / 2));
        if (!cur.some((x) => x.id === e.id)) cur.push(kept ?? e);
        await chrome.storage.session.set({ [key]: cur });
      }
    },
    (err) => console.error('[FaceScrap] saved write failed', err),
  );
}

export async function getSaved(tabId: number): Promise<SavedEntry[]> {
  return readSaved(savedKey(tabId));
}

/** Remove the per-tab CAPTURE state (media list + now-playing + recent + bindings).
 *  Each key's removal is serialized through the SAME chain that writes it: an
 *  in-flight read-merge-write that started before the wipe must not land after
 *  it (resurrecting cleared items), nor may a late clear erase captures from
 *  the page just navigated to.
 *
 *  saved_ is deliberately NOT touched: it is the tab's download history, which
 *  outlives both a page navigation and the "Clear captured list" button (whose
 *  UI promises "Saved stays"). It is byte-budgeted and, being in
 *  storage.session, cleared when the browser session ends. A CLOSED tab is the
 *  one lifecycle where the history must go too — that path is purgeTab. */
export function clearTab(tabId: number): Promise<void> {
  const fail = (err: unknown): void => console.error('[FaceScrap] storage clear failed', err);
  return Promise.all([
    enqueueWrite(() => chrome.storage.session.remove(keyFor(tabId)), fail),
    enqueuePlaying(() => chrome.storage.session.remove(playingKey(tabId)), fail),
    enqueueRecent(() => chrome.storage.session.remove(recentKey(tabId)), fail),
    enqueueBind(() => chrome.storage.session.remove(bindKey(tabId)), fail),
  ]).then(() => undefined);
}

/** Remove one tab's saved_ key on THIS context's write chain. A serialQueue
 *  orders tasks only within its own JS context, and every addSaved runs in the
 *  panel — so the worker's purgeTab removal below cannot be ordered against a
 *  panel receipt write that was already enqueued when the tab closed; it would
 *  land after the removal and resurrect the key as an orphan. Each context
 *  that writes receipts calls this from its own tabs.onRemoved instead, so its
 *  in-flight writes land first and its removal wins. */
export function dropSaved(tabId: number): Promise<void> {
  return enqueueSaved(
    () => chrome.storage.session.remove(savedKey(tabId)),
    (err) => console.error('[FaceScrap] storage clear failed', err),
  );
}

/** Full teardown for a CLOSED tab: the capture state AND the download history.
 *  Chrome does not reuse tab ids within a session, so a dead tab can never
 *  render its Saved view again — leaving saved_ would orphan the key in
 *  storage.session until the browser exits. This removal rides the WORKER's
 *  enqueueSaved chain, which orders it against nothing the panel has enqueued
 *  (see dropSaved — the panel mirrors the removal on its own chain for that);
 *  here it covers the no-panel case, and the panel's dead-tab check before
 *  every addSaved stops writes enqueued after the close. */
export function purgeTab(tabId: number): Promise<void> {
  return Promise.all([clearTab(tabId), dropSaved(tabId)]).then(() => undefined);
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

