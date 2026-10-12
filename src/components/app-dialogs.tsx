import { AboutDialog } from "@/components/about-dialog";
import { LicensesDialog } from "@/components/licenses-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { AudioTranscriptionDialog } from "@/components/audio/audio-transcription-dialog";
import type { AudioTranscriptionProvider } from "@/lib/audio-transcription/provider";
import type { DroppedRecording } from "@/components/audio/audio-transcription-dialog";

export type AppDialog = "about" | "shortcuts" | "licenses" | "settings" | "audio-transcription";

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
  audioProvider,
  droppedRecording,
  onAudioImport,
  onAudioSave,
}: {
  open: AppDialog | null;
  onOpenChange: (dialog: AppDialog | null) => void;
  /**
   * Element to focus when the dialog closes. Needed when a dialog is opened
   * from a dropdown item, which no longer exists once the dialog closes.
   * When `null`, Radix restores focus to whatever was focused before.
   */
  returnFocusTo: HTMLElement | null;
  audioProvider: AudioTranscriptionProvider;
  droppedRecording?: DroppedRecording | null;
  onAudioImport: (midi: Uint8Array<ArrayBuffer>, name: string) => Promise<void>;
  onAudioSave: (midi: Uint8Array<ArrayBuffer>, name: string) => Promise<void>;
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
      <AudioTranscriptionDialog
        open={open === "audio-transcription"}
        onOpenChange={(isOpen) => onOpenChange(isOpen ? "audio-transcription" : null)}
        onCloseAutoFocus={restoreFocus}
        provider={audioProvider}
        droppedRecording={droppedRecording}
        onImport={onAudioImport}
        onSave={onAudioSave}
      />
    </>
  );
}
