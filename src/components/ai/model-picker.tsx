import { CheckIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import { downloadText, SIZES } from "@/lib/ai/muscriptor-sizes";
import { type AiState, isInstalled } from "@/lib/ai/ai-store";
import type { MuscriptorSize } from "@/lib/tauri";

/** The three sizes as a radio group: download, speed and memory of each, and which are installed. */
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
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {SIZES.map((info) => {
        const bytes = state.status?.sizes.find((s) => s.size === info.size)?.bytes;
        const installed = isInstalled(state, info.size);
        return (
          <div
            key={info.size}
            className="flex items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary has-[:checked]:bg-muted/60 has-[:disabled]:opacity-60 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
          >
            <input
              id={`muscriptor-size-${info.size}`}
              type="radio"
              name="muscriptor-size"
              className="mt-1"
              value={info.size}
              checked={value === info.size}
              onChange={() => onChange(info.size)}
            />
            <label
              htmlFor={`muscriptor-size-${info.size}`}
              className="flex cursor-pointer flex-col gap-0.5"
            >
              <span className="font-medium">
                {info.label}{" "}
                <span className="font-normal text-muted-foreground">
                  · {bytes ? downloadText(bytes) : `${info.megabytes} MB`}
                </span>
                {installed && (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-primary">
                    <CheckIcon aria-hidden="true" className="size-3" />
                    Installed
                  </span>
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {info.note} About {info.gpuSeconds} s per minute of audio on a fast graphics
                processor
                {info.cpuSeconds ? `, ${info.cpuSeconds} s on the processor alone` : ""}; at least{" "}
                {info.ramGb} GB of memory (estimates).
              </span>
            </label>
            {onDelete && installed && (
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
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
