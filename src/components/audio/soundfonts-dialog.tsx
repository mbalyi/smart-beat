import { useId, useState } from "react";
import {
  DownloadIcon,
  FolderOpenIcon,
  MusicIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
import { errorText } from "@/lib/errors";
import { storedKey, storedSoundFontId, type SoundFont } from "@/lib/score/soundfonts";
import type {
  SoundFontCatalogueItem,
  SoundFontDownloadProgress,
  StoredSoundFont,
} from "@/lib/tauri";

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
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>SoundFonts</DialogTitle>
          <DialogDescription>
            Add more instrument sounds. Import a SoundFont (.sf2 or .sf3) from your computer, or
            download one of the recommended banks below. Added SoundFonts appear in “Instrument
            sounds” and stay on this computer.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
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
            <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm">
              {error}
            </p>
          )}

          <section aria-labelledby={`${ids}-recommended`} className="flex flex-col gap-2">
            <h3 id={`${ids}-recommended`} className="text-sm font-medium">
              Recommended SoundFonts
            </h3>
            <ul
              aria-label="Recommended SoundFonts"
              className="flex flex-col divide-y rounded-md border"
            >
              {catalogue.map((item) => {
                const font = fonts.find((f) => f.catalogue === item.id);
                const active = progress?.id === item.id;
                const percent = Math.round((progress?.fraction ?? 0) * 100);
                return (
                  <li
                    key={item.id}
                    className="flex items-start gap-3 p-3"
                    data-testid="catalogue-soundfont"
                  >
                    <MusicIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {item.name}
                        <Badge variant="secondary">{formatSize(item.bytes)}</Badge>
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
                        Source: {sourceHost(item.page)}. Download: {formatSize(item.downloadBytes)}.
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
                    {item.installed && font ? (
                      confirming === font.id ? (
                        <RemoveConfirm
                          name={item.name}
                          active={activeId === font.id}
                          onRemove={() => void remove(storedKey(font.id))}
                          onKeep={() => setConfirming(null)}
                        />
                      ) : (
                        <>
                          <Badge variant="secondary">Installed</Badge>
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
                        size="sm"
                        disabled={progress?.unpacking}
                        onClick={() => void onCancelDownload()}
                      >
                        Cancel
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
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

          <section aria-labelledby={`${ids}-yours`} className="flex flex-col gap-2">
            <h3 id={`${ids}-yours`} className="text-sm font-medium">
              Your SoundFonts
            </h3>
            {imported.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                None yet. Import a .sf2 or .sf3 file from your computer.
              </p>
            ) : (
              <ul
                aria-label="Imported SoundFonts"
                className="flex flex-col divide-y rounded-md border"
              >
                {imported.map((font) => {
                  const id = storedSoundFontId(font.id);
                  return (
                    <li
                      key={font.id}
                      className="flex items-center gap-3 p-3"
                      data-testid="imported-soundfont"
                    >
                      <MusicIcon className="size-4 shrink-0" aria-hidden="true" />
                      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm font-medium">
                        {font.name}
                        <Badge variant="secondary">{formatSize(font.bytes)}</Badge>
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
          </section>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            className="sm:mr-auto"
            disabled={!available || busy || downloading}
            onClick={() => void pickAndImport()}
          >
            <FolderOpenIcon data-icon="inline-start" />
            {busy ? "Importing…" : "Import a SoundFont…"}
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
