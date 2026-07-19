// Typed chrome.runtime protocol shared by the four extension contexts
// (content script → service worker, side panel → service worker, service
// worker → offscreen). Senders annotate their literals against these shapes,
// so renaming or reshaping a message breaks compilation on both ends instead
// of failing silently across a context boundary. Receivers keep their runtime
// field validation where the sender is less trusted: a content script shares
// a process with the page, so the worker never believes these types blindly.

import type { DiagCounters } from './diag';
import type { MediaItem } from './media';
import type { BindRecord, BindState, SavedEntry } from './storage';

/** content script → service worker: sanitized captures relayed from the page. */
export interface MediaFoundMsg {
  type: 'MEDIA_FOUND';
  items: MediaItem[];
  /** Per-content-context nonce; worker uses sender.documentId when available
   *  and this as a browser-compatibility fallback across navigation races. */
  documentToken?: string;
}

/** The worker acknowledges MEDIA_FOUND only after addMedia has durably stored
 *  the sanitized batch. Content keeps an unacknowledged batch queued. */
export type MediaFoundAck =
  | { ok: true }
  | { ok: false; retryable: boolean; error?: string };

/** content script → service worker: the now-playing signal set. */
export interface NowPlayingMsg {
  type: 'NOW_PLAYING';
  /** mediaId()s of the media under the viewport centre. */
  ids: string[];
  hasVideo: boolean;
  /** URL/DOM-derived video id on reel/watch surfaces — the exact anchor. */
  vid?: string;
  /** Centered cover URLs (the worker re-validates fbcdn before storing). */
  covers?: string[];
  /** Opaque slide marker — compared only, never fetched. */
  mark?: string;
  /** Timestamp taken in the content script when the DOM signal was observed.
   *  The worker validates it before using it, so message-queue latency cannot
   *  move the slide boundary after the media requests it is meant to anchor. */
  detectedAt?: number;
  documentToken?: string;
}

/** Worker acknowledgement for NOW_PLAYING. Content commits its dedupe key only
 *  after ok:true; retryable failures preserve the original detectedAt. */
export type NowPlayingAck =
  | { ok: true }
  | { ok: false; retryable: boolean; error?: string };

// Preserve the detector's real boundary through ordinary renderer/IPC stalls.
// A delayed but valid timestamp is much safer than re-stamping it at receipt,
// which would make neighbour traffic look post-slide. The storage layer also
// rejects an older boundary once a newer one has landed for the same tab.
const MAX_PLAYING_MESSAGE_DELAY_MS = 30_000;
export const MAX_PLAYING_FUTURE_SKEW_MS = 1_000;
const PLAYING_TIME_EPSILON_MS = 0.001;

/** True when a stored timestamp belongs to an older wall-clock epoch. This is
 * deliberately based on worker receive time, not another renderer timestamp:
 * ordinary out-of-order messages remain monotonic, while a system clock
 * rollback cannot strand a future PlayingRef until wall time catches up. */
export function playingTimestampIsFutureEpoch(storedAt: number, receivedAt: number): boolean {
  return Number.isFinite(storedAt) &&
    Number.isFinite(receivedAt) &&
    storedAt > receivedAt + MAX_PLAYING_FUTURE_SKEW_MS;
}

/** Date.now() has millisecond resolution, but two different slides can be
 *  observed within one event-loop millisecond. Give each emitted boundary a
 *  strictly increasing value so storage's monotonic guard can order them. */
export function nextPlayingDetectedAt(previous: number, wallNow: number): number {
  if (!Number.isFinite(previous)) return wallNow;
  // A manual/system clock rollback larger than the worker's accepted future
  // skew must not strand the content script emitting permanently-invalid
  // timestamps until wall time catches up.
  if (playingTimestampIsFutureEpoch(previous, wallNow)) return wallNow;
  return previous >= wallNow ? previous + PLAYING_TIME_EPSILON_MS : wallNow;
}

/** Validate an untrusted content-script timestamp against worker receive time. */
export function normalizePlayingDetectedAt(raw: unknown, receivedAt: number): number | undefined {
  // Compatibility with an older content script that has not reloaded yet.
  if (raw === undefined) return receivedAt;
  // A present-but-invalid timestamp must not be silently rewritten into a
  // plausible current boundary. Ignore that NOW_PLAYING message instead.
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  if (playingTimestampIsFutureEpoch(raw, receivedAt)) return undefined;
  if (receivedAt - raw > MAX_PLAYING_MESSAGE_DELAY_MS) return undefined;
  return raw;
}

/** How long the panel waits WITHOUT PROGRESS on FACESCRAP_DOWNLOAD_DASH before
 *  giving up. Idle, not wall-clock, for the same reason the worker's own budget
 *  is (see MUX_IDLE_MS): a large track on a slow link is healthy, and a fixed
 *  deadline reports it as failed while it is still downloading. The worker
 *  forwards mux progress here (MuxProgressMsg) to keep this clock alive. */
export const DASH_UI_IDLE_MS = 360_000;

/** Absolute ceiling on one panel-side wait. Sits above the worker's own hard cap
 *  so the worker always gets to report a real result first; this only fires if
 *  the worker died without answering at all. */
export const DASH_UI_HARD_CAP_MS = 35 * 60_000;

/** service worker → side panel: mux progress, forwarded from the offscreen port.
 *  Fire-and-forget — with no panel open, sendMessage simply has no receiver. */
export interface MuxProgressMsg extends MuxProgress {
  type: 'FACESCRAP_MUX_PROGRESS';
}

/** side panel → service worker: remux a DASH pair and download the result. */
export interface DownloadDashMsg {
  type: 'FACESCRAP_DOWNLOAD_DASH';
  tabId: number;
  videoUrl: string;
  audioUrl: string;
  filename: string;
  saveAs?: boolean;
  receipt: SavedEntry;
}
export type DownloadDashResponse = { ok: true } | { ok: false; error: string };

/** Direct downloads use the same worker-owned terminal settlement + durable
 * receipt path as DASH, so closing the panel cannot lose success/failure. */
export interface DownloadDirectMsg {
  type: 'FACESCRAP_DOWNLOAD_DIRECT';
  tabId: number;
  url: string;
  filename: string;
  saveAs?: boolean;
  receipt: SavedEntry;
}
export type DownloadDirectResponse = DownloadDashResponse;

/** service worker → offscreen: fetch and remux one (video, audio) track pair. */
export interface MuxMsg {
  type: 'FACESCRAP_MUX';
  videoUrl: string;
  audioUrl: string;
}
export type MuxResponse = { ok: true; blobUrl: string } | { ok: false; error: string };

/** offscreen → service worker: a long-lived port carrying mux progress.
 *
 *  A one-shot sendMessage gives the worker exactly one event — the answer — so
 *  its only way to notice a wedged job was a wall-clock deadline, which cannot
 *  tell "wedged" from "large file on a slow link" and killed the latter. A port
 *  turns progress into events the worker can time against, and its disconnect
 *  reports an offscreen document that died outright, which no timer detects. */
export const MUX_PORT = 'facescrap-mux';

/** One progress report. `bytes` is cumulative for the whole job. */
export interface MuxProgress {
  phase: 'fetch' | 'remux';
  bytes: number;
}

/** How often the offscreen reports. Must stay well under MUX_IDLE_MS. */
export const MUX_PROGRESS_MS = 2_000;

/** service worker → offscreen: release a published blob once its download settled. */
export interface RevokeMsg {
  type: 'FACESCRAP_REVOKE';
  blobUrl: string;
}

/**
 * side panel → service worker: wipe all captured state for a tab. Routed through
 * the worker on purpose — a panel-side clearTab() runs in a SEPARATE JS context
 * whose serial write queue cannot order against the worker's in-flight capture
 * writes, so a removal could land between an addMedia read and its write and the
 * wiped list would resurrect. Handling it in the worker puts the removal on the
 * same enqueueWrite chain as addMedia.
 */
export interface ClearTabMsg {
  type: 'FACESCRAP_CLEAR_TAB';
  tabId: number;
}

/** side panel -> service worker: commit one immutable learned-binding snapshot.
 * The worker acknowledges only after the versioned record is durable. */
export interface PersistBindingsMsg {
  type: 'FACESCRAP_PERSIST_BINDINGS';
  tabId: number;
  generation: number;
  baseRevision: number;
  state: BindState;
}

export type PersistBindingsAck =
  | { ok: true; generation: number; revision: number }
  | { ok: false; retryable: boolean; error?: string; conflict?: BindRecord };

/** side panel → service worker: reserve groups that selectPlaying confirmed for
 *  one DOM-proven Story. The worker serializes this with addMedia so a cap/quota
 *  eviction cannot race ahead of the confirmation. The pin is retention-only. */
export interface PinPlayingMediaMsg {
  type: 'FACESCRAP_PIN_PLAYING_MEDIA';
  tabId: number;
  identity: string;
  groups: string[];
  playingAt: number;
}

/** content script → service worker: discard counts drained from the page hook
 *  and the DOM scan. Only the worker can persist them — neither the MAIN world
 *  nor a content script may write the extension's storage directly. */
export interface DiagReportMsg {
  type: 'DIAG_REPORT';
  counters: DiagCounters;
  documentToken?: string;
}

export type RuntimeMessage =
  | MediaFoundMsg
  | NowPlayingMsg
  | DownloadDashMsg
  | DownloadDirectMsg
  | MuxMsg
  | MuxProgressMsg
  | RevokeMsg
  | ClearTabMsg
  | PersistBindingsMsg
  | PinPlayingMediaMsg
  | DiagReportMsg;
