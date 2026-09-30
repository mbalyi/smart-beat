import wordmark from "@/assets/smart-beat-wordmark.png";
import type { AppDialog } from "@/components/app-dialogs";
import { HelpMenu } from "@/components/help-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

export function AppHeader({
  onShowDialog,
  wide = false,
  centerRef,
}: {
  onShowDialog: (dialog: AppDialog, returnFocusTo: HTMLElement | null) => void;
  /** Span the whole window (a song is open) instead of the centred column. */
  wide?: boolean;
  /** Receives the element between the logo and the icons, where an open song puts its main controls. */
  centerRef?: (element: HTMLElement | null) => void;
}) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-backdrop-filter:bg-background/70">
      <div
        className={cn(
          "mx-auto flex w-full items-center justify-between gap-x-4 px-4 sm:px-6",
          wide ? "min-h-16 flex-wrap py-1 lg:flex-nowrap" : "h-14 max-w-5xl lg:px-8",
        )}
      >
        <div className="flex shrink-0 items-center">
          <img
            src={wordmark}
            alt="Smart Beat"
            draggable={false}
            className={cn("w-auto", wide ? "h-11" : "h-9")}
          />
        </div>
        {wide && (
          <div
            ref={centerRef}
            className="flex min-w-0 flex-1 justify-center max-lg:order-last max-lg:basis-full"
          />
        )}
        <div className="flex shrink-0 items-center gap-1">
          <ThemeToggle />
          <HelpMenu onSelect={onShowDialog} />
        </div>
      </div>
    </header>
  );
}
