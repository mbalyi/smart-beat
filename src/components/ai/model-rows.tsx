import { CheckIcon, Trash2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { DIALOG_NEON, DialogArt, DialogLogo } from "@/components/ai/dialog-art";
import { AI_DIALOG_FRAME } from "@/components/ai/dialog-frame";
import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";

// The parts the model dialogs are built from: a dialog shell, a section per feature or family of
// models, and one row per model. "Stem Separation Models" and "Record to Tab Models" use them,
// and a later overview of all the neural models can use them too.

// --- Delete ------------------------------------------------------------------------------------

/**
 * Deleting a downloaded model: a Delete button, and a second click to confirm ("Delete <label>",
 * or "Keep" to back out). The same in the Import-from-Audio model picker, the stem engine cards
 * and the model dialogs. `disabled` while a download or another delete is busy.
 */
export function DeleteModelButton({
  label,
  onDelete,
  disabled = false,
}: {
  /** The model's name: "HTDemucs", "Medium". */
  label: string;
  onDelete: () => void;
  disabled?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={disabled}
          onClick={() => {
            setConfirming(false);
            onDelete();
          }}
        >
          Delete {label}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setConfirming(false)}
        >
          Keep
        </Button>
      </div>
    );
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={disabled}
      aria-label={`Delete the ${label} model`}
      onClick={() => setConfirming(true)}
    >
      <Trash2Icon aria-hidden="true" data-icon="inline-start" />
      Delete
    </Button>
  );
}

// --- A row -------------------------------------------------------------------------------------

/** Where a model is: the line at the right edge of its row. */
export type ModelRowState =
  | { kind: "built-in" }
  | { kind: "installed" }
  | { kind: "not-installed" }
  | { kind: "unavailable" }
  | { kind: "checking"; text?: string };

function stateText(state: ModelRowState): string {
  switch (state.kind) {
    case "built-in":
      return "Built in";
    case "installed":
      return "Installed";
    case "not-installed":
      return "Not installed";
    case "unavailable":
      return "Not published yet";
    case "checking":
      return state.text ?? "Checking…";
  }
}

/**
 * One model: its name (with a Recommended badge), what it is best at, what it costs, the size of
 * the download and where it stands. The buttons (Install, Delete, a progress bar) are the
 * children and sit under the state. A list of rows is a `ul` inside a `ModelSection`.
 */
export function ModelRow({
  id,
  name,
  recommended = false,
  details,
  size,
  state,
  highlighted = false,
  children,
}: {
  id: string;
  name: string;
  recommended?: boolean;
  /** Lines under the name, the first one in normal text. */
  details: readonly ReactNode[];
  /** "Download 216 MB", or null when there is nothing to download. */
  size: string | null;
  state: ModelRowState;
  /** The model in use: the row glows purple like the picker's chosen size. */
  highlighted?: boolean;
  children?: ReactNode;
}) {
  const installed = state.kind === "installed" || state.kind === "built-in";
  return (
    <li
      data-testid={`model-row-${id}`}
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card/70 px-4 py-3 sm:flex-row sm:items-start sm:justify-between",
        highlighted &&
          "border-primary bg-primary/10 shadow-[0_0_18px_color-mix(in_oklab,var(--primary)_55%,transparent)]",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span id={`model-${id}-name`} className="font-semibold">
            {name}
          </span>
          {recommended && (
            <Badge
              variant="outline"
              className="rounded-full border-brand/60 bg-brand/10 px-2 py-0 text-xs font-medium text-brand dark:text-[#e29bff]"
            >
              Recommended
            </Badge>
          )}
        </span>
        {details.map((line, index) => (
          <span
            key={index}
            className={cn("text-xs", index === 0 ? "text-sm" : "text-muted-foreground")}
          >
            {line}
          </span>
        ))}
      </div>
      <div className="flex shrink-0 flex-col gap-2 sm:w-44 sm:items-end">
        <span
          className={cn(
            "flex items-center gap-1 text-xs",
            installed ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {installed && <CheckIcon aria-hidden="true" className="size-3.5 text-primary" />}
          {stateText(state)}
        </span>
        {size && <span className="text-xs text-muted-foreground">{size}</span>}
        {children}
      </div>
    </li>
  );
}

/** The bar of a running download, with its percent. `percent` is null while the size is unknown. */
export function ModelProgress({ label, percent }: { label: string; percent: number | null }) {
  return (
    <div role="status" className="flex w-full flex-col gap-1">
      <span className="text-xs font-semibold">{label}</span>
      <div className="flex items-center gap-2">
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
          className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              "h-full rounded-full bg-primary",
              percent === null && "w-1/3 motion-safe:animate-pulse",
            )}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
        {percent !== null && (
          <span className="w-10 text-right text-xs font-semibold">{percent}%</span>
        )}
      </div>
    </div>
  );
}

// --- A section ---------------------------------------------------------------------------------

/** A feature's or a family's models: a title, the features that use them, and the rows. */
export function ModelSection({
  id,
  title,
  usedBy,
  intro,
  children,
}: {
  id: string;
  title: string;
  /** The features that use these models: "Stem separation". Shown as "Used by …". */
  usedBy: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`model-section-${id}`} className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 id={`model-section-${id}`} className="text-base font-bold">
          {title}
        </h3>
        <p className="text-xs text-muted-foreground">Used by {usedBy}</p>
        {intro && <div className="text-sm">{intro}</div>}
      </div>
      <ul className="flex flex-col gap-2">{children}</ul>
    </section>
  );
}

// --- The dialog --------------------------------------------------------------------------------

/**
 * The window of a model dialog: neon frame, graffiti, logo and title, a body that scrolls and a
 * pinned Close. While `busy` (a download runs) it cannot be closed, so the download is not lost.
 * The content is mounted only while open, so every visit reads the models afresh.
 */
export function ModelsDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  logo,
  hero,
  title,
  description,
  testId,
  busy: busyProp = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  logo: string;
  hero?: { src: string; place: string };
  title: string;
  description: ReactNode;
  testId: string;
  /** A download runs that the dialog itself does not know about. */
  busy?: boolean;
  /**
   * The content. It mounts only while the dialog is open; a function gets `setBusy`, for content
   * that downloads: the dialog cannot be closed while it is busy.
   */
  children: ReactNode | ((setBusy: (busy: boolean) => void) => ReactNode);
}) {
  const [reported, setBusy] = useState(false);
  const busy = busyProp || reported;
  return (
    <Dialog open={open} onOpenChange={(next) => (next || !busy) && onOpenChange(next)}>
      <DialogContent
        size="xl"
        className={cn(AI_DIALOG_FRAME, DIALOG_NEON, "h-[min(46rem,calc(100dvh-2rem))]")}
        data-testid={testId}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
        onInteractOutside={(event) => busy && event.preventDefault()}
      >
        {open && (
          <div className="relative isolate flex min-h-0 flex-1 flex-col">
            <DialogArt hero={hero} name={testId} />
            <DialogHeader className="gap-3 px-6 pt-3 md:px-9">
              <DialogLogo src={logo} />
              <DialogTitle className="text-2xl font-bold">{title}</DialogTitle>
              <DialogDescription className={hero ? "md:pr-[22%]" : undefined}>
                {description}
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="gap-5 px-6 pb-4 md:px-9">
              {typeof children === "function" ? children(setBusy) : children}
            </DialogBody>
            <DialogFooter className="mt-0 flex-row justify-between border-t-0 bg-transparent px-6 pt-2 pb-5 sm:justify-between md:px-9">
              <Button
                variant="outline"
                size="lg"
                className="min-w-28 bg-card"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Close
              </Button>
              {busy && (
                <span role="status" className="self-center text-xs text-muted-foreground">
                  A download is running. Wait for it, or cancel it, to close this window.
                </span>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
