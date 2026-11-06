import { ChevronRightIcon, LockIcon } from "lucide-react";
import type { ReactNode } from "react";

import laptop from "@/assets/cloud/laptop.webp";
import splashLeft from "@/assets/record-to-tab/splash-bottom-left.webp";
import splashRight from "@/assets/record-to-tab/splash-bottom-right.webp";
import { cn } from "@/lib/utils";

/**
 * The building blocks of the "where?" dialogs (Save As and Open for songs, Save stems and Open
 * stems): the graffiti behind the window, a big card for this computer and a card per storage.
 */

/** The graffiti behind the dialog: behind everything, never in the way, hidden from readers. */
export function TargetArt() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <img
        src={splashLeft}
        alt=""
        className="absolute bottom-0 left-0 w-[40%] opacity-50 dark:opacity-90"
      />
      <img
        src={splashRight}
        alt=""
        className="absolute right-0 bottom-0 w-[20%] opacity-50 dark:opacity-90"
      />
    </div>
  );
}

const CARD =
  "group relative flex w-full cursor-pointer items-center gap-3 overflow-hidden rounded-2xl border text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/60";

/** The wide card for this computer: the laptop picture, one line of text and an arrow. */
export function ComputerCard({
  label,
  hint,
  onClick,
  testId,
}: {
  label: string;
  /** A short line under the label; the button's name includes it (WCAG 2.5.3: name contains the visible text). */
  hint?: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className={`${CARD} min-h-24 border-primary/70 bg-gradient-to-r from-primary/25 via-primary/10 to-card/80 pr-4 hover:border-primary hover:from-primary/35`}
      onClick={onClick}
      aria-label={hint ? `${label}, ${hint}` : label}
      data-testid={testId}
    >
      <img
        src={laptop}
        alt=""
        aria-hidden="true"
        className="pointer-events-none -my-2 ml-1 h-24 w-auto shrink-0 object-contain sm:h-28"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* The spaces keep the spans' text apart for a scanner that joins them (WCAG 2.5.3). */}
        <span className="text-lg font-bold sm:text-2xl">{label}</span>{" "}
        {hint && <span className="text-xs text-foreground/75 sm:text-sm">{hint}</span>}
      </span>
      <ChevronRightIcon className="size-6 shrink-0" aria-hidden="true" />
    </button>
  );
}

/** The grid of storage cards: one wide card, two or three side by side. */
export function StorageGrid({ count, children }: { count: number; children: ReactNode }) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-3",
        count === 2 && "sm:grid-cols-2",
        count > 2 && "sm:grid-cols-3",
      )}
    >
      {children}
    </div>
  );
}

/** One storage (a drive or the cloud folder): its picture, what happens and its name. */
export function StorageCard({
  art,
  verb,
  label,
  hint,
  disabled = false,
  onClick,
  testId,
}: {
  /** The logo or icon, in a box that is wide on phones and as wide as the card on larger screens. */
  art: ReactNode;
  /** "Save to", "Open from": the small line above the name. */
  verb: string;
  label: string;
  /** The line under the name (the account, or why the drive is locked); part of the button's name. */
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`${CARD} flex-row items-end border-border bg-card/85 p-3 sm:min-h-40 sm:flex-col sm:items-stretch sm:gap-1 ${
        disabled ? "cursor-not-allowed opacity-55 grayscale" : "hover:border-primary/70"
      }`}
      onClick={onClick}
      aria-label={hint ? `${verb} ${label}, ${hint}` : `${verb} ${label}`}
      data-testid={testId}
    >
      <span className="flex h-16 w-20 shrink-0 items-center justify-center self-start sm:h-20 sm:w-full">
        {art}
      </span>
      <span className="flex min-w-0 flex-1 items-end justify-between gap-2">
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="text-sm text-muted-foreground">{verb}</span>{" "}
          <span className="text-xl font-bold break-words sm:text-2xl">{label}</span>{" "}
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        </span>
        {disabled ? (
          <LockIcon className="mb-1 size-5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRightIcon className="mb-1 size-6 shrink-0" aria-hidden="true" />
        )}
      </span>
    </button>
  );
}
