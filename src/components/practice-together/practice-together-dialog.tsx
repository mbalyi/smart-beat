import {
  CheckIcon,
  CopyIcon,
  GlobeIcon,
  LogOutIcon,
  UserCheckIcon,
  UsersIcon,
  WifiIcon,
} from "lucide-react";
import { useId, useState, type FormEvent } from "react";

import iconJam from "@/assets/record-to-tab/icon-jam.webp";
import { DIALOG_NEON, DialogArt, DialogStepper } from "@/components/ai/dialog-art";
import { SyncQualityBadge } from "@/components/practice-together/sync-quality";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ConnectionKind, PracticeTogether } from "@/hooks/use-practice-together";
import {
  QUALITY_CHOICES,
  QUALITY_HINTS,
  QUALITY_LABELS,
  type QualityChoice,
} from "@/lib/practice-together/quality-presets";
import { cn } from "@/lib/utils";

const STEPS = ["Choose", "Connect", "Play together"] as const;

/** The frame of the dialog: the neon ring and a height that stays put between steps. */
const FRAME = `${DIALOG_NEON} h-[min(40rem,calc(100dvh-2rem))] sm:max-w-3xl`;

type Mode = "host" | "join";

/** Which step the session is on, for the stepper. */
function stepOf(together: PracticeTogether): number {
  const phase = together.state?.phase;
  if (!phase) return 0;
  if (phase === "synchronized" || phase === "reconnecting") return 2;
  if (phase === "closed" || phase === "failed") return 0;
  return 1;
}

export function PracticeTogetherDialog({
  open,
  onOpenChange,
  together,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  together: PracticeTogether;
}) {
  const step = stepOf(together);
  const ended = together.state?.phase === "closed" || together.state?.phase === "failed";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className={FRAME} data-testid="practice-together-dialog">
        <div className="relative isolate flex min-h-0 flex-1 flex-col">
          <DialogArt
            name="practice-together"
            hero={{ src: iconJam, place: "right-8 bottom-16 w-[16%]" }}
          />
          <DialogHeader className="gap-3 px-6 pt-5 md:px-9">
            <DialogStepper labels={STEPS} current={step} />
            <DialogTitle className="text-2xl font-bold">Practice together</DialogTitle>
            <DialogDescription className="text-base md:pr-[20%]">
              Play the same tab with someone else, in time. Each of you hears your own sound; the
              host starts and stops for both.
            </DialogDescription>
          </DialogHeader>
          {open && (
            <>
              {(!together.state || ended) && (
                <ChooseStep together={together} ended={ended} onClose={() => onOpenChange(false)} />
              )}
              {together.state && !ended && step === 1 && (
                <ConnectStep together={together} onClose={() => onOpenChange(false)} />
              )}
              {together.state && !ended && step === 2 && (
                <PlayStep together={together} onClose={() => onOpenChange(false)} />
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Footer({ children, onClose }: { children?: React.ReactNode; onClose: () => void }) {
  return (
    <DialogFooter className="mt-0 flex-row flex-wrap justify-between gap-2 border-t-0 bg-transparent px-6 pt-2 pb-5 md:px-9">
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="min-w-28 bg-card"
        onClick={onClose}
      >
        Close
      </Button>
      {children}
    </DialogFooter>
  );
}

const CARD = "rounded-xl border bg-card/90 p-4 dark:bg-card/85";

// ----- 1. Choose -----------------------------------------------------------------------------

function ChooseStep({
  together,
  ended,
  onClose,
}: {
  together: PracticeTogether;
  ended: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("host");
  const [kind, setKind] = useState<ConnectionKind>("lan");
  const [code, setCode] = useState("");
  const nameId = useId();
  const codeId = useId();
  const problem = ended ? together.state?.problem : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === "host") void together.host(kind);
    else void together.join(kind, code);
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <DialogBody className="gap-4 px-6 pb-4 md:px-9">
        {(problem || together.error) && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
          >
            {together.error ?? problem?.message}
          </p>
        )}
        <div className={cn(CARD, "flex flex-col gap-4 md:mr-[20%]")}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={nameId} className="text-sm font-semibold">
              Your name
            </label>
            <Input
              id={nameId}
              value={together.name}
              maxLength={40}
              onChange={(event) => together.setName(event.target.value)}
            />
          </div>
          <ToggleGroup
            type="single"
            variant="default"
            spacing={2}
            aria-label="What do you want to do?"
            value={mode}
            onValueChange={(value) => value && setMode(value as Mode)}
            className="flex-wrap gap-2"
          >
            <ToggleGroupItem value="host" className={CHOICE}>
              <UsersIcon data-icon="inline-start" />
              Host a session
            </ToggleGroupItem>
            <ToggleGroupItem value="join" className={CHOICE}>
              <UserCheckIcon data-icon="inline-start" />
              Join with a code
            </ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup
            type="single"
            variant="default"
            spacing={2}
            aria-label="Where are you?"
            value={kind}
            onValueChange={(value) => value && setKind(value as ConnectionKind)}
            className="flex-wrap gap-2"
          >
            <ToggleGroupItem value="lan" className={CHOICE}>
              <WifiIcon data-icon="inline-start" />
              Same network
            </ToggleGroupItem>
            <ToggleGroupItem
              value="internet"
              disabled={!together.internetAvailable}
              className={CHOICE}
              title={together.internetAvailable ? undefined : "Not available in this build"}
            >
              <GlobeIcon data-icon="inline-start" />
              Over the internet
            </ToggleGroupItem>
          </ToggleGroup>
          <p className="text-sm text-muted-foreground">
            {kind === "lan"
              ? "Both computers on the same Wi-Fi or cable. The best choice: it is the steadiest and nothing leaves your network."
              : "Connects through a small meeting service, then talks directly. A public address lookup server is contacted, and a strict firewall can block it."}
          </p>
          {mode === "join" && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={codeId} className="text-sm font-semibold">
                Room code
              </label>
              <Input
                id={codeId}
                value={code}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder={kind === "lan" ? "ABCD-EFGH-JKMN-PQRS-TVWX" : "ABCD-EFGH"}
                className="font-mono tracking-wider uppercase"
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
          )}
        </div>
      </DialogBody>
      <Footer onClose={onClose}>
        <Button
          type="submit"
          size="lg"
          className="sm:min-w-52"
          disabled={together.starting || (mode === "join" && code.trim() === "")}
        >
          {together.starting
            ? "Connecting…"
            : mode === "host"
              ? "Start a session"
              : "Join the session"}
        </Button>
      </Footer>
    </form>
  );
}

const CHOICE =
  "h-9 gap-2 rounded-lg px-4 text-sm font-semibold data-[state=on]:bg-primary data-[state=on]:text-primary-foreground";

// ----- 2. Connect ----------------------------------------------------------------------------

function ConnectStep({ together, onClose }: { together: PracticeTogether; onClose: () => void }) {
  const state = together.state!;
  const [copied, setCopied] = useState(false);
  const isHost = state.role === "host";
  const code = together.hostCode?.code ?? "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The code is on screen to read out.
    }
  };

  return (
    <>
      <DialogBody className="gap-4 px-6 pb-4 md:px-9">
        <div className={cn(CARD, "flex flex-col gap-3 md:mr-[20%]")} aria-live="polite">
          {isHost ? (
            <>
              <h3 className="text-base font-semibold">Give this code to the other player</h3>
              <div className="flex flex-wrap items-center gap-3">
                <output
                  data-testid="room-code"
                  className="rounded-lg border bg-background px-4 py-2 font-mono text-xl font-bold tracking-wider break-all"
                >
                  {code}
                </output>
                <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
                  {copied ? (
                    <CheckIcon data-icon="inline-start" />
                  ) : (
                    <CopyIcon data-icon="inline-start" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              {together.hostCode?.address && (
                <p className="text-sm text-muted-foreground">
                  Listening on {together.hostCode.address}. If the other computer cannot connect,
                  check that a firewall is not blocking Smart Beat.
                </p>
              )}
              {state.phase === "waiting" && (
                <p role="status" className="text-sm">
                  Waiting for the other player…
                </p>
              )}
              {together.approval && (
                <div
                  role="alertdialog"
                  aria-label="Let this player in?"
                  className="flex flex-col gap-3 rounded-lg border border-primary/60 p-3"
                >
                  <p className="text-sm">
                    <span className="font-semibold">{together.approval.name}</span> wants to join.
                  </p>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" onClick={() => together.approval?.answer(true)}>
                      Let in
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => together.approval?.answer(false)}
                    >
                      Decline
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p role="status" className="text-sm">
              {state.phase === "syncing" && state.peerName
                ? `Connected to ${state.peerName}. Matching the clocks…`
                : "Connecting to the host…"}
            </p>
          )}
          {state.phase === "syncing" && isHost && state.peerName && !together.approval && (
            <p role="status" className="text-sm">
              {state.peerName} joined. Matching the clocks…
            </p>
          )}
          {state.problem && <Problem message={state.problem.message} />}
        </div>
      </DialogBody>
      <Footer onClose={onClose}>
        <Button
          type="button"
          size="lg"
          variant="outline"
          className="bg-card sm:min-w-52"
          onClick={() => together.leave()}
        >
          Cancel session
        </Button>
      </Footer>
    </>
  );
}

function Problem({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
    >
      {message}
    </p>
  );
}

// ----- 3. Play together ----------------------------------------------------------------------

function PlayStep({ together, onClose }: { together: PracticeTogether; onClose: () => void }) {
  const state = together.state!;
  const isHost = state.role === "host";
  const selectId = useId();
  const peerError = state.peer?.errorMs;
  return (
    <>
      <DialogBody className="gap-4 px-6 pb-4 md:px-9">
        {state.problem && <Problem message={state.problem.message} />}
        <div className={cn(CARD, "flex flex-col gap-3 md:mr-[20%]")}>
          <h3 className="text-base font-semibold">In the session</h3>
          <ul className="flex flex-col gap-2">
            <li className="flex items-center justify-between gap-3" data-testid="peer-you">
              <span>
                {together.name} <span className="text-muted-foreground">(you, {state.role})</span>
              </span>
              {isHost ? (
                <span className="text-sm text-muted-foreground">Session clock</span>
              ) : (
                <SyncQualityBadge quality={state.quality} />
              )}
            </li>
            <li className="flex items-center justify-between gap-3" data-testid="peer-other">
              <span>{state.peerName ?? "Other player"}</span>
              {isHost && peerError !== undefined ? (
                <SyncQualityBadge
                  quality={{
                    errorMs: peerError,
                    bucket: peerError <= 5 ? "excellent" : peerError <= 15 ? "good" : "unstable",
                  }}
                />
              ) : (
                <span className="text-sm text-muted-foreground">Session clock</span>
              )}
            </li>
          </ul>
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <Stat label="Round trip" value={`${Math.round(state.latency.p50)} ms`} />
            <Stat label="Starts ahead by" value={`${state.leadMs} ms`} />
            <Stat label="Drift" value={state.peer ? `${Math.round(state.peer.driftMs)} ms` : "—"} />
          </dl>
          <p className="text-sm text-muted-foreground">
            {isHost
              ? "Press Play in the toolbar: both of you start together. Pause, Stop, speed, loop, metronome and count-in are shared. Your tracks, mute and solo stay your own."
              : "The host controls Play, Pause, Stop and the speed. You can still look around the score and change your own tracks, mute and solo."}
          </p>
        </div>
        <div className={cn(CARD, "flex flex-col gap-2 md:mr-[20%]")}>
          <label htmlFor={selectId} className="text-sm font-semibold">
            Audio quality
          </label>
          <Select
            value={together.quality}
            onValueChange={(value) => together.setQuality(value as QualityChoice)}
          >
            <SelectTrigger id={selectId} className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {QUALITY_CHOICES.map((choice) => (
                <SelectItem key={choice} value={choice}>
                  {QUALITY_LABELS[choice]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            {QUALITY_HINTS[together.quality]}
            {together.quality === "auto" && ` Now using ${QUALITY_LABELS[state.preset]}.`} The sound
            is always made on your own computer.
          </p>
        </div>
      </DialogBody>
      <Footer onClose={onClose}>
        <Button
          type="button"
          size="lg"
          variant="outline"
          className="bg-card sm:min-w-52"
          onClick={() => together.leave()}
        >
          <LogOutIcon data-icon="inline-start" />
          Leave session
        </Button>
      </Footer>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background/60 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
