// Opt-in discard counters. Every capture path in this extension swallows its
// failures on purpose — the page hook must never break Facebook, so it is
// wrapped in silent catches, and the queue/size caps drop whole GraphQL bodies
// without a trace. That leaves no way to answer "why did this video never reach
// the panel?", which is exactly the question maintenance keeps asking.
//
// No chrome.* here: this file is bundled into the MAIN-world page hook too, and
// that context has no extension APIs. The flag arrives by message instead (see
// content.ts), and drained counts ride the same channel back out.

export type DiagReason =
  // --- discards: page hook (GraphQL capture) ---
  /** Response body past MAX_BODY_BYTES — the whole GraphQL body is dropped. */
  | 'graphqlBodyTooLarge'
  /** A queued scan was evicted under burst load: one whole response lost. */
  | 'scanQueueEvicted'
  /** JSON line past MAX_JSON_LINE — structured parse skipped for that line. */
  | 'jsonLineTooLarge'
  /** A line failed JSON.parse (partial/non-JSON chunk). */
  | 'jsonLineParseError'
  /** harvest() hit its depth cap and stopped descending. */
  | 'harvestDepthExceeded'
  /** A scan reached its aggregate emitted-item/count budget. */
  | 'scanOutputCapped'
  /** Embedded document scripts exceeded their aggregate text budget. */
  | 'documentScanCapped'
  // --- discards: DASH parsing ---
  /** Representation dropped: mime/codecs matched neither video nor audio. */
  | 'unknownCodec'
  /** An MPD failed to parse — the whole quality ladder is lost, not one rung. */
  | 'mpdParseError'
  /** DRM-protected AdaptationSet/Representation skipped (expected, not a bug). */
  | 'drmSkipped'
  /** Representation dropped: BaseURL missing or not fbcdn. */
  | 'repNoFbcdnBase'
  // --- discards: storage retention ---
  /** Oldest captures spliced off at the per-tab maxItems cap. */
  | 'storageMaxItemsEvicted'
  /** Globally-oldest safe captures dropped after a shared storage quota failure. */
  | 'storageQuotaEvicted'
  // --- successes, so the discards above can be read as a ratio ---
  | 'captureGraphql'
  | 'captureDom'
  | 'captureNetwork';

export const DIAG_REASONS: readonly DiagReason[] = [
  'graphqlBodyTooLarge',
  'scanQueueEvicted',
  'jsonLineTooLarge',
  'jsonLineParseError',
  'harvestDepthExceeded',
  'scanOutputCapped',
  'documentScanCapped',
  'unknownCodec',
  'mpdParseError',
  'drmSkipped',
  'repNoFbcdnBase',
  'storageMaxItemsEvicted',
  'storageQuotaEvicted',
  'captureGraphql',
  'captureDom',
  'captureNetwork',
];

export type DiagCounters = Partial<Record<DiagReason, number>>;

let enabled = false;
const counters = new Map<DiagReason, number>();

/** Turning diagnostics OFF also clears the counts. The flag reaches the page
 *  hook asynchronously, so anything counted before it was confirmed belongs to
 *  an unknown window and would silently skew the first report. */
export function setDiagEnabled(on: boolean): void {
  enabled = on;
  counters.clear();
}

/** The enabled check lives HERE, not at the ~15 call sites, so instrumenting a
 *  new discard is a one-line edit. Call sites sit inside branches that are
 *  already rare (a catch, a size cap, an unparseable codec) — never in
 *  harvest()'s success path, which walks hundreds of thousands of nodes per
 *  reels-feed response. Disabled cost is one boolean compare. */
export function diagBump(reason: DiagReason, n = 1): void {
  if (!enabled) return;
  counters.set(reason, (counters.get(reason) ?? 0) + n);
}

export function diagSnapshot(): DiagCounters {
  return Object.fromEntries(counters) as DiagCounters;
}

/** Read and reset — used at the page hook's flush points, so a count is
 *  reported exactly once even though several contexts report independently. */
export function diagDrain(): DiagCounters {
  const out = diagSnapshot();
  counters.clear();
  return out;
}

/** Counters crossing a world boundary are page-supplied data. Re-validate at the
 *  receiver even though the sender built them, same defence-in-depth as
 *  sanitizeIncomingItems in media.ts: a compromised renderer shares a process
 *  with the page hook. The known-reason whitelist also bounds the result size. */
export function sanitizeDiagCounters(raw: unknown): DiagCounters {
  if (!raw || typeof raw !== 'object') return {};
  const out: DiagCounters = {};
  const record = raw as Record<string, unknown>;
  // Read only the fixed whitelist. Object.entries(raw) made work proportional
  // to every attacker-supplied property even though unknown keys were dropped.
  for (const key of DIAG_REASONS) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) continue;
    out[key] = value;
  }
  return out;
}
