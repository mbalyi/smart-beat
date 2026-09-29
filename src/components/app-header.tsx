import { AppLogo } from "@/components/app-logo";
import type { AppDialog } from "@/components/app-dialogs";
import { HelpMenu } from "@/components/help-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

export function AppHeader({
  onShowDialog,
  wide = false,
}: {
  onShowDialog: (dialog: AppDialog, returnFocusTo: HTMLElement | null) => void;
  /** Span the whole window (a song is open) instead of the centred column. */
  wide?: boolean;
}) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-backdrop-filter:bg-background/70">
      <div
        className={cn(
          "mx-auto flex h-14 w-full items-center justify-between gap-4 px-4 sm:px-6",
          !wide && "max-w-5xl lg:px-8",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <AppLogo className="size-7 shrink-0" />
          <span className="truncate font-heading text-base font-semibold">Smart Beat</span>
        </div>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <HelpMenu onSelect={onShowDialog} />
        </div>
      </div>
    </header>
  );
}
