// Shared media model + pure helpers (no chrome.* here — this file is also
// bundled into the MAIN-world page hook, which has no extension APIs).

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
 * Dedupe id: prefer the numeric fbcdn asset id embedded in the path
 * (stable across the rotating oh/oe signature params). Falls back to path.
 */
export function mediaId(url: string): string {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/(\d{8,})/);
    return m ? `fb:${m[1]}` : `path:${u.pathname}`;
  } catch {
    return url;
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
const MAX_URL_LEN = 8192;
const MAX_TRACK_IDS = 300;
// ECMAScript's max time value; `new Date(n).toISOString()` throws RangeError past
// it, so bound addedAt here where every other field is already bounded.
const MAX_TIME = 8_640_000_000_000_000;

export function sanitizeIncomingItems(raw: unknown): MediaItem[] {
  if (!Array.isArray(raw)) return [];
  const out: MediaItem[] = [];
  for (const r of raw.slice(0, MAX_ITEMS_PER_MESSAGE)) {
    if (!r || typeof r !== 'object') continue;
    const it = r as Record<string, unknown>;
    if (typeof it.id !== 'string' || !it.id || it.id.length > 256) continue;
    if (typeof it.url !== 'string' || it.url.length > MAX_URL_LEN || !isFbcdn(it.url)) continue;
    // fbcdn-hosted UI chrome (rsrc.php sprites/emoji) rides along in GraphQL
    // bodies as image URIs — it is never downloadable media.
    if (isStaticFbAsset(it.url)) continue;
    if (typeof it.kind !== 'string' || !MEDIA_KINDS.has(it.kind)) continue;
    if (typeof it.source !== 'string' || !MEDIA_SOURCES.has(it.source)) continue;
    if (typeof it.origin !== 'string' || !ORIGINS.has(it.origin)) continue;
    // Optional URL-bearing fields, if present, must also be fbcdn (and bounded).
    if (
      it.audioUrl !== undefined &&
      (typeof it.audioUrl !== 'string' || it.audioUrl.length > MAX_URL_LEN || !isFbcdn(it.audioUrl))
    ) {
      continue;
    }
    if (
      it.thumbUrl !== undefined &&
      (typeof it.thumbUrl !== 'string' || it.thumbUrl.length > MAX_URL_LEN || !isFbcdn(it.thumbUrl))
    ) {
      continue;
    }

    const clean: MediaItem = {
      id: it.id,
      url: it.url,
      kind: it.kind as MediaKind,
      source: it.source as MediaSource,
      origin: it.origin as MediaOrigin,
      addedAt:
        typeof it.addedAt === 'number' && Number.isFinite(it.addedAt) && Math.abs(it.addedAt) <= MAX_TIME
          ? it.addedAt
          : Date.now(),
    };
    if (typeof it.dash === 'boolean') clean.dash = it.dash;
    if (typeof it.audioUrl === 'string') clean.audioUrl = it.audioUrl;
    if (typeof it.thumbUrl === 'string') clean.thumbUrl = it.thumbUrl;
    if (typeof it.height === 'number' && Number.isFinite(it.height)) clean.height = it.height;
    if (typeof it.durationSec === 'number' && Number.isFinite(it.durationSec)) clean.durationSec = it.durationSec;
    if (Array.isArray(it.trackIds) && it.trackIds.every((t) => typeof t === 'string' && t.length <= 512)) {
      clean.trackIds = (it.trackIds as string[]).slice(0, MAX_TRACK_IDS);
    }
    out.push(clean);
  }
  return out;
}

/** Classify a raw fbcdn request of webRequest type `media` (the service-worker observer filters on type before calling). */
export function classifyNetworkRequest(url: string, now: number, source: MediaSource = 'video'): MediaItem | null {
  if (!isFbcdn(url)) return null;
  const isDash = /[?&](bytestart|byteend)=/.test(url);
  return makeItem(widenDashUrl(url), 'video', source, 'network', now, isDash);
}

/**
 * Merge new items into an existing list, deduping by id. If an incoming item
 * carries a linked audio track (audioUrl) where the stored one didn't, upgrade
 * it in place — the same video then becomes downloadable WITH audio.
 * Returns [merged, changed].
 */
export function mergeMedia(existing: MediaItem[], incoming: MediaItem[]): [MediaItem[], boolean] {
  const byId = new Map<string, MediaItem>();
  for (const m of existing) byId.set(m.id, m);
  let changed = false;
  for (const raw of incoming) {
    // Persistence boundary (defense in depth): never store a non-fbcdn URL, even
    // if some future caller reaches mergeMedia without sanitizeIncomingItems. If
    // nothing non-fbcdn is ever stored, nothing non-fbcdn can ever be rendered.
    // The optional URL fields get the same gate as `url`, so the "nothing
    // non-fbcdn is stored" invariant covers every URL the item carries.
    if (!raw.id || !raw.url || !isFbcdn(raw.url)) continue;
    const it =
      (raw.audioUrl != null && !isFbcdn(raw.audioUrl)) || (raw.thumbUrl != null && !isFbcdn(raw.thumbUrl))
        ? { ...raw, audioUrl: raw.audioUrl && isFbcdn(raw.audioUrl) ? raw.audioUrl : undefined, thumbUrl: raw.thumbUrl && isFbcdn(raw.thumbUrl) ? raw.thumbUrl : undefined }
        : raw;
    const prev = byId.get(it.id);
    if (!prev) {
      byId.set(it.id, it);
      changed = true;
      continue;
    }
    // Enrich an existing item in place when a later capture adds a linked
    // audio track and/or a thumbnail it didn't have before.
    const gainsAudio = Boolean(it.audioUrl) && !prev.audioUrl;
    const gainsThumb = Boolean(it.thumbUrl) && !prev.thumbUrl;
    const gainsTracks = Boolean(it.trackIds?.length) && !prev.trackIds?.length;
    if (gainsAudio || gainsThumb || gainsTracks) {
      byId.set(it.id, {
        ...prev,
        audioUrl: prev.audioUrl ?? it.audioUrl,
        thumbUrl: prev.thumbUrl ?? it.thumbUrl,
        trackIds: prev.trackIds ?? it.trackIds,
        dash: gainsAudio ? true : prev.dash,
      });
      changed = true;
    }
  }
  return [Array.from(byId.values()), changed];
}
