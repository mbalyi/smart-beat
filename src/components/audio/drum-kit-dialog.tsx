import { useId, useState } from "react";
import { DrumIcon, FolderOpenIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DRUM_ELEMENTS } from "@/lib/audio/drum-elements";
import { errorText } from "@/lib/errors";
import { LICENCE_LABELS } from "@/lib/audio/kit-licences";
import type { DrumKit, KitImportOptions, KitLicenceKind } from "@/lib/tauri";

const PICKABLE: Exclude<KitLicenceKind, "unknown">[] = [
  "cc0",
  "public-domain",
  "cc-by",
  "cc-by-sa",
  "other-commercial",
];

const elementLabel = (id: string) => DRUM_ELEMENTS.find((e) => e.id === id)?.label ?? id;

function formatSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** A kit waiting for the user's answer about its licence. */
interface Pending {
  path: string;
  error: string;
  /** The licence forbids commercial use: it cannot be imported at all. */
  blocked: boolean;
}

/**
 * The drum kit library (#40): free sampled kits (SFZ, SF2, SF3) the user
 * imports, with their licence. Kits with a non-commercial licence are
 * refused; when no licence is found, the user says which one applies or
 * confirms they may use the kit.
 */
export function DrumKitDialog({
  open,
  onOpenChange,
  kits,
  available,
  onPick,
  onImport,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kits: DrumKit[];
  /** False in a browser: importing needs the desktop app. */
  available: boolean;
  onPick: () => Promise<string | null>;
  onImport: (path: string, options?: KitImportOptions) => Promise<DrumKit>;
  onRemove: (id: string) => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [licence, setLicence] = useState<KitLicenceKind | "">("");
  const [confirmed, setConfirmed] = useState(false);
  const [attribution, setAttribution] = useState("");
  const ids = useId();

  const reset = () => {
    setPending(null);
    setLicence("");
    setConfirmed(false);
    setAttribution("");
  };

  const attempt = async (path: string, options: KitImportOptions = {}) => {
    setBusy(true);
    try {
      await onImport(path, options);
      reset();
    } catch (error) {
      const message = errorText(error);
      setPending({ path, error: message, blocked: /non-commercial/i.test(message) });
    } finally {
      setBusy(false);
    }
  };

  const pickAndImport = async () => {
    reset();
    const path = await onPick();
    if (path) await attempt(path);
  };

  const canRetry =
    pending && !pending.blocked && (licence === "unknown" ? confirmed : licence !== "");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Drum kits</DialogTitle>
          <DialogDescription>
            Import free sampled kits (SFZ, SF2 or SF3) and pick one per drum track in the inspector.
            Kits stay on this computer; non-commercial kits cannot be used.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {!available && (
            <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              <TriangleAlertIcon
                className="mt-0.5 size-4 shrink-0 text-amber-600"
                aria-hidden="true"
              />
              Importing drum kits is available in the Smart Beat desktop app.
            </p>
          )}

          {pending && (
            <section
              aria-labelledby={`${ids}-pending`}
              className="flex flex-col gap-2 rounded-md border p-3"
            >
              <h3 id={`${ids}-pending`} className="text-sm font-medium">
                {pending.blocked
                  ? "This kit cannot be imported"
                  : "Which licence does the kit have?"}
              </h3>
              <p role="alert" className="text-sm text-muted-foreground">
                {pending.error}
              </p>
              {!pending.blocked && (
                <>
                  <div className="flex flex-col gap-1">
                    <label htmlFor={`${ids}-licence`} className="text-xs">
                      Licence
                    </label>
                    <Select value={licence} onValueChange={(v) => setLicence(v as KitLicenceKind)}>
                      <SelectTrigger id={`${ids}-licence`} size="sm" className="w-full sm:w-96">
                        <SelectValue placeholder="Pick the kit's licence" />
                      </SelectTrigger>
                      <SelectContent>
                        {PICKABLE.map((kind) => (
                          <SelectItem key={kind} value={kind}>
                            {LICENCE_LABELS[kind]}
                          </SelectItem>
                        ))}
                        <SelectItem value="unknown">I don't know the licence</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {licence === "unknown" && (
                    <div className="flex items-start gap-2 text-sm">
                      <Checkbox
                        id={`${ids}-confirm`}
                        checked={confirmed}
                        onCheckedChange={(on) => setConfirmed(on === true)}
                      />
                      <label htmlFor={`${ids}-confirm`}>
                        I have the right to use this kit, also in songs I release.
                      </label>
                    </div>
                  )}
                  {(licence === "cc-by" ||
                    licence === "cc-by-sa" ||
                    licence === "other-commercial") && (
                    <div className="flex flex-col gap-1">
                      <label htmlFor={`${ids}-credit`} className="text-xs">
                        Credit (who made the kit)
                      </label>
                      <Input
                        id={`${ids}-credit`}
                        value={attribution}
                        onChange={(e) => setAttribution(e.target.value)}
                        placeholder="e.g. Kit by Jane Doe"
                      />
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={!canRetry || busy}
                      onClick={() =>
                        void attempt(
                          pending.path,
                          licence === "unknown"
                            ? { acceptUnknown: true }
                            : {
                                licence: licence as Exclude<KitLicenceKind, "unknown">,
                                ...(attribution.trim() && { attribution }),
                              },
                        )
                      }
                    >
                      Import the kit
                    </Button>
                    <Button size="sm" variant="outline" onClick={reset}>
                      Cancel
                    </Button>
                  </div>
                </>
              )}
            </section>
          )}

          {kits.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No drum kits yet. Free kits such as the Muldjord, DRS or Naked Drums kits (CC BY) work
              well; their licence is checked when you import them.
            </p>
          ) : (
            <ul aria-label="Imported kits" className="flex flex-col divide-y rounded-md border">
              {kits.map((kit) => (
                <li key={kit.id} className="flex items-start gap-3 p-3" data-testid="drum-kit">
                  <DrumIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                    <span className="flex flex-wrap items-center gap-2 font-medium">
                      {kit.name}
                      <Badge variant="secondary">{kit.format.toUpperCase()}</Badge>
                      <Badge variant="outline">{LICENCE_LABELS[kit.licence.kind]}</Badge>
                    </span>
                    {kit.licence.attribution && (
                      <span className="text-xs">{kit.licence.attribution}</span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatSize(kit.sizeBytes)} · Plays{" "}
                      {kit.pieces.map((p) => elementLabel(p.element)).join(", ")}
                      {kit.missing.length > 0 &&
                        ` · No ${kit.missing.map(elementLabel).join(", ")}`}
                    </span>
                    {kit.warnings.map((w) => (
                      <span key={w} className="text-xs text-muted-foreground">
                        {w}
                      </span>
                    ))}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${kit.name}`}
                    title={`Remove ${kit.name}`}
                    onClick={() => onRemove(kit.id)}
                  >
                    <Trash2Icon />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            className="sm:mr-auto"
            disabled={!available || busy}
            onClick={() => void pickAndImport()}
          >
            <FolderOpenIcon data-icon="inline-start" />
            {busy ? "Importing…" : "Import a kit…"}
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
