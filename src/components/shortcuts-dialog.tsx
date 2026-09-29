import type { AppDialogProps } from "@/components/app-dialogs";
import { AsyncContent } from "@/components/async-content";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { usePromise } from "@/hooks/use-promise";
import { errorText } from "@/lib/errors";
import { groupByMenu } from "@/lib/shortcuts";
import { getMenuShortcuts, type Shortcut } from "@/lib/tauri";

function ShortcutKeys({ shortcut }: { shortcut: Shortcut }) {
  return (
    <>
      <KbdGroup aria-hidden="true">
        {shortcut.keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </KbdGroup>
      <span className="sr-only">{shortcut.spoken}</span>
    </>
  );
}

function ShortcutList() {
  const state = usePromise(getMenuShortcuts);

  return (
    <AsyncContent
      state={state}
      loadingLabel="Loading shortcuts…"
      errorMessage={(error) => `Shortcuts are unavailable. ${errorText(error)}`}
    >
      {(shortcuts) => (
        <div className="flex flex-col gap-5">
          {groupByMenu(shortcuts).map(([menu, items]) => (
            <section key={menu} aria-labelledby={`shortcuts-${menu}`}>
              <h3
                id={`shortcuts-${menu}`}
                className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
              >
                {menu}
              </h3>
              <dl className="divide-y rounded-lg border">
                {items.map((shortcut) => (
                  <div
                    key={shortcut.action}
                    className="flex items-center justify-between gap-4 px-3 py-2"
                  >
                    <dt>{shortcut.label}</dt>
                    <dd>
                      <ShortcutKeys shortcut={shortcut} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </AsyncContent>
  );
}

export function ShortcutsDialog({ open, onOpenChange, onCloseAutoFocus }: AppDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-md"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Shortcuts for the menu bar on this computer.</DialogDescription>
        </DialogHeader>
        <ShortcutList />
      </DialogContent>
    </Dialog>
  );
}
