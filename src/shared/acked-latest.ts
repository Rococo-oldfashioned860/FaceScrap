/** Outcome of delivering one latest-state observation. `retry` preserves the
 *  exact payload; `refresh` discards it so the next poll can timestamp a new
 *  observation after a terminal expiry/validation failure. */
export type AckedLatestOutcome = 'accepted' | 'retry' | 'refresh';

interface Pending<T> {
  key: string;
  value: T;
  inFlight: boolean;
}

export interface AckedLatest<T> {
  /** Offer the currently observed logical state. Returns false only when that
   *  exact key is already committed. A repeated pending key keeps its original
   *  payload (notably its detection timestamp). */
  offer(key: string, value: T): boolean;
  /** Attempt the latest uncommitted state once. Concurrent pumps collapse. */
  pump(send: (value: T) => Promise<AckedLatestOutcome>): Promise<void>;
  /** Force the current DOM state to be reasserted, while preserving an existing
   *  in-flight/retry payload for that same state. */
  invalidateCommitted(): void;
}

/** Latest-state delivery with acknowledgement-based deduplication. A new state
 *  supersedes an older in-flight one; the older callback cannot commit because
 *  it no longer owns `pending`. */
export function createAckedLatest<T>(): AckedLatest<T> {
  let committedKey = '';
  let pending: Pending<T> | undefined;

  return {
    offer(key, value) {
      if (key === committedKey) {
        // The DOM returned to the committed state while another state was in
        // flight. Its remote side effect cannot be cancelled: replace it with a
        // fresh compensating delivery of this state, so B cannot land after an
        // A→B→A transition and leave storage stuck on B.
        if (pending != null && pending.key !== key) {
          pending = { key, value, inFlight: false };
          return true;
        }
        return false;
      }
      if (pending?.key !== key) pending = { key, value, inFlight: false };
      return true;
    },

    async pump(send) {
      const entry = pending;
      if (entry == null || entry.inFlight) return;
      entry.inFlight = true;
      let outcome: AckedLatestOutcome = 'retry';
      try {
        outcome = await send(entry.value);
      } catch {
        // Transport errors are retryable. The caller controls cadence (the DOM
        // detector's poll), so no timer has to survive MV3 suspension here.
      }
      if (pending !== entry) return;
      entry.inFlight = false;
      if (outcome === 'accepted') {
        committedKey = entry.key;
        pending = undefined;
      } else if (outcome === 'refresh') {
        pending = undefined;
      }
    },

    invalidateCommitted() {
      committedKey = '';
    },
  };
}
