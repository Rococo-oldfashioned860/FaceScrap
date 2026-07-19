/**
 * Guards capture writes across the MV3 worker start-up boundary. A tab can
 * close while listeners are awaiting storage initialization; checking only
 * before that await lets the delayed write land after purgeTab and resurrect
 * orphaned state.
 */
export class ClosedTabError extends Error {
  constructor() {
    super('Invalid or closed sender tab.');
    this.name = 'ClosedTabError';
  }
}

export class StaleTabEpochError extends Error {
  constructor() {
    super('Capture belongs to an earlier tab navigation generation.');
    this.name = 'StaleTabEpochError';
  }
}

export class StaleDocumentError extends Error {
  constructor() {
    super('Capture belongs to a stale tab document.');
    this.name = 'StaleDocumentError';
  }
}

export class NavigationPendingError extends Error {
  constructor() {
    super('The tab is committing a new document.');
    this.name = 'NavigationPendingError';
  }
}

interface TabContext {
  epoch: number;
  documentId?: string;
  previousDocumentId?: string;
  navigationPending: boolean;
  staleDocuments: string[];
}

export interface TabLifecycle {
  isDead(tabId: number): boolean;
  markDead(tabId: number): void;
  /**
   * Advance the tab generation before a clear/navigation is queued. Keeping the
   * document lets a user-initiated Clear accept later observations from the
   * still-open page; replacing it permanently rejects messages from the old
   * document after a top-level navigation.
   */
  invalidate(tabId: number, replaceDocument: boolean): void;
  /** Begin a real top-level navigation. New-document messages wait for commit;
   *  already accepted viewer-prefetch work may optionally remain valid. */
  beginNavigation(tabId: number, cancelAcceptedWork: boolean): void;
  commitDocument(tabId: number, documentId?: string): void;
  abortNavigation(tabId: number): void;
  /** Claim/check a content-script document for non-persistent diagnostics. */
  acceptDocument(tabId: number, documentId?: string): boolean;
  runIfLive<T>(tabId: number, task: () => T | Promise<T>, documentId?: string): Promise<T>;
}

export function createTabLifecycle(ready: Promise<unknown>, maxDeadTabs = 4096): TabLifecycle {
  const deadTabs = new Set<number>();
  const contexts = new Map<number, TabContext>();
  const boundedMax = Math.max(1, Math.floor(maxDeadTabs));

  const contextFor = (tabId: number): TabContext => {
    let context = contexts.get(tabId);
    if (context == null) {
      context = { epoch: 0, navigationPending: false, staleDocuments: [] };
      contexts.set(tabId, context);
    }
    return context;
  };

  const claimDocument = (context: TabContext, documentId?: string): boolean => {
    if (documentId == null) return true;
    if (context.navigationPending) throw new NavigationPendingError();
    if (context.documentId === documentId) return true;
    if (context.documentId != null || context.staleDocuments.includes(documentId)) return false;
    context.documentId = documentId;
    return true;
  };

  const retireDocument = (context: TabContext): void => {
    if (context.documentId == null) return;
    context.staleDocuments.push(context.documentId);
    if (context.staleDocuments.length > 8) context.staleDocuments.shift();
    context.documentId = undefined;
  };

  return {
    isDead(tabId) {
      return deadTabs.has(tabId);
    },

    markDead(tabId) {
      deadTabs.add(tabId);
      contexts.delete(tabId);
      while (deadTabs.size > boundedMax) {
        const oldest = deadTabs.values().next().value as number | undefined;
        if (oldest == null) break;
        deadTabs.delete(oldest);
      }
    },

    invalidate(tabId, replaceDocument) {
      if (deadTabs.has(tabId)) return;
      const context = contextFor(tabId);
      context.epoch++;
      if (replaceDocument) retireDocument(context);
    },

    beginNavigation(tabId, cancelAcceptedWork) {
      if (deadTabs.has(tabId)) return;
      const context = contextFor(tabId);
      if (!context.navigationPending) context.previousDocumentId = context.documentId;
      if (cancelAcceptedWork) context.epoch++;
      retireDocument(context);
      context.navigationPending = true;
    },

    commitDocument(tabId, documentId) {
      if (deadTabs.has(tabId)) return;
      const context = contextFor(tabId);
      context.navigationPending = false;
      context.previousDocumentId = undefined;
      if (documentId == null) return;
      context.staleDocuments = context.staleDocuments.filter((id) => id !== documentId);
      context.documentId = documentId;
    },

    abortNavigation(tabId) {
      if (deadTabs.has(tabId)) return;
      const context = contextFor(tabId);
      context.navigationPending = false;
      if (context.previousDocumentId != null) {
        context.staleDocuments = context.staleDocuments.filter((id) => id !== context.previousDocumentId);
        context.documentId = context.previousDocumentId;
      }
      context.previousDocumentId = undefined;
    },

    acceptDocument(tabId, documentId) {
      if (deadTabs.has(tabId)) return false;
      try {
        return claimDocument(contextFor(tabId), documentId);
      } catch {
        return false;
      }
    },

    async runIfLive(tabId, task, documentId) {
      if (deadTabs.has(tabId)) throw new ClosedTabError();
      const context = contextFor(tabId);
      if (!claimDocument(context, documentId)) throw new StaleDocumentError();
      const epoch = context.epoch;
      await ready;
      // This second check is the important one: the tab may have closed while
      // the service worker was waiting for its control-plane reserve.
      if (deadTabs.has(tabId)) throw new ClosedTabError();
      const current = contexts.get(tabId);
      if (current !== context || current.epoch !== epoch) throw new StaleTabEpochError();
      // Invoke synchronously after the check. Storage functions enqueue their
      // write before yielding, so a later purge is ordered behind this task.
      return task();
    },
  };
}
