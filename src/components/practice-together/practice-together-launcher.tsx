import {
  ArrowRightIcon,
  FilePlusIcon,
  FolderOpenIcon,
  MusicIcon,
  UserCheckIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";

import {
  CARD,
  CHOICE,
  TogetherContent,
  TogetherFrame,
} from "@/components/practice-together/together-frame";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogFooter } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cloudItemName, providerLabel, providerOf } from "@/lib/cloud-items";
import { baseName } from "@/lib/score/format";
import { cn } from "@/lib/utils";

/** Where the tab of a new session comes from. */
export type TogetherSource =
  { kind: "recent"; path: string } | { kind: "file" } | { kind: "blank" };

const NEW_STEPS = ["Choose", "Pick a tab", "Connect", "Play together"] as const;
const JOIN_STEPS = ["Choose", "Connect", "Play together"] as const;

/** How many recent songs are offered. */
const RECENT_SHOWN = 8;

function recentName(path: string): string {
  return providerOf(path) ? (cloudItemName(path) ?? "Cloud tab") : baseName(path);
}

function folderOf(path: string): string {
  const provider = providerOf(path);
  if (provider) return providerLabel(provider);
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2]! : "";
}

/**
 * Practice together from the start screen, before a tab is open: first "start a new session or
 * join one"; for a new session the tab comes next (a recent song, a file or a blank tab). The
 * rest (name, where you are, the code, the other player) is the dialog of the open tab, which the
 * caller opens when the tab is shown.
 */
export function PracticeTogetherLauncher({
  open,
  onOpenChange,
  recent,
  onStart,
  onJoin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Recently opened songs (paths), most recent first. */
  recent: readonly string[];
  /** A new session on this tab. */
  onStart: (source: TogetherSource) => void;
  /** Join a session: the tab comes from the host. */
  onJoin: () => void;
}) {
  const [mode, setMode] = useState<"host" | "join">("host");
  const [page, setPage] = useState<"choose" | "pick">("choose");
  const joining = mode === "join";
  const close = () => {
    onOpenChange(false);
    setPage("choose");
    setMode("host");
  };

  return (
    <TogetherFrame
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      steps={joining ? JOIN_STEPS : NEW_STEPS}
      step={page === "pick" ? 1 : 0}
      testId="practice-together-launcher"
    >
      {page === "choose" ? (
        <>
          <DialogBody className="px-6 pb-4 md:px-9">
            <TogetherContent>
              <div className={cn(CARD, "flex flex-col gap-4")}>
                <ToggleGroup
                  type="single"
                  variant="default"
                  spacing={2}
                  aria-label="What do you want to do?"
                  value={mode}
                  onValueChange={(value) => value && setMode(value as "host" | "join")}
                  className="flex-wrap gap-2"
                >
                  <ToggleGroupItem value="host" className={CHOICE}>
                    <UsersIcon data-icon="inline-start" />
                    Start a new session
                  </ToggleGroupItem>
                  <ToggleGroupItem value="join" className={CHOICE}>
                    <UserCheckIcon data-icon="inline-start" />
                    Join an existing session
                  </ToggleGroupItem>
                </ToggleGroup>
                <p className="text-sm text-muted-foreground">
                  {joining
                    ? "Someone else already started a session. You need its code; the tab comes from the host, so you do not need to have it."
                    : "You host the session. Pick the tab you want to play together, then give the code to the other player."}
                </p>
              </div>
            </TogetherContent>
          </DialogBody>
          <Footer onClose={close}>
            <Button
              type="button"
              size="lg"
              className="sm:min-w-52"
              onClick={() => {
                if (joining) {
                  onJoin();
                  close();
                } else setPage("pick");
              }}
            >
              {joining ? "Join a session" : "Pick a tab"}
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          </Footer>
        </>
      ) : (
        <>
          <DialogBody className="px-6 pb-4 md:px-9">
            <TogetherContent>
              <div className={cn(CARD, "flex flex-col gap-3")}>
                <h3 className="text-base font-semibold">Which tab do you want to play?</h3>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="bg-card"
                    onClick={() => {
                      onStart({ kind: "file" });
                      close();
                    }}
                  >
                    <FolderOpenIcon data-icon="inline-start" />
                    Open a file…
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="bg-card"
                    onClick={() => {
                      onStart({ kind: "blank" });
                      close();
                    }}
                  >
                    <FilePlusIcon data-icon="inline-start" />
                    New blank tab
                  </Button>
                </div>
                {recent.length > 0 && (
                  <>
                    <h4 className="text-sm font-semibold text-muted-foreground">Recent songs</h4>
                    <ul className="flex flex-col gap-1.5" aria-label="Recent songs">
                      {recent.slice(0, RECENT_SHOWN).map((path) => (
                        <li key={path}>
                          <button
                            type="button"
                            className="flex w-full min-w-0 items-center gap-2 rounded-lg border bg-background/60 px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
                            onClick={() => {
                              onStart({ kind: "recent", path });
                              close();
                            }}
                          >
                            <MusicIcon aria-hidden="true" className="size-4 shrink-0" />
                            <span className="min-w-0 flex-1 truncate font-medium">
                              {recentName(path)}
                            </span>
                            <span className="truncate text-xs text-muted-foreground">
                              {folderOf(path)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </TogetherContent>
          </DialogBody>
          <Footer onClose={() => setPage("choose")} label="Back" />
        </>
      )}
    </TogetherFrame>
  );
}

function Footer({
  children,
  onClose,
  label = "Close",
}: {
  children?: React.ReactNode;
  onClose: () => void;
  label?: string;
}) {
  return (
    <DialogFooter className="mt-0 flex-row flex-wrap justify-between gap-2 border-t-0 bg-transparent px-6 pt-2 pb-5 md:px-9">
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="min-w-28 bg-card"
        onClick={onClose}
      >
        {label}
      </Button>
      {children}
    </DialogFooter>
  );
}
