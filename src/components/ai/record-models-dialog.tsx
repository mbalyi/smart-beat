import { DownloadIcon } from "lucide-react";
import { useEffect } from "react";

import logo from "@/assets/ai-installer/logo.webp";
import {
  DeleteModelButton,
  ModelProgress,
  ModelRow,
  ModelSection,
  ModelsDialog,
} from "@/components/ai/model-rows";
import { Button } from "@/components/ui/button";
import { usePianoModel } from "@/hooks/use-piano-model";
import {
  chooseSize,
  isInstalled,
  openInstaller,
  refreshAi,
  removeModel,
  useAiState,
} from "@/lib/ai/ai-store";
import { downloadText, SIZES } from "@/lib/ai/muscriptor-sizes";
import { isTauri } from "@/lib/tauri";

/** "103M parameters, about 13 s per minute of audio on a graphics processor" */
const speedLine = (params: string, seconds: number) =>
  `${params.replace("~", "About ")} parameters. About ${seconds} s per minute of audio on a graphics processor.`;

/**
 * Record to Tab Models (AI menu): everything Record to tab and Import from Audio can use. The
 * MuScriptor sizes install through the guided installer (its terms come first) and hand the user
 * back here; the high-accuracy piano model downloads in place; the rest is built in.
 */
export function RecordModelsDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <ModelsDialog
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={onCloseAutoFocus}
      logo={logo}
      title="Record to Tab Models"
      testId="record-models-dialog"
      description="What turns a recording or a song into a tab. Install the models you want, and delete the ones you do not need to free the disk space."
    >
      {(setBusy) => <RecordModels onBusy={setBusy} onClose={() => onOpenChange(false)} />}
    </ModelsDialog>
  );
}

function RecordModels({
  onBusy,
  onClose,
}: {
  onBusy: (busy: boolean) => void;
  onClose: () => void;
}) {
  const ai = useAiState();
  const piano = usePianoModel(true);
  useEffect(() => {
    void refreshAi();
  }, []);
  const busy = ai.download !== null || piano.progress !== null;
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);

  // The guided installer has the model card, the terms and the download: this dialog gives way
  // to it and comes back when the installer closes.
  const install = (size: (typeof SIZES)[number]["size"]) => {
    chooseSize(size);
    onClose();
    openInstaller("models");
  };
  const desktop = isTauri();
  const pianoPercent = piano.progress === null ? null : Math.round(piano.progress * 100);

  return (
    <>
      <ModelSection
        id="muscriptor"
        title="MuScriptor (AI mode)"
        usedBy="Record to tab and Import from Audio"
        intro={
          ai.unsupported ? (
            <p className="text-muted-foreground">MuScriptor is not available on this platform.</p>
          ) : (
            <p className="text-muted-foreground">
              The AI that listens to a recording and writes the notes. Pick one size: a bigger one
              is more accurate and slower.
            </p>
          )
        }
      >
        {!ai.unsupported &&
          SIZES.map((info) => {
            const installed = isInstalled(ai, info.size);
            const bytes = ai.status?.sizes.find((s) => s.size === info.size)?.bytes;
            const chosen = installed && ai.size === info.size;
            return (
              <ModelRow
                key={info.size}
                id={`muscriptor-${info.size}`}
                name={`MuScriptor ${info.label}`}
                details={[info.note, speedLine(info.params, info.gpuSeconds)]}
                size={`Download ${bytes ? downloadText(bytes) : `${info.megabytes} MB`}`}
                state={{
                  kind: installed
                    ? "installed"
                    : desktop && !ai.status
                      ? "checking"
                      : "not-installed",
                }}
                highlighted={chosen}
              >
                {installed ? (
                  <>
                    {chosen ? (
                      <span className="text-xs font-semibold text-primary">In use</span>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        aria-label={`Use the ${info.label} model`}
                        onClick={() => chooseSize(info.size)}
                      >
                        Use this one
                      </Button>
                    )}
                    <DeleteModelButton
                      label={info.label}
                      disabled={busy}
                      onDelete={() => void removeModel(info.size)}
                    />
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || !desktop}
                    aria-label={`Install the ${info.label} model`}
                    onClick={() => install(info.size)}
                  >
                    <DownloadIcon aria-hidden="true" data-icon="inline-start" />
                    Install
                  </Button>
                )}
              </ModelRow>
            );
          })}
        {ai.error && (
          <li role="alert" className="list-none text-sm text-destructive">
            {ai.error}
          </li>
        )}
      </ModelSection>

      <ModelSection
        id="piano"
        title="High-accuracy piano"
        usedBy="Record to tab (piano, High accuracy)"
      >
        <ModelRow
          id="transkun"
          name="Transkun piano model"
          details={[
            "Finds nearly every note of a piano. Runs on this computer, but takes about half as long as the recording.",
            "Your recordings are never uploaded.",
          ]}
          size={piano.ready ? `Download ${downloadText(piano.bytes)}` : null}
          state={{
            kind: piano.installed ? "installed" : piano.ready ? "not-installed" : "checking",
          }}
        >
          {piano.progress !== null && (
            <ModelProgress label="Downloading the piano model" percent={pianoPercent} />
          )}
          {piano.progress === null && piano.ready && !piano.installed && (
            <Button
              type="button"
              size="sm"
              disabled={piano.removing}
              aria-label="Install the Transkun piano model"
              onClick={piano.download}
            >
              <DownloadIcon aria-hidden="true" data-icon="inline-start" />
              Install
            </Button>
          )}
          {piano.installed && piano.progress === null && (
            <DeleteModelButton
              label="Transkun piano"
              disabled={piano.removing}
              onDelete={() => void piano.remove()}
            />
          )}
          {piano.error && (
            <p role="alert" className="text-xs text-destructive">
              {piano.error}
            </p>
          )}
        </ModelRow>
      </ModelSection>

      <ModelSection id="built-in" title="Built in" usedBy="Record to tab">
        <ModelRow
          id="basic-pitch"
          name="Basic Pitch"
          details={[
            "Finds the notes of a guitar, bass or piano. The standard choice, fast and accurate on most takes.",
            "Made by Spotify. Built in, nothing to install.",
          ]}
          size={null}
          state={{ kind: "built-in" }}
        />
        <ModelRow
          id="drum-hits"
          name="Drum hit finder"
          details={[
            "Finds kick, snare and hi-hat hits (toms and crash cymbals are experimental).",
            "Built in, nothing to install.",
          ]}
          size={null}
          state={{ kind: "built-in" }}
        />
      </ModelSection>

      <p className="text-xs text-muted-foreground">
        Deleting a model frees its disk space. The terms you accepted stay on file, so installing it
        again only downloads the file.
      </p>
    </>
  );
}
