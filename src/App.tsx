import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AppDialogs, type AppDialog } from "@/components/app-dialogs";
import { AppFooter } from "@/components/app-footer";
import { AppHeader } from "@/components/app-header";
import { DocumentTabs } from "@/components/shell/document-tabs";
import { DiscardDialog } from "@/components/discard-dialog";
import { DropOverlay } from "@/components/drop-overlay";
import { SkipLink } from "@/components/skip-link";
import { UpdateDialog } from "@/components/update-dialog";
import { Toaster } from "@/components/ui/sonner";
import { Welcome } from "@/components/welcome";
import { useFileDrop } from "@/hooks/use-file-drop";
import { useMenuActions } from "@/hooks/use-menu-actions";
import { useRecentFiles } from "@/hooks/use-recent-files";
import { initLayoutPrefs } from "@/lib/score/layout";
import { firstScoreFile, useScoreDocuments } from "@/hooks/use-score-document";
import { useTheme } from "@/hooks/use-theme";
import { useUpdater } from "@/hooks/use-updater";
import { errorText } from "@/lib/errors";
import { hasScoreExtension } from "@/lib/score/errors";
import { baseName } from "@/lib/score/format";
import {
  AUDIO_EXTENSIONS,
  isTauri,
  pickScoreFile,
  SCORE_EXTENSIONS,
  setWindowTitle,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

const ACCEPT = SCORE_EXTENSIONS.map((ext) => `.${ext}`).join(",");

// alphaTab (renderer and synthesizer) is large: load it with the first song.
/** Whether a dropped file is a recording for the audio track. */
const isAudioFile = (path: string) =>
  (AUDIO_EXTENSIONS as readonly string[]).includes(path.split(".").pop()?.toLowerCase() ?? "");

const ScoreWorkspace = lazy(() =>
  import("@/components/score/score-workspace").then((m) => ({ default: m.ScoreWorkspace })),
);

export function App() {
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const [returnFocusTo, setReturnFocusTo] = useState<HTMLElement | null>(null);
  const { toggleTheme } = useTheme();
  const updater = useUpdater();
  const {
    songs,
    song,
    activate,
    close,
    openPath,
    openFile,
    newSong,
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

  const open = () => void showOpenDialog();
  const recent = useRecentFiles((path) => void openPath(path), recentsVersion);
  // A new install starts with a quiet layout; earlier users keep their panels (#83).
  useEffect(() => {
    void initLayoutPrefs();
  }, []);

  const [droppedAudio, setDroppedAudio] = useState<{ path: string; nonce: number } | null>(null);
  const dragging = useFileDrop({
    onDropPaths: (paths) => {
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
      case "toggle-theme":
        toggleTheme();
        break;
      case "about":
      case "shortcuts":
      case "licenses":
        showDialog(action);
        break;
      case "check-for-updates":
        updater.checkNow();
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
                    onEditedChange={(value) => setEdited(s.id, value)}
                    onSaved={(saved) => markSaved(s.id, saved)}
                    onReopenWithEncoding={(choice) => reopenWithEncoding(s.id, choice)}
                    startEditing={s.isNew}
                    droppedAudio={s.id === song.id ? droppedAudio : null}
                  />
                ))}
              </div>
            </Suspense>
          ) : (
            <Welcome
              onOpenFile={open}
              onNewSong={startNewSong}
              onShowShortcuts={() => showDialog("shortcuts")}
              recent={recent}
              onOpenRecent={(path) => void openPath(path)}
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
      <DropOverlay visible={dragging} />
      <DiscardDialog
        songName={closing ? closing.summary.title || closing.name : ""}
        open={closing !== null}
        onCancel={() => setPendingClose(null)}
        onDiscard={() => closing && discardAndClose(closing.id)}
      />
      <AppDialogs open={dialog} onOpenChange={setDialog} returnFocusTo={returnFocusTo} />
      <UpdateDialog updater={updater} />
      <Toaster position="bottom-right" />
    </>
  );
}
