export interface DownloadEvents {
  addListener(listener: (delta: chrome.downloads.DownloadDelta) => void): void;
  removeListener(listener: (delta: chrome.downloads.DownloadDelta) => void): void;
}

export interface DownloadSettlementApi {
  onChanged: DownloadEvents;
  search(query: chrome.downloads.DownloadQuery): Promise<chrome.downloads.DownloadItem[]>;
  cancel(downloadId: number): Promise<void>;
}

export interface DownloadSettlementOptions {
  /** Omit for ordinary network downloads, whose healthy duration is unbounded. */
  timeoutMs?: number;
  /** Cancel an in-progress download before exposing Retry after timeout. */
  cancelOnTimeout?: boolean;
}

export interface DashDownloadIdentity {
  tabId: number;
  receiptId: string;
  videoUrl: string;
  audioUrl: string;
  filename: string;
  saveAs: boolean;
}

/** Scope successful-download suppression to one logical request. The same
 * fbcdn representations can legitimately back different cards or tabs, so a
 * track-pair-only key would report a download that never ran for the latter. */
export function dashDownloadKey(identity: DashDownloadIdentity): string {
  return JSON.stringify([
    identity.tabId,
    identity.receiptId,
    identity.videoUrl,
    identity.audioUrl,
    identity.filename,
    identity.saveAs,
  ]);
}

export class DownloadInterruptedError extends Error {
  constructor(reason?: string) {
    super(reason ? `Download interrupted: ${reason}` : 'Download interrupted.');
    this.name = 'DownloadInterruptedError';
  }
}

function terminalError(state: string | undefined, reason?: string): Error | null | undefined {
  if (state === 'complete') return null;
  if (state === 'interrupted') return new DownloadInterruptedError(reason);
  return undefined;
}

/** Wait for the browser's terminal download state. downloads.download() only
 * confirms enqueue; Saved/dedup state must never advance on that weaker signal.
 * The listener is installed before search so a fast blob download cannot settle
 * in the gap, and every exit removes its listener/timer exactly once. */
export function waitForDownloadSettlement(
  api: DownloadSettlementApi,
  downloadId: number,
  options: DownloadSettlementOptions = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      api.onChanged.removeListener(onChanged);
      if (timer !== undefined) clearTimeout(timer);
      if (error == null) resolve();
      else reject(error);
    };

    const inspect = (item: chrome.downloads.DownloadItem | undefined): boolean => {
      const result = terminalError(item?.state, item?.error);
      if (result === undefined) return false;
      finish(result);
      return true;
    };

    const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== downloadId) return;
      const result = terminalError(delta.state?.current, delta.error?.current);
      if (result !== undefined) finish(result);
    };

    api.onChanged.addListener(onChanged);
    void api.search({ id: downloadId }).then((items) => inspect(items[0]), () => undefined);

    if (options.timeoutMs != null && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        void api.search({ id: downloadId }).then(
          async (items) => {
            if (inspect(items[0]) || settled) return;
            if (options.cancelOnTimeout && items[0]?.state === 'in_progress') {
              await api.cancel(downloadId).catch(() => {});
            }
            finish(new Error('Download settlement timed out.'));
          },
          () => finish(new Error('Download settlement timed out.')),
        );
      }, options.timeoutMs);
    }
  });
}
