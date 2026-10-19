import { CheckIcon, GaugeIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { type AiState, isInstalled } from "@/lib/ai/ai-store";
import { downloadText, SIZES } from "@/lib/ai/muscriptor-sizes";
import { cn } from "@/lib/utils";
import type { MuscriptorSize } from "@/lib/tauri";

const COLUMNS = "sm:grid-cols-[minmax(0,1.8fr)_6rem_6rem_7.5rem_8rem]";

/** "~3.5×" */
const factor = (value: number) => `~${value}×`;

/** One speed cell: a gauge, the factor and where it was measured. */
function Speed({ value, on, active }: { value: number | null; on: string; active: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <GaugeIcon
        aria-hidden="true"
        className={cn("size-8 shrink-0", active ? "text-primary" : "text-muted-foreground")}
      />
      {value === null ? (
        <span className="flex flex-col text-xs leading-tight">
          <strong className="text-sm">Not</strong>
          recommended
          <span className="text-muted-foreground">on {on}</span>
        </span>
      ) : (
        <span className="flex flex-col leading-tight">
          <strong className="text-sm">{factor(value)}</strong>
          <span className="text-xs text-muted-foreground">on {on}</span>
        </span>
      )}
    </span>
  );
}

/**
 * The three sizes as a table of radio rows: description, parameters, download, and the speed on a
 * GPU and on the CPU alone. The row that is on glows purple; an installed size can be deleted.
 */
export function ModelPicker({
  state,
  value,
  onChange,
  disabled = false,
  legend = "Model size",
  onDelete,
}: {
  state: AiState;
  value: MuscriptorSize;
  onChange: (size: MuscriptorSize) => void;
  disabled?: boolean;
  legend?: string;
  /** Deletes a downloaded size. Without it the picker has no delete buttons. */
  onDelete?: (size: MuscriptorSize) => void;
}) {
  // The size whose delete is waiting for a second click.
  const [confirming, setConfirming] = useState<MuscriptorSize | null>(null);
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-2">
      <legend className="sr-only">{legend}</legend>
      <div
        aria-hidden="true"
        className={cn(
          "hidden gap-x-3 rounded-t-xl border border-b-0 bg-card/60 px-4 py-2 text-[11px] font-semibold tracking-[0.2em] text-muted-foreground uppercase sm:grid",
          COLUMNS,
        )}
      >
        <span className="pl-9">Size</span>
        <span>Parameters</span>
        <span>Download</span>
        <span>Speed on GPU</span>
        <span>Speed on CPU</span>
      </div>
      {SIZES.map((info) => {
        const bytes = state.status?.sizes.find((s) => s.size === info.size)?.bytes;
        const installed = isInstalled(state, info.size);
        const active = value === info.size;
        const id = `muscriptor-size-${info.size}`;
        return (
          <div
            key={info.size}
            className={cn(
              "grid items-center gap-x-3 gap-y-2 rounded-xl border bg-card/40 px-4 py-3 has-[:disabled]:opacity-60 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
              COLUMNS,
              active &&
                "border-primary bg-primary/10 shadow-[0_0_18px_color-mix(in_oklab,var(--primary)_55%,transparent)]",
            )}
          >
            <div className="flex items-start gap-3">
              <input
                id={id}
                type="radio"
                name="muscriptor-size"
                className="mt-1 size-4 accent-[var(--primary)]"
                value={info.size}
                checked={active}
                onChange={() => onChange(info.size)}
              />
              <label htmlFor={id} className="flex cursor-pointer flex-col gap-0.5">
                <span className="font-semibold">
                  {info.label}
                  {installed && (
                    <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-primary">
                      <CheckIcon aria-hidden="true" className="size-3" />
                      Installed
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">{info.note}</span>
                <span className="text-xs text-muted-foreground">
                  About {info.gpuSeconds} s per minute of audio.
                </span>
              </label>
            </div>
            <span className="text-sm">
              <span className="text-xs text-muted-foreground sm:hidden">Parameters </span>
              {info.params}
            </span>
            <span className="text-sm">
              <span className="text-xs text-muted-foreground sm:hidden">Download </span>~
              {bytes ? downloadText(bytes) : `${info.megabytes} MB`}
            </span>
            <Speed value={info.gpuFactor} on="GPU" active={active} />
            <Speed value={info.cpuFactor} on="CPU" active={active} />
            {onDelete && installed && (
              <div className="flex items-center gap-1.5 sm:col-span-full">
                {confirming === info.size ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        setConfirming(null);
                        onDelete(info.size);
                      }}
                    >
                      Delete {info.label}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setConfirming(null)}
                    >
                      Keep
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`Delete the ${info.label} model`}
                    onClick={() => setConfirming(info.size)}
                  >
                    <Trash2Icon aria-hidden="true" data-icon="inline-start" />
                    Delete
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
