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
