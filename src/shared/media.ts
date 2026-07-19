// Shared media model + pure helpers (no chrome.* here — this file is also
// bundled into the MAIN-world page hook, which has no extension APIs).

import { isStoryDomId } from './story-mark';

export type MediaKind = 'video' | 'image' | 'audio';
export type MediaSource = 'reel' | 'story' | 'highlight' | 'video' | 'page';
export type MediaOrigin = 'network' | 'graphql' | 'dom';

export interface MediaItem {
  /** Stable dedupe key derived from the fbcdn asset id. */
  id: string;
  url: string;
  kind: MediaKind;
  source: MediaSource;
  /** True for a DASH track that may lack audio (or be audio-only). */
  dash?: boolean;
  /**
   * Linked DASH audio-track URL. When present, `url` (video-only) and this
   * are remuxed into one MP4 with audio (see offscreen document).
   */
  audioUrl?: string;
  /** Poster/thumbnail image URL, for previewing a video in the side panel. */
  thumbUrl?: string;
  /** Height in px of the (DASH) representation, used to label the resolution. */
  height?: number;
  /**
   * trackKey() of every DASH representation (all qualities + audio). The player's
   * ABR pick rarely matches the top-bitrate track in `url`, so the side panel
   * matches the currently-fetched track against this set. DASH-harvested items only.
   */
  trackIds?: string[];
  /** Total video duration in seconds, from the DASH manifest. Videos only. */
  durationSec?: number;
  /**
   * Opaque DOM Story card ids whose GraphQL nodes contained this video. One
   * underlying Facebook video may be reposted by several cards, so this is a
   * small bounded set rather than one last-writer-wins value.
   */
  storyIds?: string[];
  origin: MediaOrigin;
  addedAt: number;
}

export function isFbcdn(url: string): boolean {
  // Match the PARSED hostname, not the raw string: fetch/new URL/chrome.downloads all
  // resolve the host with the WHATWG parser, which normalizes backslashes to slashes —
  // a raw-string regex would accept `https://evil.com\a.fbcdn.net/` while the real
  // request hits evil.com. The (case-insensitive) substring gate keeps the hot
  // harvest path cheap; the parsed hostname is the authority.
  if (!/fbcdn\.net/i.test(url)) return false;
  try {
    const u = new URL(url);
    // https only: everything passing this gate may be fetched or downloaded,
    // and fbcdn never serves media over cleartext anyway.
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'fbcdn.net' || h.endsWith('.fbcdn.net');
  } catch {
    return false;
  }
}

/**
 * True for Facebook's static UI assets (sprites, emoji, icons) served off
 * `static.*.fbcdn.net/rsrc.php/…` — they pass isFbcdn but are chrome, not content.
 * The `/rsrc.php/` prefix is the reliable signal (content lives under `/v/…`,
 * `/o1/…`, hashed paths); the `static.` host is a secondary hint.
 */
export function isStaticFbAsset(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.startsWith('/rsrc.php/') || u.hostname.startsWith('static.');
  } catch {
    return false;
  }
}

/**
 * True for profile-picture crop renditions: the fbcdn path type token with the
 * `-1` suffix (`/t39.30808-1/`, `/t1.6435-1/`, …). Facebook serves every
 * avatar and profile-photo crop under it — including the viewer's own face on
 * the stories tray's Create-story tile — while post/story media use other
 * suffixes (`-6` photos, `-10` video thumbs, `-15` …). Chrome, not content,
 * for the incidental GraphQL image harvest; the deliberate on-screen DOM scan
 * stays permissive so a full-size profile photo opened in the viewer can still
 * be captured.
 */
export function isProfilePicCrop(url: string): boolean {
  try {
    return /\/t[\d.]+-1\//.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Widen a DASH byte-range segment URL into the full-track URL. */
export function widenDashUrl(url: string): string {
  try {
    const u = new URL(url);
    const wasSegment = u.searchParams.has('bytestart') || u.searchParams.has('byteend');
    u.searchParams.delete('bytestart');
    u.searchParams.delete('byteend');
    return wasSegment ? u.toString() : url;
  } catch {
    return url;
  }
}

/**
 * Canonical identity of one downloadable fbcdn object. The path identifies the
 * actual representation; the numeric video id alone does not, because every
 * rung in a DASH ladder can carry the same number. CDN host/routing prefixes,
 * byte ranges, and rotating signature params are deliberately ignored so the
 * manifest URL and the request URL for the same track still meet.
 */
export function mediaId(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/o\d+\/(?=v\/)/, '/');
    const tag = u.searchParams.get('tag');
    // Facebook's simple GraphQL fixture shape (also used by older stored rows)
    // already had a path-derived `video-*` id. Preserve that canonical spelling
    // while still deriving it here rather than trusting the supplied field.
    const simpleVideo = path.match(/^\/v\/t42\/([^/]+)\.mp4$/);
    if (simpleVideo) return `video-${simpleVideo[1]}${tag == null ? '' : `?tag=${encodeURIComponent(tag)}`}`;
    return `asset:${path}${tag == null ? '' : `?tag=${encodeURIComponent(tag)}`}`;
  } catch {
    return `invalid:${url}`;
  }
}

/** Identity produced by FaceScrap 1.0 before representation-safe canonical
 * ids were introduced. Kept only as a read/display alias for persisted session
 * rows and Saved receipts; all new writes use mediaId(). */
export function legacyMediaId(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const numeric = pathname.match(/(\d{8,})/);
    return numeric ? `fb:${numeric[1]}` : `path:${pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Stable key matching the currently-fetched fbcdn track to a captured
 * representation. Neither mediaId nor the full pathname is stable (no numeric
 * asset id; origin prefix varies: …/o1/v/… fetched vs …/v/… in the manifest); the
 * filename (per-track base64 token) survives origin routing, byte-range
 * segmenting, and the rotating query signature.
 */
export function trackKey(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ?? u.pathname;
  } catch {
    return url;
  }
}

/**
 * Decode a fbcdn URL's `efg` param (URL-safe base64) into its JSON string,
 * or null when the param is absent or malformed.
 */
function decodeEfg(url: string): string | null {
  const m = url.match(/[?&]efg=([^&]+)/);
  if (!m) return null;
  try {
    let b64 = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    return atob(b64);
  } catch {
    return null;
  }
}

/**
 * Canonical per-video keys from a fbcdn URL's `efg` param. The same
 * `xpv_asset_id`/`video_id` appears in every representation of one video
 * (progressive playable_url plus the separate DASH video/audio tracks), making it
 * the only reliable cross-track match. Ids stay strings: 17 digits exceeds
 * Number.MAX_SAFE_INTEGER. Returns e.g. ["xpv:…", "vid:…"].
 */
export function fbAssetKeys(url: string): string[] {
  const json = decodeEfg(url);
  if (json == null) return [];
  const keys: string[] = [];
  const xpv = json.match(/"xpv_asset_id":\s*"?(\d+)/);
  if (xpv) keys.push(`xpv:${xpv[1]}`);
  const vid = json.match(/"video_id":\s*"?(\d+)/);
  if (vid) keys.push(`vid:${vid[1]}`);
  return keys;
}

/** Resolution label + rank for an item. Prefers the URL's `tag=..._720p` (progressive), then `height` (DASH), then the `efg`'s `vencode_tag`. */
export function resolutionOf(item: Pick<MediaItem, 'url' | 'height'>): { label: string; rank: number } {
  const tag = item.url.match(/[?&]tag=[^&]*?(\d{3,4})p/i);
  if (tag) return { label: `${tag[1]}p`, rank: Number(tag[1]) };
  if (item.height != null && item.height > 0) return { label: `${item.height}p`, rank: item.height };
  const json = decodeEfg(item.url);
  if (json != null) {
    const vt = json.match(/"vencode_tag":"[^"]*?\.(\d{3,4})\./);
    if (vt) return { label: `${vt[1]}p`, rank: Number(vt[1]) };
  }
  return { label: 'Video', rank: 0 };
}

/** Key that groups every representation of the same video (the efg's xpv_asset_id; falls back to the item id when there is no efg). */
export function videoGroupKey(item: MediaItem): string {
  return fbAssetKeys(item.url)[0] ?? item.id;
}

export function makeItem(
  url: string,
  kind: MediaKind,
  source: MediaSource,
  origin: MediaOrigin,
  now: number,
  dash = false,
): MediaItem {
  return { id: mediaId(url), url, kind, source, origin, dash, addedAt: now };
}

// Exported: storage.ts validates persisted SavedEntry shapes against the same
// enum authorities this sanitizer uses.
export const MEDIA_KINDS: ReadonlySet<string> = new Set(['video', 'image', 'audio']);
export const MEDIA_SOURCES: ReadonlySet<string> = new Set(['reel', 'story', 'highlight', 'video', 'page']);
const ORIGINS: ReadonlySet<string> = new Set(['network', 'graphql', 'dom']);

/**
 * Validate + normalize items from the untrusted page-message channel. The
 * MAIN-world hook shares the page's trust domain, so any co-resident script can
 * forge a MEDIA_FOUND payload: accept only fbcdn URLs and known enum values, and
 * rebuild a clean object so forged extra fields can't ride along. Downstream
 * consumers can then treat stored items as fbcdn-scoped.
 */
// Hard caps on the untrusted page-message channel: a hostile co-resident script
// can post arbitrarily large payloads; bound what one message may cost us.
export const MAX_ITEMS_PER_MESSAGE = 500;
export const MAX_MEDIA_URL_LEN = 8192;
export const MAX_TRACK_IDS = 64;
export const MAX_MEDIA_ITEM_BYTES = 64 * 1024;
export const MAX_MEDIA_BATCH_BYTES = 512 * 1024;
export const MAX_STORY_IDS = 8;
// A capture timestamp is minted in the renderer and may spend a little time in
// an acknowledged retry queue. It is not authority for retention order beyond
// that small transit window.
const MAX_TIME = 8_640_000_000_000_000;
const MAX_CAPTURE_AGE_MS = 10 * 60 * 1000;
const MAX_CAPTURE_FUTURE_SKEW_MS = 2 * 60 * 1000;

function normalizeAddedAt(raw: unknown, now: number, allowHistorical: boolean): number {
  const safeNow = Number.isFinite(now) && Math.abs(now) <= MAX_TIME ? now : Date.now();
  if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > MAX_TIME) return safeNow;
  if (raw <= 0 || raw > safeNow + MAX_CAPTURE_FUTURE_SKEW_MS) return safeNow;
  if (!allowHistorical && raw < safeNow - MAX_CAPTURE_AGE_MS) return safeNow;
  return raw;
}

/** UTF-8 serialized size used by both page-channel validation and bounded
 * delivery queues. Invalid/cyclic values are treated as infinitely large. */
export function mediaItemWeight(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string'
      ? new TextEncoder().encode(serialized).byteLength
      : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function normalizeTrackIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const prefix = raw.slice(0, MAX_TRACK_IDS);
  return prefix.every((track) => typeof track === 'string' && track.length <= 512)
    ? prefix as string[]
    : [];
}

function normalizeStoryIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // Inspect only a small prefix even if a hostile page supplies a huge array.
  for (const value of raw.slice(0, MAX_STORY_IDS * 4)) {
    if (!isStoryDomId(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length === MAX_STORY_IDS) break;
  }
  return out;
}

/** Merge oldest-to-newest associations while keeping the newest bounded tail.
 *  A popular video can be reposted by many Story cards; keeping the first eight
 *  would eventually discard the card the user just opened and defeat the exact
 *  now-playing association this field exists to provide. */
function mergeStoryIds(older: unknown, newer: unknown): string[] {
  const out: string[] = [];
  for (const id of [...normalizeStoryIds(older), ...normalizeStoryIds(newer)]) {
    const previous = out.indexOf(id);
    if (previous >= 0) out.splice(previous, 1);
    out.push(id);
  }
  if (out.length > MAX_STORY_IDS) out.splice(0, out.length - MAX_STORY_IDS);
  return out;
}

export function sanitizeIncomingItems(
  raw: unknown,
  maxTotalBytes = Number.POSITIVE_INFINITY,
  now = Date.now(),
): MediaItem[] {
  if (!Array.isArray(raw)) return [];
  if (!(maxTotalBytes > 0)) return [];
  const out: MediaItem[] = [];
  let totalBytes = 0;
  for (const r of raw.slice(0, MAX_ITEMS_PER_MESSAGE)) {
    if (!r || typeof r !== 'object') continue;
    const it = r as Record<string, unknown>;
    if (typeof it.url !== 'string' || it.url.length > MAX_MEDIA_URL_LEN || !isFbcdn(it.url)) continue;
    // fbcdn-hosted UI chrome (rsrc.php sprites/emoji) rides along in GraphQL
    // bodies as image URIs — it is never downloadable media.
    if (isStaticFbAsset(it.url)) continue;
    if (typeof it.kind !== 'string' || !MEDIA_KINDS.has(it.kind)) continue;
    if (typeof it.source !== 'string' || !MEDIA_SOURCES.has(it.source)) continue;
    if (typeof it.origin !== 'string' || !ORIGINS.has(it.origin)) continue;
    // Optional URL-bearing fields, if present, must also be fbcdn (and bounded).
    if (
      it.audioUrl !== undefined &&
      (typeof it.audioUrl !== 'string' || it.audioUrl.length > MAX_MEDIA_URL_LEN || !isFbcdn(it.audioUrl))
    ) {
      continue;
    }
    if (
      it.thumbUrl !== undefined &&
      (typeof it.thumbUrl !== 'string' || it.thumbUrl.length > MAX_MEDIA_URL_LEN || !isFbcdn(it.thumbUrl))
    ) {
      continue;
    }

    const clean: MediaItem = {
      id: mediaId(it.url),
      url: it.url,
      kind: it.kind as MediaKind,
      source: it.source as MediaSource,
      origin: it.origin as MediaOrigin,
      addedAt: normalizeAddedAt(it.addedAt, now, false),
    };
    if (typeof it.dash === 'boolean') clean.dash = it.dash;
    if (typeof it.audioUrl === 'string') clean.audioUrl = it.audioUrl;
    if (typeof it.thumbUrl === 'string') clean.thumbUrl = it.thumbUrl;
    if (typeof it.height === 'number' && Number.isFinite(it.height)) clean.height = it.height;
    if (typeof it.durationSec === 'number' && Number.isFinite(it.durationSec)) clean.durationSec = it.durationSec;
    const trackIds = normalizeTrackIds(it.trackIds);
    if (trackIds.length > 0) clean.trackIds = trackIds;
    const storyIds = normalizeStoryIds(it.storyIds);
    if (storyIds.length > 0) clean.storyIds = storyIds;
    const itemBytes = mediaItemWeight(clean);
    if (itemBytes > MAX_MEDIA_ITEM_BYTES) continue;
    // Runtime-message receivers pass their transport budget here. Stop as soon
    // as the next clean item would cross it: the sender's ordered ACK queue
    // already splits legitimate traffic, while a forged 500-item renderer
    // payload cannot make the worker allocate/copy tens of megabytes first.
    if (totalBytes + itemBytes > maxTotalBytes) break;
    totalBytes += itemBytes;
    out.push(clean);
  }
  return out;
}

/** Classify a raw fbcdn request of webRequest type `media` (the service-worker observer filters on type before calling). */
export function classifyNetworkRequest(url: string, now: number, source: MediaSource = 'video'): MediaItem | null {
  if (url.length > MAX_MEDIA_URL_LEN || !isFbcdn(url)) return null;
  const isDash = /[?&](bytestart|byteend)=/.test(url);
  return makeItem(widenDashUrl(url), 'video', source, 'network', now, isDash);
}

/**
 * Merge new items into an existing list, deduping by id. If an incoming item
 * carries a linked audio track (audioUrl) where the stored one didn't, upgrade
 * it in place — the same video then becomes downloadable WITH audio.
 * Returns [merged, changed].
 */
function normalizeMergeCandidate(raw: MediaItem, now: number, allowHistorical: boolean): MediaItem | null {
  if (mediaItemWeight(raw) > MAX_MEDIA_ITEM_BYTES) return null;
  if (
    !raw || typeof raw !== 'object' ||
    typeof raw.url !== 'string' || raw.url.length > MAX_MEDIA_URL_LEN || !isFbcdn(raw.url) ||
    isStaticFbAsset(raw.url) ||
    typeof raw.kind !== 'string' || !MEDIA_KINDS.has(raw.kind) ||
    typeof raw.source !== 'string' || !MEDIA_SOURCES.has(raw.source) ||
    typeof raw.origin !== 'string' || !ORIGINS.has(raw.origin)
  ) return null;
  if (
    raw.audioUrl !== undefined &&
    (typeof raw.audioUrl !== 'string' || raw.audioUrl.length > MAX_MEDIA_URL_LEN || !isFbcdn(raw.audioUrl))
  ) return null;
  if (
    raw.thumbUrl !== undefined &&
    (typeof raw.thumbUrl !== 'string' || raw.thumbUrl.length > MAX_MEDIA_URL_LEN || !isFbcdn(raw.thumbUrl))
  ) return null;

  const it: MediaItem = {
    id: mediaId(raw.url),
    url: raw.url,
    kind: raw.kind,
    source: raw.source,
    origin: raw.origin,
    addedAt: normalizeAddedAt(raw.addedAt, now, allowHistorical),
  };
  if (typeof raw.dash === 'boolean') it.dash = raw.dash;
  if (typeof raw.audioUrl === 'string') it.audioUrl = raw.audioUrl;
  if (typeof raw.thumbUrl === 'string') it.thumbUrl = raw.thumbUrl;
  if (typeof raw.height === 'number' && Number.isFinite(raw.height)) it.height = raw.height;
  if (typeof raw.durationSec === 'number' && Number.isFinite(raw.durationSec)) it.durationSec = raw.durationSec;
  const trackIds = normalizeTrackIds(raw.trackIds);
  if (trackIds.length > 0) it.trackIds = trackIds;
  const storyIds = normalizeStoryIds(raw.storyIds);
  if (storyIds.length > 0) it.storyIds = storyIds;
  return mediaItemWeight(it) <= MAX_MEDIA_ITEM_BYTES ? it : null;
}

export function mergeMedia(existing: MediaItem[], incoming: MediaItem[], now = Date.now()): [MediaItem[], boolean] {
  const byId = new Map<string, MediaItem>();
  let changed = false;
  const insert = (raw: MediaItem, allowHistorical: boolean, isIncoming: boolean): void => {
    const it = normalizeMergeCandidate(raw, now, allowHistorical);
    if (!it) {
      if (!isIncoming) changed = true;
      return;
    }
    if (!isIncoming && (raw.id !== it.id || raw.addedAt !== it.addedAt || mediaItemWeight(raw) !== mediaItemWeight(it))) {
      changed = true;
    }
    const prev = byId.get(it.id);
    if (!prev) {
      byId.set(it.id, it);
      if (isIncoming) changed = true;
      return;
    }
    // Two persisted legacy rows may name the same URL with different forged or
    // pre-canonical ids. The returned map compacts them; flag the migration so
    // storage writes that repaired shape back even when neither row enriches it.
    if (!isIncoming) changed = true;
    // Enrich transactionally: every accepted intermediate shape must remain a
    // valid storable item. Never delete a field already present on `prev` just
    // to make room for new metadata. Strong playback associations win first;
    // lower-priority track/preview metadata is admitted only while it fits.
    const gainsAudio = Boolean(it.audioUrl) && !prev.audioUrl;
    const gainsThumb = Boolean(it.thumbUrl) && !prev.thumbUrl;
    const gainsTracks = Boolean(it.trackIds?.length) && !prev.trackIds?.length;
    const previousStoryIds = normalizeStoryIds(prev.storyIds);
    const mergedStoryIds = mergeStoryIds(previousStoryIds, it.storyIds);
    const storyOrderChanged =
      mergedStoryIds.length !== previousStoryIds.length ||
      mergedStoryIds.some((id, index) => id !== previousStoryIds[index]);
    let enriched = prev;
    let enrichedChanged = false;
    const accept = (candidate: MediaItem): boolean => {
      if (mediaItemWeight(candidate) > MAX_MEDIA_ITEM_BYTES) return false;
      enriched = candidate;
      enrichedChanged = true;
      return true;
    };

    if (storyOrderChanged) {
      const candidate = { ...enriched };
      if (mergedStoryIds.length > 0) candidate.storyIds = mergedStoryIds;
      else delete candidate.storyIds;
      accept(candidate);
    }
    if (gainsAudio && it.audioUrl != null) {
      accept({ ...enriched, audioUrl: it.audioUrl, dash: true });
    }
    if (gainsTracks && it.trackIds != null) {
      // Keep the longest useful prefix that fits. Serialized weight grows
      // monotonically with this string prefix, so binary search bounds hostile
      // batches to O(log MAX_TRACK_IDS) full-size serializations per item.
      const base = enriched;
      let low = 1;
      let high = it.trackIds.length;
      let best: MediaItem | null = null;
      while (low <= high) {
        const count = Math.floor((low + high) / 2);
        const candidate = { ...base, trackIds: it.trackIds.slice(0, count) };
        if (mediaItemWeight(candidate) <= MAX_MEDIA_ITEM_BYTES) {
          best = candidate;
          low = count + 1;
        } else {
          high = count - 1;
        }
      }
      if (best != null) accept(best);
    }
    if (gainsThumb && it.thumbUrl != null) {
      accept({ ...enriched, thumbUrl: it.thumbUrl });
    }
    if (enrichedChanged) {
      byId.set(it.id, enriched);
      changed = true;
    }
  };
  // Persisted rows may legitimately be older than the renderer transit window,
  // but still cannot claim a future/negative/extreme date. New captures get the
  // tighter freshness bound even when a caller bypasses sanitizeIncomingItems.
  for (const raw of existing) insert(raw, true, false);
  for (const raw of incoming) insert(raw, false, true);
  return [Array.from(byId.values()), changed];
}
