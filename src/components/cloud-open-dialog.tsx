import { CloudOffIcon, FileMusicIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import splashLeft from "@/assets/record-to-tab/splash-bottom-left.webp";
import splashRight from "@/assets/record-to-tab/splash-bottom-right.webp";
import { DIALOG_NEON } from "@/components/ai/dialog-art";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorText } from "@/lib/errors";
import {
  cloudErrorText,
  listCloudItems,
  rememberCloudName,
  type CloudItem,
  type CloudProvider,
} from "@/lib/cloud-items";
import { cn } from "@/lib/utils";

type State =
  | { status: "loading" }
  | { status: "ready"; items: CloudItem[] }
  | { status: "error"; message: string };

/** "12 KB", "1.4 MB": a short size for a row. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "5 minutes ago", "yesterday"; older than a month falls back to the date. */
function formatModified(ms: number, now = Date.now()): string {
  if (!ms) return "";
  const seconds = Math.round((ms - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 30 * 86400) return rtf.format(Math.round(seconds / 86400), "day");
  return new Date(ms).toLocaleDateString("en", { dateStyle: "medium" });
}

/** The graffiti behind the dialog: behind everything, never in the way, hidden from readers. */
function OpenArt() {
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

function OpenContent({
  provider,
  label,
  onClose,
  onPick,
  onSetupCloud,
}: {
  provider: CloudProvider;
  label: string;
  onClose: () => void;
  onPick: (item: string) => void;
  onSetupCloud?: () => void;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  const refresh = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let active = true;
    listCloudItems(provider).then(
      (items) => {
        if (active) {
          setState({
            status: "ready",
            items: [...items].sort((a, b) => b.modified_ms - a.modified_ms),
          });
        }
      },
      (error: unknown) => {
        if (active) {
          setState({
            status: "error",
            message: cloudErrorText(error, provider) ?? errorText(error),
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [provider, attempt]);

  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col">
      <OpenArt />
      <DialogHeader className="px-6 md:px-9">
        <DialogTitle className="text-2xl font-bold">Open from {label}</DialogTitle>
        <DialogDescription>
          These are the tabs Smart Beat saved to {label}. Pick one to open it.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="gap-3 px-6 md:px-9">
        {state.status === "loading" && (
          <p
            role="status"
            className="flex items-center gap-2 rounded-xl border bg-card/85 p-4 text-sm text-muted-foreground dark:bg-card/80"
          >
            <Loader2Icon
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            Loading your tabs from {label}…
          </p>
        )}
        {state.status === "error" && (
          <div
            role="alert"
            className="flex flex-col items-start gap-3 rounded-xl border border-destructive/40 bg-card/85 p-4 text-sm dark:bg-card/80"
          >
            <p className="flex items-start gap-2">
              <CloudOffIcon
                className="mt-0.5 size-4 shrink-0 text-destructive"
                aria-hidden="true"
              />
              <span>{state.message}</span>
            </p>
            <Button variant="outline" onClick={refresh} className="bg-card">
              <RefreshCwIcon data-icon="inline-start" />
              Retry
            </Button>
          </div>
        )}
        {state.status === "ready" && state.items.length === 0 && (
          <p className="rounded-xl border bg-card/85 p-4 text-sm text-muted-foreground dark:bg-card/80">
            No tabs saved to {label} yet. Use Save As › {label} to add one.
          </p>
        )}
        {state.status === "ready" && state.items.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label={`Tabs in ${label}`}>
            {state.items.map((item, index) => (
              <li key={item.id} className="min-w-0">
                <button
                  type="button"
                  className="group flex min-h-[64px] w-full min-w-0 items-center gap-3.5 overflow-hidden rounded-xl border bg-card/85 px-4 py-3 text-left transition-[border-color,background-color] duration-150 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none dark:bg-card/80"
                  onClick={() => {
                    rememberCloudName(item.id, item.name);
                    onPick(item.id);
                    onClose();
                  }}
                  title={item.name}
                  data-testid="cloud-open-item"
                >
                  <FileMusicIcon
                    className={cn(
                      "size-[22px] shrink-0",
                      index % 2 === 0 ? "text-brand-yellow" : "text-brand",
                    )}
                    aria-hidden="true"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-base font-bold">{item.name}</span>
                    <span className="truncate text-sm text-muted-foreground">
                      {[formatSize(item.size), formatModified(item.modified_ms)]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogBody>
      <DialogFooter className="mt-0 flex-row justify-between border-t-0 bg-transparent px-6 pt-2 pb-5 md:px-9">
        <Button variant="outline" size="lg" className="min-w-28 bg-card" onClick={onClose}>
          Close
        </Button>
        {onSetupCloud && (
          <Button
            variant="link"
            size="sm"
            className="text-muted-foreground"
            onClick={onSetupCloud}
            data-testid="cloud-open-setup"
          >
            Set up cloud storage
          </Button>
        )}
        <Button
          variant="outline"
          size="lg"
          className="bg-card"
          onClick={refresh}
          disabled={state.status === "loading"}
        >
          <RefreshCwIcon data-icon="inline-start" />
          Refresh
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * File › Open for an online drive (#187): lists the tabs Smart Beat saved there, newest first,
 * and hands the picked item id (`drive:<id>`) to `onPick`. File names are never sent to telemetry.
 */
export function CloudOpenDialog({
  provider,
  label,
  open,
  onOpenChange,
  onPick,
  onSetupCloud,
}: {
  provider: CloudProvider;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (item: string) => void;
  /** Shows a small "Set up cloud storage" link in the footer. */
  onSetupCloud?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="xl"
        data-testid="cloud-open-dialog"
        className={`${DIALOG_NEON} h-[min(34rem,calc(100dvh-2rem))] sm:max-w-2xl`}
      >
        {open && (
          <OpenContent
            provider={provider}
            label={label}
            onClose={() => onOpenChange(false)}
            onPick={onPick}
            onSetupCloud={onSetupCloud}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
