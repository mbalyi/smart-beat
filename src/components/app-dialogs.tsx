import { AboutDialog } from "@/components/about-dialog";
import { LicensesDialog } from "@/components/licenses-dialog";
import { SettingsDialog, type SettingsSection } from "@/components/settings-dialog";
import { ShortcutsDialog } from "@/components/shortcuts-dialog";
import { WhatsNewDialog } from "@/components/whats-new-dialog";
import type { FeatureEntry, TourId } from "@/lib/tour/feature-registry";
import { AudioTranscriptionDialog } from "@/components/audio/audio-transcription-dialog";
import type { AudioTranscriptionProvider } from "@/lib/audio-transcription/provider";
import type { DroppedRecording } from "@/components/audio/audio-transcription-dialog";
import { StemDialog, type DroppedSong } from "@/components/stems/stem-dialog";
import type { StemSong } from "@/lib/tauri";

export type AppDialog =
  | "about"
  | "shortcuts"
  | "licenses"
  | "settings"
  | "audio-transcription"
  | "whats-new"
  | "stem-separation";

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
  droppedStem,
  onStemSeparated,
  whatsNew,
  onShowTour,
  settingsSection = null,
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
  /** A song dropped on the window while Stem separation is open. */
  droppedStem?: DroppedSong | null;
  /** A song was separated: the app opens its page. */
  onStemSeparated: (song: StemSong) => void;
  /** The features the What's New dialog lists. */
  whatsNew: { version: string; features: readonly FeatureEntry[] };
  onShowTour: (tour: TourId) => void;
  /** The Settings section to open on (Help › Cloud Storage Settings…). */
  settingsSection?: SettingsSection | null;
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
      <SettingsDialog {...props("settings")} section={settingsSection} />
      <WhatsNewDialog
        {...props("whats-new")}
        version={whatsNew.version}
        features={whatsNew.features}
        onShowMe={onShowTour}
      />
      <AudioTranscriptionDialog
        open={open === "audio-transcription"}
        onOpenChange={(isOpen) => onOpenChange(isOpen ? "audio-transcription" : null)}
        onCloseAutoFocus={restoreFocus}
        provider={audioProvider}
        droppedRecording={droppedRecording}
        onImport={onAudioImport}
        onSave={onAudioSave}
      />
      <StemDialog
        {...props("stem-separation")}
        droppedSong={droppedStem}
        onSeparated={onStemSeparated}
      />
    </>
  );
}
