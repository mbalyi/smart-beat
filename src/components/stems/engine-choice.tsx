import { CheckIcon } from "lucide-react";
import { useState } from "react";

import type { EngineModels } from "@/components/stems/use-engine-models";
import {
  engineInfo,
  offeredEngines,
  type EngineInfo,
  type NeuralEngine,
} from "@/components/stems/stem-engines";
import { formatBytes } from "@/components/stems/stem-labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { StemEngine } from "@/lib/tauri";
import { cn } from "@/lib/utils";

// --- The engine choice -----------------------------------------------------------------------

/** The line under a card's strength: what the user has to do to use it. */
function stateText(info: EngineInfo, models: EngineModels): string {
  if (info.id === "fast") return "Built in";
  const state = models.states[info.id];
  if (!state) return models.unreadable[info.id] ? "Status not available" : "Checking…";
  if (!state.available) return "Not published yet";
  if (models.isReady(info.id)) return "On this computer";
  return `Download ${formatBytes(state.downloadBytes)}`;
}

/** The engines as a list of cards: pick one; the panel below the list is its download. */
export function EngineChoice({
  engine,
  onEngine,
  models,
}: {
  engine: StemEngine;
  onEngine: (engine: StemEngine) => void;
  models: EngineModels;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span id="stem-engine-label" className="text-sm font-medium">
        Engine
      </span>
      <div role="radiogroup" aria-labelledby="stem-engine-label" className="flex flex-col gap-2">
        {offeredEngines(models.states).map((info) => {
          const ready = models.isReady(info.id);
          return (
            <label
              key={info.id}
              htmlFor={`stem-engine-${info.id}`}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border bg-card/70 px-4 py-2.5 has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
              )}
            >
              <input
                type="radio"
                id={`stem-engine-${info.id}`}
                name="stem-engine"
                value={info.id}
                checked={engine === info.id}
                onChange={() => onEngine(info.id)}
                aria-labelledby={`stem-engine-${info.id}-name`}
                aria-describedby={
                  info.recommended
                    ? `stem-engine-${info.id}-badge stem-engine-${info.id}-info`
                    : `stem-engine-${info.id}-info`
                }
                className="mt-1 size-4 shrink-0 accent-primary"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span id={`stem-engine-${info.id}-name`} className="font-semibold">
                    {info.label}
                  </span>
                  {info.recommended && (
                    <Badge
                      id={`stem-engine-${info.id}-badge`}
                      variant="outline"
                      className="rounded-full border-brand/60 bg-brand/10 px-2 py-0 text-xs font-medium text-brand dark:text-[#e29bff]"
                    >
                      Recommended
                    </Badge>
                  )}
                  <span
                    className={cn(
                      "ml-auto flex items-center gap-1 text-xs",
                      ready ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {ready && info.id !== "fast" && (
                      <CheckIcon aria-hidden="true" className="size-3.5" />
                    )}
                    {stateText(info, models)}
                  </span>
                </span>
                <span id={`stem-engine-${info.id}-info`} className="flex flex-col gap-0.5">
                  <span className="text-sm">{info.strength}</span>
                  <span className="text-xs text-muted-foreground">{info.speed}</span>
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {engine !== "fast" && <ModelPanel engine={engine} models={models} />}
    </div>
  );
}

/** Where the chosen model is: ready (and a way to delete it), not published, or to download. */
function ModelPanel({ engine, models }: { engine: NeuralEngine; models: EngineModels }) {
  const { label } = engineInfo(engine);
  const state = models.states[engine];
  if (!state) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {models.unreadable[engine] || `Checking ${label}…`}
      </p>
    );
  }
  if (!state.available) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="status" className="text-xs text-muted-foreground">
          {label} is not published yet, so it cannot be downloaded. It will appear here once it is.
        </p>
        <Button type="button" variant="outline" disabled>
          Download {label}
        </Button>
      </div>
    );
  }
  if (models.isReady(engine)) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-xs text-muted-foreground">{label} is on this computer.</p>
        <Button type="button" variant="outline" onClick={() => models.remove(engine)}>
          Remove {label} from this computer
        </Button>
        {models.error && (
          <p role="alert" className="text-xs text-destructive">
            {models.error}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-xs text-muted-foreground">
        It needs a one-time download of {formatBytes(state.downloadBytes)}, and you confirm its
        terms first.
      </p>
      <Button type="button" variant="outline" onClick={() => models.open(engine)}>
        Download {label}
      </Button>
    </div>
  );
}

/** The terms of the model being set up, and then its download. */
export function ModelSetup({ models }: { models: EngineModels }) {
  const [rights, setRights] = useState(false);
  const { setup } = models;
  if (!setup) return null;
  const { label } = engineInfo(setup.engine);
  const { download } = setup;
  const percent =
    download && download.totalBytes > 0
      ? Math.round((download.downloadedBytes / download.totalBytes) * 100)
      : null;
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="stem-neural-setup">
      <h3 className="text-lg font-bold">Terms of {label}</h3>
      <p className="rounded-xl border bg-card/70 px-4 py-3 whitespace-pre-line">
        {models.states[setup.engine]?.licence}
      </p>
      <label htmlFor="stem-neural-rights" className="flex cursor-pointer items-start gap-3">
        <Checkbox
          id="stem-neural-rights"
          checked={rights}
          onCheckedChange={(on) => setRights(on === true)}
          disabled={models.busy}
          className="mt-0.5"
        />
        <span>I only use music I have the rights to, and I accept these terms.</span>
      </label>
      {models.busy && (
        <div role="status" className="flex flex-col gap-1.5">
          <p className="font-semibold">Downloading {label}…</p>
          <div className="flex items-center gap-3">
            <div
              role="progressbar"
              aria-label="Download progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
              className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cn(
                  "h-full rounded-full bg-primary",
                  percent === null && "w-1/3 motion-safe:animate-pulse",
                )}
                style={percent === null ? undefined : { width: `${percent}%` }}
              />
            </div>
            {percent !== null && <span className="w-12 text-right font-semibold">{percent}%</span>}
          </div>
        </div>
      )}
      {setup.error && (
        <p role="alert" className="text-destructive">
          {setup.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {models.busy ? (
          <Button type="button" variant="outline" size="lg" onClick={models.cancel}>
            Cancel download
          </Button>
        ) : (
          <>
            <Button type="button" size="lg" disabled={!rights} onClick={models.accept}>
              Accept and download
            </Button>
            <Button type="button" variant="outline" size="lg" onClick={models.close}>
              Not now
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
