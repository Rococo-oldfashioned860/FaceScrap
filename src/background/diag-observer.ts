import {
  DIAG_REASONS,
  sanitizeDiagCounters,
  type DiagCounters,
} from '../shared/diag';

const DEFAULT_INTERVAL_MS = 1_500;
const DEFAULT_MAX_TABS = 128;
const DEFAULT_MAX_COUNT = 1_000_000;

type TimerHandle = unknown;

export interface DiagObserverOptions {
  write: (delta: DiagCounters) => Promise<void>;
  drainWorker?: () => DiagCounters;
  intervalMs?: number;
  maxTabs?: number;
  maxCountPerReason?: number;
  schedule?: (task: () => void, delayMs: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
  onError?: (error: unknown) => void;
}

export interface DiagObserver {
  setEnabled(enabled: boolean): void;
  report(tabId: number, counters: unknown): boolean;
  removeTab(tabId: number): void;
  flush(): Promise<void>;
}

function addBounded(target: DiagCounters, source: DiagCounters, max: number): void {
  for (const reason of DIAG_REASONS) {
    const value = source[reason];
    if (value === undefined || value <= 0) continue;
    target[reason] = Math.min(max, (target[reason] ?? 0) + Math.min(value, max));
  }
}

/**
 * Coalesces renderer diagnostics before persistence. The scheduler is injected
 * so tests can drive flushes without real timers, and the receiver applies its
 * own whitelist/count bounds even when the content script already sanitized.
 */
export function createDiagObserver(options: DiagObserverOptions): DiagObserver {
  const intervalMs = Math.max(100, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const maxTabs = Math.max(1, options.maxTabs ?? DEFAULT_MAX_TABS);
  const maxCount = Math.max(1, options.maxCountPerReason ?? DEFAULT_MAX_COUNT);
  const schedule = options.schedule ?? ((task, delay) => setTimeout(task, delay));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const pending = new Map<number, DiagCounters>();
  let enabled = false;
  let timer: TimerHandle | undefined;
  let flushChain = Promise.resolve();

  const clearTimer = (): void => {
    if (timer === undefined) return;
    cancel(timer);
    timer = undefined;
  };

  const scheduleFlush = (): void => {
    if (!enabled || timer !== undefined) return;
    timer = schedule(() => {
      timer = undefined;
      void api.flush().catch((error) => options.onError?.(error));
    }, intervalMs);
  };

  const flushOnce = async (): Promise<void> => {
    clearTimer();
    if (!enabled) {
      pending.clear();
      options.drainWorker?.();
      return;
    }

    const aggregate: DiagCounters = {};
    for (const counters of pending.values()) addBounded(aggregate, counters, maxCount);
    pending.clear();
    addBounded(aggregate, sanitizeDiagCounters(options.drainWorker?.()), maxCount);
    if (Object.keys(aggregate).length > 0) {
      try {
        await options.write(aggregate);
      } catch (error) {
        // Diagnostics are best-effort, but a transient local-storage failure
        // should not make the coalescer itself lossy. A reserved internal bucket
        // retains the already-aggregated delta without expanding the tab map.
        const retry = pending.get(-1) ?? {};
        addBounded(retry, aggregate, maxCount);
        pending.set(-1, retry);
        scheduleFlush();
        throw error;
      }
    }
    if (pending.size > 0) scheduleFlush();
  };

  const api: DiagObserver = {
    setEnabled(on): void {
      enabled = on;
      if (on) return;
      clearTimer();
      pending.clear();
      options.drainWorker?.();
    },

    report(tabId, counters): boolean {
      if (!enabled || !Number.isInteger(tabId) || tabId < 0) return false;
      const clean = sanitizeDiagCounters(counters);
      if (Object.keys(clean).length === 0) return false;

      let tabCounters = pending.get(tabId);
      if (!tabCounters) {
        if (pending.size >= maxTabs) return false;
        tabCounters = {};
        pending.set(tabId, tabCounters);
      }
      addBounded(tabCounters, clean, maxCount);
      scheduleFlush();
      return true;
    },

    removeTab(tabId): void {
      pending.delete(tabId);
      if (pending.size === 0) clearTimer();
    },

    flush(): Promise<void> {
      flushChain = flushChain.then(flushOnce, flushOnce);
      return flushChain;
    },
  };

  return api;
}
