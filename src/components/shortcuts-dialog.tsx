import type { AppDialogProps } from "@/components/app-dialogs";
import { AsyncContent } from "@/components/async-content";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { EDITOR_SHORTCUTS } from "@/hooks/use-editor-keys";
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

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

/** The score editor's keys (Edit mode), which don't live in the menu bar. */
function EditorShortcuts() {
  const mac = isMac();
  const mod = mac ? "⌘" : "Ctrl";
  const spokenMod = mac ? "Command" : "Control";
  const alt = (key: string) => (key === "⌥" && !mac ? "Alt" : key);
  return (
    <section aria-labelledby="shortcuts-editor">
      <h3
        id="shortcuts-editor"
        className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
      >
        Score editor (Edit mode)
      </h3>
      <dl className="divide-y rounded-lg border">
        {EDITOR_SHORTCUTS.map(({ keys, spoken, label }) => (
          <div key={label} className="flex items-center justify-between gap-4 px-3 py-2">
            <dt>{label}</dt>
            <dd className="shrink-0">
              <KbdGroup aria-hidden="true">
                {keys.map((key) => (
                  <Kbd key={key} className="text-foreground">
                    {key === "mod" ? mod : alt(key)}
                  </Kbd>
                ))}
              </KbdGroup>
              <span className="sr-only">
                {spoken.replace("mod", spokenMod).replace("Option", mac ? "Option" : "Alt")}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ShortcutsDialog({ open, onOpenChange, onCloseAutoFocus }: AppDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts for the menu bar on this computer, and for writing music in the score.
          </DialogDescription>
        </DialogHeader>
        {/* Focusable, so the list can be scrolled with the keyboard. */}
        <DialogBody
          tabIndex={0}
          role="region"
          aria-label="Shortcuts list"
          className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <div className="flex flex-col gap-5">
            <ShortcutList />
            <EditorShortcuts />
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
