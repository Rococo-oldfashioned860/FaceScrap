export interface AckedBatchOptions<T, K = never> {
  /** Maximum number of items passed to one send call. */
  maxBatch: number;
  /** Hard bound for queued items, including the batch currently in flight. */
  maxPending: number;
  /** Optional approximate serialized weight for one item. */
  weight?: (item: T) => number;
  /** Optional maximum combined weight passed to one send call. */
  maxBatchWeight?: number;
  /** Optional hard bound for the combined weight of all queued items. */
  maxPendingWeight?: number;
  /** Optional logical identity used to deduplicate pending items. */
  key?: (item: T) => K;
  /** Combines a queued item with a newer item of the same key. */
  merge?: (queued: T, incoming: T) => T;
  /** Which unique item loses when the bounded queue is full. In-flight items
   *  are immutable and are never eligible for oldest eviction. */
  overflow?: 'drop-newest' | 'drop-oldest';
  /** Halve a rejected multi-item front batch on its next delivery attempt. */
  splitOnFailure?: boolean;
  /** Move a repeatedly rejected single item behind newer queued work. */
  rotateAfterFailures?: number;
}

export interface EnqueueResult {
  added: number;
  merged: number;
  /** Unique items or updates discarded after the queue reached a bound. */
  dropped: number;
}

export interface AckedBatch<T> {
  enqueue(item: T): EnqueueResult;
  enqueueMany(items: Iterable<T>): EnqueueResult;
  /**
   * Drains complete batches in FIFO order. The front batch is removed only
   * after `send` resolves true. A false acknowledgement or exception stops the
   * drain. With adaptive failure handling enabled, a rejected batch is split
   * on its next pump and an irreducible item can rotate behind newer work.
   * Concurrent calls share the same drain operation.
   */
  pump(send: (batch: readonly T[]) => Promise<boolean>): Promise<boolean>;
  readonly pending: number;
  readonly pendingWeight: number;
}

interface QueueEntry<T> {
  item: T;
  weight: number;
  failures: number;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function positiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

/**
 * Bounded, acknowledgement-driven batch delivery.
 *
 * When deduplication is enabled, the in-flight prefix is deliberately excluded
 * from merging and eviction: it is the immutable payload awaiting
 * acknowledgement. A new value with the same key is queued behind it, so
 * accepting the older batch cannot discard an update that arrived meanwhile.
 */
export function createAckedBatch<T, K = never>(options: AckedBatchOptions<T, K>): AckedBatch<T> {
  positiveInteger(options.maxBatch, 'maxBatch');
  positiveInteger(options.maxPending, 'maxPending');
  if (options.maxBatchWeight != null) positiveFinite(options.maxBatchWeight, 'maxBatchWeight');
  if (options.maxPendingWeight != null) positiveFinite(options.maxPendingWeight, 'maxPendingWeight');
  if (options.rotateAfterFailures != null) positiveInteger(options.rotateAfterFailures, 'rotateAfterFailures');

  const queue: QueueEntry<T>[] = [];
  let totalWeight = 0;
  let inFlightCount = 0;
  let retryBatchLimit: number | undefined;
  let activePump: Promise<boolean> | undefined;

  const weigh = (item: T): number => {
    const value = options.weight?.(item) ?? 1;
    if (!Number.isFinite(value) || value < 0) throw new RangeError('weight(item) must be a finite non-negative number');
    return value;
  };

  const removeAt = (index: number): QueueEntry<T> => {
    const [removed] = queue.splice(index, 1);
    totalWeight -= removed.weight;
    return removed;
  };

  const hasRoom = (additionalWeight: number): boolean =>
    queue.length < options.maxPending &&
    totalWeight + additionalWeight <= (options.maxPendingWeight ?? Number.POSITIVE_INFINITY);

  const makeRoom = (additionalWeight: number, result: EnqueueResult): boolean => {
    // A single item that can never satisfy the pending-weight invariant must
    // not evict healthy queued work before being rejected itself.
    if (additionalWeight > (options.maxPendingWeight ?? Number.POSITIVE_INFINITY)) return false;
    while (!hasRoom(additionalWeight)) {
      if (options.overflow !== 'drop-oldest' || inFlightCount >= queue.length) return false;
      removeAt(inFlightCount);
      result.dropped++;
    }
    return true;
  };

  const enqueueMany = (items: Iterable<T>): EnqueueResult => {
    const result: EnqueueResult = { added: 0, merged: 0, dropped: 0 };

    for (const incoming of items) {
      const incomingWeight = weigh(incoming);
      if (options.key != null) {
        const incomingKey = options.key(incoming);
        let match = -1;
        for (let index = inFlightCount; index < queue.length; index++) {
          if (Object.is(options.key(queue[index].item), incomingKey)) {
            match = index;
            break;
          }
        }
        if (match >= 0) {
          const matchedEntry = queue[match];
          const merged = options.merge?.(matchedEntry.item, incoming) ?? matchedEntry.item;
          const mergedWeight = weigh(merged);
          const delta = mergedWeight - matchedEntry.weight;
          const pendingWeightLimit = options.maxPendingWeight ?? Number.POSITIVE_INFINITY;
          const evictionIndexes: number[] = [];
          let projectedWeight = totalWeight + delta;

          if (projectedWeight > pendingWeightLimit && options.overflow === 'drop-oldest') {
            // Plan the eviction before mutating the queue. The in-flight prefix
            // and the item being enriched are both immutable candidates here.
            // This keeps a rejected enrichment from destroying healthy work.
            for (let index = inFlightCount; index < queue.length && projectedWeight > pendingWeightLimit; index++) {
              if (index === match) continue;
              evictionIndexes.push(index);
              projectedWeight -= queue[index].weight;
            }
          }

          if (projectedWeight > pendingWeightLimit) {
            result.dropped++;
            continue;
          }

          for (let index = evictionIndexes.length - 1; index >= 0; index--) {
            removeAt(evictionIndexes[index]);
            result.dropped++;
          }
          const currentMatch = queue.indexOf(matchedEntry);
          totalWeight += delta;
          queue[currentMatch] = { item: merged, weight: mergedWeight, failures: matchedEntry.failures };
          result.merged++;
          continue;
        }
      }

      if (!makeRoom(incomingWeight, result)) {
        result.dropped++;
        continue;
      }
      queue.push({ item: incoming, weight: incomingWeight, failures: 0 });
      totalWeight += incomingWeight;
      result.added++;
    }

    return result;
  };

  const batchCount = (): number => {
    const limit = Math.min(options.maxBatch, retryBatchLimit ?? options.maxBatch, queue.length);
    const weightLimit = options.maxBatchWeight ?? Number.POSITIVE_INFINITY;
    let count = 0;
    let batchWeight = 0;
    while (count < limit) {
      const nextWeight = queue[count].weight;
      // An overweight singleton must still be attempted so it can reach the
      // bounded-failure rotation path instead of becoming a local deadlock.
      if (count > 0 && batchWeight + nextWeight > weightLimit) break;
      batchWeight += nextWeight;
      count++;
    }
    return Math.max(1, count);
  };

  const api: AckedBatch<T> = {
    enqueue(item) {
      return enqueueMany([item]);
    },

    enqueueMany,

    pump(send) {
      if (activePump != null) return activePump;

      const drain = async (): Promise<boolean> => {
        while (queue.length > 0) {
          inFlightCount = batchCount();
          const batch = queue.slice(0, inFlightCount).map((entry) => entry.item);
          let acknowledged = false;
          try {
            acknowledged = await send(batch);
          } catch {
            // Transport failures are retryable and preserve queued work.
          }
          if (!acknowledged) {
            if (options.splitOnFailure && inFlightCount > 1) {
              retryBatchLimit = Math.max(1, Math.floor(inFlightCount / 2));
            } else if (inFlightCount === 1 && options.rotateAfterFailures != null) {
              queue[0].failures++;
              if (queue[0].failures >= options.rotateAfterFailures && queue.length > 1) {
                const failed = queue.shift()!;
                failed.failures = 0;
                queue.push(failed);
                retryBatchLimit = undefined;
              }
            }
            inFlightCount = 0;
            return false;
          }
          for (let index = 0; index < inFlightCount; index++) totalWeight -= queue[index].weight;
          queue.splice(0, inFlightCount);
          inFlightCount = 0;
          retryBatchLimit = undefined;
        }
        return true;
      };

      activePump = drain().finally(() => {
        activePump = undefined;
        inFlightCount = 0;
      });
      return activePump;
    },

    get pending() {
      return queue.length;
    },

    get pendingWeight() {
      return totalWeight;
    },
  };

  return api;
}
