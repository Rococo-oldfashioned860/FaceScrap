import { widenDashUrl } from '../shared/media';

export interface RecentObserver {
  /** Returns the scheduled write, or undefined when the same canonical track
   *  is still the latest observation for this tab. */
  bump(tabId: number, url: string, documentId?: string): Promise<boolean> | undefined;
  /** Invalidate callbacks and dedupe state across a clear/navigation boundary. */
  reset(tabId: number): void;
}

interface RecentObserverOptions {
  now?: () => number;
  isDead?: (tabId: number) => boolean;
  onError?: (err: unknown) => void;
}

interface LatestObservation {
  generation: number;
  url: string;
  at: number;
  documentId?: string;
}

interface TabObservationState {
  epoch: number;
  nextGeneration: number;
  latest?: LatestObservation;
  activeByGeneration: Map<number, number>;
}

/** Per-tab acknowledgement-based dedupe for network track observations. A
 *  failed storage write never consumes the key, and a callback from before a
 *  clear cannot suppress the same track in the new page epoch. */
export function createRecentObserver(
  write: (tabId: number, url: string, at: number, documentId?: string) => Promise<boolean>,
  options: RecentObserverOptions = {},
): RecentObserver {
  const now = options.now ?? Date.now;
  const isDead = options.isDead ?? (() => false);
  const stateByTab = new Map<number, TabObservationState>();

  function stateFor(tabId: number): TabObservationState {
    let state = stateByTab.get(tabId);
    if (state == null) {
      state = { epoch: 0, nextGeneration: 0, activeByGeneration: new Map() };
      stateByTab.set(tabId, state);
    }
    return state;
  }

  function activeCount(state: TabObservationState, generation: number): number {
    return state.activeByGeneration.get(generation) ?? 0;
  }

  function schedule(
    tabId: number,
    state: TabObservationState,
    epoch: number,
    observation: LatestObservation,
  ): Promise<boolean> {
    state.activeByGeneration.set(observation.generation, activeCount(state, observation.generation) + 1);
    return (async () => {
      let ok = false;
      try {
        ok = await write(tabId, observation.url, observation.at, observation.documentId);
      } catch (err) {
        options.onError?.(err);
      }

      const remaining = activeCount(state, observation.generation) - 1;
      if (remaining > 0) state.activeByGeneration.set(observation.generation, remaining);
      else state.activeByGeneration.delete(observation.generation);

      if (state.epoch !== epoch || isDead(tabId)) return ok;
      const latest = state.latest;
      if (latest == null) return ok;

      if (!ok) {
        // Failure does not consume the newest observation. Only clear it after
        // its last attempt settles; an older failed callback must not make a
        // newer transition eligible as a false duplicate.
        if (latest.generation === observation.generation && activeCount(state, latest.generation) === 0) {
          state.latest = undefined;
        }
        return false;
      }

      if (latest.generation !== observation.generation && activeCount(state, latest.generation) === 0) {
        // This older write completed after the latest state had already
        // settled, so storage now contains the wrong track. Reassert the real
        // latest observation. If its own attempt is still running, that attempt
        // is already the required compensation and no duplicate is launched.
        void schedule(tabId, state, epoch, latest);
      }
      return true;
    })();
  }

  return {
    bump(tabId, url, documentId) {
      if (isDead(tabId)) return undefined;
      const widened = widenDashUrl(url);
      const state = stateFor(tabId);
      if (state.latest?.url === widened) return undefined;
      const observation = {
        generation: ++state.nextGeneration,
        url: widened,
        at: now(),
        documentId,
      };
      state.latest = observation;
      return schedule(tabId, state, state.epoch, observation);
    },

    reset(tabId) {
      const state = stateFor(tabId);
      state.epoch++;
      state.latest = undefined;
    },
  };
}
