// Pure DASH helpers: turn Facebook's prefetch representations or a DASH MPD
// XML string into linked { videoUrl, audioUrl } pairs — one per video quality
// in the ladder, each linked to the best audio representation.
// No chrome.* — imported only by the MAIN-world page hook (which has DOMParser).
// DRM-protected representations are skipped (they cannot be remuxed/decrypted).

import { diagBump } from './diag';
import { isFbcdn, widenDashUrl } from './media';

// Keep structured harvesting and raw-text fallbacks on one shared list. These
// used to be duplicated in page-hook.ts, where the fallback silently missed
// hd_src/sd_src and four of the five MPD string fields.
export const VIDEO_KEYS = [
  'playable_url',
  'playable_url_quality_hd',
  'browser_native_hd_url',
  'browser_native_sd_url',
  'hd_src',
  'sd_src',
] as const;

export const MPD_STRING_KEYS = [
  'dash_manifest',
  'dash_manifest_xml',
  'dash_manifest_xml_string',
  'manifest_xml',
  'playlist',
] as const;

const PREFETCH_KEY = JSON.stringify('all_video_dash_prefetch_representations');
// This scanner only runs after the 16 MiB whole-line parser guard trips. Keep
// its recovery work explicitly bounded so malformed input cannot replace one
// main-thread stall with another.
const MAX_PREFETCH_FRAGMENT_CHARS = 4 * 1024 * 1024;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractJsonStrings(text: string, keys: readonly string[]): string[] {
  const alternatives = keys.map(escapeRegExp).join('|');
  const re = new RegExp(`"(?:${alternatives})"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'g');
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    try {
      const value: unknown = JSON.parse(`"${match[1]}"`);
      if (typeof value === 'string') out.push(value);
    } catch {
      // A partial JSON string is not recoverable; the structured parser will
      // still handle well-formed lines on its normal path.
    }
  }
  return out;
}

/** Raw GraphQL fallback for every supported progressive-video field. */
export function extractUrlsByKey(text: string): string[] {
  return extractJsonStrings(text, VIDEO_KEYS).filter(isFbcdn);
}

/** Raw GraphQL fallback for every supported MPD string field. */
export function extractStringsByKey(text: string): string[] {
  return extractJsonStrings(text, MPD_STRING_KEYS);
}

export interface DashPair {
  /** Total video duration in seconds (from the MPD's mediaPresentationDuration). */
  durationSec?: number;
  videoUrl: string;
  /** Best audio track of the same ladder. Absent when the manifest carries no
   *  usable (non-DRM, fbcdn) audio representation — the pair then downloads as
   *  a muted video-only track ("may lack audio" in the UI). */
  audioUrl?: string;
  height?: number;
  /** All representation URLs (every video quality + audio), widened. The player
   *  streams one adaptive quality that is usually NOT the highest — we keep the
   *  full set so the now-playing filter can match whichever one it fetches. */
  trackUrls: string[];
}

interface Rep {
  url: string;
  bandwidth: number;
  kind: 'video' | 'audio';
  height?: number;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

function kindFromCodecs(codecs: unknown): 'video' | 'audio' | null {
  if (typeof codecs !== 'string') return null;
  if (/^(avc|hev|hvc|vp0?9|av01)/i.test(codecs)) return 'video';
  if (/^(mp4a|opus|ac-3|ec-3|aac|vorbis)/i.test(codecs)) return 'audio';
  return null;
}

function kindOf(mime: string, codecs: unknown): 'video' | 'audio' | null {
  if (mime.startsWith('audio')) return 'audio';
  if (mime.startsWith('video')) return 'video';
  return kindFromCodecs(codecs);
}

/** One pair per VIDEO representation, highest quality first, so every rung of
 *  the ladder becomes a download option (not just the top-bitrate one). All
 *  pairs share the ladder's best audio track and the FULL track-URL set (the
 *  now-playing filter matches whichever quality the player streams). A ladder
 *  with no usable audio still yields video-only pairs instead of being dropped.
 *  Emitting highest-first also means that if legacy numeric fbcdn ids collide
 *  across qualities in mergeMedia, the stored item is the best one. */
function ladderPairs(reps: Rep[], durationSec?: number): DashPair[] {
  const videos = reps
    .filter((r) => r.kind === 'video')
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth);
  const audio = reps
    .filter((r) => r.kind === 'audio')
    .sort((a, b) => b.bandwidth - a.bandwidth)[0];
  const trackUrls = reps.map((r) => r.url);
  return videos.map((v) => ({
    videoUrl: v.url,
    audioUrl: audio?.url,
    height: v.height,
    trackUrls,
    durationSec,
  }));
}

/** ISO-8601 duration ("PT1M23.4S") → seconds. */
function parseIsoDuration(d: string | null): number | undefined {
  if (!d) return undefined;
  const m = d.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return undefined;
  const total = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

/** all_video_dash_prefetch_representations → pairs (no XML; base_url is the full track). */
export function fromPrefetchReps(input: unknown): DashPair[] {
  if (!Array.isArray(input)) return [];
  // Facebook nests the ladder as [{ representations: [ {base_url,…}, … ] }];
  // older/other payloads are a flat rep array. Flatten both to a rep list.
  const reps: unknown[] = [];
  for (const el of input) {
    const inner = el && typeof el === 'object' ? (el as Record<string, unknown>).representations : undefined;
    if (Array.isArray(inner)) reps.push(...inner);
    else reps.push(el);
  }
  const parsed: Rep[] = [];
  for (const r of reps) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const url = typeof o.base_url === 'string' ? o.base_url : undefined;
    if (!url || !isFbcdn(url)) {
      diagBump('repNoFbcdnBase');
      continue; // only fbcdn representations (no SSRF via a forged BaseURL)
    }
    const mime = typeof o.mime_type === 'string' ? o.mime_type : '';
    const kind = kindOf(mime, o.codecs);
    if (!kind) {
      diagBump('unknownCodec');
      continue;
    }
    parsed.push({
      url: widenDashUrl(url),
      bandwidth: num(o.bandwidth) ?? num(o.bitrate) ?? 0,
      kind,
      height: num(o.height),
    });
  }
  return ladderPairs(parsed);
}

function isJsonWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function arrayStartAfterKey(text: string, keyEnd: number): number {
  let i = keyEnd;
  while (isJsonWhitespace(text[i])) i += 1;
  if (text[i] !== ':') return -1;
  i += 1;
  while (isJsonWhitespace(text[i])) i += 1;
  return text[i] === '[' ? i : -1;
}

/** Return the exclusive end of a JSON array, respecting nested arrays and strings. */
function balancedArrayEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  const limit = Math.min(text.length, start + MAX_PREFETCH_FRAGMENT_CHARS + 1);
  for (let i = start; i < limit; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Recover DASH ladders from an oversized raw GraphQL line without parsing the
 * entire line. A truncated/malformed occurrence is ignored, never thrown.
 */
export function extractPrefetchPairs(text: string): DashPair[] {
  const out: DashPair[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const keyAt = text.indexOf(PREFETCH_KEY, searchFrom);
    if (keyAt < 0) break;
    const keyEnd = keyAt + PREFETCH_KEY.length;
    searchFrom = keyEnd;
    const start = arrayStartAfterKey(text, keyEnd);
    if (start < 0) continue;
    const end = balancedArrayEnd(text, start);
    // Unterminated or over the fragment cap. Stop: searching the same suffix
    // again for another key would make repeated malformed occurrences O(n²),
    // and without an end boundary a later-looking key may be nested data.
    if (end < 0) break;
    searchFrom = end;
    try {
      out.push(...fromPrefetchReps(JSON.parse(text.slice(start, end))));
    } catch {
      // A balanced-looking but invalid fragment is no better than today's
      // skipped oversized line. Continue in case a later occurrence is valid.
    }
  }
  return out;
}

// A DASH ContentProtection element marks DRM. Check DIRECT children only:
// getElementsByTagName is a DESCENDANT query, so at AdaptationSet level it would also
// match a ContentProtection nested in a child Representation and wrongly drop the set's
// clear representations.
function hasDirectContentProtection(el: Element): boolean {
  return Array.from(el.getElementsByTagName('ContentProtection')).some((cp) => cp.parentNode === el);
}

/** DASH MPD XML string → pairs. Uses DOMParser; skips DRM representations. */
export function fromMpdXml(xml: string): DashPair[] {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    // Losing an MPD costs the WHOLE quality ladder, not one rung — worth
    // counting separately from the per-representation drops below.
    diagBump('mpdParseError');
    return [];
  }
  if (doc.getElementsByTagName('parsererror').length > 0) {
    diagBump('mpdParseError');
    return [];
  }

  const mpd = doc.getElementsByTagName('MPD')[0];
  const durationSec = parseIsoDuration(mpd?.getAttribute('mediaPresentationDuration') ?? null);

  const reps: Rep[] = [];
  for (const as of Array.from(doc.getElementsByTagName('AdaptationSet'))) {
    if (hasDirectContentProtection(as)) {
      diagBump('drmSkipped');
      continue; // DRM at AdaptationSet level
    }
    const asMime = as.getAttribute('mimeType') || as.getAttribute('contentType') || '';
    const asCodecs = as.getAttribute('codecs') || '';
    for (const rep of Array.from(as.getElementsByTagName('Representation'))) {
      if (hasDirectContentProtection(rep)) {
        diagBump('drmSkipped');
        continue; // DRM at Representation level
      }
      const mime = rep.getAttribute('mimeType') || asMime;
      const codecs = rep.getAttribute('codecs') || asCodecs;
      const kind = kindOf(mime, codecs);
      if (!kind) {
        diagBump('unknownCodec');
        continue;
      }
      const baseEls = rep.getElementsByTagName('BaseURL');
      const base = baseEls.length > 0 ? baseEls[0].textContent?.trim() : undefined;
      if (!base || !isFbcdn(base)) {
        diagBump('repNoFbcdnBase');
        continue; // only fbcdn representations (no SSRF via a forged BaseURL)
      }
      reps.push({
        url: widenDashUrl(base),
        bandwidth: num(rep.getAttribute('bandwidth')) ?? 0,
        kind,
        height: num(rep.getAttribute('height')),
      });
    }
  }
  return ladderPairs(reps, durationSec);
}

/** Decode a (possibly percent/plus-encoded and escaped) MPD string. */
export function decodeMpd(raw: string): string {
  let s = raw;
  if (!/^\s*<\??(xml|MPD)/i.test(s) && /%[0-9a-f]{2}/i.test(s)) {
    try {
      s = decodeURIComponent(s.replace(/\+/g, ' '));
    } catch {
      /* leave as-is */
    }
  }
  s = s.replace(/\\\//g, '/');
  // A real MPD keeps its &amp; entities — DOMParser rejects bare & in BaseURL
  // query strings. Only collapse &amp; for non-XML (double-escaped) payloads.
  if (!/^\s*<\??(xml|MPD)/i.test(s)) s = s.replace(/&amp;/g, '&');
  return s;
}
