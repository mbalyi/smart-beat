import { ArrowRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import pianoIcon from "@/assets/record-to-tab/icon-piano.webp";
import { DIALOG_NEON, DialogArt } from "@/components/ai/dialog-art";
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

/**
 * The frame every MIDI editing dialog shares (dialog-design): the neon ring, the graffiti art
 * of the record dialogs, a title with a short description, a scrolling body of cards, and a
 * pinned footer with Close on the left and one primary action on the right.
 */
export function MidiDialog({
  open,
  onOpenChange,
  title,
  description,
  action,
  onAction,
  actionDisabled,
  testId,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** The primary button's text. */
  action: string;
  onAction: () => void;
  actionDisabled?: boolean;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="xl"
        data-testid={testId}
        className={cn(DIALOG_NEON, "h-[min(40rem,calc(100dvh-2rem))] sm:max-w-2xl")}
      >
        {open && (
          <div className="relative isolate flex min-h-0 flex-1 flex-col">
            <DialogArt
              name={testId}
              hero={{ src: pianoIcon, place: "top-6 right-6 w-[22%] opacity-90" }}
            />
            <DialogHeader className="gap-1 px-6 pt-6 pb-2 md:px-9 md:pr-[28%]">
              <DialogTitle className="text-2xl font-bold">{title}</DialogTitle>
              <DialogDescription className="text-base">{description}</DialogDescription>
            </DialogHeader>
            <DialogBody className="gap-3 px-6 pb-4 md:px-9">{children}</DialogBody>
            <DialogFooter className="mt-0 flex-row justify-between border-t-0 bg-transparent px-6 pt-2 pb-5">
              <Button
                variant="outline"
                size="lg"
                className="min-w-28 bg-card"
                onClick={() => onOpenChange(false)}
              >
                Close
              </Button>
              <Button size="lg" className="min-w-52" disabled={actionDisabled} onClick={onAction}>
                {action}
                <ArrowRightIcon aria-hidden="true" />
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A group of choices in a MIDI dialog: a card with a heading. */
export function MidiCard({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn("flex flex-col gap-3 rounded-xl border bg-card/90 p-4", className)}
    >
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** Large toggle buttons for one choice of a few (dialog-design: filled when chosen). */
export function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-9 rounded-lg border px-3 text-sm font-semibold transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            value === o.value
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card hover:bg-accent",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A labelled checkbox row. */
export function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-4 accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
