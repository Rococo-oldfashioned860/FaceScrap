// Per-tab captured-media storage, backed by chrome.storage.session.
// Only trusted contexts (service worker, side panel) touch this — content scripts
// relay via messages instead. Writes are serialized per key family (one promise
// chain each) so bursty fbcdn read-modify-write cycles can't lose updates, while
// unrelated keys never wait on each other.

import { diagBump, sanitizeDiagCounters, setDiagEnabled, type DiagCounters, type DiagReason } from './diag';
import {
  fbAssetKeys,
  isFbcdn,
  mediaId,
  MAX_MEDIA_URL_LEN,
  MEDIA_KINDS,
  MEDIA_SOURCES,
  mergeMedia,
  videoGroupKey,
  type MediaItem,
  type MediaKind,
  type MediaSource,
} from './media';
import { playingTimestampIsFutureEpoch } from './messages';
import { durableStoryMarkPortion, isProvisionalStoryMark, storyDomIdFromMark } from './story-mark';
import { DEFAULT_SETTINGS, loadSettings } from './settings';

const keyFor = (tabId: number): string => `media_${tabId}`;

// Per-tab retention cap (Settings.maxItems). One reels-feed GraphQL burst can carry
// ~1200 reels (several DASH items each), so the cap must exceed a burst or oldest-first
// eviction drops the watched reel. Cached so addMedia doesn't read storage on every
// capture; refreshed when the setting changes. 0/unset → Infinity (unlimited).
let maxItemsCache: number = DEFAULT_SETTINGS.maxItems;
// Rides the same settings read: this context's diag flag has to come from
// somewhere, and every context that imports storage.ts is one that can discard.
function refreshFromSettings(): void {
  loadSettings()
    .then((s) => {
      maxItemsCache = s.maxItems > 0 ? s.maxItems : Infinity;
      setDiagEnabled(s.diagEnabled);
    })
    .catch(() => {});
}
refreshFromSettings();
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'settings' in changes) refreshFromSettings();
  });
} catch {
  /* storage.onChanged unavailable — the cap stays at its default */
}

const readKey = async <T>(key: string, fallback: T): Promise<T> =>
  ((await chrome.storage.session.get(key))[key] as T | undefined) ?? fallback;

// storage.session has one quota shared by every Facebook tab. Reserve enough
// bytes up front for the control plane (playing/recent/pin), so a large Library
// burst cannot leave the panel with media rows but no current pointer. Data
// writes always carry the full reserve; a quota recovery replaces it with an
// empty value in the same set as the critical state, then restores headroom
// before the recovery lane is released.
const CONTROL_HEADROOM_KEY = 'capture_control_headroom_v1';
const CONTROL_HEADROOM_BYTES = 512 * 1024;
const CONTROL_HEADROOM_MIN_BYTES = 128 * 1024;
const CONTROL_HEADROOM = '0'.repeat(CONTROL_HEADROOM_BYTES);
const CONTROL_HEADROOM_MIN = '0'.repeat(CONTROL_HEADROOM_MIN_BYTES);

function dataValues(values: Record<string, unknown>): Record<string, unknown> {
  return { [CONTROL_HEADROOM_KEY]: CONTROL_HEADROOM, ...values };
}

let headroomChain: Promise<void> = Promise.resolve();
function withHeadroomLock<T>(task: () => Promise<T>): Promise<T> {
  const run = headroomChain.then(task);
  headroomChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function restoreControlHeadroom(): Promise<void> {
  try {
    await chrome.storage.session.set({ [CONTROL_HEADROOM_KEY]: CONTROL_HEADROOM });
    return;
  } catch {
    // A compact recent payload can use part of the emergency reserve. Keep a
    // smaller second-use reserve rather than reporting the already-durable
    // control write as failed.
  }
  try {
    await chrome.storage.session.set({ [CONTROL_HEADROOM_KEY]: CONTROL_HEADROOM_MIN });
  } catch {
    // Best effort only. Every later data-plane write attempts to restore the
    // full reserve atomically, and the next control failure remains retryable.
  }
}

/** Establish shared control-plane headroom before capture listeners process
 *  their first event. Idempotent across MV3 worker restarts because session
 *  storage outlives the worker. */
export function ensureCaptureHeadroom(): Promise<boolean> {
  return withHeadroomLock(async () => {
    let current: unknown = '';
    try {
      current = await readKey<unknown>(CONTROL_HEADROOM_KEY, '');
    } catch (err) {
      // A one-shot session.get failure must not poison the worker-wide readiness
      // promise forever. Continue with the idempotent set path; if storage is
      // genuinely unavailable those writes still fail and return false.
      console.warn('[FaceScrap] control headroom read failed; re-establishing reserve', err);
    }
    if (typeof current === 'string' && current.length >= CONTROL_HEADROOM_MIN_BYTES) return true;
    try {
      await chrome.storage.session.set({ [CONTROL_HEADROOM_KEY]: CONTROL_HEADROOM });
      return true;
    } catch {
      try {
        await chrome.storage.session.set({ [CONTROL_HEADROOM_KEY]: CONTROL_HEADROOM_MIN });
        return true;
      } catch (err) {
        console.error('[FaceScrap] control headroom initialization failed', err);
        return false;
      }
    }
  });
}

// A short request burst can be much wider than the steady recent-track ring:
// the Story viewer preloads several cards while the 300 ms DOM detector is
// still settling. Keep that burst briefly, then collapse back to the steady
// budget while reserving the two groups closest to the current slide boundary.
// This is retention only; selectPlaying still decides whether the evidence is
// trustworthy enough to display or learn from.
const RECENT_STEADY_MAX = 24;
const RECENT_BURST_MAX = 96;
const RECENT_BURST_MS = 4_000;
const RECENT_BOUNDARY_MS = 12_000;
const RECENT_PER_BOUNDARY_GROUP_MAX = 8;

function recentGroupKey(track: RecentTrack): string {
  return fbAssetKeys(track.url)[0] ?? mediaId(track.url);
}

function boundaryRecentGroups(recent: RecentRef | null, ref: PlayingRef | null, limit = 2): Map<string, number> {
  if (ref?.hasVideo !== true || recent == null) return new Map();
  const distanceByGroup = new Map<string, number>();
  for (const track of recent.tracks) {
    const distance = Math.abs(track.at - ref.at);
    if (distance > RECENT_BOUNDARY_MS) continue;
    const group = recentGroupKey(track);
    distanceByGroup.set(group, Math.min(distance, distanceByGroup.get(group) ?? Infinity));
  }
  return new Map([...distanceByGroup].sort((a, b) => a[1] - b[1]).slice(0, limit));
}

function retainRecentTracks(tracks: RecentTrack[], at: number, ref: PlayingRef | null): RecentTrack[] {
  if (tracks.length <= RECENT_STEADY_MAX) return tracks;
  const boundary = boundaryRecentGroups({ tracks }, ref);
  const chosen = new Set<number>();

  // Reserve a bounded number of observations for each boundary-near group.
  for (const group of boundary.keys()) {
    const indices: number[] = [];
    tracks.forEach((track, index) => {
      if (recentGroupKey(track) === group) indices.push(index);
    });
    for (const index of indices.slice(-RECENT_PER_BOUNDARY_GROUP_MAX)) chosen.add(index);
  }

  // Keep the entire short transition burst (up to the hard cap). This is what
  // prevents request 1 from disappearing merely because requests 2..25 landed
  // before PlayingRef and the panel could correlate them.
  for (let index = tracks.length - 1; index >= 0 && chosen.size < RECENT_BURST_MAX; index--) {
    if (at - tracks[index].at <= RECENT_BURST_MS) chosen.add(index);
  }

  // Once the burst cools, retain the ordinary newest tail as a backstop.
  for (let index = tracks.length - 1; index >= 0 && chosen.size < RECENT_STEADY_MAX; index--) {
    chosen.add(index);
  }

  return tracks.filter((_track, index) => chosen.has(index));
}

/** Identity of the media surface the user is actually viewing. A DOM-proven
 *  Story card or exact reel id outranks per-load MSE markers; those markers are
 *  only needed on surfaces that expose no durable media identity. */
export function playingIdentity(ref: PlayingRef | null | undefined): string {
  if (ref == null) return '';
  const story = durableStoryMarkPortion(ref.mark);
  if (story != null) return `story:${story}`;
  if (ref.vid != null) return `video:${ref.vid}`;
  return `${ref.hasVideo ? 'video' : 'media'}|${[...ref.ids].sort().join(',')}|${ref.mark ?? ''}`;
}

/** Identity strong enough to reserve Library rows. A provisional Story path is
 *  tray-wide and must never pin data; direct ids/reel ids are already protected
 *  by isExactPlayingItem, so only a DOM-proven Story needs this extra ledger. */
export function playingRetentionIdentity(ref: PlayingRef | null | undefined): string | undefined {
  const story = durableStoryMarkPortion(ref?.mark);
  return ref?.hasVideo === true && story != null ? `story:${story}` : undefined;
}

const PLAYING_PIN_GROUP_MAX = 8;
const playingPinKey = (tabId: number): string => `playing_pin_${tabId}`;

interface PlayingMediaPin {
  identity: string;
  groups: string[];
  playingAt: number;
}

function sanitizePlayingMediaPin(value: unknown): PlayingMediaPin | null {
  if (value == null || typeof value !== 'object') return null;
  const pin = value as Partial<PlayingMediaPin>;
  if (typeof pin.identity !== 'string' || pin.identity.length === 0 || pin.identity.length > 8192) return null;
  if (!Array.isArray(pin.groups)) return null;
  if (typeof pin.playingAt !== 'number' || !Number.isFinite(pin.playingAt) || pin.playingAt < 0) return null;
  const groups = [...new Set(pin.groups.filter((group): group is string => typeof group === 'string' && group.length <= 512))]
    .slice(0, PLAYING_PIN_GROUP_MAX);
  return groups.length > 0 ? { identity: pin.identity, groups, playingAt: pin.playingAt } : null;
}

async function getPlayingMediaPin(tabId: number): Promise<PlayingMediaPin | null> {
  return sanitizePlayingMediaPin(await readKey<unknown>(playingPinKey(tabId), null));
}

function isExactPlayingItem(item: MediaItem, ref: PlayingRef | null): boolean {
  if (ref == null) return false;
  const active = new Set(ref.ids);
  if (active.has(item.id)) return true;
  if (item.thumbUrl != null && active.has(mediaId(item.thumbUrl))) return true;
  const storyId = storyDomIdFromMark(ref.mark);
  if (storyId != null && item.kind === 'video' && item.storyIds?.includes(storyId) === true) return true;
  if (ref.vid == null || item.kind !== 'video') return false;
  const wanted = `vid:${ref.vid}`;
  return fbAssetKeys(item.url).includes(wanted) ||
    (item.audioUrl != null && fbAssetKeys(item.audioUrl).includes(wanted));
}

/** Move exact/current-boundary media to the retained end of the FIFO. This
 *  never marks them live; it only ensures selectPlaying still has an item to
 *  return after the storage cap or quota fallback sheds unrelated captures. */
interface RetentionOverrides {
  ref?: PlayingRef | null;
  recent?: RecentRef | null;
  pin?: PlayingMediaPin | null;
}

interface RetentionPartition {
  ordinary: MediaItem[];
  reserved: MediaItem[];
}

async function partitionMediaForRetention(
  tabId: number,
  items: MediaItem[],
  overrides: RetentionOverrides = {},
): Promise<RetentionPartition> {
  const [storedRef, storedRecent, storedPin] = await Promise.all([
    getPlaying(tabId),
    getRecent(tabId),
    getPlayingMediaPin(tabId),
  ]);
  const ref = overrides.ref === undefined ? storedRef : overrides.ref;
  const recent = overrides.recent === undefined ? storedRecent : overrides.recent;
  const pin = overrides.pin === undefined ? storedPin : overrides.pin;
  const boundary = boundaryRecentGroups(recent, ref);
  const retentionIdentity = playingRetentionIdentity(ref);
  const pinnedGroups = pin != null && pin.identity === retentionIdentity ? new Set(pin.groups) : new Set<string>();
  const ordinary: MediaItem[] = [];
  const protectedItems: { item: MediaItem; priority: number }[] = [];
  for (const item of items) {
    const group = item.kind === 'video' ? videoGroupKey(item) : undefined;
    const distance = group == null ? undefined : boundary.get(group);
    const priority = isExactPlayingItem(item, ref)
      ? 3_000_000
      : group != null && pinnedGroups.has(group)
        ? 2_000_000
      : distance == null
        ? 0
        : 1_000_000 - distance;
    if (priority > 0) protectedItems.push({ item, priority });
    else ordinary.push(item);
  }
  protectedItems.sort((a, b) => a.priority - b.priority);
  return { ordinary, reserved: protectedItems.map(({ item }) => item) };
}

async function prioritizeMediaForRetention(
  tabId: number,
  items: MediaItem[],
  overrides: RetentionOverrides = {},
): Promise<MediaItem[]> {
  const { ordinary, reserved } = await partitionMediaForRetention(tabId, items, overrides);
  return [...ordinary, ...reserved];
}

// One task queue per key family: read-modify-write cycles on a key must run one
// at a time, but unrelated keys must never wait on each other's writes.
function serialQueue(): (task: () => Promise<void>, onError: (err: unknown) => void) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return (task, onError) => {
    chain = chain.then(task).catch(onError);
    return chain;
  };
}

/** One ordered capture-state lane per tab. Media retention reads playing/recent,
 *  so those three keys cannot use independent queues without observing an older
 *  snapshot during a burst. Different tabs still proceed independently. */
function keyedSerialQueue(): (
  key: number,
  task: () => Promise<void>,
  onError: (err: unknown) => void,
) => Promise<void> {
  const chains = new Map<number, Promise<void>>();
  return (key, task, onError) => {
    const run = (chains.get(key) ?? Promise.resolve()).then(task);
    const settled = run.catch(onError);
    chains.set(key, settled);
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return settled;
  };
}

// chrome.storage.session shares a ~10MB budget across all tabs. A small
// single-key write (playing/recent/bind) can't shed bytes of its own to
// recover — but swallowing its failure silently hides that now-playing or the
// track fallback stopped updating. Log it so a persistent quota problem is at
// least visible in the service worker console, like addMedia's failure is.
const logWriteError =
  (label: string) =>
  (err: unknown): void => {
    console.error(`[FaceScrap] ${label} write failed`, err);
  };

const enqueueCaptureState = keyedSerialQueue();

// storage.session's quota is shared by every Facebook tab. Per-tab capture
// queues prevent lost updates within one key, but they cannot make a global
// quota snapshot/reclaim safe: tab B could otherwise prune a stale snapshot of
// tab A while tab A is writing. Serialize every media read-merge-write and tab
// media removal through one additional lane. Playing/recent/pin remain on their
// per-tab lane and are re-read when retention is classified.
let mediaGlobalChain: Promise<void> = Promise.resolve();
function withMediaGlobalLock<T>(task: () => Promise<T>): Promise<T> {
  const run = mediaGlobalChain.then(task);
  mediaGlobalChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// A global quota reclaim classifies foreign tabs from playing/recent/pin and
// then deletes ordinary media. Those control pointers must not advance between
// classification and the atomic media write, or a just-activated row in tab A
// could still look ordinary to tab B's older snapshot. Normal media writes do
// not need this barrier; only quota reclaim and retention-control mutations do.
let retentionSnapshotChain: Promise<void> = Promise.resolve();
function withRetentionSnapshotLock<T>(task: () => Promise<T>): Promise<T> {
  const run = retentionSnapshotChain.then(task);
  retentionSnapshotChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Persist only the bounded group ids that selectPlaying has already confirmed.
 *  Retention consults this pin, but selection never does: a stale or corrupt pin
 *  can keep a few Library rows, never make them appear as currently playing. */
export function setPlayingMediaPin(
  tabId: number,
  identity: string,
  groups: Iterable<string>,
  playingAt: number,
  receivedAt?: number,
): Promise<boolean> {
  if (
    receivedAt !== undefined &&
    (!Number.isFinite(receivedAt) || playingTimestampIsFutureEpoch(playingAt, receivedAt))
  ) {
    return Promise.resolve(false);
  }
  const pin = sanitizePlayingMediaPin({ identity, groups: [...groups], playingAt });
  if (pin == null) return Promise.resolve(false);
  let completed = false;
  return enqueueCaptureState(
    tabId,
    async () => {
      if (receivedAt !== undefined && playingTimestampIsFutureEpoch(pin.playingAt, Date.now())) return;
      await withRetentionSnapshotLock(async () => {
        // selectPlaying may finish after the user has already advanced. Refuse to
        // attach its confirmed group to a different Story identity. This is a
        // completed stale request, not a storage failure worth retrying.
        if (playingRetentionIdentity(await getPlaying(tabId)) !== pin.identity) {
          completed = true;
          return;
        }
        const current = await getPlayingMediaPin(tabId);
        if (current != null && current.playingAt > pin.playingAt) {
          completed = true;
          return;
        }
        if (
          current?.identity === pin.identity &&
          current.playingAt === pin.playingAt &&
          current.groups.length === pin.groups.length &&
          current.groups.every((group, index) => group === pin.groups[index])
        ) {
          completed = true;
          return;
        }
        await writeCaptureState(tabId, { [playingPinKey(tabId)]: pin }, { pin, retryTransient: false });
        completed = true;
      });
    },
    logWriteError('playing pin'),
  ).then(() => completed);
}

function isStorageQuotaError(err: unknown): boolean {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return /quota|QUOTA_BYTES|MAX_(?:WRITE|SUSTAINED_WRITE|ITEMS)/i.test(detail);
}

interface CaptureWriteOptions extends RetentionOverrides {
  /** Pin writes are retried by the panel render loop; keeping their first
   *  non-quota failure observable avoids reporting an unconfirmed reservation. */
  retryTransient?: boolean;
  /** Smaller equivalent state to try before spending reserved headroom.
   *  Recent-track history can compact safely; PlayingRef and the pin cannot. */
  compactValues?: Record<string, unknown>;
}

/** Persist capture control state with a real success/failure contract. One
 *  ordinary backend hiccup gets an identical retry. Quota pressure first uses
 *  a smaller equivalent payload (when available), then spends the dedicated
 *  headroom. It never deletes Library rows to persist a pointer: before the
 *  panel has correlated a new Story, no row can be proven safe to sacrifice. */
async function writeCaptureState(
  _tabId: number,
  values: Record<string, unknown>,
  options: CaptureWriteOptions = {},
): Promise<void> {
  let failure: unknown;
  try {
    await chrome.storage.session.set(values);
    return;
  } catch (err) {
    failure = err;
  }

  if (!isStorageQuotaError(failure) && options.retryTransient !== false) {
    try {
      await chrome.storage.session.set(values);
      return;
    } catch (err) {
      failure = err;
    }
  }

  if (!isStorageQuotaError(failure)) throw failure;
  if (options.compactValues != null) {
    try {
      await chrome.storage.session.set(options.compactValues);
      return;
    } catch (err) {
      failure = err;
      if (!isStorageQuotaError(failure)) throw failure;
    }
  }
  const criticalValues = options.compactValues ?? values;
  try {
    await withHeadroomLock(async () => {
      // One observable storage operation both releases the reserved bytes and
      // writes the critical state. Other tab lanes cannot interleave their own
      // headroom recovery, and data-plane writes carry a full reserve themselves.
      await chrome.storage.session.set({ [CONTROL_HEADROOM_KEY]: '', ...criticalValues });
      await restoreControlHeadroom();
    });
    return;
  } catch (err) {
    failure = err;
  }
  throw failure;
}

interface GlobalMediaRow {
  key: string;
  tabId: number;
  item: MediaItem;
}

/** Recover shared session quota without crossing the retention boundary of any
 *  tab. The first failed set was atomic, so this starts from a fresh area-wide
 *  snapshot, replaces the current tab with its pending merge, and progressively
 *  removes globally-oldest ordinary rows. Every retry includes the pending
 *  current array, every changed foreign array, and the full control reserve in
 *  one storage.set. A failure therefore leaves the prior store untouched. */
async function reclaimGlobalMediaQuota(
  currentTabId: number,
  currentItems: MediaItem[],
  incomingIds: ReadonlySet<string>,
): Promise<{ count: number; evicted: number }> {
  const snapshot = await chrome.storage.session.get(null);
  const itemsByKey = new Map<string, MediaItem[]>();
  const tabByKey = new Map<string, number>();
  const currentKey = keyFor(currentTabId);

  for (const [key, value] of Object.entries(snapshot)) {
    const match = /^media_(\d+)$/.exec(key);
    if (match == null || !Array.isArray(value)) continue;
    const tabId = Number(match[1]);
    if (!Number.isSafeInteger(tabId)) continue;
    itemsByKey.set(key, value as MediaItem[]);
    tabByKey.set(key, tabId);
  }
  itemsByKey.set(currentKey, currentItems);
  tabByKey.set(currentKey, currentTabId);

  const candidates: GlobalMediaRow[] = [];
  for (const [key, tabItems] of itemsByKey) {
    const tabId = tabByKey.get(key);
    if (tabId == null || tabItems.length <= 1) continue;
    const { ordinary } = await partitionMediaForRetention(tabId, tabItems);
    const ordinaryItems = new Set(ordinary);
    const removable = tabItems.filter((item) =>
      ordinaryItems.has(item) && !(tabId === currentTabId && incomingIds.has(item.id)),
    );
    // Precompute only rows that can truly be removed. If there is no reserved
    // or incoming row to keep this tab represented, exclude its newest ordinary
    // row from the candidate list. This also guarantees the final candidate is
    // a real final retry point instead of a runtime-skipped "leave one" row.
    const alreadyKept = tabItems.length - removable.length;
    removable.sort((a, b) => {
      const aAt = Number.isFinite(a.addedAt) ? a.addedAt : 0;
      const bAt = Number.isFinite(b.addedAt) ? b.addedAt : 0;
      return aAt - bAt;
    });
    const removableCount = alreadyKept > 0 ? removable.length : Math.max(0, removable.length - 1);
    for (const item of removable.slice(0, removableCount)) candidates.push({ key, tabId, item });
  }
  candidates.sort((a, b) => {
    const aAt = Number.isFinite(a.item.addedAt) ? a.item.addedAt : 0;
    const bAt = Number.isFinite(b.item.addedAt) ? b.item.addedAt : 0;
    return aAt - bAt;
  });

  const working = new Map<string, MediaItem[]>();
  for (const [key, tabItems] of itemsByKey) working.set(key, [...tabItems]);
  const changedKeys = new Set<string>([currentKey]);
  let evicted = 0;
  let nextAttemptAt = 1;

  // A quota-shaped error can be a one-shot backend race (for example another
  // context just released bytes). Retry the intact pending merge once from the
  // fresh global snapshot before deleting anything. Persistent quota proceeds
  // to the safe candidates below; no-candidate quota still rejects unchanged.
  try {
    await chrome.storage.session.set(dataValues({ [currentKey]: currentItems }));
    return { count: currentItems.length, evicted: 0 };
  } catch (err) {
    if (!isStorageQuotaError(err)) throw err;
  }

  for (const candidate of candidates) {
    const tabItems = working.get(candidate.key);
    if (tabItems == null || tabItems.length <= 1) continue;
    const index = tabItems.indexOf(candidate.item);
    if (index < 0) continue;
    tabItems.splice(index, 1);
    changedKeys.add(candidate.key);
    evicted++;

    // Try after 1, 2, 4, ... cumulative removals, and always after the last
    // safe candidate. This bounds write amplification while still finding the
    // smallest practical reclaim instead of immediately deleting half a tab.
    const isLast = candidate === candidates[candidates.length - 1];
    if (evicted < nextAttemptAt && !isLast) continue;
    const values: Record<string, unknown> = {};
    for (const key of changedKeys) values[key] = working.get(key) ?? [];
    try {
      await chrome.storage.session.set(dataValues(values));
      return { count: working.get(currentKey)?.length ?? 0, evicted };
    } catch (err) {
      if (!isStorageQuotaError(err)) throw err;
      nextAttemptAt *= 2;
    }
  }

  // No safe candidate existed, or even removing all ordinary candidates was
  // insufficient. All attempted writes were atomic failures, so rejecting here
  // preserves every previously stored row and never touches Saved history.
  throw quotaErrorForGlobalReclaim();
}

function quotaErrorForGlobalReclaim(): Error {
  const error = new Error('storage.session quota exhausted with no safe media rows to reclaim');
  error.name = 'QuotaExceededError';
  return error;
}

/** Merge new captures for a tab; resolves with the stored item count (for the
 *  badge) so callers don't re-read the whole array right after writing it. */
export function addMedia(tabId: number, items: MediaItem[]): Promise<number> {
  let count = 0;
  let failure: unknown;
  return enqueueCaptureState(
    tabId,
    async () => {
      await withMediaGlobalLock(async () => {
        const key = keyFor(tabId);
        const stored = await readKey<MediaItem[]>(key, []);
        const [merged, changed] = mergeMedia(stored, items);
        if (changed && merged.length > maxItemsCache) {
          const { ordinary, reserved } = await partitionMediaForRetention(tabId, merged);
          merged.splice(0, merged.length, ...ordinary, ...reserved);
          // Oldest-first, and insertion order is not viewing order — a capture the
          // user actually watched used to vanish here. Current-boundary candidates
          // were moved to the retained end above; the counter still records how
          // much unrelated evidence was shed.
          diagBump('storageMaxItemsEvicted', merged.length - maxItemsCache);
          merged.splice(0, merged.length - maxItemsCache);
        }
        // Default the badge count to what is ALREADY stored: a failed set() is an
        // atomic no-op, so a rejected write cannot make the badge claim an empty
        // Library. Raise it only after a write actually lands.
        count = stored.length;
        if (!changed) return;
        try {
          await chrome.storage.session.set(dataValues({ [key]: merged }));
          count = merged.length;
        } catch (err) {
          if (!isStorageQuotaError(err)) {
            // A renderer/backend hiccup must not consume a one-shot GraphQL
            // capture. Retry the identical merge once before surfacing failure.
            await chrome.storage.session.set(dataValues({ [key]: merged }));
            count = merged.length;
            return;
          }
          const incomingIds = new Set(items.map((item) => item.id));
          const recovered = await withRetentionSnapshotLock(() =>
            reclaimGlobalMediaQuota(tabId, merged, incomingIds),
          );
          count = recovered.count;
          diagBump('storageQuotaEvicted', recovered.evicted);
        }
      });
    },
    (err) => {
      failure = err;
      console.error('[FaceScrap] storage write failed', err);
    },
  ).then(() => {
    if (failure !== undefined) throw failure;
    return count;
  });
}

export async function getMedia(tabId: number): Promise<MediaItem[]> {
  const stored = await readKey<MediaItem[]>(keyFor(tabId), []);
  const [normalized, changed] = mergeMedia(stored, []);
  if (changed) {
    // Return the repaired view immediately so an already-buffered video can
    // match NOW_PLAYING without waiting for new network traffic. Persist via
    // addMedia's serialized read/merge/write lane; never overwrite a concurrent
    // capture from this read path.
    void addMedia(tabId, []).catch((error) => console.error('[FaceScrap] media id migration failed', error));
  }
  return normalized;
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
  /** Opaque slide marker: a durable DOM story id (`u:`) or provisional pinned-
   *  path fallback (`p:`), combined with a per-video-load id when present (see
   *  content.ts). Never fetched; only compared/bound according to provenance. */
  mark?: string;
  at: number;
}

/** Bound an opaque PlayingRef.mark for persistence. An overlong mark is cut
 *  at the story side only: the `#<videoMark>` suffix (already capped at ~200
 *  by video-mark.ts) survives whole so consecutive loads stay distinct, and
 *  the story head becomes a stable prefix so the derived story portion still
 *  re-matches the same card across loads — a plain prefix slice would collapse
 *  loads, a positional head+tail split would shift the portion whenever the
 *  suffix length changes. */
export function boundPlayingMark(mark: string): string {
  if (mark.length <= 256) return mark;
  const i = mark.lastIndexOf('#');
  if (i < 0) return mark.slice(0, 256);
  // Fixed budgets, not remainder math: a head that flexed with suffix length
  // would change the derived story portion between loads `:9` and `:10`. 56
  // covers a whole synthetic `#vm:<uuid>:<seq>` suffix; an overlong progressive
  // src keeps its last 56 chars instead — still deterministic per load.
  return mark.slice(0, Math.min(i, 200)) + mark.slice(i).slice(-56);
}

const playingKey = (tabId: number): string => `playing_${tabId}`;

export function setPlaying(tabId: number, ref: PlayingRef, receivedAt?: number): Promise<boolean> {
  let completed = false;
  return enqueueCaptureState(
    tabId,
    async () => {
      await withRetentionSnapshotLock(async () => {
        const key = playingKey(tabId);
        const current = (await chrome.storage.session.get(key))[key] as PlayingRef | undefined;
        const resetClockEpoch =
          current != null &&
          receivedAt !== undefined &&
          playingTimestampIsFutureEpoch(current.at, receivedAt);
        // sendMessage calls can settle out of order under a renderer stall. Once a
        // newer DOM boundary is stored, an older message must never move the tab
        // back to the previous Story. The one exception is a stored value from a
        // pre-rollback wall-clock epoch; keeping it would ACK-but-ignore every
        // valid observation until the old future timestamp caught up.
        if (current != null && current.at > ref.at && !resetClockEpoch) {
          completed = true;
          return;
        }
        if (!resetClockEpoch) {
          await writeCaptureState(tabId, { [key]: ref }, { ref });
          completed = true;
          return;
        }

        // Recent requests and the retention pin carry timestamps from the same
        // clock. Repair the whole control snapshot in one durable write so old
        // future evidence cannot immediately re-select or reserve the previous
        // Story after the PlayingRef itself has recovered.
        const recentStorageKey = recentKey(tabId);
        const rawRecent = (await chrome.storage.session.get(recentStorageKey))[recentStorageKey] as
          | RecentRef
          | undefined;
        const repairedRecent: RecentRef | null = rawRecent && Array.isArray(rawRecent.tracks)
          ? {
              tracks: rawRecent.tracks.filter(
                (track) =>
                  track != null &&
                  typeof track.url === 'string' &&
                  typeof track.at === 'number' &&
                  !playingTimestampIsFutureEpoch(track.at, receivedAt),
              ),
            }
          : null;
        const values: Record<string, unknown> = {
          [key]: ref,
          [playingPinKey(tabId)]: null,
        };
        if (repairedRecent != null) values[recentStorageKey] = repairedRecent;
        await writeCaptureState(tabId, values, { ref, recent: repairedRecent, pin: null });
        completed = true;
      });
    },
    logWriteError('playing'),
  ).then(() => completed);
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
  /** Fetched tracks, oldest→newest. Normally a 24-entry tail; a bounded 4s
   *  transition burst and two boundary-near groups may temporarily widen it. */
  tracks: RecentTrack[];
}

const recentKey = (tabId: number): string => `recent_${tabId}`;

export function setRecent(tabId: number, url: string, at: number, receivedAt?: number): Promise<boolean> {
  if (
    url.length > MAX_MEDIA_URL_LEN ||
    !isFbcdn(url) ||
    !Number.isFinite(at) ||
    at < 0 ||
    (receivedAt !== undefined &&
      (!Number.isFinite(receivedAt) || playingTimestampIsFutureEpoch(at, receivedAt)))
  ) {
    return Promise.resolve(false);
  }
  let completed = false;
  return enqueueCaptureState(
    tabId,
    async () => {
      if (receivedAt !== undefined && playingTimestampIsFutureEpoch(at, Date.now())) return;
      await withRetentionSnapshotLock(async () => {
        const key = recentKey(tabId);
        const cur = ((await chrome.storage.session.get(key))[key] as RecentRef | undefined)?.tracks ?? [];
        // A worker can lose the ACK after storage accepted the write, then retry
        // the same observation. Keep that retry idempotent so one network segment
        // cannot occupy the bounded ring twice.
        if (!cur.some((track) => track.url === url && track.at === at)) cur.push({ url, at });
        const ref = await getPlaying(tabId);
        const retained = retainRecentTracks(cur, at, ref);
        const compact = retained.slice(-RECENT_STEADY_MAX);
        const value = { tracks: retained } satisfies RecentRef;
        const compactValue = { tracks: compact } satisfies RecentRef;
        await writeCaptureState(
          tabId,
          { [key]: value },
          {
            ref,
            recent: value,
            compactValues: { [key]: compactValue },
          },
        );
        completed = true;
      });
    },
    logWriteError('recent'),
  ).then(() => completed);
}

export async function getRecent(tabId: number): Promise<RecentRef | null> {
  const key = recentKey(tabId);
  const raw = (await chrome.storage.session.get(key))[key] as RecentRef | undefined;
  return raw && Array.isArray(raw.tracks) ? raw : null;
}

// --- Learned now-playing bindings, persisted so a reopened panel re-matches ---
// The panel learns cover→group, group→cover and mark→group while it runs; those
// live in panel-local memory wiped on panel close. Persist per tab so reopening on
// an already-buffered video re-matches WITHOUT new fbcdn traffic. The worker owns
// durable writes and clear tombstones; panels only submit versioned snapshots. lastLive is
// intentionally NOT persisted — restoring it resurrects a stale/neighbour video on
// reopen (the reopen should re-derive from live evidence + these bindings instead).

export interface BindState {
  coverBind: [string, string][];
  groupCover: [string, string][];
  markBind: [string, string][];
}

export interface BindRecord {
  version: 1;
  generation: number;
  revision: number;
  state: BindState | null;
}

export interface PersistBindingsRequest {
  generation: number;
  baseRevision: number;
  state: BindState;
}

export type PersistBindingsResult =
  | { ok: true; generation: number; revision: number }
  | { ok: false; conflict: true; record: BindRecord };

const BIND_VERSION = 1;
const BIND_MAX_ENTRIES = 300;
const BIND_MAX_BYTES = 96 * 1024;
const BIND_TEXT_MAX = 8 * 1024;
const bindKey = (tabId: number): string => `bind_${tabId}`;

function sanitizeBindEntries(raw: unknown, provisionalMarks = false): [string, string][] {
  if (!Array.isArray(raw)) return [];
  const deduped = new Map<string, string>();
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, value] = entry;
    if (
      typeof key !== 'string' ||
      typeof value !== 'string' ||
      key.length === 0 ||
      value.length === 0 ||
      key.length > BIND_TEXT_MAX ||
      value.length > BIND_TEXT_MAX ||
      (provisionalMarks && isProvisionalStoryMark(key))
    ) {
      continue;
    }
    if (deduped.has(key)) deduped.delete(key);
    deduped.set(key, value);
  }
  return [...deduped.entries()].slice(-BIND_MAX_ENTRIES);
}

function bindBytes(state: BindState): number {
  return new TextEncoder().encode(JSON.stringify(state)).byteLength;
}

export function sanitizeBindState(raw: unknown): BindState | null {
  if (raw == null || typeof raw !== 'object') return null;
  const candidate = raw as Partial<BindState>;
  const state: BindState = {
    coverBind: sanitizeBindEntries(candidate.coverBind),
    groupCover: sanitizeBindEntries(candidate.groupCover),
    markBind: sanitizeBindEntries(candidate.markBind, true),
  };
  // Preserve the durable mark mapping longest. Cover thumbnails are recoverable
  // from captures, and groupCover is the least important of the three maps.
  while (bindBytes(state) > BIND_MAX_BYTES) {
    if (state.groupCover.length > 0) state.groupCover.shift();
    else if (state.coverBind.length > 0) state.coverBind.shift();
    else if (state.markBind.length > 0) state.markBind.shift();
    else return null;
  }
  return state;
}

function isCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseBindRecord(raw: unknown): BindRecord {
  if (raw != null && typeof raw === 'object') {
    const record = raw as Partial<BindRecord>;
    if (
      record.version === BIND_VERSION &&
      isCounter(record.generation) &&
      isCounter(record.revision) &&
      (record.state === null || sanitizeBindState(record.state) != null)
    ) {
      return {
        version: BIND_VERSION,
        generation: record.generation,
        revision: record.revision,
        state: record.state === null ? null : sanitizeBindState(record.state),
      } as BindRecord;
    }
    // Legacy BindState: generation/revision zero lets its first durable update
    // migrate it without making a reopened panel lose the learned mappings.
    const legacy = sanitizeBindState(raw);
    if (legacy != null) return { version: BIND_VERSION, generation: 0, revision: 0, state: legacy };
  }
  return { version: BIND_VERSION, generation: 0, revision: 0, state: null };
}

async function readBindRecord(tabId: number): Promise<BindRecord> {
  const key = bindKey(tabId);
  return parseBindRecord((await chrome.storage.session.get(key))[key]);
}

function sameBindState(left: BindState | null, right: BindState): boolean {
  return left != null && JSON.stringify(left) === JSON.stringify(right);
}

/** Worker-owned CAS write. It shares the tab's capture lane with clearTab, so a
 * clear cannot be overtaken by an older panel write. The baseRevision+1 equality
 * case is a lost-ACK retry and returns the already-durable acknowledgement. */
export function persistBindings(tabId: number, request: PersistBindingsRequest): Promise<PersistBindingsResult> {
  const state = sanitizeBindState(request.state);
  if (!isCounter(request.generation) || !isCounter(request.baseRevision) || state == null) {
    return Promise.reject(new TypeError('Invalid binding persistence request.'));
  }
  let result: PersistBindingsResult | undefined;
  let failure: unknown;
  return enqueueCaptureState(
    tabId,
    async () => {
      const current = await readBindRecord(tabId);
      if (current.generation !== request.generation) {
        result = { ok: false, conflict: true, record: current };
        return;
      }
      if (current.revision === request.baseRevision + 1 && sameBindState(current.state, state)) {
        result = { ok: true, generation: current.generation, revision: current.revision };
        return;
      }
      if (current.revision !== request.baseRevision) {
        result = { ok: false, conflict: true, record: current };
        return;
      }
      const next: BindRecord = {
        version: BIND_VERSION,
        generation: current.generation,
        revision: current.revision + 1,
        state,
      };
      await writeCaptureState(tabId, { [bindKey(tabId)]: next });
      result = { ok: true, generation: next.generation, revision: next.revision };
    },
    (error) => {
      failure = error;
    },
  ).then(() => {
    if (failure !== undefined) throw failure;
    return result as PersistBindingsResult;
  });
}

/** Compatibility API for non-worker harnesses. Production panels use the
 * versioned runtime protocol so an acknowledgement always means durability. */
export async function setBind(tabId: number, state: BindState): Promise<void> {
  for (;;) {
    const current = await getBindRecord(tabId);
    const result = await persistBindings(tabId, {
      generation: current.generation,
      baseRevision: current.revision,
      state,
    });
    if (result.ok) return;
  }
}

export function getBindRecord(tabId: number): Promise<BindRecord> {
  return readBindRecord(tabId);
}

export async function getBind(tabId: number): Promise<BindState | null> {
  return (await readBindRecord(tabId)).state;
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
// Per-tab keys, not one global ledger. The service worker owns every receipt,
// so its one serial queue orders completions from all panel windows.

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
  let failure: unknown;
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
        await chrome.storage.session.set(dataValues({ [key]: cur }));
      } catch (err) {
        if (!isStorageQuotaError(err)) {
          // Download completion is a one-shot event. A transient backend error
          // must retry the intact ledger, never masquerade as quota and delete
          // half of the user's Saved history.
          await chrome.storage.session.set(dataValues({ [key]: cur }));
          return;
        }
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
        await chrome.storage.session.set(dataValues({ [key]: cur }));
      }
    },
    (err) => {
      failure = err;
      console.error('[FaceScrap] saved write failed', err);
    },
  ).then(() => {
    if (failure !== undefined) throw failure;
  });
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
  let failure: unknown;
  return enqueueCaptureState(
    tabId,
    async () => {
      const current = await readBindRecord(tabId);
      const tombstone: BindRecord = {
        version: BIND_VERSION,
        generation: current.generation + 1,
        revision: 0,
        state: null,
      };
      // Land the generation barrier first. If the following capture removal
      // fails, callers see the failure, but an old panel callback still cannot
      // resurrect bindings from the generation that was just cleared.
      await writeCaptureState(tabId, { [bindKey(tabId)]: tombstone });
      await withMediaGlobalLock(() =>
        chrome.storage.session.remove([keyFor(tabId), playingKey(tabId), recentKey(tabId), playingPinKey(tabId)]),
      );
    },
    (error) => {
      failure = error;
    },
  ).then(() => {
    if (failure !== undefined) throw failure;
  });
}

/** Remove one tab's saved_ key on the same worker-owned write chain as addSaved. */
export function dropSaved(tabId: number): Promise<void> {
  return enqueueSaved(
    () => chrome.storage.session.remove(savedKey(tabId)),
    (err) => console.error('[FaceScrap] storage clear failed', err),
  );
}

/** Full teardown for a CLOSED tab: the capture state AND the download history.
 *  Chrome does not reuse tab ids within a session, so a dead tab can never
 *  render its Saved view again — leaving saved_ would orphan the key in
 *  storage.session until the browser exits. Download completion and purge both
 *  run in the worker, so enqueueSaved orders a finishing receipt before/after
 *  this removal without a cross-context resurrection race. */
export function purgeTab(tabId: number): Promise<void> {
  const removeBindRecord = (): Promise<void> => {
    let failure: unknown;
    return enqueueCaptureState(
      tabId,
      () => chrome.storage.session.remove(bindKey(tabId)),
      (error) => {
        failure = error;
      },
    ).then(() => {
      if (failure !== undefined) throw failure;
    });
  };
  return Promise.all([
    clearTab(tabId).then(removeBindRecord),
    dropSaved(tabId),
  ]).then(() => undefined);
}

// --- Runtime capability flags (published by the SW, read by the panel/popup) ---

export interface Caps {
  sidePanel: boolean;
  offscreen: boolean;
}

const CAPS_KEY = 'caps';

export async function setCaps(caps: Caps): Promise<void> {
  await chrome.storage.session.set(dataValues({ [CAPS_KEY]: caps }));
}

export async function getCaps(): Promise<Caps | null> {
  return readKey<Caps | null>(CAPS_KEY, null);
}

// --- Diagnostic counters (opt-in; see diag.ts for why they exist) ---

// storage.LOCAL, unlike every other key in this file: the counters answer "what
// has this install been dropping?", a question asked across sessions. Tying them
// to storage.session would wipe the evidence at the exact moment a maintainer
// restarts the browser to reproduce a capture bug.
const DIAG_KEY = 'diag_counters';
const enqueueDiag = serialQueue();

/** Merge one context's drained counts into the running totals. Contexts report
 *  independently (page hook via the content script, worker, panel), so this ADDS
 *  rather than replaces — a plain set() would let whichever context flushed last
 *  erase the others' counts. */
export function addDiagCounters(delta: DiagCounters): Promise<void> {
  return enqueueDiag(
    async () => {
      // Re-sanitize even though the sender already did: the page hook's counts
      // cross a world boundary it shares with the page, same threat model as
      // sanitizeIncomingItems. Doing it here covers every caller at once.
      const clean = sanitizeDiagCounters(delta);
      if (Object.keys(clean).length === 0) return;
      const stored = sanitizeDiagCounters((await chrome.storage.local.get(DIAG_KEY))[DIAG_KEY]);
      for (const [reason, n] of Object.entries(clean)) {
        const key = reason as DiagReason;
        stored[key] = (stored[key] ?? 0) + n;
      }
      await chrome.storage.local.set({ [DIAG_KEY]: stored });
    },
    (err) => console.error('[FaceScrap] diag write failed', err),
  );
}

export async function getDiagCounters(): Promise<DiagCounters> {
  try {
    return sanitizeDiagCounters((await chrome.storage.local.get(DIAG_KEY))[DIAG_KEY]);
  } catch {
    return {};
  }
}

export function resetDiagCounters(): Promise<void> {
  return enqueueDiag(
    () => chrome.storage.local.remove(DIAG_KEY),
    (err) => console.error('[FaceScrap] diag clear failed', err),
  );
}

