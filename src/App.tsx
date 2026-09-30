import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AppDialogs, type AppDialog } from "@/components/app-dialogs";
import { AppFooter } from "@/components/app-footer";
import { AppHeader } from "@/components/app-header";
import { DiscardDialog } from "@/components/discard-dialog";
import { DropOverlay } from "@/components/drop-overlay";
import { SkipLink } from "@/components/skip-link";
import { Toaster } from "@/components/ui/sonner";
import { Welcome } from "@/components/welcome";
import { useFileDrop } from "@/hooks/use-file-drop";
import { useMenuActions } from "@/hooks/use-menu-actions";
import { firstScoreFile, useScoreDocument } from "@/hooks/use-score-document";
import { useTheme } from "@/hooks/use-theme";
import { errorText } from "@/lib/errors";
import { baseName } from "@/lib/score/format";
import { isTauri, pickScoreFile, SCORE_EXTENSIONS, setWindowTitle } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const ACCEPT = SCORE_EXTENSIONS.map((ext) => `.${ext}`).join(",");

// alphaTab (renderer and synthesizer) is large: load it with the first song.
const ScoreWorkspace = lazy(() =>
  import("@/components/score/score-workspace").then((m) => ({ default: m.ScoreWorkspace })),
);

export function App() {
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const [returnFocusTo, setReturnFocusTo] = useState<HTMLElement | null>(null);
  const { toggleTheme } = useTheme();
  const { song, openPath, openFile, newSong } = useScoreDocument();
  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * The open song has changes that would be lost by opening another one. A
   * ref, updated as soon as the music changes, so a menu command right after
   * an edit sees it.
   */
  const edited = useRef(false);
  const setEdited = useCallback((value: boolean) => {
    edited.current = value;
  }, []);
  /** What to do once the user agrees to discard their changes. */
  const [pending, setPending] = useState<(() => void) | null>(null);

  /** Runs `action` (which replaces the song), asking first if it was edited. */
  const replaceSong = (action: () => void) => {
    if (song && edited.current) setPending(() => action);
    else action();
  };

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

  const open = () => replaceSong(() => void showOpenDialog());
  const startNewSong = () => replaceSong(() => void newSong());

  const dragging = useFileDrop({
    onDropPaths: (paths) => {
      const path = firstScoreFile(paths, baseName);
      if (path) replaceSong(() => void openPath(path));
    },
    onDropFiles: (files) => {
      const file = firstScoreFile(files, (f) => f.name);
      if (file) replaceSong(() => void openFile(file));
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
        <AppHeader onShowDialog={showDialog} wide={song !== null} />
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
              <ScoreWorkspace
                key={song.id}
                song={song}
                onOpen={open}
                onEditedChange={setEdited}
                startEditing={song.isNew}
              />
            </Suspense>
          ) : (
            <Welcome
              onOpenFile={open}
              onNewSong={startNewSong}
              onShowShortcuts={() => showDialog("shortcuts")}
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
        songName={song ? song.summary.title || song.name : ""}
        open={pending !== null}
        onCancel={() => setPending(null)}
        onDiscard={() => {
          const action = pending;
          setPending(null);
          edited.current = false;
          action?.();
        }}
      />
      <AppDialogs open={dialog} onOpenChange={setDialog} returnFocusTo={returnFocusTo} />
      <Toaster position="bottom-right" />
    </>
  );
}
