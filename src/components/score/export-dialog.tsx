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
import type { ExportChoice, ExportGroup } from "@/lib/export/choices";

/**
 * Lists every format Smart Beat can write, so nobody has to know which menu entry makes which
 * file (#90). Save keeps working on your song; Export writes a copy in the format you pick.
 */
export function ExportDialog({
  open,
  onOpenChange,
  groups,
  onChoose,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: ExportGroup[];
  onChoose: (choice: ExportChoice) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
          <DialogDescription>
            Save keeps working on your song. Export writes a copy in another format and leaves the
            song as it is. Formats that hold less than Smart Beat does tell you what was left out.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {groups.map((group) => (
            <section key={group.title} aria-label={group.title} className="flex flex-col gap-1.5">
              <h3 className="text-sm font-medium">{group.title}</h3>
              <ul className="flex flex-col gap-1">
                {group.choices.map((choice) => (
                  <li key={choice.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onOpenChange(false);
                        onChoose(choice);
                      }}
                      className="flex w-full flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <span className="flex w-full items-baseline justify-between gap-2 text-sm font-medium">
                        {choice.label}
                        <span className="text-xs font-normal text-muted-foreground tabular-nums">
                          .{choice.extension}
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground">{choice.note}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
