/** Fold a per-reel DOM id into a per-load marker.
 *
 *  createVideoMarkFactory keys on OBJECT IDENTITY, which Facebook does not
 *  guarantee to be per-slide: it can hand two different reels the same
 *  MediaSourceHandle, and mid-transition a pooled <video> can be reused while
 *  its srcObject is still null (the element-as-fallback path). Either way the
 *  WeakMap returns the previous slide's id, the slide signature never changes,
 *  and now-playing stays pinned to the video before last.
 *
 *  `rid` (data-video-id) is Facebook's own per-reel attribute, read fresh from
 *  the DOM on every call, so it advances no matter how the objects churn.
 *  Undefined off reels — stories have no such attribute and keep the bare mark.
 *
 *  Separator is ':' and not '#': detectPlaying joins the story and video marks
 *  with '#', and storage bounds an overlong mark by its LAST '#'. An inner '#'
 *  would move that cut point. */
export function combineVideoMark(mark: string, rid: string | undefined): string {
  return rid != null ? `${mark}:rid:${rid}` : mark;
}

/** Create stable opaque markers for video loads within one content-script epoch. */
export function createVideoMarkFactory(epoch: string): (key: object, src: string) => string {
  const marks = new WeakMap<object, string>();
  let sequence = 0;

  return (key, src) => {
    if (src && !src.startsWith('blob:')) return src.slice(0, 200);
    const existing = marks.get(key);
    if (existing != null) return existing;
    const mark = `vm:${epoch}:${++sequence}`;
    marks.set(key, mark);
    return mark;
  };
}
