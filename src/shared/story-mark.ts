/** Build and classify the story portion of a now-playing marker.
 *
 * `u:` is durable because its card id came from the active DOM card. `p:` is
 * only a provisional slide-change signal: Facebook pins the path to the card
 * that opened the tray, so that value must never become a durable binding.
 * This module owns the prefix encoding — consumers must classify marks through
 * the predicates below, never by re-deriving the string prefixes.
 */
const STORY_PATH = /\/stories\/([^/]+)\/([^/]+)/;

/** Cheap pre-check so hot-path callers can skip the DOM work that feeds
 *  storyCardMark when the page cannot yield a story marker at all. */
export function isStoryPath(pathname: string): boolean {
  return STORY_PATH.test(pathname);
}

export function storyCardMark(pathname: string, domId?: string): string {
  const match = pathname.match(STORY_PATH);
  if (!match) return '';
  return domId ? `u:${match[1]}/${domId}` : `p:${match[1]}/${match[2]}`;
}

/** DOM-proven provenance: safe to persist and to rescue a revisit on. */
export function isDurableStoryMark(mark: string | undefined): mark is string {
  return mark?.startsWith('u:') === true;
}

/** Tray-pinned URL provenance: compare-only, must never become a binding. */
export function isProvisionalStoryMark(mark: string | undefined): boolean {
  return mark?.startsWith('p:') === true;
}
