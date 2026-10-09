import type { ElementType, ReactNode } from "react";

/**
 * The small label above a section of the start page: a short yellow line, then the text in
 * capitals ("BUILT WITH", "MADE FOR THE WAY YOU PLAY", "RECENT SONGS"). One style for all of them.
 */
export function SectionKicker({
  children,
  as: Tag = "p",
  id,
}: {
  children: ReactNode;
  as?: ElementType;
  id?: string;
}) {
  return (
    <Tag
      id={id}
      className="flex items-center gap-2 text-xs font-bold tracking-[0.12em] text-muted-foreground uppercase"
    >
      <span aria-hidden="true" className="h-0.5 w-5 bg-brand-yellow" />
      {children}
    </Tag>
  );
}
