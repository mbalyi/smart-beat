import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { track } from "@/lib/telemetry";
import { toast } from "sonner";

import { AppDialogs, type AppDialog } from "@/components/app-dialogs";
import { AiInstallerDialog } from "@/components/ai/ai-installer-dialog";
import { onInstallerReturn, openInstaller } from "@/lib/ai/ai-store";
import { AppFooter } from "@/components/app-footer";
import { AppHeader } from "@/components/app-header";
import { DocumentTabs } from "@/components/shell/document-tabs";
import { DiscardDialog } from "@/components/discard-dialog";
import { LeaveDialog } from "@/components/leave-dialog";
import { DropOverlay } from "@/components/drop-overlay";
import { SkipLink } from "@/components/skip-link";
import { useUsageNotice } from "@/hooks/use-usage-notice";
import { UpdateDialog } from "@/components/update-dialog";
import { Toaster } from "@/components/ui/sonner";
import { Welcome } from "@/components/welcome";
import { useFileDrop } from "@/hooks/use-file-drop";
import { useMenuActions } from "@/hooks/use-menu-actions";
import { useExternalOpen } from "@/hooks/use-external-open";
import { useRecentFiles } from "@/hooks/use-recent-files";
import { initLayoutPrefs, readLayoutPrefs } from "@/lib/score/layout";
import { firstScoreFile, useScoreDocuments } from "@/hooks/use-score-document";
import { useTheme } from "@/hooks/use-theme";
import { useUpdater } from "@/hooks/use-updater";
import type { HelpAction } from "@/components/help-menu";
import { useTour } from "@/hooks/use-tour";
import { demoSongFile, DEMO_SONG_TITLE } from "@/lib/tour/demo-song";
import type { TourId } from "@/lib/tour/feature-registry";
import { isExistingUser } from "@/lib/tour/tour-store";
import { latestFeatures, pendingFeatures } from "@/lib/tour/whats-new";
import { APP_VERSION } from "@/lib/project-info";
import { errorText } from "@/lib/errors";
import { hasScoreExtension } from "@/lib/score/errors";
import { baseName } from "@/lib/score/format";
import {
  AUDIO_EXTENSIONS,
  isTauri,
  pickSavePath,
  pickScoreFile,
  SCORE_EXTENSIONS,
  setWindowTitle,
  writeScoreFile,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { muscriptorProvider } from "@/lib/muscriptor";
import { isEnabled } from "@/lib/features";
import type { DroppedRecording } from "@/components/audio/audio-transcription-dialog";

const ACCEPT = SCORE_EXTENSIONS.map((ext) => `.${ext}`).join(",");

// alphaTab (renderer and synthesizer) is large: load it with the first song.
/** Whether a dropped file is a recording for the audio track. */
const isAudioFile = (path: string) =>
  (AUDIO_EXTENSIONS as readonly string[]).includes(path.split(".").pop()?.toLowerCase() ?? "");

const ScoreWorkspace = lazy(() =>
  import("@/components/score/score-workspace").then((m) => ({ default: m.ScoreWorkspace })),
);

export function App() {
  const [transcriptionDrop, setTranscriptionDrop] = useState<DroppedRecording | null>(null);
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const [returnFocusTo, setReturnFocusTo] = useState<HTMLElement | null>(null);
  const { toggleTheme } = useTheme();
  const updater = useUpdater();
  useUsageNotice(() => setDialog("settings"));
  const {
    songs,
    song,
    activate,
    close,
    closeAll,
    openPath,
    openFile,
    newSong,
    openScore,
    markSaved,
    reopenWithEncoding,
    recentsVersion,
  } = useScoreDocuments();
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Where an open song puts its main controls (the app header's centre). */
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  /**
   * Songs with changes that would be lost by closing them. A ref, updated as
   * soon as the music changes, so a menu command right after an edit sees it.
   */
  const edited = useRef(new Set<number>());
  const [editedIds, setEditedIds] = useState<ReadonlySet<number>>(() => new Set());
  const setEdited = useCallback((id: number, value: boolean) => {
    if (edited.current.has(id) === value) return;
    if (value) edited.current.add(id);
    else edited.current.delete(id);
    setEditedIds(new Set(edited.current));
  }, []);
  /** The song the user is asked about: closing it would lose changes. */
  const [pendingClose, setPendingClose] = useState<number | null>(null);

  const closeSong = (id: number) => {
    if (edited.current.has(id)) {
      setPendingClose(id);
      return;
    }
    close(id);
  };

  const discardAndClose = (id: number) => {
    setPendingClose(null);
    setEdited(id, false);
    close(id);
  };

  /** The logo: back to the start screen. Unsaved changes are asked about first. */
  const [leaving, setLeaving] = useState(false);
  const goHome = () => {
    if (songs.length === 0) return;
    if (edited.current.size > 0) {
      setLeaving(true);
      return;
    }
    closeAll();
  };
  const leaveAndGoHome = () => {
    setLeaving(false);
    edited.current.clear();
    setEditedIds(new Set());
    closeAll();
  };
  const unsavedNames = songs
    .filter((s) => editedIds.has(s.id))
    .map((s) => s.summary.title || s.name);

  const startNewSong = () => void newSong();

  const tabs = (
    <DocumentTabs
      tabs={songs.map((s) => ({
        id: s.id,
        title: s.summary.title || s.name,
        edited: editedIds.has(s.id),
      }))}
      activeId={song?.id ?? null}
      onActivate={activate}
      onClose={closeSong}
      onNew={startNewSong}
    />
  );
  const closing = songs.find((s) => s.id === pendingClose) ?? null;

  const showDialog = (next: AppDialog, returnFocusTo: HTMLElement | null = null) => {
    if (next === "settings") track("settings_open");
    setReturnFocusTo(returnFocusTo);
    setDialog(next);
  };

  const showOpenDialog = async () => {
    // A browser (`pnpm dev`) can't show the native dialog: use a file input.
    if (!isTauri()) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const path = await pickScoreFile();
      if (path) await openPath(path);
    } catch (error) {
      toast.error("Couldn't show the Open dialog", { description: errorText(error) });
    }
  };

  // The installer hands the user back to Import from Audio when it closes.
  useEffect(() => onInstallerReturn("audio", () => setDialog("audio-transcription")), []);

  const open = () => void showOpenDialog();
  // Import from Audio stays out of reach until the feature is switched on.
  const importAudio = isEnabled("audio-2-tab")
    ? () => showDialog("audio-transcription")
    : undefined;
  const recent = useRecentFiles((path) => void openPath(path), recentsVersion);
  useExternalOpen((path) => void openPath(path));
  // A new install starts with a quiet layout; earlier users keep their panels (#83).
  const tour = useTour();
  // What's new after an update: once per version, never on a fresh install (it gets the welcome).
  const [whatsNew, setWhatsNew] = useState<ReturnType<typeof latestFeatures>>(() =>
    latestFeatures(),
  );
  const initTour = tour.init;
  useEffect(() => {
    void (async () => {
      const before = readLayoutPrefs();
      const prefs = await initLayoutPrefs();
      const state = initTour(isExistingUser(before, prefs));
      const pending = state ? pendingFeatures(state.lastSeenVersion, APP_VERSION) : [];
      if (pending.length > 0 && state?.tours.main !== undefined) {
        setWhatsNew({ version: APP_VERSION, features: pending });
        setDialog("whats-new");
      }
    })();
  }, [initTour]);

  // The guided tours (#84) open the demo song when they need a song and none is open.
  const songOpen = song !== null;
  const songOpenRef = useRef(songOpen);
  useEffect(() => {
    songOpenRef.current = songOpen;
  });
  const openDemo = useCallback(() => {
    void openFile(demoSongFile(), DEMO_SONG_TITLE, true);
  }, [openFile]);
  const bindTourHost = tour.bindHost;
  useEffect(() => {
    bindTourHost({ hasSong: () => songOpenRef.current, openDemo });
  }, [bindTourHost, openDemo]);

  const startTour = (id: TourId) => {
    const step = id === "main" ? tour.resumeStep(id) : null;
    tour.start(id, step ?? 0);
  };
  const helpAction = (action: HelpAction) => {
    if (typeof action === "object") startTour(action.tour);
    else if (action === "demo-song") openDemo();
    else if (action === "whats-new") showDialog("whats-new");
    else tour.resetHints();
  };

  const [droppedAudio, setDroppedAudio] = useState<{ path: string; nonce: number } | null>(null);
  const dragging = useFileDrop({
    onDropPaths: (paths) => {
      if (dialog === "audio-transcription") {
        if (paths[0])
          setTranscriptionDrop((current) => ({ path: paths[0], nonce: (current?.nonce ?? 0) + 1 }));
        return;
      }
      const score = paths.find((p) => hasScoreExtension(baseName(p)));
      if (score) {
        void openPath(score);
        return;
      }
      // An mp3, wav… dropped on an open song becomes its audio track; an amp
      // capture (.nam) goes to the sound library (the workspace decides).
      const sound = song ? paths.find((p) => isAudioFile(p) || /\.nam$/i.test(p)) : undefined;
      if (sound) {
        setDroppedAudio((d) => ({ path: sound, nonce: (d?.nonce ?? 0) + 1 }));
        return;
      }
      // Anything else: opening it reports why it is not a song.
      if (paths[0]) void openPath(paths[0]);
    },
    onDropFiles: (files) => {
      if (dialog === "audio-transcription") {
        if (files[0])
          setTranscriptionDrop((current) => ({ file: files[0], nonce: (current?.nonce ?? 0) + 1 }));
        return;
      }
      const file = firstScoreFile(files, (f) => f.name);
      if (file) void openFile(file);
    },
  });

  useEffect(() => {
    const title = song ? `${song.summary.title || song.name} — Smart Beat` : "Smart Beat";
    setWindowTitle(title).catch((error: unknown) => {
      console.warn("Could not set the window title", error);
    });
  }, [song]);

  useMenuActions((action) => {
    switch (action) {
      case "new-song":
        startNewSong();
        break;
      case "open":
        open();
        break;
      case "ai-models":
        // From the AI menu there is no dialog to go back to.
        openInstaller();
        break;
      case "import-audio":
        importAudio?.();
        break;
      case "toggle-theme":
        toggleTheme();
        break;
      case "about":
      case "shortcuts":
      case "settings":
      case "licenses":
        showDialog(action);
        break;
      case "check-for-updates":
        updater.checkNow();
        break;
      case "tour":
        startTour("main");
        break;
      case "tour-editing":
        startTour("editing");
        break;
      case "tour-speed-trainer":
        startTour("speed-trainer");
        break;
      case "tour-effects":
        startTour("effects");
        break;
      case "tour-record-to-tab":
        startTour("record-to-tab");
        break;
      case "demo-song":
        openDemo();
        break;
      case "whats-new":
        helpAction("whats-new");
        break;
      case "reset-tips":
        tour.resetHints();
        break;
      default:
        // Window actions (zoom, full screen, quit) are handled natively;
        // song actions (undo, loop, tracks...) by the workspace.
        break;
    }
  });

  return (
    <>
      <SkipLink />
      <div className={cn("flex flex-col", song ? "h-svh" : "min-h-svh")}>
        <AppHeader
          onShowDialog={showDialog}
          onCheckForUpdates={isTauri() ? updater.checkNow : undefined}
          onHelpAction={helpAction}
          resumeStep={tour.resumeStep("main")}
          onHome={goHome}
          wide={song !== null}
          centerRef={setHeaderSlot}
        />
        <main
          id="main"
          tabIndex={-1}
          className={cn("flex-1 outline-none", song && "flex min-h-0 flex-col")}
        >
          {song ? (
            <Suspense
              fallback={
                <p role="status" className="p-6 text-muted-foreground">
                  Loading the score viewer…
                </p>
              }
            >
              <div className="relative min-h-0 flex-1">
                {songs.map((s) => (
                  <ScoreWorkspace
                    key={s.id}
                    song={s}
                    active={s.id === song.id}
                    tabs={tabs}
                    headerSlot={headerSlot}
                    onOpen={open}
                    onOpenScore={(score, name) => void openScore(score, name)}
                    onEditedChange={(value) => setEdited(s.id, value)}
                    onSaved={(saved) => markSaved(s.id, saved)}
                    onReopenWithEncoding={(choice) => reopenWithEncoding(s.id, choice)}
                    startEditing={s.isNew}
                    droppedAudio={s.id === song.id ? droppedAudio : null}
                    onOpenSettings={(from) => showDialog("settings", from)}
                  />
                ))}
              </div>
            </Suspense>
          ) : (
            <Welcome
              onOpenFile={open}
              onImportAudio={importAudio}
              onNewSong={startNewSong}
              onShowShortcuts={() => showDialog("shortcuts")}
              onShowLicenses={() => showDialog("licenses")}
              recent={recent}
              onOpenRecent={(path) => void openPath(path)}
              onTakeTour={() => startTour("main")}
              tour={
                tour.offerMainTour
                  ? { onStart: () => startTour("main"), onSkip: tour.dismissMainTour }
                  : undefined
              }
            />
          )}
        </main>
        {!song && <AppFooter />}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        hidden
        aria-label="Guitar Pro file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = ""; // allow picking the same file again
          if (file) void openFile(file);
        }}
      />
      <DropOverlay visible={dragging && dialog !== "audio-transcription"} />
      <DiscardDialog
        songName={closing ? closing.summary.title || closing.name : ""}
        open={closing !== null}
        onCancel={() => setPendingClose(null)}
        onDiscard={() => closing && discardAndClose(closing.id)}
      />
      <LeaveDialog
        songNames={unsavedNames}
        open={leaving}
        onCancel={() => setLeaving(false)}
        onLeave={leaveAndGoHome}
      />
      <AppDialogs
        open={dialog}
        onOpenChange={(next) => {
          if (dialog === "whats-new" && next !== "whats-new") tour.markVersionSeen();
          setDialog(next);
        }}
        returnFocusTo={returnFocusTo}
        audioProvider={muscriptorProvider}
        whatsNew={whatsNew}
        onShowTour={startTour}
        droppedRecording={transcriptionDrop}
        onAudioImport={async (midi, name) => {
          // Only in memory until saved: closing the song asks first.
          const opened = await openFile(
            new File([midi], name, { type: "audio/midi" }),
            name.replace(/\.mid$/i, ""),
            true,
          );
          if (!opened)
            throw new Error(
              "The generated MIDI could not be imported. Your transcription is still available to save or retry.",
            );
        }}
        onAudioSave={async (midi, name) => {
          const path = await pickSavePath(
            name,
            [{ name: "MIDI files", extensions: ["mid"] }],
            "Save MIDI As",
          );
          if (path) await writeScoreFile(path, midi);
        }}
      />
      <AiInstallerDialog />
      <UpdateDialog updater={updater} />
      <Toaster position="bottom-right" />
    </>
  );
}
