// Tiny async helpers shared across contexts (side panel, service worker).

/** A timeout that measures IDLENESS, not elapsed time: `beat()` restarts the
 *  clock, so work that keeps reporting progress is never cut off.
 *
 *  A wall-clock cap cannot tell a wedged job from a slow one. The offscreen
 *  document learned this for single track reads (see STALL_MS there) but the
 *  worker still capped the whole mux round-trip at a fixed 115s, so a large
 *  track on a slow-but-steady link died mid-download — deterministically, and
 *  with every downloaded byte thrown away. `hardCapMs` stays as the backstop
 *  for the case the idle timer cannot see: an offscreen document that died
 *  outright would send neither progress nor an answer.
 *
 *  Returns the guarded promise plus the beat function; the caller wires `beat`
 *  to whatever progress channel it owns. */
export function withHeartbeat<T>(
  work: Promise<T>,
  idleMs: number,
  hardCapMs: number,
  message: string,
): { promise: Promise<T>; beat: () => void } {
  let idleTimer: ReturnType<typeof setTimeout>;
  let settled = false;
  let fail: (e: Error) => void = () => {};
  const guard = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const arm = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail(new Error(message)), idleMs);
  };
  arm();
  const hardTimer = setTimeout(() => fail(new Error(message)), hardCapMs);
  const promise = Promise.race([work, guard]).finally(() => {
    settled = true;
    clearTimeout(idleTimer);
    clearTimeout(hardTimer);
  });
  return {
    promise,
    // Guarded: a progress report that races the final answer must not leave a
    // timer armed against an already-settled promise (an unhandled rejection).
    beat: () => {
      if (!settled) arm();
    },
  };
}

/** Reject after `ms` if `p` hasn't settled, without leaking the timer. */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}
