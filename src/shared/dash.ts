// Pure DASH helpers: turn Facebook's prefetch representations or a DASH MPD
// XML string into linked { videoUrl, audioUrl } pairs — one per video quality
// in the ladder, each linked to the best audio representation.
// No chrome.* — imported only by the MAIN-world page hook (which has DOMParser).
// DRM-protected representations are skipped (they cannot be remuxed/decrypted).

import { isFbcdn, widenDashUrl } from './media';

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
    if (!url || !isFbcdn(url)) continue; // only fbcdn representations (no SSRF via a forged BaseURL)
    const mime = typeof o.mime_type === 'string' ? o.mime_type : '';
    const kind = kindOf(mime, o.codecs);
    if (!kind) continue;
    parsed.push({
      url: widenDashUrl(url),
      bandwidth: num(o.bandwidth) ?? num(o.bitrate) ?? 0,
      kind,
      height: num(o.height),
    });
  }
  return ladderPairs(parsed);
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
    return [];
  }
  if (doc.getElementsByTagName('parsererror').length > 0) return [];

  const mpd = doc.getElementsByTagName('MPD')[0];
  const durationSec = parseIsoDuration(mpd?.getAttribute('mediaPresentationDuration') ?? null);

  const reps: Rep[] = [];
  for (const as of Array.from(doc.getElementsByTagName('AdaptationSet'))) {
    if (hasDirectContentProtection(as)) continue; // DRM at AdaptationSet level
    const asMime = as.getAttribute('mimeType') || as.getAttribute('contentType') || '';
    const asCodecs = as.getAttribute('codecs') || '';
    for (const rep of Array.from(as.getElementsByTagName('Representation'))) {
      if (hasDirectContentProtection(rep)) continue; // DRM at Representation level
      const mime = rep.getAttribute('mimeType') || asMime;
      const codecs = rep.getAttribute('codecs') || asCodecs;
      const kind = kindOf(mime, codecs);
      if (!kind) continue;
      const baseEls = rep.getElementsByTagName('BaseURL');
      const base = baseEls.length > 0 ? baseEls[0].textContent?.trim() : undefined;
      if (!base || !isFbcdn(base)) continue; // only fbcdn representations (no SSRF via a forged BaseURL)
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
