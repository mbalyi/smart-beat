import { PlusIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** One open song, as a tab. */
export interface DocumentTab {
  id: number;
  title: string;
  /** Has changes that are not saved. */
  edited: boolean;
}

/**
 * The open songs, one tab each (like browser tabs). A list of buttons rather
 * than an ARIA tab widget: each tab and its close button are ordinary tab
 * stops, and the shown song is marked with `aria-current`.
 */
export function DocumentTabs({
  tabs,
  activeId,
  onActivate,
  onClose,
  onNew,
}: {
  tabs: DocumentTab[];
  activeId: number | null;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
}) {
  return (
    <nav aria-label="Open songs" className="flex shrink-0 items-stretch border-b bg-muted/40">
      <ul className="flex min-w-0 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <li
              key={tab.id}
              className={cn(
                "flex max-w-64 min-w-28 items-center border-r border-b-2 border-b-transparent",
                active ? "border-b-primary bg-background" : "hover:bg-muted",
              )}
            >
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                aria-label={tab.edited ? `${tab.title} (edited)` : undefined}
                onClick={() => onActivate(tab.id)}
                title={tab.title}
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-1 pl-3 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
              >
                <span className="truncate">{tab.title}</span>
                {tab.edited && (
                  <>
                    <span
                      aria-hidden="true"
                      className="size-1.5 shrink-0 rounded-full bg-sky-500"
                    />
                  </>
                )}
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Close ${tab.title}`}
                title="Close"
                onClick={() => onClose(tab.id)}
                className="mr-1 shrink-0"
              >
                <XIcon />
              </Button>
            </li>
          );
        })}
      </ul>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="New song"
        title="New song"
        onClick={onNew}
        className="m-0.5 shrink-0"
      >
        <PlusIcon />
      </Button>
    </nav>
  );
}
