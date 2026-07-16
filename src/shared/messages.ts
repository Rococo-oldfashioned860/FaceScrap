// Typed chrome.runtime protocol shared by the four extension contexts
// (content script → service worker, side panel → service worker, service
// worker → offscreen). Senders annotate their literals against these shapes,
// so renaming or reshaping a message breaks compilation on both ends instead
// of failing silently across a context boundary. Receivers keep their runtime
// field validation where the sender is less trusted: a content script shares
// a process with the page, so the worker never believes these types blindly.

import type { MediaItem } from './media';

/** content script → service worker: sanitized captures relayed from the page. */
export interface MediaFoundMsg {
  type: 'MEDIA_FOUND';
  items: MediaItem[];
}

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
}

/** side panel → service worker: remux a DASH pair and download the result. */
export interface DownloadDashMsg {
  type: 'FACESCRAP_DOWNLOAD_DASH';
  videoUrl: string;
  audioUrl: string;
  filename: string;
  saveAs?: boolean;
}
export type DownloadDashResponse = { ok: true } | { ok: false; error: string };

/** service worker → offscreen: fetch and remux one (video, audio) track pair. */
export interface MuxMsg {
  type: 'FACESCRAP_MUX';
  videoUrl: string;
  audioUrl: string;
}
export type MuxResponse = { ok: true; blobUrl: string } | { ok: false; error: string };

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
export type ClearTabResponse = { ok: true } | { ok: false; error: string };

export type RuntimeMessage = MediaFoundMsg | NowPlayingMsg | DownloadDashMsg | MuxMsg | RevokeMsg | ClearTabMsg;
