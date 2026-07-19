export interface TokenBudgetOptions {
  capacityItems: number;
  capacityBytes: number;
  refillItemsPerMs: number;
  refillBytesPerMs: number;
  now?: number;
}

export interface TokenBudget {
  tryTake(items: number, bytes: number, now: number): boolean;
  readonly remainingItems: number;
  readonly remainingBytes: number;
}

// One bounded page-hook scan may legitimately emit 2,500 items / 16 MiB, and a
// rapid route change can finish an old scan immediately before the new page's
// scan. Admit that bounded two-scan producer burst so ingress never rejects the
// newest tail; the separate ACK queue remains capped at 2,000 / 8 MiB and sheds
// oldest work under pressure.
export const MEDIA_INGRESS_CAPACITY_ITEMS = 5_000;
export const MEDIA_INGRESS_CAPACITY_BYTES = 32 * 1024 * 1024;
const MEDIA_INGRESS_REFILL_MS = 20_000;

export function createMediaIngressBudget(now: number): TokenBudget {
  return createTokenBudget({
    capacityItems: MEDIA_INGRESS_CAPACITY_ITEMS,
    capacityBytes: MEDIA_INGRESS_CAPACITY_BYTES,
    refillItemsPerMs: MEDIA_INGRESS_CAPACITY_ITEMS / MEDIA_INGRESS_REFILL_MS,
    refillBytesPerMs: MEDIA_INGRESS_CAPACITY_BYTES / MEDIA_INGRESS_REFILL_MS,
    now,
  });
}

export function createNavIngressBudget(now: number): TokenBudget {
  return createTokenBudget({
    capacityItems: 3,
    capacityBytes: 3,
    refillItemsPerMs: 1 / 2_000,
    refillBytesPerMs: 1 / 2_000,
    now,
  });
}

/** A deterministic two-dimensional token bucket. Callers charge only bounded,
 * sanitized values so calculating the item/byte cost cannot itself become an
 * attacker-controlled scan of an unbounded page payload. */
export function createTokenBudget(options: TokenBudgetOptions): TokenBudget {
  let remainingItems = options.capacityItems;
  let remainingBytes = options.capacityBytes;
  let updatedAt = options.now ?? 0;

  const refill = (now: number): void => {
    if (!Number.isFinite(now) || now <= updatedAt) return;
    const elapsed = now - updatedAt;
    updatedAt = now;
    remainingItems = Math.min(
      options.capacityItems,
      remainingItems + elapsed * options.refillItemsPerMs,
    );
    remainingBytes = Math.min(
      options.capacityBytes,
      remainingBytes + elapsed * options.refillBytesPerMs,
    );
  };

  return {
    tryTake(items, bytes, now) {
      if (
        !Number.isFinite(items) ||
        !Number.isFinite(bytes) ||
        items < 0 ||
        bytes < 0 ||
        items > options.capacityItems ||
        bytes > options.capacityBytes
      ) {
        return false;
      }
      refill(now);
      // Fractional refill rates can land a few ULPs below an exact full bucket
      // (for example 24 MiB over 20 s). Treat only a material deficit as empty;
      // otherwise a legitimate request exactly at the documented cap would be
      // rejected depending on floating-point rounding.
      const itemTolerance = Number.EPSILON * Math.max(1, options.capacityItems) * 4;
      const byteTolerance = Number.EPSILON * Math.max(1, options.capacityBytes) * 4;
      if (items - remainingItems > itemTolerance || bytes - remainingBytes > byteTolerance) return false;
      remainingItems = Math.max(0, remainingItems - items);
      remainingBytes = Math.max(0, remainingBytes - bytes);
      return true;
    },
    get remainingItems() {
      return remainingItems;
    },
    get remainingBytes() {
      return remainingBytes;
    },
  };
}

export interface CounterCoalescer<K extends string> {
  add(counters: Readonly<Partial<Record<K, number>>>): void;
  drain(): Partial<Record<K, number>>;
}

/** Accumulates already-sanitized counters and saturates instead of overflowing
 * Number.MAX_SAFE_INTEGER. Scheduling is intentionally left to the caller. */
export function createCounterCoalescer<K extends string>(): CounterCoalescer<K> {
  let pending: Partial<Record<K, number>> = {};
  return {
    add(counters) {
      for (const key of Object.keys(counters) as K[]) {
        const value = counters[key];
        if (value === undefined || value <= 0 || !Number.isSafeInteger(value)) continue;
        pending[key] = Math.min(Number.MAX_SAFE_INTEGER, (pending[key] ?? 0) + value);
      }
    },
    drain() {
      const drained = pending;
      pending = {};
      return drained;
    },
  };
}
