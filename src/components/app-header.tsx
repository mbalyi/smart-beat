import { AppLogo } from "@/components/app-logo";
import type { AppDialog } from "@/components/app-dialogs";
import { HelpMenu } from "@/components/help-menu";
import { ThemeToggle } from "@/components/theme-toggle";

export function AppHeader({
  onShowDialog,
}: {
  onShowDialog: (dialog: AppDialog, returnFocusTo: HTMLElement | null) => void;
}) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur supports-backdrop-filter:bg-background/70">
      <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
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
