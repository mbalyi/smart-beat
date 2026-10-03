import { useId, useMemo, useState } from "react";

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
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { describeChain } from "@/lib/audio/effects";
import {
  allPresets,
  filterPresets,
  GENRE_LABELS,
  GENRES,
  TARGET_LABELS,
  type Genre,
  type Preset,
  type PresetTarget,
} from "@/lib/audio/presets";
import { cn } from "@/lib/utils";

const TARGETS: PresetTarget[] = ["guitar", "bass", "drums", "master"];

/** What a preset sets, in a few words. */
function summaryOf(preset: Preset): string {
  const chain = describeChain(preset.chain);
  return preset.kind === "drumMix" ? `Kit mix · ${chain}` : chain;
}

/**
 * The preset browser (#42): every preset, filtered by genre, by what it is
 * for (guitar, bass, drums, master) and by name, with what it contains. A
 * drum mix sets the kit pieces' levels and pans and the drum bus chain.
 */
export function PresetBrowserDialog({
  open,
  onOpenChange,
  target: initialTarget,
  targets = TARGETS,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the browser shows first (the track or master it was opened for). */
  target: PresetTarget;
  /** What can be browsed from here (e.g. only drums from the drum mixer). */
  targets?: PresetTarget[];
  onApply: (preset: Preset) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        {open && (
          <Browser
            initialTarget={initialTarget}
            targets={targets}
            onApply={(preset) => {
              onApply(preset);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Browser({
  initialTarget,
  targets,
  onApply,
  onCancel,
}: {
  initialTarget: PresetTarget;
  targets: PresetTarget[];
  onApply: (preset: Preset) => void;
  onCancel: () => void;
}) {
  const [target, setTarget] = useState(initialTarget);
  const [genre, setGenre] = useState<Genre | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const searchId = useId();
  const listId = useId();

  const presets = useMemo(
    () => filterPresets(allPresets(), { target, genre, query }),
    [target, genre, query],
  );
  const chosen = presets.find((p) => p.id === selected) ?? null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Presets</DialogTitle>
        <DialogDescription>
          Tones, drum mixes and mastering chains for heavy genres. Pick one to see what it sets,
          then apply it.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="flex flex-col gap-3">
          {targets.length > 1 && (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={target}
              onValueChange={(value) => {
                if (!value) return;
                setTarget(value as PresetTarget);
                setSelected(null);
              }}
              aria-label="For"
              className="flex-wrap"
            >
              {targets.map((t) => (
                <ToggleGroupItem key={t} value={t}>
                  {TARGET_LABELS[t]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={genre ?? "all"}
            onValueChange={(value) => {
              if (!value) return;
              setGenre(value === "all" ? null : (value as Genre));
              setSelected(null);
            }}
            aria-label="Genre"
            className="flex-wrap"
          >
            <ToggleGroupItem value="all">All genres</ToggleGroupItem>
            {GENRES.map((g) => (
              <ToggleGroupItem key={g} value={g}>
                {GENRE_LABELS[g]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="flex flex-col gap-1">
            <label htmlFor={searchId} className="text-xs">
              Search
            </label>
            <Input
              id={searchId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name or sound, e.g. “chug”"
            />
          </div>
        </div>

        {presets.length === 0 ? (
          <p className="text-sm text-muted-foreground">No presets match.</p>
        ) : (
          <div
            id={listId}
            role="radiogroup"
            aria-label="Presets"
            className="grid gap-2 sm:grid-cols-2"
          >
            {presets.map((preset) => {
              const on = preset.id === selected;
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={preset.name}
                  aria-describedby={`${listId}-${preset.id}`}
                  data-testid="preset"
                  onClick={() => setSelected(preset.id)}
                  onDoubleClick={() => onApply(preset)}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-md border p-2 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
                    on && "border-sky-600 ring-2 ring-sky-600/40",
                  )}
                >
                  <span className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                    {preset.name}
                    {preset.kind === "drumMix" && <Badge variant="secondary">Drum mix</Badge>}
                    {preset.user && <Badge variant="outline">Yours</Badge>}
                  </span>
                  <span id={`${listId}-${preset.id}`} className="flex flex-col gap-1">
                    <span className="text-xs text-foreground/75">{preset.description}</span>
                    <span className="text-xs">{summaryOf(preset)}</span>
                  </span>
                  {preset.genres.length > 0 && (
                    <span className="text-[0.7rem] text-foreground/75">
                      {preset.genres.map((g) => GENRE_LABELS[g]).join(" · ")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!chosen} onClick={() => chosen && onApply(chosen)}>
          {chosen ? `Apply “${chosen.name}”` : "Apply"}
        </Button>
      </DialogFooter>
    </>
  );
}
