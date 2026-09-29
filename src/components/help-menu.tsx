import { useRef } from "react";
import { CircleHelpIcon, InfoIcon, KeyboardIcon, ScaleIcon } from "lucide-react";

import type { AppDialog } from "@/components/app-dialogs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** In-window mirror of the native Help menu. */
export function HelpMenu({
  onSelect,
}: {
  /** `trigger` is where focus should return once the dialog closes. */
  onSelect: (dialog: AppDialog, trigger: HTMLElement | null) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const select = (dialog: AppDialog) => onSelect(dialog, triggerRef.current);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button ref={triggerRef} variant="ghost" size="icon" aria-label="Help">
              <CircleHelpIcon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Help</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onSelect={() => select("shortcuts")}>
          <KeyboardIcon />
          Keyboard Shortcuts
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => select("licenses")}>
          <ScaleIcon />
          Open-Source Licenses
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => select("about")}>
          <InfoIcon />
          About Smart Beat
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
