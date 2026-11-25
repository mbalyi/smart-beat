import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  FileAudioIcon,
  FolderDownIcon,
  LinkIcon,
  PackageIcon,
  SquareIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import logo from "@/assets/add-samples/logo.webp";
import { AI_DIALOG_FRAME } from "@/components/ai/dialog-frame";
import { DIALOG_NEON, DialogArt, DialogLogo, DialogStepper } from "@/components/ai/dialog-art";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { errorText } from "@/lib/errors";
import { countLabel, formatBytes } from "@/lib/samples/filter";
import type {
  ArchiveReport,
  FolderScan,
  SampleFolder,
  SampleProgress,
  SampleSource,
} from "@/lib/samples/types";
import {
  AUDIO_EXTENSIONS,
  cancelSampleJob,
  importSampleArchive,
  importSampleFiles,
  importSampleFolder,
  inspectSampleArchive,
  linkSampleFolder,
  onSampleProgress,
  pickSampleArchive,
  pickSampleFiles,
  pickSampleFolder,
  scanSampleFolder,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

const STEPS = ["Source", "Review", "Done"] as const;

interface SourceInfo {
  title: string;
  blurb: string;
  note: string;
  action: string;
  tag: string;
  icon: typeof LinkIcon;
}

/** The ways in: the three of the core, and single files, which are always copied. */
type DialogSource = SampleSource | "files";

const DEFAULT_FILES_NAME = "Imported samples";
/** Chosen files listed on the review step before "and N more". */
const LISTED_FILES = 4;

const SOURCES: Record<DialogSource, SourceInfo> = {
  link: {
    title: "Link a folder",
    blurb: "Use the files where they are. Best for a big library or an external drive.",
    note: "Files stay where they are. Smart Beat only remembers the location.",
    action: "Add folder",
    tag: "kept in place",
    icon: LinkIcon,
  },
  folder: {
    title: "Import a folder",
    blurb: "Copy every audio file into Smart Beat. Best when the folder may move.",
    note: "The copy is independent of the original. Subfolders are kept.",
    action: "Copy files",
    tag: "copied",
    icon: FolderDownIcon,
  },
  archive: {
    title: "Import an archive",
    blurb: "Unpack a .zip or .7z sample pack into Smart Beat.",
    note: "The archive can be deleted afterwards. Only audio is unpacked.",
    action: "Unpack and add",
    tag: "unpacked",
    icon: PackageIcon,
  },
  files: {
    title: "Add audio files",
    blurb: "Pick single files and copy them into a new folder in Smart Beat.",
    note: "The files are copied. The originals stay where they are and can be deleted afterwards.",
    action: "Copy files",
    tag: "copied",
    icon: FileAudioIcon,
  },
};

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const stemOf = (path: string) => baseName(path).replace(/\.[^.]+$/, "");
const isAudioPath = (path: string) => {
  const ext = baseName(path).split(".").pop()?.toLowerCase() ?? "";
  return (AUDIO_EXTENSIONS as readonly string[]).includes(ext);
};
/** What a folder of chosen files is called to begin with: the one file, or a general name. */
const defaultFolderName = (files: string[]) =>
  files.length === 1 ? stemOf(files[0]!) : DEFAULT_FILES_NAME;

let jobCounter = 0;
const newJobId = () => `samples-${Date.now().toString(36)}-${++jobCounter}`;

interface AddSamplesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The folder that was added, once the user is done. */
  onAdded: (folder: SampleFolder) => void;
}

/** Brings samples in: link, import or unpack a folder, an archive or chosen files (three steps). */
export function AddSamplesDialog({ open, onOpenChange, onAdded }: AddSamplesDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="xl"
        data-tour="samples-dialog"
        className={cn(AI_DIALOG_FRAME, DIALOG_NEON, "h-[min(40rem,calc(100dvh-2rem))]")}
      >
        {open && <Flow close={() => onOpenChange(false)} onAdded={onAdded} />}
      </DialogContent>
    </Dialog>
  );
}

function Flow({ close, onAdded }: { close: () => void; onAdded: (folder: SampleFolder) => void }) {
  const [source, setSource] = useState<DialogSource>("link");
  const [step, setStep] = useState(0);
  const [path, setPath] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [skippedFiles, setSkippedFiles] = useState(0);
  const [folderName, setFolderName] = useState(DEFAULT_FILES_NAME);
  const nameEdited = useRef(false);
  const nameId = useId();
  const [scan, setScan] = useState<FolderScan | null>(null);
  const [report, setReport] = useState<ArchiveReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<SampleProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<SampleFolder | null>(null);
  const job = useRef<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let off: (() => void) | undefined;
    void onSampleProgress((p) => {
      if (p.jobId === job.current) setProgress(p);
    }).then((unlisten) => {
      if (alive.current) off = unlisten;
      else unlisten();
    });
    return () => {
      alive.current = false;
      off?.();
      // Closing the dialog stops a copy or unpack that is still running.
      if (job.current) void cancelSampleJob(job.current).catch(() => {});
    };
  }, []);

  const info = SOURCES[source];
  const archive = source === "archive";
  const fileSource = source === "files";
  const ready = fileSource
    ? files.length > 0
    : archive
      ? report?.safe === true
      : (scan?.fileCount ?? 0) > 0;
  const stepIndex = running ? 1 : step;

  const chooseFiles = async () => {
    setError(null);
    try {
      const picked = await pickSampleFiles();
      if (!picked) return;
      const audio = picked.filter(isAudioPath);
      setFiles(audio);
      setSkippedFiles(picked.length - audio.length);
      if (!nameEdited.current) setFolderName(defaultFolderName(audio));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const choose = async () => {
    if (fileSource) return chooseFiles();
    setError(null);
    try {
      const picked = archive ? await pickSampleArchive() : await pickSampleFolder();
      if (!picked) return;
      setChecking(true);
      setPath(picked);
      setScan(null);
      setReport(null);
      if (archive) setReport(await inspectSampleArchive(picked));
      else setScan(await scanSampleFolder(picked));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setChecking(false);
    }
  };

  const run = async () => {
    if (fileSource ? files.length === 0 : !path) return;
    setError(null);
    setRunning(true);
    setProgress(null);
    const id = newJobId();
    job.current = id;
    try {
      const folder = fileSource
        ? await importSampleFiles(files, folderName.trim() || DEFAULT_FILES_NAME, id)
        : source === "link"
          ? await linkSampleFolder(path!)
          : source === "folder"
            ? await importSampleFolder(path!, id)
            : await importSampleArchive(path!, id);
      if (!alive.current) return;
      setAdded(folder);
      onAdded(folder);
      setStep(2);
    } catch (e) {
      if (alive.current && errorText(e) !== "Cancelled.") setError(errorText(e));
    } finally {
      job.current = null;
      if (alive.current) setRunning(false);
    }
  };

  const cancel = () => {
    if (job.current) void cancelSampleJob(job.current).catch(() => {});
  };

  const again = () => {
    setStep(0);
    resetChoice();
    setAdded(null);
    setError(null);
  };

  const resetChoice = () => {
    setPath(null);
    setScan(null);
    setReport(null);
    setFiles([]);
    setSkippedFiles(0);
    setFolderName(DEFAULT_FILES_NAME);
    nameEdited.current = false;
  };

  const title =
    step === 0
      ? "Where are your samples?"
      : step === 1
        ? info.title
        : `${added?.name ?? "Samples"} is ready`;
  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : 0;

  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col">
      <DialogArt name="add-samples" />
      <DialogHeader className="gap-3 px-6 pt-3 md:px-9">
        <DialogLogo src={logo} testId="add-samples-logo" />
        <DialogStepper labels={STEPS} current={stepIndex} />
        <DialogTitle className="sr-only">Add samples</DialogTitle>
        <DialogDescription className="md:pr-[20%]">
          {step === 0
            ? "Pick one. You can add more folders any time."
            : step === 1
              ? "Check what was found, then add it."
              : "Your samples are in the list. Audition them and put them on a lane."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="px-6 pb-4 md:px-9">
        <div className="flex flex-col gap-4">
          <h3 className="text-lg font-semibold">{title}</h3>
          {step === 0 && (
            <>
              <div
                role="radiogroup"
                aria-label="Source"
                className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
              >
                {(Object.keys(SOURCES) as DialogSource[]).map((key) => {
                  const s = SOURCES[key];
                  const Icon = s.icon;
                  return (
                    <button
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={source === key}
                      data-testid={`source-${key}`}
                      onClick={() => {
                        setSource(key);
                        resetChoice();
                      }}
                      className={cn(
                        "flex flex-col items-start gap-1.5 rounded-xl border-2 bg-card p-3.5 text-left",
                        source === key &&
                          "border-primary shadow-[0_0_18px_color-mix(in_oklab,var(--primary)_30%,transparent)]",
                      )}
                    >
                      <span className="flex items-center gap-2 font-semibold">
                        <Icon className="size-4" aria-hidden="true" />
                        {s.title}
                      </span>
                      <span className="text-sm text-muted-foreground">{s.blurb}</span>
                      <span className="font-mono text-xs text-brand">{s.tag}</span>
                    </button>
                  );
                })}
              </div>
              <Card tone="info">
                Supports WAV, MP3, M4A, FLAC, OGG and AIFF. Other files are skipped without an
                error.
              </Card>
            </>
          )}

          {step === 1 && (
            <>
              <div
                className={cn(
                  "flex flex-col items-start gap-2 rounded-xl p-3",
                  archive && "border-2 border-dashed border-primary/50 bg-card/40",
                )}
              >
                <div className="flex w-full items-center gap-2">
                  <p
                    data-testid="chosen-path"
                    className="min-w-0 flex-1 truncate rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs"
                  >
                    {fileSource
                      ? files.length > 0
                        ? `${countLabel(files.length)} chosen`
                        : "No files chosen"
                      : (path ?? (archive ? "No archive chosen" : "No folder chosen"))}
                  </p>
                  <Button
                    variant="outline"
                    className="bg-card"
                    disabled={running || checking}
                    onClick={() => void choose()}
                  >
                    {fileSource ? "Choose files…" : archive ? "Choose archive…" : "Choose folder…"}
                  </Button>
                </div>
                {checking && <p className="text-sm text-muted-foreground">Looking inside…</p>}
              </div>

              {fileSource && files.length > 0 && (
                <>
                  <Card>
                    <strong>{countLabel(files.length)} will be copied</strong>
                    <ul aria-label="Chosen files" className="font-mono text-xs">
                      {files.slice(0, LISTED_FILES).map((file) => (
                        <li key={file} className="truncate">
                          {baseName(file)}
                        </li>
                      ))}
                    </ul>
                    {files.length > LISTED_FILES && (
                      <span className="text-muted-foreground">
                        and {(files.length - LISTED_FILES).toLocaleString("en")} more
                      </span>
                    )}
                    {skippedFiles > 0 && (
                      <span className="text-muted-foreground">
                        {skippedFiles} skipped (not audio)
                      </span>
                    )}
                  </Card>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={nameId} className="text-sm font-medium">
                      Folder name
                    </label>
                    <Input
                      id={nameId}
                      value={folderName}
                      maxLength={80}
                      disabled={running}
                      onChange={(e) => {
                        nameEdited.current = true;
                        setFolderName(e.target.value);
                      }}
                    />
                  </div>
                </>
              )}
              {fileSource && files.length === 0 && skippedFiles > 0 && (
                <Card tone="bad">
                  <strong>No audio files in that choice</strong>
                  <span className="text-muted-foreground">{skippedFiles} skipped (not audio)</span>
                </Card>
              )}
              {scan && (
                <Card>
                  {scan.fileCount === 0 ? (
                    <strong>No audio files found in that folder</strong>
                  ) : (
                    <strong>{countLabel(scan.fileCount)} found</strong>
                  )}
                  <span className="text-muted-foreground">
                    {scan.subfolders} {scan.subfolders === 1 ? "subfolder" : "subfolders"} ·{" "}
                    {scan.skipped} skipped (not audio) · {formatBytes(scan.totalBytes)}
                  </span>
                </Card>
              )}
              {report && (
                <Card tone={report.safe ? undefined : "bad"}>
                  {report.safe ? (
                    <>
                      <strong>
                        <CheckIcon
                          className="mr-1 inline size-4 text-green-600"
                          aria-hidden="true"
                        />
                        {report.name}: {countLabel(report.audioFiles)}
                      </strong>
                      <span className="text-muted-foreground">
                        {report.skippedFiles} other files will be skipped ·{" "}
                        {formatBytes(report.unpackedBytes)} unpacked from{" "}
                        {formatBytes(report.sizeBytes)}
                      </span>
                    </>
                  ) : (
                    <>
                      <strong>
                        <TriangleAlertIcon className="mr-1 inline size-4" aria-hidden="true" />
                        Archive was not unpacked
                      </strong>
                      <span>{report.problem}</span>
                      <span className="text-muted-foreground">Nothing was written.</span>
                    </>
                  )}
                </Card>
              )}
              {running && source !== "link" && (
                <div className="flex flex-col gap-1.5" data-testid="samples-progress">
                  <div
                    role="progressbar"
                    aria-label={archive ? "Unpacking" : "Copying"}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    className="h-3 overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full rounded-full bg-green-500"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">
                    {archive ? "Unpacking" : "Copying"} {percent}%
                  </p>
                </div>
              )}
              {error && (
                <Card tone="bad" role="alert">
                  {error}
                </Card>
              )}
              <Card tone="info">{info.note}</Card>
            </>
          )}

          {step === 2 && added && (
            <Card>
              <strong className="flex items-center gap-2 text-green-600 dark:text-green-400">
                <CheckIcon className="size-4" aria-hidden="true" />
                {countLabel(added.fileCount ?? 0)} ready to browse
              </strong>
              <span className="text-muted-foreground">
                Lengths and waveforms fill in while you scroll the list.
              </span>
            </Card>
          )}
        </div>
      </DialogBody>
      <DialogFooter className="mt-0 flex-row flex-wrap justify-between gap-2 border-t-0 bg-transparent px-6 pt-2 pb-5 sm:justify-between md:px-9">
        {step === 0 && (
          <>
            <Button variant="outline" size="lg" className="min-w-28 bg-card" onClick={close}>
              Close
            </Button>
            <Button size="lg" className="min-w-52" onClick={() => setStep(1)}>
              Continue
              <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
            </Button>
          </>
        )}
        {step === 1 && !running && (
          <>
            <Button
              variant="outline"
              size="lg"
              className="min-w-28 bg-card"
              onClick={() => {
                setError(null);
                setStep(0);
              }}
            >
              <ArrowLeftIcon aria-hidden="true" data-icon="inline-start" />
              Back
            </Button>
            <Button
              size="lg"
              className="min-w-52"
              disabled={!ready || checking}
              onClick={() => void run()}
            >
              {info.action}
              <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
            </Button>
          </>
        )}
        {step === 1 && running && (
          <Button variant="outline" size="lg" className="bg-card" onClick={cancel}>
            <SquareIcon aria-hidden="true" data-icon="inline-start" className="fill-current" />
            {source === "link" ? "Cancel" : archive ? "Cancel unpacking" : "Cancel copying"}
          </Button>
        )}
        {step === 2 && (
          <>
            <Button variant="outline" size="lg" className="min-w-28 bg-card" onClick={again}>
              Add another
            </Button>
            <Button size="lg" className="min-w-52" onClick={close}>
              Show samples
              <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
            </Button>
          </>
        )}
      </DialogFooter>
    </div>
  );
}

function Card({
  tone,
  role,
  children,
}: {
  tone?: "info" | "bad";
  role?: "alert";
  children: ReactNode;
}) {
  return (
    <div
      role={role}
      className={cn(
        "flex flex-col gap-1 rounded-xl border bg-card/90 px-3.5 py-3 text-sm",
        tone === "info" && "border-primary/40 bg-primary/10",
        tone === "bad" && "border-destructive/60 bg-destructive/10",
      )}
    >
      {children}
    </div>
  );
}
