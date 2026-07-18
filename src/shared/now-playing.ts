// Now-playing inference: given a tab's captured items plus the signals the
// content script relays (centered ids, slide marker, freshly fetched tracks),
// decide which video groups the user is actually watching. Storage-backed
// logic with no DOM access; the side panel is the only consumer — it feeds
// render() through selectPlaying() and wires the lifecycle hooks
// (loadBindings / flushBindingsNow / purgeTabBindings / forgetLastLive) to
// its tab events.

import { fbAssetKeys, mediaId, trackKey, videoGroupKey, type MediaItem } from './media';
import { getBind, getPlaying, getRecent, setBind } from './storage';

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
// seenActive: the centered-media id signature under which the remembered video
// was endorsed. When the signature CHANGES, the user visibly moved to another
// slide — the strongest relay trigger for back-to-back videos whose covers we
// can't match to captures.
const lastLive = new Map<number, { keys: Set<string>; at: number; seenActive: string }>();
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
// How long a definite slide change may wait for the new video's GraphQL capture
// (its stream is visible but matches no captured item yet) before relays and
// honest-empty proceed anyway.
const CAPTURE_WAIT_MS = 4000;
function remember(map: Map<string, string>, key: string, value: string): void {
  if (map.has(key)) map.delete(key); // refresh insertion order
  map.set(key, value);
  if (map.size > BIND_MAX) map.delete(map.keys().next().value as string);
}

// The re-attach-durable slice of a combined mark: the `u:<owner>/<card>` portion
// before `#`. Survives a story video's srcObject re-attach (which regenerates the
// `vm:` suffix) AND panel reopen, so a markBind keyed on it re-matches a buffered
// MSE story revisit with zero network. undefined off /stories (no `u:` prefix).
function markStoryPortion(mark: string | undefined): string | undefined {
  if (mark == null || !mark.startsWith('u:')) return undefined;
  const i = mark.indexOf('#');
  return i >= 0 ? mark.slice(0, i) : mark;
}

/** The cover URL learned for a video group while it played on screen. */
export function getGroupCover(tid: number, groupKey: string): string | undefined {
  return groupCover.get(`${tid}:${groupKey}`);
}

/** Forget a closed tab's last-live memory. */
export function forgetLastLive(tid: number): void {
  lastLive.delete(tid);
}

// --- Persist the learned bindings so a reopened panel re-matches ---
// Written per tab under bind_<tabId>; dirty-flagged, 1s-debounced, serialized
// through setBind's chain. The dirty tab is remembered explicitly (pendingTid),
// so the debounced write always lands on the tab that learned, even around a
// tab switch. lastLive is intentionally NOT persisted (see storage.ts).
let bindDirty = false;
let bindFlushTimer: ReturnType<typeof setTimeout> | undefined;
let pendingTid: number | undefined;
function cancelBindFlush(): void {
  bindDirty = false;
  pendingTid = undefined;
  if (bindFlushTimer !== undefined) {
    clearTimeout(bindFlushTimer);
    bindFlushTimer = undefined;
  }
}
function scheduleBindFlush(tid: number): void {
  bindDirty = true;
  pendingTid = tid;
  if (bindFlushTimer !== undefined) return;
  bindFlushTimer = setTimeout(() => {
    bindFlushTimer = undefined;
    flushBindingsNow();
  }, 1000);
}
export function flushBindingsNow(): void {
  if (bindFlushTimer !== undefined) {
    clearTimeout(bindFlushTimer);
    bindFlushTimer = undefined;
  }
  if (!bindDirty || pendingTid === undefined) return;
  bindDirty = false;
  const tid = pendingTid;
  pendingTid = undefined;
  const prefix = `${tid}:`;
  const strip = (m: Map<string, string>): [string, string][] =>
    [...m.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => [k.slice(prefix.length), v] as [string, string]);
  void setBind(tid, {
    coverBind: strip(coverBind),
    groupCover: strip(groupCover),
    markBind: strip(markBind),
  });
}
export async function loadBindings(tid: number): Promise<void> {
  const state = await getBind(tid);
  if (!state) return;
  const prefix = `${tid}:`;
  for (const [k, v] of state.coverBind) remember(coverBind, prefix + k, v);
  for (const [k, v] of state.groupCover) remember(groupCover, prefix + k, v);
  for (const [k, v] of state.markBind) remember(markBind, prefix + k, v);
}
// A nav/close reset (clearTab) fired for this tab: drop its in-memory learned
// bindings + last-live and cancel any pending flush, so a debounced write can't
// resurrect bind_ after storage was wiped (the F5 race) and the panel stops
// showing the pre-reload video from stale in-memory state.
export function purgeTabBindings(tid: number): void {
  const prefix = `${tid}:`;
  for (const m of [coverBind, groupCover, markBind]) {
    for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
  }
  lastLive.delete(tid);
  if (pendingTid === tid) cancelBindFlush();
}

/** Items for what's on screen: centered DOM media + the video being fetched now,
 *  plus any video still within its post-play grace window. */
export async function selectPlaying(tid: number, items: MediaItem[]): Promise<MediaItem[]> {
  const [ref, recent] = await Promise.all([getPlaying(tid), getRecent(tid)]);
  const active = new Set(ref?.ids ?? []);
  const now = Date.now();

  // Fetched-track fallback: every fbcdn track streamed within the match window —
  // only trusted while a <video> is actually centered, so a photo story doesn't
  // surface a stale video. Precompute each track's match keys: efg asset ids
  // (canonical), mediaId (legacy numeric), trackKey (filename).
  const tracks =
    ref?.hasVideo && recent ? recent.tracks.filter((t) => now - t.at < TRACK_MATCH_WINDOW_MS) : [];
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
  // representation). Both tie the item to what the user is actually LOOKING at.
  const urlVid = ref?.vid != null ? `vid:${ref.vid}` : undefined;
  const domMatch = (i: MediaItem, g: string, k: ItemKeys): boolean => {
    if (active.has(i.id)) return true;
    if (i.thumbUrl != null && active.has(mediaId(i.thumbUrl))) return true;
    if (urlVid != null && i.kind === 'video') {
      if (k.keys.includes(urlVid)) return true;
      if (k.audioKeys.includes(urlVid)) return true;
    }
    // Learned binding: a centered cover we previously saw over this exact video.
    for (const id of active) {
      if (coverBind.get(`${tid}:${id}`) === g) return true;
    }
    return false;
  };

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
  const fetchOldest = new Map<string, number>();
  const trackMatched: boolean[] = new Array(trackSigs.length).fill(false);
  for (const i of items) {
    if (i.kind !== 'video') continue;
    const k = keysOf(i);
    const g = k.keys[0] ?? i.id; // == videoGroupKey(i), reusing the decode above
    if (domMatch(i, g, k)) {
      domLive.add(g);
      continue;
    }
    let score = 0;
    let newest = 0;
    let oldest = Infinity;
    for (let ti = 0; ti < trackSigs.length; ti++) {
      if (matchesTrack(i, k, trackSigs[ti])) {
        trackMatched[ti] = true;
        score++;
        newest = Math.max(newest, tracks[ti].at);
        oldest = Math.min(oldest, tracks[ti].at);
      }
    }
    if (score > 0) {
      fetchScore.set(g, Math.max(score, fetchScore.get(g) ?? 0));
      fetchNewest.set(g, Math.max(newest, fetchNewest.get(g) ?? 0));
      fetchOldest.set(g, Math.min(oldest, fetchOldest.get(g) ?? Infinity));
    }
  }
  // Same-blob revisit rescue: a learned mark→group binding is dom-grade evidence
  // (a prefetch never has a mark), added BEFORE any relay can look at window
  // residue. The FULL mark carries the per-load `vm:` id, so it is card+load
  // specific for a video. But a PHOTO story card carries no `vm:` (centreMedia
  // adopts no video), so its full mark equals the durable portion learned while
  // the previous VIDEO card played — honouring it would pin that stale video onto
  // the photo. Gate on hasVideo: a slide with no video can't be a buffered video
  // revisit, so it must never resurrect a video group.
  const fullMark = ref?.mark;
  if (ref?.hasVideo === true && fullMark != null) {
    const mg = markBind.get(`${tid}:${fullMark}`);
    if (mg != null) domLive.add(mg);
  }
  // The re-attach-durable story-card portion (no `vm:`) lets an already-buffered
  // MSE story video re-match after reopen once its `vm:` id regenerated — BUT on
  // story surfaces the URL path does NOT advance per card, so this portion is the
  // SAME for every card in the tray; applied blindly it would pin now-playing to
  // the first-learned video. Honour it only when no OTHER group is streaming fresh
  // since this slide began: a genuine buffered revisit has no competing stream,
  // whereas advancing to a new card streams a DIFFERENT group — there, skip the
  // rescue so `domLive` stays empty and the relay/slide-change logic can hand over.
  // Gate on hasVideo for the same reason as the full-mark rescue above: on a photo
  // card tracks is forced empty (hasVideo=false ⇒ no fetch evidence), so
  // otherStreamingFresh is unconditionally false and this would re-pin the
  // previously learned video every tick. A photo slide is never a video revisit.
  const storyPortion = markStoryPortion(ref?.mark);
  const boundGroup =
    ref?.hasVideo === true && storyPortion != null ? markBind.get(`${tid}:${storyPortion}`) : undefined;
  if (boundGroup != null) {
    const otherStreamingFresh = [...fetchNewest].some(
      ([g, at]) => g !== boundGroup && at >= slideAt && now - at < FETCH_FRESH_MS,
    );
    if (!otherStreamingFresh) domLive.add(boundGroup);
  }
  // A track streamed SINCE this slide began that matches no captured item yet:
  // its GraphQL capture is still in flight — hold relays briefly so a captured
  // neighbour prefetch can't steal the endorsement (and burn the signature)
  // meanwhile. Bounded: only post-slide fresh tracks, at most CAPTURE_WAIT_MS.
  const captureWait =
    now - slideAt < CAPTURE_WAIT_MS &&
    tracks.some((t, ti) => t.at >= slideAt && now - t.at < FETCH_FRESH_MS && !trackMatched[ti]);
  // Rank by RECENCY first: what is streaming right now is what's playing. The
  // previous video's residue can out-COUNT a just-started one — count only
  // breaks ties within the same burst.
  const ranked = [...fetchScore.entries()].sort(
    (a, b) => (fetchNewest.get(b[0]) ?? 0) - (fetchNewest.get(a[0]) ?? 0) || b[1] - a[1],
  );
  const bestFetch = ranked[0]?.[0];

  // Slide signature: centered ids PLUS the opaque video marker. The marker is
  // what distinguishes back-to-back video slides on surfaces that expose no
  // cover/poster ids at all (this viewer unmounts covers during playback).
  const activeSig = `${[...active].sort().join(',')}|${ref?.mark ?? ''}`;
  const blind = active.size === 0 && (ref?.mark ?? '') === '';
  const prev = lastLive.get(tid);
  // Best candidate OUTSIDE the remembered set — the remembered video's own
  // residual tracks often outscore a just-started next video, so the relay
  // decision must exclude them or back-to-back videos never hand over.
  const bestOther = prev != null ? ranked.find(([g]) => !prev.keys.has(g))?.[0] : undefined;
  const bestOtherFresh = bestOther != null && now - (fetchNewest.get(bestOther) ?? 0) < FETCH_FRESH_MS;
  // Did the candidate stream AFTER this slide appeared? Pre-slide-only evidence
  // (residue of two slides ago, mid-watch prefetch) must not win a relay off a
  // signature change, or rapid swiping lands on the n-2 video.
  const bestOtherSinceSlide = bestOther != null && (fetchNewest.get(bestOther) ?? 0) >= slideAt;
  const prevNewest = prev != null ? Math.max(0, ...[...prev.keys].map((k) => fetchNewest.get(k) ?? 0)) : 0;
  const prevStreaming = prev != null && now - prevNewest < FETCH_FRESH_MS;

  // Endorse a set of groups as "what's playing" — and, when it's a single video
  // on a video slide, LEARN the on-screen evidence: bind the centered cover ids
  // to the group (so returning to this already-buffered video re-matches without
  // any network traffic) and keep its cover URL as a display thumbnail.
  const endorse = (keys: Set<string>): void => {
    lastLive.set(tid, { keys, at: now, seenActive: activeSig });
    if (keys.size !== 1 || ref?.hasVideo !== true) return;
    const g = keys.values().next().value as string;
    for (const id of active) remember(coverBind, `${tid}:${id}`, g);
    // Bind the slide marker only when backed by POST-slide fetch evidence whose
    // FIRST matching track sits near the slide start — so residue or a next-
    // neighbour prefetch (whose stream began well after slideAt) can't poison the
    // revisit memory, especially the DURABLE story-card key that persists across
    // reopen. Learn under BOTH the full mark and the story-card portion.
    if (
      ref.mark != null &&
      (fetchNewest.get(g) ?? 0) >= slideAt &&
      Math.abs((fetchOldest.get(g) ?? Infinity) - slideAt) < FETCH_FRESH_MS
    ) {
      remember(markBind, `${tid}:${ref.mark}`, g);
      const sp = markStoryPortion(ref.mark);
      if (sp != null) remember(markBind, `${tid}:${sp}`, g);
    }
    const cover = ref.coverUrls?.[0];
    if (cover != null) remember(groupCover, `${tid}:${g}`, cover);
    scheduleBindFlush(tid);
  };

  if (domLive.size > 0) {
    endorse(domLive);
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
          Math.abs((fetchOldest.get(b[0]) ?? Infinity) - slideAt) <
          Math.abs((fetchOldest.get(a[0]) ?? Infinity) - slideAt)
            ? b
            : a,
        )[0];
      }
      // The wide match window exists for RELAYS (a prefetched story must stay
      // matchable when its slide finally arrives); claiming an EMPTY slot is
      // held to actively-streaming evidence so a cold panel open can't
      // resurrect an old prefetched neighbour as "playing now".
      if (now - (fetchNewest.get(seed) ?? 0) < STREAM_SEED_MS) endorse(new Set([seed]));
    }
  } else if (
    bestOther != null &&
    !captureWait &&
    ((activeSig !== prev.seenActive && (bestOtherSinceSlide || now - slideAt > 1500)) ||
      (blind && bestOtherFresh && now - prev.at > PLAYING_TAKEOVER_MS))
  ) {
    // DEFINITE slide change (marker/cover signature differs from the one the
    // remembered video was endorsed under) → relay to the best other candidate,
    // preferring one that streamed since this slide appeared; pre-slide-only
    // evidence gets a 1.5s hold so the real video's first track wins the race
    // (falling back covers a video served 100% from prefetch cache). Deferring
    // does NOT consume the signature — seenActive is only written by endorse —
    // so the relay stays armed. While the user stays on the same slide the
    // signature never changes and a background prefetch can never win.
    endorse(new Set([bestOther]));
  } else if (
    activeSig !== prev.seenActive &&
    ref?.hasVideo === true &&
    bestOther == null &&
    !captureWait &&
    now - slideAt > 1500
  ) {
    // Definite slide change to a video with NO candidate evidence at all (e.g.
    // revisiting a fully-buffered video whose window expired): drop the stale
    // memory — an honest empty beats pinning the previous video for 5 minutes.
    // (A same-blob revisit never reaches here: markBind rescues it as domLive.)
    lastLive.delete(tid);
  } else if (prevStreaming) {
    // Refresh only on FRESH streaming — window residue must not keep a finished
    // video pinned past the handover to the next one.
    prev.at = now;
  } else if (ref != null && !ref.hasVideo && active.size > 0) {
    // A non-video slide (photo story) is centered now — it supersedes the
    // remembered video; "now playing" follows what the user is viewing.
    lastLive.delete(tid);
  }

  const sticky = lastLive.get(tid);
  const stickyKeys = sticky != null && now - sticky.at <= PLAYING_GRACE_MS ? sticky.keys : undefined;
  if (sticky != null && stickyKeys == null) lastLive.delete(tid);

  // Visible set: DOM-live videos plus the remembered one — never raw fetch-only
  // matches (those may be prefetched neighbours the user isn't watching).
  // Non-videos (photos) match via the centered-media ids only.
  return items.filter((i) => {
    const g = videoGroupKey(i);
    // Photos reach domMatch but never its efg branch (video-gated), so NO_KEYS is safe.
    if (i.kind !== 'video') return domMatch(i, g, NO_KEYS);
    return domLive.has(g) || (stickyKeys != null && stickyKeys.has(g));
  });
}
