import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AppDialogs, type AppDialog } from "@/components/app-dialogs";
import { AppFooter } from "@/components/app-footer";
import { AppHeader } from "@/components/app-header";
import { DropOverlay } from "@/components/drop-overlay";
import { ScoreWorkspace } from "@/components/score/score-workspace";
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

export function App() {
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const [returnFocusTo, setReturnFocusTo] = useState<HTMLElement | null>(null);
  const { toggleTheme } = useTheme();
  const { song, openPath, openFile } = useScoreDocument();
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const dragging = useFileDrop({
    onDropPaths: (paths) => {
      const path = firstScoreFile(paths, baseName);
      if (path) void openPath(path);
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
      case "open":
        void showOpenDialog();
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
        // Window actions (zoom, full screen, quit) are handled natively.
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
            <ScoreWorkspace key={song.id} song={song} onOpen={() => void showOpenDialog()} />
          ) : (
            <Welcome
              onOpenFile={() => void showOpenDialog()}
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
      <AppDialogs open={dialog} onOpenChange={setDialog} returnFocusTo={returnFocusTo} />
      <Toaster position="bottom-right" />
    </>
  );
}
