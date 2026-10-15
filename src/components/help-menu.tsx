import { useRef } from "react";
import {
  CircleHelpIcon,
  CompassIcon,
  DownloadIcon,
  InfoIcon,
  KeyboardIcon,
  MusicIcon,
  RotateCcwIcon,
  ScaleIcon,
  SettingsIcon,
  SparklesIcon,
} from "lucide-react";

import type { AppDialog } from "@/components/app-dialogs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TOUR_LIST } from "@/lib/tour/tours";
import type { TourId } from "@/lib/tour/feature-registry";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** The Help items that run the guided tours and the demo song (#84). */
export type HelpAction = "demo-song" | "whats-new" | "reset-tips" | { tour: TourId };

/** In-window mirror of the native Help menu. */
export function HelpMenu({
  onSelect,
  onCheckForUpdates,
  onAction,
  resumeStep,
}: {
  /** The tour, demo song and tips items. */
  onAction?: (action: HelpAction) => void;
  /** Where an interrupted main tour stopped: the item then says "Continue the Tour". */
  resumeStep?: number | null;
  /** `trigger` is where focus should return once the dialog closes. */
  onSelect: (dialog: AppDialog, trigger: HTMLElement | null) => void;
  /** Only the desktop app can update itself: without this, the item is left out. */
  onCheckForUpdates?: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const select = (dialog: AppDialog) => onSelect(dialog, triggerRef.current);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button ref={triggerRef} variant="ghost" size="icon" aria-label="Help" data-tour="help">
              <CircleHelpIcon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Help</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-52">
        {onAction && (
          <>
            <DropdownMenuItem onSelect={() => onAction({ tour: "main" })}>
              <CompassIcon />
              {resumeStep ? "Continue the Tour" : "Take the Tour"}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <CompassIcon />
                Tours
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {TOUR_LIST.filter((tour) => tour.id !== "main").map((tour) => (
                  <DropdownMenuItem key={tour.id} onSelect={() => onAction({ tour: tour.id })}>
                    {tour.title}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onSelect={() => onAction("demo-song")}>
              <MusicIcon />
              Open Demo Song
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction("whats-new")}>
              <SparklesIcon />
              What’s New
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAction("reset-tips")}>
              <RotateCcwIcon />
              Reset Tips
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={() => select("shortcuts")}>
          <KeyboardIcon />
          Keyboard Shortcuts
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => select("settings")}>
          <SettingsIcon />
          Settings…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => select("licenses")}>
          <ScaleIcon />
          Open-Source Licenses
        </DropdownMenuItem>
        {onCheckForUpdates && (
          <DropdownMenuItem onSelect={onCheckForUpdates}>
            <DownloadIcon />
            Check for Updates…
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => select("about")}>
          <InfoIcon />
          About Smart Beat
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
