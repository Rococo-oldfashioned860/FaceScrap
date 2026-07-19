// Now-playing inference: given a tab's captured items plus the signals the
// content script relays (centered ids, slide marker, freshly fetched tracks),
// decide which video groups the user is actually watching. Storage-backed
// logic with no DOM access; the side panel is the only consumer — it feeds
// render() through selectPlaying() and wires the lifecycle hooks
// (loadBindings / flushBindingsNow / purgeTabBindings / forgetLastLive) to
// its tab events.

import { fbAssetKeys, legacyMediaId, mediaId, trackKey, videoGroupKey, type MediaItem } from './media';
import { withTimeout } from './async';
import {
  playingTimestampIsFutureEpoch,
  type PersistBindingsAck,
  type PersistBindingsMsg,
  type PinPlayingMediaMsg,
} from './messages';
import {
  getBindRecord,
  getPlaying,
  getRecent,
  persistBindings,
  playingIdentity,
  playingRetentionIdentity,
  sanitizeBindState,
  setPlayingMediaPin,
  type BindState,
} from './storage';
import { durableStoryMarkPortion, isProvisionalStoryMark, storyDomIdFromMark } from './story-mark';

// An MSE-played video (blob: currentSrc, never in ref.ids) only matches via fetched
// tracks, which age out of the match window after streaming stops — so remember the
// LAST live video per tab. The next video (or photo) that goes live REPLACES it
// (relay), so rows never accumulate; the grace window is only a backstop for
// abandoned tabs.
const PLAYING_GRACE_MS = 5 * 60 * 1000;
// How long a fetched track stays MATCHABLE. Wide on purpose: the stories tray
// prefetches upcoming cards when the viewer opens, so by the time the user
// reaches card N its tracks are minutes old — with a narrow window those
// stories had NO matchable evidence when their slide arrived, and the relay
// had nothing to hand over to (the same stories lagged on every single visit).
// Width is safe because staleness is judged separately: takeovers and
// streaming checks gate on FETCH_FRESH_MS, ranking is recency-first, seeding
// an empty slot requires STREAM_SEED_MS-fresh evidence, and raw fetch matches
// are never rendered directly (only domLive + the remembered video are).
const TRACK_MATCH_WINDOW_MS = 120_000;
// Seeding an EMPTY slot stays conservative: only a video streaming this
// recently may claim it, so a panel opened cold can't resurrect a neighbour
// prefetched a minute ago as "playing now".
const STREAM_SEED_MS = 30_000;
// How long the remembered video keeps its slot against a fetch-only candidate
// when no evidence refreshes it. Short — a real "next video" should relay fast —
// because the freshness gate below is what actually blocks prefetch takeovers.
const PLAYING_TAKEOVER_MS = 10 * 1000;
// A fetch-only candidate may take over only while it is STILL streaming (its
// newest matching track this fresh). A one-shot neighbour prefetch stops being
// fresh almost immediately; genuine playback keeps re-fetching and stays fresh.
const FETCH_FRESH_MS = 12 * 1000;
// The request for a newly visible Story can beat the 300 ms DOM poll that
// reports its PlayingRef. The live stress trace also measured a 697 ms main-
// thread stall, so poll + stall can put the first request roughly one second
// before the marker. Keep the allowance bounded and require sustained evidence
// below before a pre-ref-only burst may use it.
const SLIDE_DETECTION_SKEW_MS = 1_200;
// A one-shot post-slide request is still indistinguishable from neighbour
// prefetch. A group that starts near the marker and keeps requesting across a
// meaningful span is genuine playback-grade fallback evidence even when no
// request happened to beat the DOM detector.
const POST_SLIDE_STREAM_MIN_TRACKS = 3;
const POST_SLIDE_STREAM_MIN_SPAN_MS = 500;

function atOrAfterDetectedSlide(trackAt: number, slideAt: number): boolean {
  return trackAt >= slideAt - SLIDE_DETECTION_SKEW_MS;
}

function anchoredToSlide(trackAt: number, slideAt: number): boolean {
  return atOrAfterDetectedSlide(trackAt, slideAt) && trackAt - slideAt < FETCH_FRESH_MS;
}

function anchoredAfterSlide(trackAt: number, slideAt: number): boolean {
  return trackAt >= slideAt && trackAt - slideAt < FETCH_FRESH_MS;
}
// seenActive: the visible-media identity under which the remembered video was
// endorsed. A DOM-proven Story uses only its durable card id: its MSE handle and
// placeholder ids may churn while that same card remains on screen.
const lastLive = new Map<number, { keys: Set<string>; at: number; seenActive: string }>();
// Slide signatures under which honest-empty REFUSED to guess. The refusal must
// survive the deletion of lastLive it performs: one tick later prev is null and
// the SEED branch runs — without this memory it would endorse, on the very same
// slide, the same guess-grade candidate the relay just declined (its 30s
// freshness gate is looser than the anchor). Cleared by any endorsement and on
// tab teardown.
const emptiedUnder = new Map<number, string>();
// Learned on-screen evidence: cover asset id → video group, and group → cover URL.
// Fetch evidence only exists the FIRST time a video streams; returning to an
// already-buffered video fetches nothing, so these learned bindings are the only
// way it can re-match (and how a thumb-less capture gets a thumbnail). Keyed per
// tab (`${tabId}:${key}`); FIFO-capped.
const coverBind = new Map<string, string>();
const groupCover = new Map<string, string>();
// mark → group: a same-blob revisit of an already-buffered video (which fetches
// NOTHING) re-matches as dom-grade evidence through this memory. Only learned
// when the endorsement is backed by post-slide fetch evidence (no poisoning).
const markBind = new Map<string, string>();
const BIND_MAX = 300;
// Distinct fresh bursts that contradict a coverBind with anchored evidence for a
// DIFFERENT group. A learned binding is read as DOM-grade, and DOM-grade wins the
// cascade unconditionally — so a binding learned from a wrong guess re-proves
// itself on every later tick and never expires (only FIFO eviction or a real
// navigation clears it). endorse()'s comments record this being observed.
//
// Two ticks, not one: a single tick cannot separate the watched video from a deep
// bucket's burst prefetch anchoring in the same transition instant — the exact
// ambiguity endorse() already documents. Across two, genuine evidence stays
// anchored while a one-shot prefetch has gone quiet.
//
// In memory only, like lastLive: it describes the current disagreement, not
// anything worth restoring after a reload.
interface BindDisagreement {
  activeSig: string;
  group: string;
  newest: number;
  streak: number;
}
const bindDisagree = new Map<string, BindDisagreement>();
// Avoid one worker round-trip on every 500 ms render after a confirmation. This
// is only a write-dedup cache; storage remains the retention authority.
const confirmedPinWrites = new Map<number, string>();
const PIN_ACK_TIMEOUT_MS = 5_000;
const BIND_DISAGREE_STREAK = 2;
// How long a definite slide change may wait for the new video's GraphQL capture
// (its stream is visible but matches no captured item yet) before relays and
// honest-empty proceed anyway.
const CAPTURE_WAIT_MS = 4000;
function remember(map: Map<string, string>, key: string, value: string): void {
  if (map.has(key)) map.delete(key); // refresh insertion order
  map.set(key, value);
  if (map.size > BIND_MAX) map.delete(map.keys().next().value as string);
}

/** The cover URL learned for a video group while it played on screen. */
export function getGroupCover(tid: number, groupKey: string): string | undefined {
  return groupCover.get(`${tid}:${groupKey}`);
}

/** Forget a closed tab's last-live memory. */
export function forgetLastLive(tid: number): void {
  lastLive.delete(tid);
  emptiedUnder.delete(tid);
  confirmedPinWrites.delete(tid);
}

async function persistPlayingPin(tid: number, identity: string, groups: Set<string>, playingAt: number): Promise<void> {
  const orderedGroups = [...groups].sort();
  const signature = `${identity}|${playingAt}|${orderedGroups.join(',')}`;
  if (confirmedPinWrites.get(tid) === signature) return;
  const message = {
    type: 'FACESCRAP_PIN_PLAYING_MEDIA',
    tabId: tid,
    identity,
    groups: orderedGroups,
    playingAt,
  } satisfies PinPlayingMediaMsg;

  // Route the production write through the worker so it shares addMedia's
  // per-tab lane. Tests and degraded runtimes have no runtime bus and use the
  // awaited direct fallback instead.
  if (typeof chrome.runtime?.sendMessage === 'function') {
    try {
      const response = (await withTimeout(
        chrome.runtime.sendMessage(message),
        PIN_ACK_TIMEOUT_MS,
        'Playing pin acknowledgement timed out.',
      )) as { ok?: boolean } | undefined;
      if (response?.ok === true) {
        confirmedPinWrites.set(tid, signature);
      }
    } catch {
      // A sleeping/restarting worker is recoverable: this signature remains
      // unconfirmed, so the next 500 ms render retries it through the worker.
      // Never cross into this panel context's independent storage queue — that
      // would race addMedia/clearTab in the worker and defeat the pin's purpose.
    }
    return;
  }
  // Unit harnesses and degraded non-extension runtimes have no message bus.
  // Only there is a direct write safe, because there is no competing worker.
  if (await setPlayingMediaPin(tid, identity, orderedGroups, playingAt)) {
    confirmedPinWrites.set(tid, signature);
  }
}

// --- Persist the learned bindings so a reopened panel re-matches ---
// Written per tab under bind_<tabId>; dirty-flagged, 1s-debounced and delivered
// through a worker-owned versioned CAS. Each tab keeps its own immutable
// in-flight snapshot, so tab switches and concurrent retries cannot cross-wire.
// lastLive is intentionally NOT persisted (see storage.ts).
const BIND_ACK_TIMEOUT_MS = 5_000;
const BIND_RETRY_MIN_MS = 250;
const BIND_RETRY_MAX_MS = 8_000;
interface BindingOutbox {
  generation: number;
  revision: number;
  dirty: boolean;
  retry: number;
  epoch: number;
  timer?: ReturnType<typeof setTimeout>;
  inFlight?: { state: BindState; generation: number; baseRevision: number; epoch: number };
}
const bindingOutbox = new Map<number, BindingOutbox>();
function ensureBindingOutbox(tid: number): BindingOutbox {
  let outbox = bindingOutbox.get(tid);
  if (outbox == null) {
    outbox = { generation: 0, revision: 0, dirty: false, retry: 0, epoch: 0 };
    bindingOutbox.set(tid, outbox);
  }
  return outbox;
}

function scheduleBindFlush(tid: number): void {
  const outbox = ensureBindingOutbox(tid);
  outbox.dirty = true;
  if (outbox.timer !== undefined || outbox.inFlight != null) return;
  outbox.timer = setTimeout(() => {
    outbox.timer = undefined;
    void pumpBindings(tid);
  }, 1000);
}
export function flushBindingsNow(): void {
  for (const [tid, outbox] of bindingOutbox) {
    if (outbox.timer !== undefined) {
      clearTimeout(outbox.timer);
      outbox.timer = undefined;
    }
    if (outbox.dirty) void pumpBindings(tid);
  }
}

function bindingState(tid: number): BindState {
  const prefix = `${tid}:`;
  const strip = (m: Map<string, string>): [string, string][] =>
    [...m.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => [k.slice(prefix.length), v] as [string, string]);
  return sanitizeBindState({
    coverBind: strip(coverBind),
    groupCover: strip(groupCover),
    markBind: strip(markBind),
  }) as BindState;
}

function sameBindingState(left: BindState, right: BindState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dropBindingMemory(tid: number): void {
  const prefix = `${tid}:`;
  for (const m of [coverBind, groupCover, markBind, bindDisagree]) {
    for (const key of [...m.keys()]) if (key.startsWith(prefix)) m.delete(key);
  }
}

function restoreBindingState(tid: number, state: BindState | null): void {
  if (state == null) return;
  const prefix = `${tid}:`;
  for (const [key, value] of state.coverBind) remember(coverBind, prefix + key, value);
  for (const [key, value] of state.groupCover) remember(groupCover, prefix + key, value);
  for (const [key, value] of state.markBind) {
    if (!isProvisionalStoryMark(key)) remember(markBind, prefix + key, value);
  }
}

function retryBindings(tid: number, outbox: BindingOutbox): void {
  if (bindingOutbox.get(tid) !== outbox || !outbox.dirty || outbox.timer !== undefined) return;
  const delay = Math.min(BIND_RETRY_MAX_MS, BIND_RETRY_MIN_MS * 2 ** Math.min(outbox.retry++, 5));
  outbox.timer = setTimeout(() => {
    outbox.timer = undefined;
    void pumpBindings(tid);
  }, delay);
}

async function deliverBindings(tid: number, snapshot: NonNullable<BindingOutbox['inFlight']>): Promise<PersistBindingsAck> {
  const message = {
    type: 'FACESCRAP_PERSIST_BINDINGS',
    tabId: tid,
    generation: snapshot.generation,
    baseRevision: snapshot.baseRevision,
    state: snapshot.state,
  } satisfies PersistBindingsMsg;
  if (typeof chrome.runtime?.sendMessage === 'function') {
    return (await withTimeout(
      chrome.runtime.sendMessage(message),
      BIND_ACK_TIMEOUT_MS,
      'Binding acknowledgement timed out.',
    )) as PersistBindingsAck;
  }
  const result = await persistBindings(tid, message);
  return result.ok
    ? result
    : { ok: false, retryable: true, error: 'Binding revision conflict.', conflict: result.record };
}

async function pumpBindings(tid: number): Promise<void> {
  const outbox = bindingOutbox.get(tid);
  if (outbox == null || !outbox.dirty || outbox.inFlight != null) return;
  const snapshot = {
    state: bindingState(tid),
    generation: outbox.generation,
    baseRevision: outbox.revision,
    epoch: outbox.epoch,
  };
  outbox.inFlight = snapshot;
  let ack: PersistBindingsAck | undefined;
  try {
    ack = await deliverBindings(tid, snapshot);
  } catch {
    // The exact snapshot stays dirty. A retry is idempotent if the write landed
    // but its acknowledgement was lost.
  }
  if (bindingOutbox.get(tid) !== outbox || outbox.inFlight !== snapshot || outbox.epoch !== snapshot.epoch) return;
  outbox.inFlight = undefined;
  if (ack?.ok === true) {
    outbox.generation = ack.generation;
    outbox.revision = ack.revision;
    outbox.retry = 0;
    outbox.dirty = !sameBindingState(bindingState(tid), snapshot.state);
    if (outbox.dirty) retryBindings(tid, outbox);
    return;
  }
  if (ack?.conflict != null) {
    const current = ack.conflict;
    if (current.generation !== snapshot.generation) {
      dropBindingMemory(tid);
      outbox.generation = current.generation;
      outbox.revision = current.revision;
      outbox.dirty = false;
      outbox.retry = 0;
      return;
    }
    const local = bindingState(tid);
    dropBindingMemory(tid);
    restoreBindingState(tid, current.state);
    restoreBindingState(tid, local);
    outbox.revision = current.revision;
  }
  retryBindings(tid, outbox);
}

export async function loadBindings(tid: number): Promise<void> {
  const existing = ensureBindingOutbox(tid);
  const epoch = existing.epoch;
  const record = await getBindRecord(tid);
  const current = bindingOutbox.get(tid);
  if (current == null || current.epoch !== epoch || current.dirty || current.inFlight != null) return;
  dropBindingMemory(tid);
  restoreBindingState(tid, record.state);
  const outbox = ensureBindingOutbox(tid);
  outbox.generation = record.generation;
  outbox.revision = record.revision;
  outbox.dirty = false;
  outbox.retry = 0;
  // Provenance invariant (markBind never holds `p:` keys), restore layer: the
  // write gate in endorse() already refuses provisional marks, so a clean
  // write path can't persist one — this filter only guards corrupt or
  // hand-written storage, and the read guard in selectPlaying backstops both.
}
// A nav/close reset (clearTab) fired for this tab: drop its in-memory learned
// bindings + last-live and cancel any pending flush, so a debounced write can't
// resurrect bind_ after storage was wiped (the F5 race) and the panel stops
// showing the pre-reload video from stale in-memory state.
export function purgeTabBindings(tid: number): void {
  dropBindingMemory(tid);
  lastLive.delete(tid);
  emptiedUnder.delete(tid);
  confirmedPinWrites.delete(tid);
  const outbox = ensureBindingOutbox(tid);
  if (outbox?.timer !== undefined) clearTimeout(outbox.timer);
  // Retain this invalidation token. Deleting the outbox let a loadBindings()
  // that started before Clear finish afterward, see no epoch to contradict it,
  // and restore the stale snapshot into memory.
  outbox.epoch++;
  outbox.timer = undefined;
  outbox.inFlight = undefined;
  outbox.dirty = false;
  outbox.retry = 0;
  outbox.generation = 0;
  outbox.revision = 0;
}

/** Items for what's on screen: centered DOM media + the video being fetched now,
 *  plus any video still within its post-play grace window. */
export async function selectPlaying(tid: number, items: MediaItem[]): Promise<MediaItem[]> {
  const [ref, recent] = await Promise.all([getPlaying(tid), getRecent(tid)]);
  const active = new Set(ref?.ids ?? []);
  const now = Date.now();
  if (playingTimestampIsFutureEpoch(lastLive.get(tid)?.at ?? 0, now)) lastLive.delete(tid);

  // Fetched-track fallback: every fbcdn track streamed within the match window —
  // only trusted while a <video> is actually centered, so a photo story doesn't
  // surface a stale video. Precompute each track's match keys: efg asset ids
  // (canonical), mediaId (legacy numeric), trackKey (filename).
  const tracks =
    ref?.hasVideo && recent
      ? recent.tracks.filter(
          (t) => !playingTimestampIsFutureEpoch(t.at, now) && now - t.at < TRACK_MATCH_WINDOW_MS,
        )
      : [];
  const trackSigs = tracks.map((t) => ({
    assets: fbAssetKeys(t.url),
    mid: mediaId(t.url),
    tk: trackKey(t.url),
  }));
  // When the current slide appeared: PlayingRef.at is stamped on every centered-
  // media change, so it anchors "evidence from THIS slide" vs pre-slide residue.
  const slideAt = ref?.at ?? 0;

  // efg decode is the per-item hot cost; compute each item's keys ONCE per tick
  // (selectPlaying runs on every storage burst + the 2s tick over up to maxItems
  // items × the track window) instead of re-deriving them inside every matchesTrack.
  interface ItemKeys {
    keys: string[];
    audioKeys: string[];
    audioMid: string | null;
  }
  const keysOf = (i: MediaItem): ItemKeys => ({
    keys: fbAssetKeys(i.url),
    audioKeys: i.audioUrl != null ? fbAssetKeys(i.audioUrl) : [],
    audioMid: i.audioUrl != null ? mediaId(i.audioUrl) : null,
  });
  const NO_KEYS: ItemKeys = { keys: [], audioKeys: [], audioMid: null };

  const matchesTrack = (i: MediaItem, k: ItemKeys, s: (typeof trackSigs)[number]): boolean => {
    // Primary: the fetched track and this captured video share an efg asset id.
    // Works across progressive↔DASH and video↔audio tracks (different filenames).
    if (s.assets.length > 0) {
      if (k.keys.some((x) => s.assets.includes(x))) return true;
      if (k.audioKeys.some((x) => s.assets.includes(x))) return true;
    }
    // Legacy: exact numeric-id or audio-track match (older fbcdn URLs).
    if (i.id === s.mid || (k.audioMid != null && k.audioMid === s.mid)) return true;
    // Fallback: the fetched track's filename is one of this video's DASH reps.
    if (i.trackIds != null && i.trackIds.includes(s.tk)) return true;
    return false;
  };

  // DOM-grade evidence: the item (or its cover) is under the viewport centre, or
  // the page URL names this exact video (/reel/<id> → the efg `vid:` key of every
  // representation), or its GraphQL node carries the active Story card's exact
  // DOM id. All three tie the item to what the user is actually LOOKING at.
  const urlVid = ref?.vid != null ? `vid:${ref.vid}` : undefined;
  const storyDomId = storyDomIdFromMark(ref?.mark);
  // Split by PROVENANCE, not just by outcome: evidence derived from this tick
  // cannot be poisoned, a learned binding can. Only the latter is second-guessed.
  const domMatchFresh = (i: MediaItem, k: ItemKeys): boolean => {
    if (active.has(i.id) || active.has(mediaId(i.url)) || active.has(legacyMediaId(i.url) ?? '')) return true;
    if (i.thumbUrl != null && active.has(mediaId(i.thumbUrl))) return true;
    if (storyDomId != null && i.kind === 'video' && i.storyIds?.includes(storyDomId) === true) return true;
    if (urlVid != null && i.kind === 'video') {
      if (k.keys.includes(urlVid)) return true;
      if (k.audioKeys.includes(urlVid)) return true;
    }
    return false;
  };
  // Learned binding: a centered cover we previously saw over this exact video.
  const coverBindMatch = (g: string): boolean => {
    for (const id of active) {
      if (coverBind.get(`${tid}:${id}`) === g) return true;
    }
    return false;
  };
  /** Either provenance. Used where the distinction does not apply — the final
   *  photo filter, which has no group of its own to second-guess. */
  const domMatch = (i: MediaItem, g: string, k: ItemKeys): boolean => domMatchFresh(i, k) || coverBindMatch(g);

  // Two-tier live detection. DOM-grade evidence is authoritative: it replaces the
  // remembered video, so moving to the next reel/story swaps the row. Fetch-only
  // evidence is weak — fbcdn PREFETCHES neighbouring videos — so each video group
  // is SCORED by how many recent tracks match it: the actively watched video keeps
  // re-appending its alternating video/audio tracks and dominates the window,
  // while a one-shot prefetch scores 1-2 and ages out. The best fetch candidate
  // may seed an empty slot or refresh the remembered video, but never displaces a
  // fresh one; only a remembered entry with no evidence for a while is taken over.
  const domLive = new Set<string>();
  const fetchScore = new Map<string, number>();
  const fetchNewest = new Map<string, number>();
  const fetchClosestToSlide = new Map<string, number>();
  // Earliest track inside the bounded detector-skew window. This may relay the
  // visible row, but is deliberately separate from the strict post-slide map
  // below so pre-slide evidence can never create a durable binding.
  const fetchOldestNear = new Map<string, number>();
  // Oldest POST-slide track per group — the markBind learn gate's anchor. The
  // global oldest is dragged arbitrarily far back by pre-slide prefetch residue
  // inside the wide match window, which would silently block learning for a
  // group that ALSO streamed genuine near-slide evidence.
  const fetchOldestSince = new Map<string, number>();
  const fetchPostCount = new Map<string, number>();
  // Groups admitted to domLive by fresh evidence vs by a learned binding alone.
  // Only the second kind can be poisoned, so only it is second-guessed below.
  const freshGroups = new Set<string>();
  const bindGroups = new Set<string>();
  const trackMatched: boolean[] = new Array(trackSigs.length).fill(false);
  for (const i of items) {
    if (i.kind !== 'video') continue;
    const k = keysOf(i);
    const g = k.keys[0] ?? i.id; // == videoGroupKey(i), reusing the decode above
    if (domMatchFresh(i, k)) {
      domLive.add(g);
      freshGroups.add(g);
      continue;
    }
    if (coverBindMatch(g)) {
      domLive.add(g);
      bindGroups.add(g);
      continue;
    }
    let score = 0;
    let newest = 0;
    let closestToSlide = Infinity;
    let oldestNear = Infinity;
    let oldestSince = Infinity; // first track fetched AFTER this slide appeared
    let postCount = 0;
    for (let ti = 0; ti < trackSigs.length; ti++) {
      if (matchesTrack(i, k, trackSigs[ti])) {
        trackMatched[ti] = true;
        score++;
        newest = Math.max(newest, tracks[ti].at);
        if (Math.abs(tracks[ti].at - slideAt) < Math.abs(closestToSlide - slideAt)) {
          closestToSlide = tracks[ti].at;
        }
        if (atOrAfterDetectedSlide(tracks[ti].at, slideAt)) {
          oldestNear = Math.min(oldestNear, tracks[ti].at);
        }
        if (tracks[ti].at >= slideAt) {
          oldestSince = Math.min(oldestSince, tracks[ti].at);
          postCount++;
        }
      }
    }
    if (score > 0) {
      fetchScore.set(g, Math.max(score, fetchScore.get(g) ?? 0));
      fetchNewest.set(g, Math.max(newest, fetchNewest.get(g) ?? 0));
      const previousClosest = fetchClosestToSlide.get(g) ?? Infinity;
      if (Math.abs(closestToSlide - slideAt) < Math.abs(previousClosest - slideAt)) {
        fetchClosestToSlide.set(g, closestToSlide);
      }
      if (oldestNear !== Infinity) {
        fetchOldestNear.set(g, Math.min(oldestNear, fetchOldestNear.get(g) ?? Infinity));
      }
      if (oldestSince !== Infinity) {
        fetchOldestSince.set(g, Math.min(oldestSince, fetchOldestSince.get(g) ?? Infinity));
        fetchPostCount.set(g, Math.max(postCount, fetchPostCount.get(g) ?? 0));
      }
    }
  }
  const hasSlideStreamEvidence = (g: string): boolean => {
    const near = fetchOldestNear.get(g) ?? Infinity;
    const oldestSince = fetchOldestSince.get(g) ?? Infinity;
    const newest = fetchNewest.get(g) ?? -Infinity;
    // A request that beat the DOM detector is only trustworthy when the SAME
    // group continues across the boundary. A one-sided burst is indistinguishable
    // from Facebook prefetching a neighbour, even when it lands just after the
    // marker. Exact Story/URL/cover associations are handled as DOM-grade above.
    const crossedBoundary =
      near < slideAt &&
      anchoredToSlide(near, slideAt) &&
      newest >= slideAt &&
      now - newest < FETCH_FRESH_MS;
    const sustainedAfterBoundary =
      (fetchPostCount.get(g) ?? 0) >= POST_SLIDE_STREAM_MIN_TRACKS &&
      anchoredAfterSlide(oldestSince, slideAt) &&
      oldestSince - slideAt <= SLIDE_DETECTION_SKEW_MS &&
      newest - oldestSince >= POST_SLIDE_STREAM_MIN_SPAN_MS &&
      now - newest < FETCH_FRESH_MS;
    return crossedBoundary || sustainedAfterBoundary;
  };
  // Same-blob revisit rescue: a learned mark→group binding is dom-grade evidence
  // (a prefetch never has a mark), added BEFORE any relay can look at window
  // residue. The FULL mark carries the per-load `vm:` id, so it is card+load
  // specific for a video. But a PHOTO story card carries no `vm:` (centreMedia
  // adopts no video), so its full mark equals the durable portion learned while
  // the previous VIDEO card played — honouring it would pin that stale video onto
  // the photo. Gate on hasVideo: a slide with no video can't be a buffered video
  // revisit, so it must never resurrect a video group.
  // The provisional check is the read layer of the markBind provenance
  // invariant (endorse()'s write gate and loadBindings' restore filter are the
  // other two): markBind can't contain `p:` keys, so this only defends against
  // one of those layers being relaxed in isolation.
  const fullMark = ref?.mark;
  if (ref?.hasVideo === true && fullMark != null && !isProvisionalStoryMark(fullMark)) {
    const mg = markBind.get(`${tid}:${fullMark}`);
    if (mg != null) domLive.add(mg);
  }
  // The re-attach-durable DOM-card portion (no `vm:`) lets an already-buffered
  // MSE story video re-match after reopen once its `vm:` id regenerated. Honour
  // it only when no OTHER group is streaming fresh since this slide began: a
  // genuine buffered revisit has no competing stream, whereas a transition can
  // expose stale binding evidence alongside a different fresh group — there,
  // skip the rescue so the relay/slide-change logic can hand over.
  // Gate on hasVideo for the same reason as the full-mark rescue above: on a photo
  // card tracks is forced empty (hasVideo=false ⇒ no fetch evidence), so
  // otherStreamingFresh is unconditionally false and this would re-pin the
  // previously learned video every tick. A photo slide is never a video revisit.
  const storyPortion = durableStoryMarkPortion(ref?.mark);
  const boundGroup =
    ref?.hasVideo === true && storyPortion != null ? markBind.get(`${tid}:${storyPortion}`) : undefined;
  if (boundGroup != null) {
    const otherStreamingFresh = [...fetchNewest].some(
      ([g, at]) => g !== boundGroup && hasSlideStreamEvidence(g) && now - at < FETCH_FRESH_MS,
    );
    if (!otherStreamingFresh) domLive.add(boundGroup);
  }
  // A track streamed at this slide boundary that matches no captured item yet:
  // its GraphQL capture is still in flight — hold relays briefly so a captured
  // neighbour prefetch can't steal the endorsement (and burn the signature)
  // meanwhile. Bounded: only near-boundary fresh tracks, at most CAPTURE_WAIT_MS.
  const captureWait =
    now - slideAt < CAPTURE_WAIT_MS &&
    tracks.some(
      (t, ti) => atOrAfterDetectedSlide(t.at, slideAt) && now - t.at < FETCH_FRESH_MS && !trackMatched[ti],
    );
  // Rank by RECENCY first: what is streaming right now is what's playing. The
  // previous video's residue can out-COUNT a just-started one — count only
  // breaks ties within the same burst.
  const ranked = [...fetchScore.entries()].sort(
    (a, b) => (fetchNewest.get(b[0]) ?? 0) - (fetchNewest.get(a[0]) ?? 0) || b[1] - a[1],
  );
  const bestFetch = ranked[0]?.[0];

  // Use durable identity whenever the surface exposes one. `#vm` names a single
  // MSE load, not a Story; provisional/blind surfaces still retain the full
  // marker and centered ids through playingIdentity().
  const activeSig = playingIdentity(ref);
  const blind = active.size === 0 && (ref?.mark ?? '') === '';
  const relayable = (g: string): boolean => {
    const newest = fetchNewest.get(g) ?? -Infinity;
    return hasSlideStreamEvidence(g) || (blind && now - newest < FETCH_FRESH_MS);
  };
  // Second-guess groups that reached domLive on a learned binding ALONE, before
  // ANY of the cascade's inputs are read — a binding contradicted by anchored
  // evidence for another group across BIND_DISAGREE_STREAK consecutive ticks is
  // wrong, and left in place it re-proves itself on every later tick.
  for (const g of bindGroups) {
    const disagreeKey = `${tid}:${g}`;
    if (freshGroups.has(g)) {
      bindDisagree.delete(disagreeKey);
      continue;
    }
    const contradicted = [...fetchOldestNear.keys()]
      .filter((other) => other !== g && relayable(other))
      .map((group) => ({ group, newest: fetchNewest.get(group) ?? -Infinity }))
      .filter(({ newest }) => now - newest < FETCH_FRESH_MS)
      .sort((a, b) => b.newest - a.newest)[0];
    if (contradicted == null) {
      bindDisagree.delete(disagreeKey);
      continue;
    }
    const previousDisagreement = bindDisagree.get(disagreeKey);
    if (
      previousDisagreement?.activeSig === activeSig &&
      previousDisagreement?.group === contradicted.group &&
      contradicted.newest <= previousDisagreement.newest
    ) {
      continue;
    }
    const streak =
      previousDisagreement?.activeSig === activeSig && previousDisagreement.group === contradicted.group
        ? previousDisagreement.streak + 1
        : 1;
    if (streak < BIND_DISAGREE_STREAK) {
      bindDisagree.set(disagreeKey, { activeSig, ...contradicted, streak });
      continue;
    }
    domLive.delete(g);
    for (const id of active) {
      if (coverBind.get(`${tid}:${id}`) === g) coverBind.delete(`${tid}:${id}`);
    }
    bindDisagree.delete(disagreeKey);
    scheduleBindFlush(tid);
    // The remembered choice was endorsed off this binding, tick after tick. With
    // the binding gone it has no evidence left, and leaving it would pin the same
    // wrong video through the sticky branch — the slide signature never changed,
    // so no relay would fire to replace it. Dropping it here, BEFORE prev is
    // read, lets the seed branch pick from what is actually streaming.
    if (lastLive.get(tid)?.keys.has(g) === true) lastLive.delete(tid);
  }

  const prev = lastLive.get(tid);
  // A relay is only as good as its evidence, and the only evidence that IDs
  // "the video of THIS slide" is an ANCHORED stream: either a strict post-slide
  // start or one continuous stream crossing the small detector-skew window.
  // Everything else is a guess — window residue can't tell tray card N from
  // N+1 (one prefetch burst, near-identical timestamps), and a mid-watch
  // prefetch of a DEEPER tray bucket streams fresh and post-slide yet belongs
  // to a story two profiles down; both guesses were observed painting the
  // wrong story as playing, and endorse() would durably learn the error into
  // coverBind. On blind surfaces (no ids, no mark) the signature can't change,
  // slideAt goes stale, and no anchor can form — there the old freshness-based
  // takeover is the only relay there is.
  // Best RELAYABLE candidate OUTSIDE the remembered set — the remembered
  // video's own residual tracks often outscore a just-started next video, so
  // the relay decision must exclude them or back-to-back videos never hand
  // over. Among several ANCHORED candidates (the true video and a deep
  // bucket's burst prefetch can anchor in the same transition instant),
  // recency cannot tell them apart: prefer the stream that began CLOSEST to
  // the slide start, then the more SUSTAINED one — genuine playback keeps
  // appending tracks while a one-shot prefetch scores 1-2. Blind surfaces
  // keep the recency order; no anchor exists there to compare.
  let bestOther: string | undefined;
  if (prev != null) {
    const others = ranked.filter(([g]) => !prev.keys.has(g) && relayable(g));
    if (!blind && others.length > 1) {
      others.sort(
        (a, b) =>
          Math.abs((fetchClosestToSlide.get(a[0]) ?? Infinity) - slideAt) -
            Math.abs((fetchClosestToSlide.get(b[0]) ?? Infinity) - slideAt) ||
          b[1] - a[1],
      );
    }
    bestOther = others[0]?.[0];
  }
  const prevNewest = prev != null ? Math.max(0, ...[...prev.keys].map((k) => fetchNewest.get(k) ?? 0)) : 0;
  const prevStreaming = prev != null && now - prevNewest < FETCH_FRESH_MS;

  // Endorse a set of groups as "what's playing" — and, when it's a single video
  // on a video slide, LEARN the on-screen evidence: bind the centered cover ids
  // to the group (so returning to this already-buffered video re-matches without
  // any network traffic) and keep its cover URL as a display thumbnail.
  //
  // Learning is gated by PROVENANCE: bindings are durable (persisted, and a
  // coverBind hit counts as dom-grade evidence on every future visit), so they
  // may only come from evidence that identifies THIS slide — a dom-grade
  // endorsement, or a fetch endorsement whose stream anchors to the slide
  // start. A guessed endorsement may paint once, but must never teach: a wrong
  // coverBind row misidentifies this exact slide until the FIFO evicts it.
  let pinWrite: Promise<void> | undefined;
  const endorse = (keys: Set<string>, domGrade = false): void => {
    lastLive.set(tid, { keys, at: now, seenActive: activeSig });
    emptiedUnder.delete(tid);
    const retentionIdentity = playingRetentionIdentity(ref);
    const strongForRetention = domGrade || [...keys].every((group) => hasSlideStreamEvidence(group));
    if (retentionIdentity != null && strongForRetention && ref != null) {
      pinWrite = persistPlayingPin(tid, retentionIdentity, keys, ref.at);
    }
    if (keys.size !== 1 || ref?.hasVideo !== true) return;
    const g = keys.values().next().value as string;
    // The skew window is sufficient for a transient handoff, but not for
    // durable learning: a neighbour prefetch can also occur just before the DOM
    // poll. Only direct DOM evidence or a strictly post-slide stream may write
    // cover/mark bindings that survive future visits.
    const durableAnchor = anchoredAfterSlide(fetchOldestSince.get(g) ?? Infinity, slideAt);
    if (!domGrade && !durableAnchor) return;
    for (const id of active) remember(coverBind, `${tid}:${id}`, g);
    // A full per-load marker requires POST-slide fetch evidence whose first
    // track sits near the slide start. The durable Story portion may also be
    // learned from direct, fresh DOM evidence; that is what survives a panel
    // restart when an already-buffered video emits no network traffic and the
    // later poll exposes no src/poster ids. The provisional check is the WRITE
    // gate of the markBind provenance invariant — loadBindings' restore filter
    // and the read guards mirror it as defense in depth.
    if (ref.mark != null && !isProvisionalStoryMark(ref.mark)) {
      const sp = durableStoryMarkPortion(ref.mark);
      // Strict post-slide traffic may bind the full per-load marker. Direct DOM
      // evidence can also bind the durable Story portion even without traffic:
      // this is the zero-network/buffered case. freshGroups excludes learned
      // bindings, and stale placeholder covers are removed by centreMedia.
      if (durableAnchor) remember(markBind, `${tid}:${ref.mark}`, g);
      if (sp != null && (durableAnchor || (domGrade && freshGroups.has(g)))) {
        remember(markBind, `${tid}:${sp}`, g);
      }
    }
    const cover = ref.coverUrls?.[0];
    if (cover != null) remember(groupCover, `${tid}:${g}`, cover);
    scheduleBindFlush(tid);
  };

  if (domLive.size > 0) {
    endorse(domLive, true);
  } else if (prev == null) {
    if (bestFetch != null) {
      // Anchor the seed to the slide start: the watched video begins streaming
      // when its slide appears, so the group whose FIRST track sits closest to
      // slideAt beats both older residue and a mid-slide neighbour prefetch
      // (pure recency would seed the prefetch when the panel opens mid-watch).
      // Seeding can't displace anything — prev is empty.
      let seed = bestFetch;
      if (ranked.length > 1) {
        seed = ranked.reduce((a, b) =>
          Math.abs((fetchClosestToSlide.get(b[0]) ?? Infinity) - slideAt) <
          Math.abs((fetchClosestToSlide.get(a[0]) ?? Infinity) - slideAt)
            ? b
            : a,
        )[0];
      }
      // The wide match window exists for RELAYS (a prefetched story must stay
      // matchable when its slide finally arrives); claiming an EMPTY slot is
      // held to actively-streaming evidence so a cold panel open can't
      // resurrect an old prefetched neighbour as "playing now". And if the
      // slot is empty because honest-empty REFUSED to guess on this very
      // slide, streaming-fresh is not enough — only an anchored candidate may
      // reseed here, or a deep bucket's 30s-fresh burst wins one tick later
      // exactly what the relay just declined it. (A cold open has no refusal
      // recorded, and its stale slideAt could never anchor anything.)
      const refusedHere = emptiedUnder.get(tid) === activeSig;
      // Post-refusal escape hatch for late starts on an UNCHANGED slide (a
      // story paused and resumed >12s in): slideAt never re-stamps, so the
      // resumed stream can never anchor — but being the ONLY candidate
      // actively streaming right now is discriminating enough: sustained
      // playback stays continuously fresh, while a burst prefetch is fresh
      // for one 12s window at the transition and has long gone quiet.
      const freshNow = (g: string): boolean => now - (fetchNewest.get(g) ?? 0) < FETCH_FRESH_MS;
      const onlyFreshStreaming = freshNow(seed) && ranked.every(([g]) => g === seed || !freshNow(g));
      // A freshly detected, identifiable slide must use anchored/cross-boundary
      // evidence even when lastLive is empty. The permissive cold-open escape is
      // only for an old unchanged ref whose slideAt can no longer form an anchor.
      const freshlyDetectedNonBlind = !blind && now - slideAt < FETCH_FRESH_MS;
      const seedAllowed =
        relayable(seed) || (!freshlyDetectedNonBlind && (!refusedHere || onlyFreshStreaming));
      if (now - (fetchNewest.get(seed) ?? 0) < STREAM_SEED_MS && seedAllowed) {
        endorse(new Set([seed]));
      } else if (freshlyDetectedNonBlind && !relayable(seed)) {
        // Preserve this refusal beyond the 12 s fresh-slide window. Otherwise
        // the same lone prefetch becomes seedable later merely because time
        // passed, despite no new network evidence arriving.
        emptiedUnder.set(tid, activeSig);
      }
    }
  } else if (
    bestOther != null &&
    !captureWait &&
    (activeSig !== prev.seenActive || (blind && now - prev.at > PLAYING_TAKEOVER_MS))
  ) {
    // DEFINITE slide change (marker/cover signature differs from the one the
    // remembered video was endorsed under) → relay to the best ANCHORED
    // candidate, immediately: the anchor already proves its stream began with
    // this slide, so the old 1.5s pre-slide-evidence hold is unnecessary — it
    // existed precisely because unanchored evidence couldn't be trusted, and
    // unanchored candidates no longer relay at all. Deferring (no anchored
    // candidate yet) does NOT consume the signature — seenActive is only
    // written by endorse — so the relay stays armed while the real video's
    // first track is still in flight. While the user stays on the same slide
    // the signature never changes and a background prefetch can never win.
    endorse(new Set([bestOther]));
  } else if (
    activeSig !== prev.seenActive &&
    ref?.hasVideo === true &&
    bestOther == null &&
    !captureWait &&
    now - slideAt > 1500
  ) {
    // Definite slide change to a video with NO anchored candidate (a fully
    // buffered video that fetches nothing, or only guess-grade residue and
    // deep-prefetch candidates in the window): drop the stale memory after a
    // 1.5s grace for the real video's first track — an honest empty beats both
    // pinning the previous video for 5 minutes and painting a guessed
    // neighbour. Remember the refusal under this signature so the seed branch
    // can't re-guess on the same slide once prev is gone. (A same-blob revisit
    // never reaches here: markBind rescues it as domLive.)
    lastLive.delete(tid);
    emptiedUnder.set(tid, activeSig);
  } else if (prevStreaming) {
    // Refresh only on FRESH streaming — window residue must not keep a finished
    // video pinned past the handover to the next one.
    prev.at = now;
  } else if (ref?.hasVideo === true && storyPortion != null && activeSig === prev.seenActive) {
    // The DOM still proves the same video Story is visible. A fully buffered
    // player emits no network traffic and Facebook may replace its MSE handle;
    // neither event means the user advanced to another card.
    prev.at = now;
  } else if (
    ref != null &&
    !ref.hasVideo &&
    (active.size > 0 || storyPortion != null || activeSig !== prev.seenActive)
  ) {
    // A non-video slide is centered now and it is NOT the slide the remembered
    // video was endorsed under: a photo story (centered ids), or a dead
    // "story no longer available" bucket (no ids, no cover — but its card
    // marker moved). Either way it supersedes the remembered video — "now
    // playing" follows what the user is viewing, and keeping the previous
    // profile's story endorsed over an unavailable card paints the wrong
    // story. The content script debounces transient empties (1.2s), so a
    // no-signal emission reaching here is a stable real slide. A mute slide
    // whose marker cannot advance at all keeps the sticky: with no signal of
    // change there is nothing honest to act on. A durable Story marker is itself
    // enough: after content.ts's stable-empty debounce, hasVideo=false means the
    // card is no longer presenting the remembered video even if its id stayed.
    lastLive.delete(tid);
  }

  const sticky = lastLive.get(tid);
  const stickyKeys = sticky != null && now - sticky.at <= PLAYING_GRACE_MS ? sticky.keys : undefined;
  if (sticky != null && stickyKeys == null) lastLive.delete(tid);

  // Visible set: DOM-live videos plus the remembered one — never raw fetch-only
  // matches (those may be prefetched neighbours the user isn't watching).
  // Non-videos (photos) match via the centered-media ids only.
  const selected = items.filter((i) => {
    const g = videoGroupKey(i);
    // Photos reach domMatch but never its efg branch (video-gated), so NO_KEYS is safe.
    if (i.kind !== 'video') return domMatch(i, g, NO_KEYS);
    return domLive.has(g) || (stickyKeys != null && stickyKeys.has(g));
  });
  if (pinWrite != null) await pinWrite;
  return selected;
}
