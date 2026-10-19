import { useEffect, useState } from "react";

import { AI_DIALOG_FRAME } from "@/components/ai/dialog-frame";
import { ModelPicker } from "@/components/ai/model-picker";
import { MuscriptorFacts } from "@/components/ai/powered-by-muscriptor";
import { ExternalLink } from "@/components/external-link";
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
import {
  chooseSize,
  closeInstaller,
  installModel,
  isInstalled,
  refreshAi,
  stopInstall,
  useAiState,
} from "@/lib/ai/ai-store";
import type { AiState } from "@/lib/ai/ai-store";
import { downloadText, sizeInfo } from "@/lib/ai/muscriptor-sizes";
import { MUSCRIPTOR } from "@/lib/credits";

type Step = "about" | "models" | "terms" | "download" | "done";
const STEPS: readonly Step[] = ["about", "models", "terms", "download", "done"];
const TITLES: Record<Step, string> = {
  about: "Powered by MuScriptor",
  models: "Models and performance",
  terms: "Register and accept the terms",
  download: "Downloading",
  done: "Everything is set up",
};

/**
 * The guided install of the MuScriptor model (#150), one dialog with five steps. Record to tab
 * and Import from Audio hand over to it and get the user back when it closes. The frame never
 * changes size and the buttons never move: the steps swap only the body.
 */
export function AiInstallerDialog() {
  const ai = useAiState();
  const close = () => {
    if (ai.download) stopInstall();
    closeInstaller();
  };
  return (
    <Dialog open={ai.installer.open} onOpenChange={(next) => !next && close()}>
      <DialogContent size="xl" className={AI_DIALOG_FRAME} data-testid="ai-installer">
        {/* Mounted only while open: every visit starts at the first step. */}
        {ai.installer.open && <Installer ai={ai} close={close} />}
      </DialogContent>
    </Dialog>
  );
}

function Installer({ ai, close }: { ai: AiState; close: () => void }) {
  const { returnTo } = ai.installer;
  const [chosen, setStep] = useState<Step>("about");
  // null: untouched, so the boxes follow the terms on file (already accepted: ticked).
  const [acceptedBox, setAccepted] = useState<boolean | null>(null);
  const [rightsBox, setRights] = useState<boolean | null>(null);
  const accepted = acceptedBox ?? Boolean(ai.status?.termsAccepted);
  const rights = rightsBox ?? Boolean(ai.status?.termsAccepted);
  const installed = isInstalled(ai, ai.size);
  // The download ended: on to the last step; a failure stays on the download step with its error.
  const step: Step = chosen === "download" && !ai.download && installed ? "done" : chosen;

  useEffect(() => {
    void refreshAi();
  }, []);

  const info = sizeInfo(ai.size);
  const bytes = ai.status?.sizes.find((s) => s.size === ai.size)?.bytes;
  const downloading = ai.download !== null;
  const index = STEPS.indexOf(step);
  const back = returnTo === "audio" ? "Import from Audio" : "recording";

  const start = () => {
    setStep("download");
    void installModel(ai.size, rights);
  };
  const next = () => {
    if (step === "terms" || (step === "download" && !downloading && !installed)) start();
    else if (step === "done") close();
    else setStep(STEPS[Math.min(index + 1, STEPS.length - 1)] ?? "done");
  };
  const primary =
    step === "about"
      ? "Choose a model"
      : step === "models"
        ? "Continue"
        : step === "terms"
          ? `Download ${info.label} (${bytes ? downloadText(bytes) : `${info.megabytes} MB`})`
          : step === "download"
            ? downloading
              ? "Downloading…"
              : "Try again"
            : `Back to ${back}`;
  const primaryDisabled =
    (step === "terms" && !(accepted && rights)) || (step === "download" && downloading);
  const percent = Math.round((ai.download?.fraction ?? 0) * 100);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{TITLES[step]}</DialogTitle>
        <DialogDescription>
          Step {index + 1} of {STEPS.length}. MuScriptor is an optional AI model that runs on this
          computer. You download it once.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        {step === "about" && (
          <div className="text-sm">
            <MuscriptorFacts withSpeeds />
          </div>
        )}
        {step === "models" && <ModelPicker state={ai} value={ai.size} onChange={chooseSize} />}
        {step === "terms" && (
          <div className="flex flex-col gap-4 text-sm">
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Open the official model card, sign in to Hugging Face if it asks you to, and read
                and accept the terms of the weights:{" "}
                <ExternalLink className="underline" href={MUSCRIPTOR.modelCard}>
                  huggingface.co/MuScriptor/muscriptor-medium
                </ExternalLink>
                . They are {MUSCRIPTOR.licence.name}: non-commercial use only.
              </li>
              <li>Come back here and confirm below. Smart Beat keeps a record of it.</li>
            </ol>
            <div className="flex items-start gap-3">
              <Checkbox
                id="ai-terms"
                className="mt-0.5"
                checked={accepted}
                onCheckedChange={(v) => setAccepted(v === true)}
              />
              <label htmlFor="ai-terms">
                I read and accepted the MuScriptor weight terms on the official model card, and I
                use the model for non-commercial purposes only.
              </label>
            </div>
            <div className="flex items-start gap-3">
              <Checkbox
                id="ai-rights"
                className="mt-0.5"
                checked={rights}
                onCheckedChange={(v) => setRights(v === true)}
              />
              <label htmlFor="ai-rights">
                I only use MuScriptor with my own music or music I have the rights to, and I am
                responsible for that.
              </label>
            </div>
          </div>
        )}
        {step === "download" && (
          <div role="status" className="flex flex-col gap-3 text-sm">
            {downloading ? (
              <>
                <p>
                  Downloading {info.label} ({bytes ? downloadText(bytes) : `${info.megabytes} MB`}
                  ): {percent}%
                </p>
                <progress className="w-full" max={100} value={percent} aria-label="Download" />
                <p className="text-muted-foreground">
                  You can stop at any time. A later download continues where it stopped.
                </p>
                <div>
                  <Button variant="outline" onClick={stopInstall}>
                    Stop download
                  </Button>
                </div>
              </>
            ) : (
              <p>{ai.error ?? "The download stopped. Try again to continue where it stopped."}</p>
            )}
            {ai.error && downloading && <p role="alert">{ai.error}</p>}
          </div>
        )}
        {step === "done" && (
          <div className="flex flex-col gap-3 text-sm">
            <p>
              MuScriptor ({info.label}) is on this computer, and you confirmed the terms. Go back to{" "}
              {back} and pick the AI mode.
            </p>
            <p className="text-muted-foreground">
              {MUSCRIPTOR.name} by {MUSCRIPTOR.authors}, {MUSCRIPTOR.licence.name}. Non-commercial
              use only.
            </p>
          </div>
        )}
        {ai.error && step !== "download" && (
          <p role="alert" className="text-sm text-destructive">
            {ai.error}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button
          variant="outline"
          className="min-w-24"
          disabled={index === 0 || step === "download" || step === "done"}
          onClick={() => setStep(STEPS[Math.max(index - 1, 0)] ?? "about")}
        >
          Back
        </Button>
        <Button className="min-w-64" disabled={primaryDisabled} onClick={next}>
          {primary}
        </Button>
        <Button variant="outline" className="min-w-24" onClick={close}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}
