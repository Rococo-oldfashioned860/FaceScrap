export type LimitedTextResult =
  | { ok: true; text: string; bytesRead: number }
  | { ok: false; text: ''; bytesRead: number };

/**
 * Read a response clone without ever retaining more than maxBytes from its
 * decoded body. The caller's response remains untouched and can still be read
 * by Facebook. Content-Length is only an early rejection; the stream counter
 * is the authoritative limit for chunked and decompressed bodies.
 */
export async function readClonedResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<LimitedTextResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes');

  const clone = response.clone();
  const declared = Number(clone.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void clone.body?.cancel('FaceScrap body limit').catch(() => undefined);
    return { ok: false, text: '', bytesRead: 0 };
  }

  if (!clone.body) return { ok: true, text: '', bytesRead: 0 };

  const reader = clone.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        // A cloned Response is a tee branch. Awaiting cancellation may wait for
        // the untouched original branch too, so request cancellation and return
        // immediately; this hook must never delay Facebook's response consumer.
        void reader.cancel('FaceScrap body limit').catch(() => undefined);
        return { ok: false, text: '', bytesRead };
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return { ok: true, text: parts.join(''), bytesRead };
  } finally {
    reader.releaseLock();
  }
}

export interface TextBudget {
  readonly maxChars: number;
  readonly usedChars: number;
  readonly full: boolean;
  add(text: string, separator?: string): boolean;
  value(): string;
}

/** A bounded string accumulator that never partially appends a document node. */
export function createTextBudget(maxChars: number): TextBudget {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) throw new RangeError('maxChars');
  const parts: string[] = [];
  let usedChars = 0;
  let full = false;
  return {
    maxChars,
    get usedChars() {
      return usedChars;
    },
    get full() {
      return full;
    },
    add(text, separator = '') {
      if (full) return false;
      const extra = text.length + (parts.length === 0 ? 0 : separator.length);
      if (extra > maxChars - usedChars) {
        full = true;
        return false;
      }
      if (parts.length > 0 && separator) parts.push(separator);
      parts.push(text);
      usedChars += extra;
      return true;
    },
    value() {
      return parts.join('');
    },
  };
}

export interface BoundedCollector<T> {
  readonly items: readonly T[];
  readonly weight: number;
  readonly full: boolean;
  add(item: T): boolean;
}

/** Stops accepting work as soon as either the count or aggregate weight is hit. */
export function createBoundedCollector<T>(options: {
  maxItems: number;
  maxWeight: number;
  weightOf: (item: T) => number;
}): BoundedCollector<T> {
  const { maxItems, maxWeight, weightOf } = options;
  if (!Number.isSafeInteger(maxItems) || maxItems < 0) throw new RangeError('maxItems');
  if (!Number.isSafeInteger(maxWeight) || maxWeight < 0) throw new RangeError('maxWeight');
  const items: T[] = [];
  let weight = 0;
  let full = false;
  return {
    items,
    get weight() {
      return weight;
    },
    get full() {
      return full;
    },
    add(item) {
      if (full) return false;
      const itemWeight = weightOf(item);
      if (!Number.isSafeInteger(itemWeight) || itemWeight < 0) return false;
      if (items.length >= maxItems || itemWeight > maxWeight - weight) {
        full = true;
        return false;
      }
      items.push(item);
      weight += itemWeight;
      return true;
    },
  };
}

/**
 * Mutate a small FIFO queue back under both caps. Disposable jobs are selected
 * first, but neither protected/keep jobs nor the newest arrival are exempt.
 */
export function trimQueueToBudget<T>(options: {
  queue: T[];
  maxItems: number;
  maxWeight: number;
  weightOf: (item: T) => number;
  isDisposable: (item: T) => boolean;
}): T[] {
  const { queue, maxItems, maxWeight, weightOf, isDisposable } = options;
  let weight = queue.reduce((sum, item) => sum + weightOf(item), 0);
  const dropped: T[] = [];
  while (queue.length > maxItems || weight > maxWeight) {
    const disposable = queue.findIndex(isDisposable);
    const [item] = queue.splice(disposable >= 0 ? disposable : 0, 1);
    if (item === undefined) break;
    weight -= weightOf(item);
    dropped.push(item);
  }
  return dropped;
}
