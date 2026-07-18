// Feature-detection for Chromium APIs that vary by browser (Chrome/Edge vs Brave/Opera/…).
// Checks read `chrome` lazily via `typeof`/`in`: a throw at module-eval time would kill the service worker.

/** True when the Side Panel API is usable (Chrome/Edge 114+). */
export function hasSidePanel(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    'sidePanel' in chrome &&
    typeof chrome.sidePanel?.setPanelBehavior === 'function'
  );
}

/** True when the Offscreen Documents API is usable (needed for DASH remux).
 *  Also checks runtime.getContexts (Chrome 116): a fork may ship createDocument
 *  (Chrome 109) without it, and ensureOffscreen() needs both — verifying only
 *  createDocument would let ensureOffscreen throw on getContexts mid-download. */
export function hasOffscreen(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    'offscreen' in chrome &&
    typeof chrome.offscreen?.createDocument === 'function' &&
    typeof chrome.runtime?.getContexts === 'function' &&
    typeof chrome.runtime?.ContextType?.OFFSCREEN_DOCUMENT === 'string'
  );
}
