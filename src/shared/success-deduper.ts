export interface SuccessDeduper {
  readonly inFlightCount: number;
  run(key: string, task: () => Promise<void>): Promise<void>;
}

/** Collapses concurrent duplicates and remembers only successful completion.
 * A rejection is deliberately never cached, so Retry always runs real work. */
export function createSuccessDeduper(windowMs: number, now: () => number): SuccessDeduper {
  const inFlight = new Map<string, Promise<void>>();
  const completed = new Map<string, number>();

  return {
    get inFlightCount() {
      return inFlight.size;
    },

    run(key, task) {
      const pending = inFlight.get(key);
      if (pending != null) return pending;

      const current = now();
      const completedAt = completed.get(key);
      if (completedAt != null && current >= completedAt && current - completedAt < windowMs) {
        return Promise.resolve();
      }
      if (completedAt != null && current < completedAt) completed.delete(key);

      const work = task()
        .then(() => {
          const at = now();
          completed.set(key, at);
          for (const [candidate, time] of completed) {
            if (at < time || at - time > windowMs) completed.delete(candidate);
          }
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, work);
      return work;
    },
  };
}
