/** Which rows of a long list are drawn: the visible ones plus a few above and below. */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  count: number,
  overscan = 6,
): { start: number; end: number } {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  // A scroll position past the end (the list just got shorter) still draws the last rows.
  const first = Math.min(count, Math.floor(Math.max(0, scrollTop) / rowHeight));
  const last = Math.min(
    count,
    Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportHeight)) / rowHeight),
  );
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, last + overscan),
  };
}

/** The scroll position that brings row `index` fully into view, or null when it already is. */
export function scrollToRow(
  index: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
): number | null {
  const top = index * rowHeight;
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + viewportHeight) return top + rowHeight - viewportHeight;
  return null;
}
