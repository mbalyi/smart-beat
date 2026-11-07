import { CheckIcon, CloudIcon, CopyIcon, LinkIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { DIALOG_NEON } from "@/components/ai/dialog-art";
import { CloudProviderLogo } from "@/components/cloud-provider-logos";
import { StorageCard, StorageGrid, TargetArt } from "@/components/target-cards";
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
import { Stepper } from "@/components/ui/stepper";
import {
  listCloudAccounts,
  type CloudAccount,
  type CloudProvider,
  type ShareLevel,
} from "@/lib/cloud";
import { cloudErrorText } from "@/lib/cloud-items";
import {
  copyToClipboard,
  createShareLink,
  targetProvider,
  uploadForShare,
  type ShareTarget,
} from "@/lib/cloud-share";
import { errorText } from "@/lib/errors";
import { cancelStemSeparation, isCommandError, isStemFileStopped } from "@/lib/tauri";

type Phase =
  | { step: "storage" }
  | { step: "level" }
  | { step: "working"; message: string; fraction: number | null }
  | { step: "done"; link: string; copied: boolean }
  | { step: "error"; message: string; reconnect: boolean };

const LEVEL_TEXT: Record<ShareLevel, { title: string; text: string }> = {
  view: {
    title: "Can view",
    text: "Anyone with the link can look at it and download it.",
  },
  edit: {
    title: "Can edit",
    text: "Anyone with the link can change the file in your drive. Share it only with people you trust.",
  },
};

/**
 * Share a link to a file (#201). A file in a connected drive goes straight to the choice of what
 * people may do with the link; a file on this computer first asks which storage gets a copy.
 * The link is copied to the clipboard and also shown, in case the system refuses the copy.
 */
export function ShareDialog({
  target,
  onClose,
  onSetUpCloud,
}: {
  target: ShareTarget;
  onClose: () => void;
  onSetUpCloud?: () => void;
}) {
  const fixed = targetProvider(target);
  const local = target.kind !== "cloud";
  const [accounts, setAccounts] = useState<CloudAccount[] | null>(null);
  const [provider, setProvider] = useState<CloudProvider | null>(fixed);
  const [level, setLevel] = useState<ShareLevel>("view");
  const [phase, setPhase] = useState<Phase>(local ? { step: "storage" } : { step: "level" });
  /** What an earlier try already put in a drive, so trying again never uploads a second copy. */
  const uploaded = useRef<{ provider: CloudProvider; item: string } | null>(null);

  useEffect(() => {
    let active = true;
    listCloudAccounts()
      .then((found) => active && setAccounts(found))
      .catch(() => active && setAccounts([]));
    return () => {
      active = false;
    };
  }, []);

  const account = accounts?.find((a) => a.provider === provider) ?? null;
  const levels = account?.shareLevels ?? ["view"];
  const label = account?.label ?? "your drive";
  const working = phase.step === "working";
  const stems = target.kind === "stems";
  // A level the service can't make falls back to view.
  const chosen: ShareLevel = levels.includes(level) ? level : "view";

  const connected = (accounts ?? []).filter((a) => a.configured && a.account);

  const share = async () => {
    if (!provider) return;
    setPhase({ step: "working", message: "Starting…", fraction: null });
    try {
      let item = target.kind === "cloud" ? target.item : null;
      if (!item && uploaded.current?.provider === provider) item = uploaded.current.item;
      if (!item && target.kind !== "cloud") {
        item = await uploadForShare(target, provider, (progress) =>
          setPhase({
            step: "working",
            message: progress.stage === "writing" ? "Packing the stems…" : `Uploading to ${label}…`,
            fraction: progress.fraction,
          }),
        );
        uploaded.current = { provider, item };
      }
      if (!item) return;
      setPhase({ step: "working", message: "Making the link…", fraction: null });
      const link = await createShareLink(item, chosen);
      const copied = await copyToClipboard(link);
      if (copied) toast.success("Link copied", { description: target.name });
      setPhase({ step: "done", link, copied });
    } catch (error) {
      if (isStemFileStopped(error)) {
        setPhase({ step: "level" });
        return;
      }
      setPhase({
        step: "error",
        message: cloudErrorText(error, provider) ?? errorText(error),
        reconnect: isCommandError(error) && error.kind === "auth-expired",
      });
    }
  };

  const copyAgain = async () => {
    if (phase.step !== "done") return;
    const copied = await copyToClipboard(phase.link);
    if (copied) toast.success("Link copied", { description: target.name });
    setPhase({ ...phase, copied });
  };

  const stop = () => {
    if (stems) void cancelStemSeparation().catch(() => {});
  };

  const stepLabels = local ? ["Storage", "Link"] : null;
  const stepIndex = phase.step === "storage" ? 0 : phase.step === "done" ? 2 : 1;

  const title =
    phase.step === "storage"
      ? "Where should it go?"
      : phase.step === "level"
        ? "Who can use the link?"
        : phase.step === "working"
          ? "Making your link…"
          : phase.step === "done"
            ? phase.copied
              ? "Link copied"
              : "Your link is ready"
            : "Couldn't make the link";
  const description =
    phase.step === "storage"
      ? `Smart Beat puts a copy of “${target.name}” in your online drive and gives you a link to it.`
      : phase.step === "level"
        ? local
          ? `A copy of “${target.name}” goes to ${label}. Then you get a link.`
          : `A link to “${target.name}” in ${label}.`
        : target.name;

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (isOpen) return;
        if (working) stop();
        else onClose();
      }}
    >
      <DialogContent
        size="xl"
        showCloseButton={!working}
        data-testid="share-dialog"
        className={`${DIALOG_NEON} max-h-[calc(100dvh-2rem)] sm:max-w-3xl`}
      >
        <div className="relative isolate flex min-h-0 flex-1 flex-col overflow-y-auto">
          <TargetArt />
          <DialogHeader className="px-6 pt-2 pr-14 md:px-9">
            <DialogTitle className="text-2xl font-bold">{title}</DialogTitle>
            <DialogDescription className="text-sm break-words sm:text-base">
              {description}
            </DialogDescription>
            {stepLabels && <Stepper steps={stepLabels} current={stepIndex} className="mt-3 pb-1" />}
          </DialogHeader>
          <DialogBody className="gap-3 overflow-visible px-6 md:px-9">
            {phase.step === "storage" &&
              (accounts === null ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Looking for your accounts…
                </p>
              ) : (
                <>
                  {connected.length === 0 && (
                    <p
                      className="rounded-2xl border bg-card/85 p-4 text-sm"
                      data-testid="share-no-storage"
                    >
                      No online drive is connected yet. Connect Google Drive, OneDrive or Dropbox to
                      share a link.
                    </p>
                  )}
                  <StorageGrid count={accounts.length}>
                    {accounts.map((a) => {
                      const usable = a.configured && !!a.account;
                      return (
                        <StorageCard
                          key={a.provider}
                          art={
                            <CloudProviderLogo
                              provider={a.provider}
                              className="h-10 w-auto drop-shadow-md sm:h-12"
                            />
                          }
                          verb="Upload to"
                          label={a.label}
                          hint={
                            usable
                              ? undefined
                              : a.configured
                                ? "Not connected"
                                : "Not available in this build"
                          }
                          disabled={!usable}
                          onClick={() => {
                            setProvider(a.provider);
                            setPhase({ step: "level" });
                          }}
                          testId={`share-storage-${a.provider}`}
                        />
                      );
                    })}
                  </StorageGrid>
                </>
              ))}
            {phase.step === "level" && (
              <fieldset className="flex flex-col gap-3" data-testid="share-levels">
                <legend className="sr-only">What people with the link can do</legend>
                {(["view", "edit"] as const).map((option) => {
                  const available = levels.includes(option);
                  return (
                    <div
                      key={option}
                      className="flex items-start gap-3 rounded-2xl border border-border bg-card/85 p-4 has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:disabled]:opacity-60 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/60"
                    >
                      <input
                        type="radio"
                        id={`share-level-${option}`}
                        name="share-level"
                        className="mt-1 size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed"
                        value={option}
                        checked={chosen === option}
                        disabled={!available}
                        aria-describedby={`share-level-${option}-text`}
                        onChange={() => setLevel(option)}
                      />
                      <div className="flex flex-col gap-0.5">
                        <label
                          htmlFor={`share-level-${option}`}
                          className="cursor-pointer text-lg font-bold"
                        >
                          {LEVEL_TEXT[option].title}
                        </label>
                        <p
                          id={`share-level-${option}-text`}
                          className="text-sm text-muted-foreground"
                        >
                          {available
                            ? LEVEL_TEXT[option].text
                            : `${label} links made here can only be viewed.`}
                        </p>
                      </div>
                    </div>
                  );
                })}
                {stems && (
                  <p className="text-sm text-muted-foreground">
                    The separated parts are shared as their own stems file, with a link of its own.
                    The original song is not included.
                  </p>
                )}
              </fieldset>
            )}
            {phase.step === "working" && (
              <div
                className="flex min-h-40 flex-col justify-center gap-4 rounded-2xl border border-border bg-card/85 p-5"
                role="status"
                aria-live="polite"
                data-testid="share-progress"
              >
                <div className="flex items-center gap-4">
                  {provider && (
                    <CloudProviderLogo provider={provider} className="h-12 w-auto drop-shadow-md" />
                  )}
                  <span className="text-lg font-bold sm:text-2xl">{phase.message}</span>
                </div>
                <div
                  className="relative h-2 w-full overflow-hidden rounded-full bg-primary/20"
                  aria-hidden="true"
                >
                  {phase.fraction === null ? (
                    <div className="absolute inset-y-0 w-1/3 animate-pulse rounded-full bg-primary" />
                  ) : (
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-primary"
                      style={{ width: `${Math.round(phase.fraction * 100)}%` }}
                    />
                  )}
                </div>
              </div>
            )}
            {phase.step === "done" && (
              <div
                className="flex flex-col gap-3 rounded-2xl border border-border bg-card/85 p-5"
                data-testid="share-done"
              >
                <p role="status" className="flex items-center gap-2 text-lg font-bold">
                  <CheckIcon className="size-5 shrink-0 text-primary" aria-hidden="true" />
                  {phase.copied
                    ? "The link is on your clipboard."
                    : "Copy the link below. The clipboard did not accept it."}
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={phase.link}
                    aria-label="Share link"
                    onFocus={(event) => event.currentTarget.select()}
                    data-testid="share-link"
                  />
                  <Button
                    variant="outline"
                    className="shrink-0 bg-card"
                    onClick={() => void copyAgain()}
                    data-testid="share-copy-again"
                  >
                    <CopyIcon data-icon="inline-start" />
                    Copy again
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  {chosen === "edit"
                    ? "Anyone who has this link can change the file."
                    : "Anyone who has this link can view the file."}{" "}
                  The link opens in {label}, not in Smart Beat.
                </p>
              </div>
            )}
            {phase.step === "error" && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-2xl border border-border bg-card/85 p-5 text-sm sm:text-base"
              >
                <TriangleAlertIcon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                <span data-testid="share-error">{phase.message}</span>
              </p>
            )}
          </DialogBody>
          <DialogFooter className="mt-0 flex-row flex-wrap items-center justify-between gap-2 border-t-0 bg-transparent px-6 pt-4 pb-5 md:px-9">
            <div className="flex items-center gap-2">
              {phase.step === "level" && local ? (
                <Button
                  variant="outline"
                  size="lg"
                  className="min-w-28 bg-card"
                  onClick={() => setPhase({ step: "storage" })}
                >
                  Back
                </Button>
              ) : phase.step === "done" ? null : (
                <Button
                  variant="outline"
                  size="lg"
                  className="min-w-28 bg-card"
                  onClick={working ? stop : onClose}
                  disabled={working && !stems}
                  data-testid="share-cancel"
                >
                  {phase.step === "error" ? "Close" : "Cancel"}
                </Button>
              )}
              {onSetUpCloud &&
                ((phase.step === "storage" && connected.length === 0 && accounts !== null) ||
                  (phase.step === "error" && phase.reconnect)) && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full border-border bg-card px-3 text-foreground shadow-sm"
                    onClick={onSetUpCloud}
                    data-testid="share-setup"
                  >
                    <CloudIcon aria-hidden="true" />
                    {phase.step === "error" ? "Open cloud settings" : "Set up cloud storage"}
                  </Button>
                )}
            </div>
            {phase.step === "level" && (
              <Button
                size="lg"
                className="min-w-52"
                onClick={() => void share()}
                disabled={accounts === null}
                data-testid="share-confirm"
              >
                <LinkIcon data-icon="inline-start" />
                {local ? "Upload and copy link" : "Copy link"}
              </Button>
            )}
            {phase.step === "error" && (
              <Button
                size="lg"
                className="min-w-52"
                onClick={() => void share()}
                data-testid="share-retry"
              >
                Try again
              </Button>
            )}
            {phase.step === "done" && (
              <Button
                size="lg"
                className="min-w-52"
                onClick={onClose}
                data-testid="share-done-close"
              >
                Done
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
