/** What a lane without clips says: a quiet dashed box that never takes the pointer. */
export function EmptyLaneHint() {
  return (
    <span
      data-testid="empty-lane"
      className="pointer-events-none absolute inset-x-1 inset-y-1 flex items-center rounded-md border border-dashed border-muted-foreground/40 px-3 text-xs text-muted-foreground"
    >
      <span className="truncate">Empty lane · drop audio here or use Import audio</span>
    </span>
  );
}
