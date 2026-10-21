import {
  ArrowRightIcon,
  CheckIcon,
  ExternalLinkIcon,
  FileTextIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import logo from "@/assets/ai-installer/logo.webp";
import heroAbout from "@/assets/ai-installer/hero-about.webp";
import heroDone from "@/assets/ai-installer/hero-done.webp";
import heroDownload from "@/assets/ai-installer/hero-download.webp";
import heroModel from "@/assets/ai-installer/hero-model.webp";
import { DIALOG_NEON, DialogArt, DialogLogo, DialogStepper } from "@/components/ai/dialog-art";
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
  hasTerms,
  installModel,
  isInstalled,
  refreshAi,
  removeModel,
  stopInstall,
  useAiState,
} from "@/lib/ai/ai-store";
import type { AiState } from "@/lib/ai/ai-store";
import { downloadText, sizeInfo } from "@/lib/ai/muscriptor-sizes";
import { MUSCRIPTOR } from "@/lib/credits";
import { cn } from "@/lib/utils";

type Step = "about" | "models" | "terms" | "download" | "done";
const STEPS: readonly Step[] = ["about", "models", "terms", "download", "done"];
const TITLES: Record<Step, string> = {
  about: "Powered by MuScriptor",
  models: "Pick your model size",
  terms: "Register and accept the terms",
  download: "Downloading",
  done: "Everything is set up!",
};
/** What the stepper calls each step. */
const LABELS: Record<Step, string> = {
  about: "About",
  models: "Model",
  terms: "Terms",
  download: "Download",
  done: "Complete",
};
/** The picture of a step, and where it sits: beside the title or beside the text. */
const HEROES: Partial<Record<Step, { src: string; place: string }>> = {
  about: { src: heroAbout, place: "top-[33%] right-0 w-[50%]" },
  models: { src: heroModel, place: "-top-2 right-14 w-[12%]" },
  download: { src: heroDownload, place: "top-[26%] right-4 w-[28%]" },
  done: { src: heroDone, place: "top-[26%] right-4 w-[28%]" },
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
      <DialogContent
        size="md"
        className={cn(AI_DIALOG_FRAME, "h-[min(44rem,calc(100dvh-2rem))]", DIALOG_NEON)}
        data-testid="ai-installer"
      >
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
  // The terms are on file per model size: the boxes follow the size that is being installed.
  const onFile = hasTerms(ai);
  const accepted = acceptedBox ?? onFile;
  const rights = rightsBox ?? onFile;
  // The confirmations appear once the model card was opened, so they cannot be ticked unread.
  // Terms already on file need no reading again.
  const [cardOpened, setCardOpened] = useState(false);
  const showBoxes = cardOpened || onFile;
  const installed = isInstalled(ai, ai.size);
  // The download ended: on to the last step; a failure stays on the download step with its error.
  const step: Step = chosen === "download" && !ai.download && installed ? "done" : chosen;

  useEffect(() => {
    void refreshAi();
  }, []);

  const info = sizeInfo(ai.size);
  const bytes = ai.status?.sizes.find((s) => s.size === ai.size)?.bytes;
  const size = bytes ? downloadText(bytes) : `${info.megabytes} MB`;
  const downloading = ai.download !== null;
  const index = STEPS.indexOf(step);
  // Opened from the AI menu there is nothing to go back to.
  const back = returnTo === "audio" ? "Import from Audio" : returnTo ? "recording" : null;

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
      : step === "download"
        ? downloading
          ? "Downloading…"
          : "Try again"
        : step === "done"
          ? back
            ? `Back to ${back}`
            : "Close"
          : "Continue";
  const primaryDisabled =
    (step === "terms" && !(accepted && rights)) || (step === "download" && downloading);
  const percent = Math.round((ai.download?.fraction ?? 0) * 100);
  const subtitle: Record<Step, ReactNode> = {
    about: (
      <>
        MuScriptor by Kyutai and Mirelo is an optional AI model that runs on this computer. You
        download it once.
      </>
    ),
    models: (
      <>
        Choose the right balance between speed and quality. You can always download a different
        model later.
      </>
    ),
    terms: (
      <>
        To use MuScriptor, you need to accept the model&apos;s license terms. Continuing downloads{" "}
        {info.label} ({size}) from Hugging Face.
      </>
    ),
    download: (
      <>
        Downloading {info.label} ({size}).
      </>
    ),
    done: (
      <>
        MuScriptor ({info.label}) is now on this computer, and you&apos;ve confirmed the terms.{" "}
        {back
          ? `Go back to ${back} and pick the AI mode to start using it.`
          : "Open Import from Audio or Record to Tab from the AI menu to start using it."}
      </>
    ),
  };
  // The text keeps clear of the picture that sits beside it.
  const beside = step === "download" || step === "done";

  return (
    <div className="relative isolate flex min-h-0 flex-1 flex-col">
      <DialogArt hero={HEROES[step]} name={step} />
      <DialogHeader className="gap-3 px-6 pt-3 md:px-9">
        <DialogLogo src={logo} />
        <DialogStepper labels={STEPS.map((s) => LABELS[s])} current={index} />
        <DialogTitle className="text-2xl font-bold">{TITLES[step]}</DialogTitle>
        <DialogDescription
          className={cn(beside && "md:pr-[20%]", step === "models" && "md:pr-[26%]")}
        >
          Step {index + 1} of {STEPS.length}. {subtitle[step]}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="px-6 pb-4 md:px-9">
        {step === "about" && <MuscriptorFacts withSpeeds />}
        {step === "models" && (
          <>
            <ModelPicker
              state={ai}
              value={ai.size}
              onChange={chooseSize}
              onDelete={(size) => void removeModel(size)}
            />
            <p className="text-xs text-muted-foreground">
              Measured by Smart Beat on an Apple M2 Pro, on one machine and one recording only; your
              computer will differ. Speed is relative to the length of the audio: at 2×, a
              four-minute song is transcribed in about two minutes, and at 0.5× in about eight.
              Deleting a model frees its disk space; the accepted terms stay on file.
            </p>
          </>
        )}
        {step === "terms" && (
          <div className="flex flex-col gap-4 text-sm">
            <ExternalLink
              href={MUSCRIPTOR.modelCard}
              onClick={() => setCardOpened(true)}
              className="flex items-center gap-4 rounded-xl border bg-card/60 px-4 py-3 outline-none hover:bg-card focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <FileTextIcon aria-hidden="true" className="size-8 shrink-0" />
              <span className="flex flex-1 flex-col">
                <span className="font-semibold text-primary underline">
                  Read the model card and license terms
                </span>
                <span className="text-muted-foreground">
                  You will be redirected to Hugging Face ({MUSCRIPTOR.licence.name}).
                </span>
              </span>
              <ExternalLinkIcon aria-hidden="true" className="size-5 shrink-0" />
            </ExternalLink>
            {showBoxes ? (
              <>
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="ai-terms"
                    className="mt-0.5"
                    checked={accepted}
                    onCheckedChange={(v) => setAccepted(v === true)}
                  />
                  <label htmlFor="ai-terms">
                    I have read and accepted the MuScriptor weight terms on the official model card,
                    and I use the model for <strong>non-commercial purposes only</strong>.
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
              </>
            ) : (
              <p className="text-muted-foreground" data-testid="terms-locked">
                Open the model card above and read the terms. The confirmations appear after you
                have opened it.
              </p>
            )}
          </div>
        )}
        {step === "download" && (
          <div role="status" className="flex flex-col gap-3 text-sm md:pr-[32%]">
            {downloading ? (
              <>
                <div className="flex items-center gap-3">
                  <div
                    role="progressbar"
                    aria-label="Download"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    className="h-3 flex-1 overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full rounded-full bg-green-500 transition-[width]"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <span className="w-12 text-right font-semibold">{percent}%</span>
                </div>
                <p className="text-muted-foreground">
                  You can stop at any time. A later download continues where it stopped.
                </p>
                <div>
                  <Button variant="outline" onClick={stopInstall}>
                    <SquareIcon
                      aria-hidden="true"
                      data-icon="inline-start"
                      className="fill-current"
                    />
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
          <ul className="flex w-fit flex-col gap-2 rounded-xl border bg-card/60 px-4 py-3 text-sm">
            {["Model downloaded", "License terms accepted", "Ready to use"].map((line) => (
              <li key={line} className="flex items-center gap-2.5">
                <span className="flex size-5 items-center justify-center rounded-full bg-green-500 text-white">
                  <CheckIcon aria-hidden="true" className="size-3.5" />
                </span>
                {line}
              </li>
            ))}
          </ul>
        )}
        {ai.error && step !== "download" && (
          <p role="alert" className="text-sm text-destructive">
            {ai.error}
          </p>
        )}
      </DialogBody>
      <DialogFooter className="mt-0 flex-row justify-between border-t-0 bg-transparent px-6 pt-2 pb-5 sm:justify-between md:px-9">
        {step === "about" || step === "done" ? (
          <Button variant="outline" size="lg" className="min-w-28 bg-card" onClick={close}>
            Close
          </Button>
        ) : (
          <Button
            variant="outline"
            size="lg"
            className="min-w-28 bg-card"
            disabled={step === "download"}
            onClick={() => setStep(STEPS[Math.max(index - 1, 0)] ?? "about")}
          >
            Back
          </Button>
        )}
        <Button size="lg" className="min-w-52" disabled={primaryDisabled} onClick={next}>
          {primary}
          <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
        </Button>
      </DialogFooter>
    </div>
  );
}
