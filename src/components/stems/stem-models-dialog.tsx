import { useEffect } from "react";

import logo from "@/assets/stem-separation/logo.webp";
import {
  DeleteModelButton,
  ModelRow,
  ModelSection,
  ModelsDialog,
  type ModelRowState,
} from "@/components/ai/model-rows";
import { ModelSetup } from "@/components/stems/engine-choice";
import {
  offeredEngines,
  type EngineInfo,
  type NeuralEngine,
} from "@/components/stems/stem-engines";
import { formatBytes } from "@/components/stems/stem-labels";
import { useEngineModels, type EngineModels } from "@/components/stems/use-engine-models";
import { Button } from "@/components/ui/button";

/** Where an engine stands, for its row. */
function rowState(info: EngineInfo, models: EngineModels): ModelRowState {
  if (info.id === "fast") return { kind: "built-in" };
  const state = models.states[info.id];
  if (!state) {
    return {
      kind: "checking",
      text: models.unreadable[info.id] ? "Status not available" : "Checking…",
    };
  }
  if (!state.available) return { kind: "unavailable" };
  return { kind: models.isReady(info.id) ? "installed" : "not-installed" };
}

/**
 * Stem Separation Models (AI menu): every engine of Stem separation, with what it is best at,
 * what it costs and where it stands, to install (the terms first, then the download with its
 * progress) or delete without starting a separation.
 */
export function StemModelsDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  // A download that runs keeps the window open (the content reports it, and only exists while open).
  return (
    <ModelsDialog
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={onCloseAutoFocus}
      logo={logo}
      title="Stem Separation Models"
      testId="stem-models-dialog"
      description="The engines that split a song into its parts. Install the ones you want, and delete the ones you do not need to free the disk space."
    >
      {(setBusy) => <StemModels onBusy={setBusy} />}
    </ModelsDialog>
  );
}

function StemModels({ onBusy }: { onBusy: (busy: boolean) => void }) {
  const models = useEngineModels(true);
  useEffect(() => {
    onBusy(models.busy);
    return () => onBusy(false);
  }, [models.busy, onBusy]);

  if (models.setup) return <ModelSetup models={models} />;
  const deleteDisabled = models.busy || models.removing !== null;
  return (
    <>
      <ModelSection id="stem-engines" title="Engines" usedBy="Stem separation">
        {offeredEngines(models.states).map((info) => {
          const state = rowState(info, models);
          const downloadBytes = info.id === "fast" ? null : models.states[info.id]?.downloadBytes;
          return (
            <ModelRow
              key={info.id}
              id={info.id}
              name={info.label}
              recommended={info.recommended}
              details={[info.strength, info.speed, ...(info.partsNote ? [info.partsNote] : [])]}
              size={
                info.id === "fast"
                  ? "Nothing to install"
                  : downloadBytes
                    ? `Download ${formatBytes(downloadBytes)}`
                    : null
              }
              state={state}
            >
              {state.kind === "not-installed" && (
                <Button
                  type="button"
                  size="sm"
                  disabled={models.busy}
                  aria-label={`Install the ${info.label} model`}
                  onClick={() => models.open(info.id as NeuralEngine)}
                >
                  Install
                </Button>
              )}
              {state.kind === "installed" && info.id !== "fast" && (
                <DeleteModelButton
                  label={info.label}
                  disabled={deleteDisabled}
                  onDelete={() => void models.remove(info.id as NeuralEngine)}
                />
              )}
            </ModelRow>
          );
        })}
      </ModelSection>
      {models.error && (
        <p role="alert" className="text-sm text-destructive">
          {models.error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Deleting a model frees its disk space. The terms you accepted stay on file, so installing it
        again only downloads the file.
      </p>
    </>
  );
}
