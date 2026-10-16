import { useId, useState } from "react";
import { DownloadIcon, FolderOpenIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { cn } from "cn";

import art from "@/assets/soundfonts/art.webp";
import headingRecommended from "@/assets/soundfonts/heading-recommended.webp";
import headingYours from "@/assets/soundfonts/heading-yours.webp";
import note1 from "@/assets/soundfonts/note-1.webp";
import note2 from "@/assets/soundfonts/note-2.webp";
import note3 from "@/assets/soundfonts/note-3.webp";
import note4 from "@/assets/soundfonts/note-4.webp";
import splashLeft from "@/assets/soundfonts/splash-bottom-left.webp";
import splashRight from "@/assets/soundfonts/splash-bottom-right.webp";
import title from "@/assets/soundfonts/title.webp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorText } from "@/lib/errors";
import { storedKey, storedSoundFontId, type SoundFont } from "@/lib/score/soundfonts";
import type {
  SoundFontCatalogueItem,
  SoundFontDownloadProgress,
  StoredSoundFont,
} from "@/lib/tauri";

/** The music notes in front of the rows, used one after the other in this order. */
const NOTES = [note1, note2, note3, note4] as const;
const noteFor = (index: number) => NOTES[index % NOTES.length]!;

function formatSize(bytes: number) {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

/** The site a bank is published on, for “Source: …”. */
function sourceHost(page: string) {
  try {
    return new URL(page).hostname.replace(/^www\./, "");
  } catch {
    return page;
  }
}

/** The graffiti around the dialog: behind everything, never in the way, hidden from readers. */
function SoundFontsArt() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <img
        src={splashLeft}
        alt=""
        className="absolute bottom-0 left-0 w-[38%] opacity-50 dark:opacity-90"
      />
      <img
        src={splashRight}
        alt=""
        className="absolute right-0 bottom-0 w-[24%] opacity-50 dark:opacity-90"
      />
      <img src={art} alt="" className="absolute top-3 right-4 hidden w-[38%] md:block" />
    </div>
  );
}

/** A row of the lists: a card with a music note in front, lit up when it is the one in use. */
const ROW =
  "flex items-center gap-4 rounded-xl border bg-card/85 p-3 pr-4 backdrop-blur-[1px] dark:bg-card/80";
const ROW_LIT =
  "border-brand shadow-[0_0_16px_color-mix(in_oklab,var(--brand)_55%,transparent)] ring-1 ring-brand/70";

/**
 * Extra SoundFonts (#81): import a `.sf2` or `.sf3` from this computer, or download one of the
 * recommended banks. Added banks appear in the “Instrument sounds” list and can be removed
 * again. Nothing is bundled: a download comes from the bank's own site and is checked by the app.
 */
export function SoundFontsDialog({
  open,
  onOpenChange,
  fonts,
  stored,
  catalogue,
  available,
  activeId,
  onPick,
  onImport,
  onDownload,
  onCancelDownload,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The added SoundFonts as picker entries. */
  fonts: readonly SoundFont[];
  stored: readonly StoredSoundFont[];
  catalogue: readonly SoundFontCatalogueItem[];
  /** False in a browser: adding SoundFonts needs the desktop app. */
  available: boolean;
  /** The SoundFont in use, so removing it can say what happens. */
  activeId: string;
  onPick: () => Promise<string | null>;
  onImport: (path: string) => Promise<StoredSoundFont>;
  onDownload: (
    id: string,
    onProgress: (progress: SoundFontDownloadProgress) => void,
  ) => Promise<StoredSoundFont | null>;
  onCancelDownload: () => Promise<void>;
  onRemove: (id: string) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<SoundFontDownloadProgress | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const ids = useId();

  const pickAndImport = async () => {
    setError("");
    const path = await onPick();
    if (!path) return;
    setBusy(true);
    try {
      await onImport(path);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const download = async (id: string) => {
    setError("");
    setProgress({ id, fraction: 0, unpacking: false });
    try {
      await onDownload(id, setProgress);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
    }
  };

  const remove = async (id: string) => {
    setConfirming(null);
    await onRemove(id);
  };

  const downloading = progress !== null;
  // Banks you downloaded are listed with the catalogue; only your own files are listed below.
  const imported = stored.filter((font) => !font.catalogue);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setError("");
          setConfirming(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        size="xl"
        className={cn(
          "shadow-[0_0_32px_color-mix(in_oklab,var(--brand)_45%,transparent)] ring-2 ring-brand/80 sm:max-w-4xl",
        )}
      >
        <div className="relative isolate flex min-h-0 flex-1 flex-col">
          <SoundFontsArt />
          <DialogHeader className="px-6 pt-5 md:px-10 md:pr-[44%]">
            <DialogTitle className="-mt-1 -mb-1 flex items-center">
              <img
                src={title}
                alt=""
                aria-hidden="true"
                className="w-[260px] max-w-full sm:w-[320px]"
              />
              <span className="sr-only">SoundFonts</span>
            </DialogTitle>
            <DialogDescription className="text-[15px]">
              Add more instrument sounds. Import a SoundFont (.sf2 or .sf3) from your computer, or
              download one of the recommended banks below. Added SoundFonts appear in “Instrument
              sounds” and stay on this computer.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="gap-3 px-6 pt-2 pb-6 md:px-10">
            {!available && (
              <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                <TriangleAlertIcon
                  className="mt-0.5 size-4 shrink-0 text-amber-600"
                  aria-hidden="true"
                />
                Adding SoundFonts is available in the Smart Beat desktop app.
              </p>
            )}

            {error && (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-card/90 px-3 py-2 text-sm"
              >
                {error}
              </p>
            )}

            <section aria-labelledby={`${ids}-recommended`} className="flex flex-col gap-2">
              <h3 id={`${ids}-recommended`} className="-mb-1 flex">
                <img
                  src={headingRecommended}
                  alt=""
                  aria-hidden="true"
                  className="h-12 w-auto sm:h-14"
                />
                <span className="sr-only">Recommended SoundFonts</span>
              </h3>
              <ul aria-label="Recommended SoundFonts" className="flex flex-col gap-2">
                {catalogue.map((item, index) => {
                  const font = fonts.find((f) => f.catalogue === item.id);
                  const active = progress?.id === item.id;
                  const percent = Math.round((progress?.fraction ?? 0) * 100);
                  const installed = item.installed && font !== undefined;
                  return (
                    <li
                      key={item.id}
                      className={cn(ROW, installed && ROW_LIT)}
                      data-testid="catalogue-soundfont"
                    >
                      <img
                        src={noteFor(index)}
                        alt=""
                        aria-hidden="true"
                        className="size-14 shrink-0 object-contain"
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                        <span className="flex flex-wrap items-center gap-2 text-base font-semibold">
                          {item.name}
                          <Badge variant="outline">{formatSize(item.bytes)}</Badge>
                          <Badge
                            variant="outline"
                            className={item.personalUseOnly ? "border-amber-500" : undefined}
                          >
                            {item.personalUseOnly ? "Personal use only" : item.licence}
                          </Badge>
                        </span>
                        <span className="text-muted-foreground">{item.description}</span>
                        <span className="text-xs text-muted-foreground">
                          {item.personalUseOnly ? `${item.licence} ` : `Licence: ${item.licence}. `}
                          Source: {sourceHost(item.page)}. Download:{" "}
                          {formatSize(item.downloadBytes)}.
                        </span>
                        {active && (
                          <>
                            <div
                              role="progressbar"
                              aria-label={`Downloading ${item.name}`}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={percent}
                              className="h-1.5 w-full overflow-hidden rounded bg-muted"
                            >
                              <div
                                className="h-full bg-primary transition-[width]"
                                style={{ width: `${percent}%` }}
                              />
                            </div>
                            <span className="text-xs text-muted-foreground" aria-live="polite">
                              {progress?.unpacking ? "Unpacking…" : `Downloading… ${percent}%`}
                            </span>
                          </>
                        )}
                      </div>
                      {installed ? (
                        confirming === font.id ? (
                          <RemoveConfirm
                            name={item.name}
                            active={activeId === font.id}
                            onRemove={() => void remove(storedKey(font.id))}
                            onKeep={() => setConfirming(null)}
                          />
                        ) : (
                          <>
                            <Badge variant="outline" className="border-brand bg-brand/15">
                              Installed
                            </Badge>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove ${item.name}`}
                              title={`Remove ${item.name}`}
                              disabled={downloading}
                              onClick={() => setConfirming(font.id)}
                            >
                              <Trash2Icon />
                            </Button>
                          </>
                        )
                      ) : active ? (
                        <Button
                          variant="outline"
                          className={ACTION}
                          disabled={progress?.unpacking}
                          onClick={() => void onCancelDownload()}
                        >
                          Cancel
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          className={ACTION}
                          aria-label={`Download ${item.name}`}
                          disabled={!available || downloading || busy}
                          onClick={() => void download(item.id)}
                        >
                          <DownloadIcon data-icon="inline-start" />
                          Download
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>

            <section aria-labelledby={`${ids}-yours`} className="mt-1 flex flex-col gap-2">
              <h3 id={`${ids}-yours`} className="-mb-1 flex">
                <img src={headingYours} alt="" aria-hidden="true" className="h-11 w-auto" />
                <span className="sr-only">Your SoundFonts</span>
              </h3>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1 rounded-xl border-2 border-dashed border-brand/70 bg-card/70 p-2">
                  {imported.length === 0 ? (
                    <p className="flex items-center gap-4 p-1 text-sm">
                      <img
                        src={note1}
                        alt=""
                        aria-hidden="true"
                        className="size-10 shrink-0 object-contain"
                      />
                      None yet. Import a .sf2 or .sf3 file from your computer.
                    </p>
                  ) : (
                    <ul aria-label="Imported SoundFonts" className="flex flex-col gap-2">
                      {imported.map((font, index) => {
                        const id = storedSoundFontId(font.id);
                        return (
                          <li
                            key={font.id}
                            className={cn(ROW, "p-2 pr-3", activeId === id && ROW_LIT)}
                            data-testid="imported-soundfont"
                          >
                            <img
                              src={noteFor(catalogue.length + index)}
                              alt=""
                              aria-hidden="true"
                              className="size-11 shrink-0 object-contain"
                            />
                            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm font-semibold">
                              {font.name}
                              <Badge variant="outline">{formatSize(font.bytes)}</Badge>
                            </span>
                            {confirming === id ? (
                              <RemoveConfirm
                                name={font.name}
                                active={activeId === id}
                                onRemove={() => void remove(font.id)}
                                onKeep={() => setConfirming(null)}
                              />
                            ) : (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Remove ${font.name}`}
                                title={`Remove ${font.name}`}
                                onClick={() => setConfirming(id)}
                              >
                                <Trash2Icon />
                              </Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
                <Button
                  className="h-12 shrink-0 gap-2 rounded-xl px-6 text-base shadow-[0_0_18px_color-mix(in_oklab,var(--primary)_60%,transparent)] ring-[3px] ring-black"
                  disabled={!available || busy || downloading}
                  onClick={() => void pickAndImport()}
                >
                  <FolderOpenIcon data-icon="inline-start" />
                  {busy ? "Importing…" : "Import a SoundFont…"}
                </Button>
              </div>
            </section>
          </DialogBody>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The Download and Cancel buttons: dark with a blue outline, as in the design. */
const ACTION =
  "h-10 shrink-0 gap-2 rounded-lg border-2 border-sky-500/70 bg-card px-4 text-sm font-semibold hover:bg-sky-500/10 dark:border-cyan-400/80";

function RemoveConfirm({
  name,
  active,
  onRemove,
  onKeep,
}: {
  name: string;
  active: boolean;
  onRemove: () => void;
  onKeep: () => void;
}) {
  return (
    <span role="group" aria-label={`Remove ${name}?`} className="flex flex-col items-end gap-1">
      <span className="text-xs text-muted-foreground">
        {active ? "In use. Playback switches to the default sounds." : "Delete this file?"}
      </span>
      <span className="flex gap-1">
        <Button size="sm" variant="destructive" onClick={onRemove}>
          Remove
        </Button>
        <Button size="sm" variant="outline" onClick={onKeep}>
          Keep
        </Button>
      </span>
    </span>
  );
}
