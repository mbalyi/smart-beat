import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AudioWaveformIcon } from "lucide-react";
import { track } from "@/lib/telemetry";
import { toast } from "sonner";

import { AppDialogs, type AppDialog } from "@/components/app-dialogs";
import type { SettingsSection } from "@/components/settings-dialog";
import { AiInstallerDialog } from "@/components/ai/ai-installer-dialog";
import { onInstallerReturn } from "@/lib/ai/ai-store";
import { CloudLibraryDialog } from "@/components/cloud-library-dialog";
import { CloudOpenDialog } from "@/components/cloud-open-dialog";
import { SaveTargetDialog } from "@/components/save-target-dialog";
import { listCloudAccounts, type CloudProvider } from "@/lib/cloud";
import { opened as countTogetherOpened } from "@/lib/practice-together/analytics";
import { setLiveShower } from "@/lib/practice-together/live";
import { ShareProvider } from "@/providers/share-provider";
import { toCloudDrives, type CloudDrive } from "@/lib/cloud-items";
import { AppFooter } from "@/components/app-footer";
import { AppHeader } from "@/components/app-header";
import { DocumentTabs } from "@/components/shell/document-tabs";
import { DiscardDialog } from "@/components/discard-dialog";
import { LeaveDialog } from "@/components/leave-dialog";
import { DropOverlay } from "@/components/drop-overlay";
import { SkipLink } from "@/components/skip-link";
import { useCloudFlush } from "@/hooks/use-cloud-flush";
import { useUsageNotice } from "@/hooks/use-usage-notice";
import { UpdateDialog } from "@/components/update-dialog";
import { Toaster } from "@/components/ui/sonner";
import { Welcome } from "@/components/welcome";
import {
  PracticeTogetherLauncher,
  type TogetherSource,
} from "@/components/practice-together/practice-together-launcher";
import type { TogetherMode } from "@/components/practice-together/practice-together-dialog";
import { OpenStemsDialog } from "@/components/stems/open-stems-dialog";
import { StemPage } from "@/components/stems/stem-page";
import type { DroppedSong } from "@/components/stems/stem-dialog";
import { useFileDrop } from "@/hooks/use-file-drop";
import { dispatchMenuAction, useMenuActions } from "@/hooks/use-menu-actions";
import { useExternalOpen } from "@/hooks/use-external-open";
import { useRecentFiles } from "@/hooks/use-recent-files";
import { useStemBundleOpened } from "@/hooks/use-stem-bundle-opened";
import { initLayoutPrefs, readLayoutPrefs } from "@/lib/score/layout";
import {
  firstScoreFile,
  isUntouchedBlank,
  songTitle,
  useScoreDocuments,
} from "@/hooks/use-score-document";
import type { ReceivedScore } from "@/hooks/use-tab-sharing";
import type { MixerSettings } from "@/lib/tauri";
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
  isStemFileStopped,
  isTauri,
  openStemBundle,
  openStemBundleFromCloud,
  pickSavePath,
  pickScoreFile,
  pickStemBundle,
  savePicks,
  SCORE_EXTENSIONS,
  setWindowTitle,
  touchStemSong,
  writeScoreFile,
  type StemSong,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { muscriptorProvider } from "@/lib/muscriptor";
import { isEnabled } from "@/lib/features";
import type { DroppedRecording } from "@/components/audio/audio-transcription-dialog";

/** How long a started save may show no sign of life (no dialog, no change) before it is given up. */
const SAVE_IDLE_MS = 15_000;

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
  const [stemDrop, setStemDrop] = useState<DroppedSong | null>(null);
  /** The separated songs that are open as tabs, and the one whose page is shown. */
  const [stemSongs, setStemSongs] = useState<StemSong[]>([]);
  const [activeStemId, setActiveStemId] = useState<string | null>(null);
  /** Where each separated song was saved from its page (the page forgets it when it closes). */
  const [savedStems, setSavedStems] = useState<Readonly<Record<string, string>>>({});
  const [openStemsDialog, setOpenStemsDialog] = useState(false);
  /** Practice together from the start screen: the first choice, and what the next shown tab does. */
  const [togetherLauncher, setTogetherLauncher] = useState(false);
  const [togetherIntent, setTogetherIntent] = useState<TogetherMode | null>(null);
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const [returnFocusTo, setReturnFocusTo] = useState<HTMLElement | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const { toggleTheme } = useTheme();
  const updater = useUpdater();
  useUsageNotice(() => {
    setSettingsSection(null);
    setDialog("settings");
  });
  useCloudFlush();
  const {
    songs,
    song,
    activate,
    close,
    openPath,
    openFile,
    newSong,
    openScore,
    openReceived,
    markSaved,
    reopenWithEncoding,
    reloadFromDisk,
    recentsVersion,
  } = useScoreDocuments();
  // Practice together moves between tabs: it can bring a tab to the front (a guest's host changed
  // tab, or the tab that held the session closed).
  const activateRef = useRef(activate);
  useEffect(() => {
    activateRef.current = activate;
  });
  useEffect(() => {
    setLiveShower((id) => activateRef.current(id));
    return () => setLiveShower(null);
  }, []);
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
  /**
   * Practice together: the host's tab arrived. When the only open tab is an untouched blank one
   * (the guest joined from the start screen), the host's tab takes its place; any other tab,
   * and a blank one that was edited, stays.
   */
  const receiveTab = (tab: ReceivedScore, options: { replaceId?: number; mix?: MixerSettings }) => {
    const only = songs.length === 1 ? songs[0] : undefined;
    const blank = only && isUntouchedBlank(only, edited.current.has(only.id)) ? only.id : undefined;
    void openReceived(tab, { ...options, replaceId: options.replaceId ?? blank });
  };
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

  /** The logo asked to leave songs with unsaved changes: the dialog is open. */
  const [leaving, setLeaving] = useState(false);
  /** Save all is running (a second click does nothing). */
  const savingAll = useRef(false);
  /** The stem page shown instead of the start screen (never over an open song). */
  const stemSong = song ? null : (stemSongs.find((s) => s.id === activeStemId) ?? null);
  /** The page fills the window (header, tabs and controls stay, the content scrolls). */
  const fullHeight = song !== null || stemSong !== null;
  const latest = useRef({ songId: song?.id ?? null });
  useEffect(() => {
    latest.current = { songId: song?.id ?? null };
  });

  /**
   * The logo: the start screen. Open songs stay open (their tabs, edits and undo history are
   * kept, playing stops); opening something there adds a tab next to them. Songs with unsaved
   * changes are asked about first.
   */
  const goHome = () => {
    if (!song) {
      setActiveStemId(null);
      return;
    }
    if (edited.current.size > 0) setLeaving(true);
    else activate(null);
  };

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /**
   * Saves one edited song the way File › Save does: its tab is shown and the menu's Save goes
   * to its workspace. Resolves to whether the changes are saved. Gives up when it is cancelled
   * (Save As closed without a file), or when nothing happens for a while and no dialog is open.
   */
  const saveSong = async (id: number): Promise<boolean> => {
    activate(id);
    while (latest.current.songId !== id) await wait(20);
    await wait(30); // the workspace has the shown song's menu handler now
    const picks = savePicks.settled;
    const errorToasts = () =>
      document.querySelectorAll('[data-sonner-toast][data-type="error"]').length;
    const errorsBefore = errorToasts();
    dispatchMenuAction("save");
    let quietSince = Date.now();
    while (edited.current.has(id)) {
      await wait(50);
      const busy =
        savePicks.pending > 0 || document.querySelector('[role="dialog"],[role="alertdialog"]');
      if (busy) quietSince = Date.now();
      else if (savePicks.settled > picks && savePicks.cancelled) return false;
      else if (errorToasts() > errorsBefore) return false;
      else if (Date.now() - quietSince > SAVE_IDLE_MS) return false;
    }
    return true;
  };

  /** Leave dialog › Save: every edited song, one at a time, then the start screen. */
  const saveAllAndGoHome = async () => {
    if (savingAll.current) return;
    savingAll.current = true;
    setLeaving(false);
    try {
      for (const s of songs) {
        if (!edited.current.has(s.id)) continue;
        // A failed or cancelled save stops here, on that song, and leaves the rest as they are.
        if (!(await saveSong(s.id))) return;
      }
      activate(null);
    } finally {
      savingAll.current = false;
    }
  };

  const startNewSong = () => void newSong();

  const closeStem = (id: string) => {
    const index = stemSongs.findIndex((s) => s.id === id);
    const rest = stemSongs.filter((s) => s.id !== id);
    setStemSongs(rest);
    // Closing the shown page moves to its neighbour, or to the start screen with the last one.
    if (stemSong?.id === id) setActiveStemId(rest[Math.min(index, rest.length - 1)]?.id ?? null);
  };
  const activateStem = (id: string) => {
    activate(null);
    setActiveStemId(id);
  };
  const closing = songs.find((s) => s.id === pendingClose) ?? null;

  const showDialog = (
    next: AppDialog,
    returnFocusTo: HTMLElement | null = null,
    section: SettingsSection | null = null,
  ) => {
    if (next === "settings") track("settings_open");
    setSettingsSection(next === "settings" ? section : null);
    setReturnFocusTo(returnFocusTo);
    setDialog(next);
  };

  // On the stem page, + starts a stem separation (when the feature is on); elsewhere a new song.
  const newStem = stemSong && isEnabled("stem-separation");
  const tabs = (
    <DocumentTabs
      tabs={[
        ...songs.map((s) => ({
          id: s.id,
          title: songTitle(s),
          edited: editedIds.has(s.id),
        })),
        ...stemSongs.map((s) => ({
          id: s.id,
          title: s.name,
          edited: false,
          icon: (
            <AudioWaveformIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          ),
        })),
      ]}
      activeId={song?.id ?? stemSong?.id ?? null}
      onActivate={(id) => (typeof id === "number" ? activate(id) : activateStem(id))}
      onClose={(id) => (typeof id === "number" ? closeSong(id) : closeStem(id))}
      onNew={(button) => (newStem ? showDialog("stem-separation", button) : startNewSong())}
      label={stemSongs.length > 0 ? "Open songs and stems" : undefined}
      newLabel={newStem ? "New stem separation" : undefined}
    />
  );
  /** The computer's own Open dialog (a file input in a browser). */
  const showNativeOpenDialog = async () => {
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

  /**
   * Every online drive for the chooser, with the ones that can't be used yet disabled and a
   * hint why. `connected` is how many are signed in; none when they can't be listed.
   */
  const cloudDrives = async (): Promise<{ drives: CloudDrive[]; connected: CloudDrive[] }> => {
    if (!isTauri()) return { drives: [], connected: [] };
    try {
      const drives = toCloudDrives(await listCloudAccounts());
      return { drives, connected: drives.filter((d) => !d.disabled) };
    } catch {
      return { drives: [], connected: [] };
    }
  };

  /** "Set up cloud storage": closes the chooser or picker and opens Settings on that section. */
  const setUpCloud = () => {
    setOpenChooser(null);
    setCloudOpen(null);
    showDialog("settings", null, "cloud");
  };

  /** Where Open asks first (connected drives), and the drive whose songs are listed. */
  const [openChooser, setOpenChooser] = useState<CloudDrive[] | null>(null);
  const [cloudOpen, setCloudOpen] = useState<CloudDrive | null>(null);
  /** File › Cloud Library: every tab and stems file in the connected drives (#201). */
  const [libraryOpen, setLibraryOpen] = useState(false);

  /**
   * Open: always asks where first in the desktop app, with every drive that is not set up
   * disabled; the native dialog straight away only where the drives can't be listed (browser).
   */
  const showOpenDialog = async () => {
    const { drives } = await cloudDrives();
    if (drives.length > 0) setOpenChooser(drives);
    else await showNativeOpenDialog();
  };

  const chooseOpenTarget = (target: "computer" | CloudProvider) => {
    const drives = openChooser ?? [];
    setOpenChooser(null);
    if (target === "computer") void showNativeOpenDialog();
    else setCloudOpen(drives.find((d) => d.provider === target) ?? null);
  };

  /** File › Open from Cloud…: straight to the drive's songs. */
  const showCloudOpen = async () => {
    const { drives, connected } = await cloudDrives();
    if (connected.length === 0) {
      toast("Connect a cloud account in Settings first");
      showDialog("settings", null, "cloud");
    } else if (connected.length === 1) setCloudOpen(connected[0] ?? null);
    else setOpenChooser(drives);
  };

  // The installer hands the user back to Import from Audio when it closes.
  useEffect(() => onInstallerReturn("audio", () => setDialog("audio-transcription")), []);
  // ...and to Record to Tab Models when it was opened from there.
  useEffect(() => onInstallerReturn("models", () => setDialog("record-models")), []);

  const open = () => void showOpenDialog();
  // The tab chosen for Practice together is opened; the dialog of the shown tab continues from
  // there (host: it is the tab to share; join: a blank tab that the host's tab replaces). The
  // wish lapses when no tab was shown within a minute (the file picker was cancelled).
  useEffect(() => {
    if (!togetherIntent) return;
    const timer = setTimeout(() => setTogetherIntent(null), 60_000);
    return () => clearTimeout(timer);
  }, [togetherIntent]);
  const startTogether = (source: TogetherSource) => {
    setTogetherIntent("host");
    if (source.kind === "recent") void openPath(source.path);
    else if (source.kind === "file") open();
    else startNewSong();
  };
  const joinTogether = () => {
    setTogetherIntent("join");
    startNewSong();
  };
  // Stem separation stays out of reach until the feature is switched on.
  const separateStems = isEnabled("stem-separation")
    ? (button: HTMLElement) => showDialog("stem-separation", button)
    : undefined;
  /** Opens a separated song as a tab and shows its page, over any open song. */
  const addStemTab = (opened: StemSong) => {
    activate(null);
    setStemSongs((open) =>
      open.some((s) => s.id === opened.id)
        ? open.map((s) => (s.id === opened.id ? opened : s))
        : [...open, opened],
    );
    setActiveStemId(opened.id);
  };
  /** Shows a separated song's page and notes that it was just used (it moves up in Recent). */
  const showStemSong = (opened: StemSong) => {
    // The page and the list recover on their own if this fails: the time is only for ordering.
    touchStemSong(opened.id).catch(() => {});
    addStemTab(opened);
  };
  /** Reads a saved `.sbstems` file into the library and shows its page, over any open song. */
  const openStemBundleAt = async (path: string) => {
    const loading = toast.loading("Opening the saved stems…");
    try {
      addStemTab(await openStemBundle(path));
    } catch (error) {
      toast.error("Couldn't open the saved stems", { description: errorText(error) });
    } finally {
      toast.dismiss(loading);
    }
  };
  /** Downloads a saved stems file of an online drive and shows its page, over any open song. */
  const openCloudStemItem = async (item: string) => {
    const loading = toast.loading("Opening the saved stems…");
    try {
      addStemTab(await openStemBundleFromCloud(item));
    } catch (error) {
      if (!isStemFileStopped(error))
        toast.error("Couldn't open the saved stems", { description: errorText(error) });
    } finally {
      toast.dismiss(loading);
    }
  };
  /** Open stems: the computer's Open dialog, then the file. */
  const openSavedStems = isEnabled("stem-separation")
    ? async () => {
        try {
          const path = await pickStemBundle();
          if (path) await openStemBundleAt(path);
        } catch (error) {
          toast.error("Couldn't show the Open dialog", { description: errorText(error) });
        }
      }
    : undefined;
  useStemBundleOpened((path) => void openStemBundleAt(path), openSavedStems !== undefined);
  // Opening a song replaces the stem page: it would otherwise come back under the start screen.
  const [lastSong, setLastSong] = useState(song);
  if (song !== lastSong) {
    setLastSong(song);
    if (song) setActiveStemId(null);
  }
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
      if (dialog === "stem-separation") {
        const dropped = paths[0];
        if (dropped)
          setStemDrop((current) => ({ path: dropped, nonce: (current?.nonce ?? 0) + 1 }));
        return;
      }
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
      // A browser gives no path to separate from.
      if (dialog === "stem-separation") return;
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
    const title = song
      ? `${songTitle(song)} — Smart Beat`
      : stemSong
        ? `${stemSong.name} — Stem separation — Smart Beat`
        : "Smart Beat";
    setWindowTitle(title).catch((error: unknown) => {
      console.warn("Could not set the window title", error);
    });
  }, [song, stemSong]);

  useMenuActions((action) => {
    switch (action) {
      case "new-song":
        startNewSong();
        break;
      case "open":
        open();
        break;
      case "open-cloud":
        void showCloudOpen();
        break;
      case "cloud-library":
        setLibraryOpen(true);
        break;
      case "record-models":
        showDialog("record-models");
        break;
      case "stem-models":
        showDialog("stem-models");
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
      case "cloud-settings":
        // The same dialog as Settings, scrolled to the cloud storage section.
        showDialog("settings", null, "cloud");
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
    <ShareProvider onSetUpCloud={() => showDialog("settings", null, "cloud")}>
      <SkipLink />
      <div className={cn("flex flex-col", fullHeight ? "h-svh" : "min-h-svh")}>
        <AppHeader
          onShowDialog={showDialog}
          onCheckForUpdates={isTauri() ? updater.checkNow : undefined}
          onHelpAction={helpAction}
          resumeStep={tour.resumeStep("main")}
          onHome={goHome}
          wide={fullHeight}
          centerRef={setHeaderSlot}
        />
        <main
          id="main"
          tabIndex={-1}
          className={cn("flex-1 outline-none", fullHeight && "flex min-h-0 flex-col")}
        >
          {songs.length > 0 && (
            <Suspense
              fallback={
                song ? (
                  <p role="status" className="p-6 text-muted-foreground">
                    Loading the score viewer…
                  </p>
                ) : null
              }
            >
              {/* On the start screen the songs stay mounted (hidden, paused), so coming back
                  to a tab finds it exactly as it was left. */}
              <div
                className={cn(
                  "relative min-h-0 flex-1",
                  !song && "pointer-events-none invisible fixed inset-0",
                )}
              >
                {songs.map((s) => (
                  <ScoreWorkspace
                    key={s.id}
                    song={s}
                    active={s.id === song?.id}
                    tabs={tabs}
                    headerSlot={headerSlot}
                    onOpen={open}
                    onSetUpCloud={setUpCloud}
                    onOpenScore={(score, name) => void openScore(score, name)}
                    onReceiveTab={receiveTab}
                    onEditedChange={(value) => setEdited(s.id, value)}
                    onSaved={(saved) => markSaved(s.id, saved)}
                    onReopenWithEncoding={(choice) => reopenWithEncoding(s.id, choice)}
                    onReloadFromDisk={() => reloadFromDisk(s.id)}
                    startEditing={s.isNew}
                    droppedAudio={s.id === song?.id ? droppedAudio : null}
                    togetherIntent={s.id === song?.id ? togetherIntent : null}
                    onTogetherIntentHandled={() => setTogetherIntent(null)}
                    onOpenSettings={(from) => showDialog("settings", from)}
                    onShowShortcuts={() => showDialog("shortcuts")}
                  />
                ))}
              </div>
            </Suspense>
          )}
          {stemSong && (
            <StemPage
              key={stemSong.id}
              song={stemSong}
              tabs={tabs}
              headerSlot={headerSlot}
              onNew={newStem ? (button) => showDialog("stem-separation", button) : undefined}
              onOpenStems={openSavedStems ? () => setOpenStemsDialog(true) : undefined}
              onSaved={(path) => setSavedStems((saved) => ({ ...saved, [stemSong.id]: path }))}
              savedPath={savedStems[stemSong.id]}
              onOpenCloudSettings={() => showDialog("settings", null, "cloud")}
            />
          )}
          {!song && !stemSong && (
            <>
              <Welcome
                onOpenFile={open}
                onImportAudio={importAudio}
                onSeparateStems={separateStems}
                onOpenStemSong={separateStems ? showStemSong : undefined}
                onOpenStemBundle={openSavedStems ? () => setOpenStemsDialog(true) : undefined}
                onPracticeTogether={() => {
                  countTogetherOpened("start");
                  setTogetherLauncher(true);
                }}
                onNewSong={startNewSong}
                onShowShortcuts={() => showDialog("shortcuts")}
                onShowLicenses={() => showDialog("licenses")}
                recent={recent}
                onOpenRecent={(path) => void openPath(path)}
                onOpenCloud={(path) => void openPath(path)}
                onOpenCloudStem={openSavedStems ? (path) => void openStemBundleAt(path) : undefined}
                onTakeTour={() => startTour("main")}
                tour={
                  tour.offerMainTour
                    ? { onStart: () => startTour("main"), onSkip: tour.dismissMainTour }
                    : undefined
                }
              />
            </>
          )}
        </main>
        {!fullHeight && <AppFooter />}
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
      <DropOverlay
        visible={dragging && dialog !== "audio-transcription" && dialog !== "stem-separation"}
      />
      <DiscardDialog
        songName={closing ? closing.summary.title || closing.name : ""}
        open={closing !== null}
        onCancel={() => setPendingClose(null)}
        onDiscard={() => closing && discardAndClose(closing.id)}
      />
      <LeaveDialog
        songNames={songs.filter((s) => editedIds.has(s.id)).map((s) => s.summary.title || s.name)}
        open={leaving}
        onCancel={() => setLeaving(false)}
        onKeep={() => {
          setLeaving(false);
          activate(null);
        }}
        onSave={() => void saveAllAndGoHome()}
      />
      <PracticeTogetherLauncher
        open={togetherLauncher}
        onOpenChange={setTogetherLauncher}
        recent={recent}
        onStart={startTogether}
        onJoin={joinTogether}
      />
      <AppDialogs
        open={dialog}
        onOpenChange={(next) => {
          if (dialog === "whats-new" && next !== "whats-new") tour.markVersionSeen();
          if (next !== "settings") setSettingsSection(null);
          setDialog(next);
        }}
        settingsSection={settingsSection}
        returnFocusTo={returnFocusTo}
        audioProvider={muscriptorProvider}
        whatsNew={whatsNew}
        onShowTour={startTour}
        droppedRecording={transcriptionDrop}
        droppedStem={stemDrop}
        onStemSeparated={(separated) => {
          setDialog(null);
          showStemSong(separated);
        }}
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
      <SaveTargetDialog
        mode="open"
        providers={openChooser ?? []}
        open={openChooser !== null}
        onChoose={chooseOpenTarget}
        onCancel={() => setOpenChooser(null)}
        onSetupCloud={setUpCloud}
      />
      {cloudOpen && (
        <CloudOpenDialog
          provider={cloudOpen.provider}
          label={cloudOpen.label}
          onSetupCloud={setUpCloud}
          open
          onOpenChange={(isOpen) => !isOpen && setCloudOpen(null)}
          onPick={(item) => {
            setCloudOpen(null);
            void openPath(item);
          }}
        />
      )}
      <OpenStemsDialog
        open={openStemsDialog}
        onOpenChange={setOpenStemsDialog}
        onPickComputer={() => {
          setOpenStemsDialog(false);
          void openSavedStems?.();
        }}
        onOpenStem={(path) => {
          setOpenStemsDialog(false);
          void openStemBundleAt(path);
        }}
        onSetupCloud={() => {
          setOpenStemsDialog(false);
          showDialog("settings", null, "cloud");
        }}
        onOpenedSong={
          openSavedStems
            ? (opened) => {
                setOpenStemsDialog(false);
                addStemTab(opened);
              }
            : undefined
        }
      />
      <CloudLibraryDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        onSetUpCloud={() => {
          setLibraryOpen(false);
          showDialog("settings", null, "cloud");
        }}
        onOpenTab={(item) => {
          setLibraryOpen(false);
          void openPath(item);
        }}
        onOpenStems={(item) => {
          setLibraryOpen(false);
          void openCloudStemItem(item);
        }}
      />
      <AiInstallerDialog />
      <UpdateDialog updater={updater} />
      <Toaster position="bottom-right" />
    </ShareProvider>
  );
}
