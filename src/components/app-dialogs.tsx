import { AboutDialog } from "@/components/about-dialog";
import { LicensesDialog } from "@/components/licenses-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";

export type AppDialog = "about" | "shortcuts" | "licenses" | "settings";

export interface AppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

/** The app-level dialogs; at most one is open at a time. */
export function AppDialogs({
  open,
  onOpenChange,
  returnFocusTo,
}: {
  open: AppDialog | null;
  onOpenChange: (dialog: AppDialog | null) => void;
  /**
   * Element to focus when the dialog closes. Needed when a dialog is opened
   * from a dropdown item, which no longer exists once the dialog closes.
   * When `null`, Radix restores focus to whatever was focused before.
   */
  returnFocusTo: HTMLElement | null;
}) {
  const restoreFocus = (event: Event) => {
    if (returnFocusTo?.isConnected) {
      event.preventDefault();
      returnFocusTo.focus();
    }
  };

  const props = (dialog: AppDialog): AppDialogProps => ({
    open: open === dialog,
    onOpenChange: (isOpen) => onOpenChange(isOpen ? dialog : null),
    onCloseAutoFocus: restoreFocus,
  });

  return (
    <>
      <AboutDialog {...props("about")} />
      <ShortcutsDialog {...props("shortcuts")} />
      <LicensesDialog {...props("licenses")} />
      <SettingsDialog {...props("settings")} />
    </>
  );
}
