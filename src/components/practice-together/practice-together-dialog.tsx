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

import { DirectConnectionHelp } from "@/components/practice-together/direct-connection-help";
import {
  CARD,
  CHOICE,
  TogetherContent,
  TogetherFrame,
} from "@/components/practice-together/together-frame";
import { SyncQualityBadge } from "@/components/practice-together/sync-quality";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ConnectionKind, PracticeTogether } from "@/hooks/use-practice-together";
import {
  QUALITY_CHOICES,
  QUALITY_HINTS,
  QUALITY_LABELS,
  type QualityChoice,
} from "@/lib/practice-together/quality-presets";

const STEPS = ["Choose", "Connect", "Play together"] as const;

/** Start a new session (share the open tab) or join one (the tab comes from the host). */
export type TogetherMode = "host" | "join";

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
  initialMode = "host",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  together: PracticeTogether;
  /** What the first choice starts on; "join" when the dialog was opened to join a session. */
  initialMode?: TogetherMode;
}) {
  const step = stepOf(together);
  const ended = together.state?.phase === "closed" || together.state?.phase === "failed";
  return (
    <TogetherFrame
      open={open}
      onOpenChange={onOpenChange}
      steps={STEPS}
      step={step}
      testId="practice-together-dialog"
    >
      {(!together.state || ended) && (
        <ChooseStep
          together={together}
          ended={ended}
          initialMode={initialMode}
          onClose={() => onOpenChange(false)}
        />
      )}
      {together.state && !ended && step === 1 && (
        <ConnectStep together={together} onClose={() => onOpenChange(false)} />
      )}
      {together.state && !ended && step === 2 && (
        <PlayStep together={together} onClose={() => onOpenChange(false)} />
      )}
    </TogetherFrame>
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

// ----- 1. Choose -----------------------------------------------------------------------------

function ChooseStep({
  together,
  ended,
  initialMode,
  onClose,
}: {
  together: PracticeTogether;
  ended: boolean;
  initialMode: TogetherMode;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<TogetherMode>(initialMode);
  const [kind, setKind] = useState<ConnectionKind>("lan");
  const [code, setCode] = useState("");
  const [helping, setHelping] = useState(false);
  const nameId = useId();
  const codeId = useId();
  const noInternetId = useId();
  const problem = ended ? together.state?.problem : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === "host") void together.host(kind);
    else void together.join(kind, code);
  };

  if (helping) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <DialogBody className="px-6 pb-4 md:px-9">
          <TogetherContent>
            <DirectConnectionHelp />
          </TogetherContent>
        </DialogBody>
        <Footer onClose={onClose}>
          <Button type="button" size="lg" className="sm:min-w-52" onClick={() => setHelping(false)}>
            Back to the connection
          </Button>
        </Footer>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <DialogBody className="px-6 pb-4 md:px-9">
        <TogetherContent>
          {(problem || together.error) && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
            >
              {together.error ?? problem?.message}
            </p>
          )}
          <div className={cn(CARD, "flex flex-col gap-4")}>
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
              onValueChange={(value) => value && setMode(value as TogetherMode)}
              className="flex-wrap gap-2"
            >
              <ToggleGroupItem value="host" className={CHOICE}>
                <UsersIcon data-icon="inline-start" />
                Start a new session
              </ToggleGroupItem>
              <ToggleGroupItem value="join" className={CHOICE}>
                <UserCheckIcon data-icon="inline-start" />
                Join an existing session
              </ToggleGroupItem>
            </ToggleGroup>
            <p className="text-sm text-muted-foreground" data-testid="mode-hint">
              {mode === "host"
                ? "You host: the other player gets this tab from you if they do not have it yet, and you start and stop for both."
                : "You join the host's session with its code. The tab comes from the host, so you do not need to have it."}
            </p>
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
                aria-describedby={together.internetAvailable ? undefined : noInternetId}
              >
                <GlobeIcon data-icon="inline-start" />
                Over the internet
              </ToggleGroupItem>
            </ToggleGroup>
            {!together.internetAvailable && (
              <p id={noInternetId} className="text-sm text-muted-foreground">
                Over the internet is not available: it needs the online connection service, which
                this build does not include.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {kind === "lan"
                ? "Both computers on the same Wi-Fi or cable. The best choice: it is the steadiest and nothing leaves your network."
                : "Connects through a small meeting service, then talks directly. A public address lookup server is contacted, and a strict firewall can block it."}
            </p>
            {kind === "lan" && (
              <Button
                type="button"
                variant="link"
                className="h-auto justify-start p-0 text-left whitespace-normal"
                onClick={() => setHelping(true)}
              >
                Need a direct connection? (no router, cable or hotspot)
              </Button>
            )}
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
        </TogetherContent>
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
      <DialogBody className="px-6 pb-4 md:px-9">
        <TogetherContent>
          <div className={cn(CARD, "flex flex-col gap-3")} aria-live="polite">
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
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => together.approval?.answer(true)}
                      >
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
            <TransferLine transfer={together.transfer} />
            {state.problem && <Problem message={state.problem.message} />}
          </div>
        </TogetherContent>
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

/** The tab on its way between the two computers: the host sends it, the guest receives it. */
function TransferLine({ transfer }: { transfer: PracticeTogether["transfer"] }) {
  const id = useId();
  if (!transfer) return null;
  const done = transfer.done >= transfer.total && transfer.total > 0;
  const label = done
    ? transfer.direction === "send"
      ? `Sent "${transfer.name}".`
      : `Received "${transfer.name}".`
    : transfer.direction === "send"
      ? `Sending "${transfer.name}" to the other player…`
      : `Receiving "${transfer.name}" from the host…`;
  return (
    <div className="flex flex-col gap-1.5" data-testid="tab-transfer">
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
      <progress
        id={id}
        value={transfer.done}
        max={Math.max(transfer.total, 1)}
        className="h-2 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary"
      />
    </div>
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
      <DialogBody className="px-6 pb-4 md:px-9">
        <TogetherContent>
          {state.problem && <Problem message={state.problem.message} />}
          <div className={cn(CARD, "flex flex-col gap-3")}>
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
              <Stat
                label="Drift"
                value={state.peer ? `${Math.round(state.peer.driftMs)} ms` : "—"}
              />
            </dl>
            <TransferLine transfer={together.transfer} />
            <p className="text-sm text-muted-foreground">
              {isHost
                ? "Press Play in the toolbar: both of you start together. Pause, Stop, speed, loop, metronome and count-in are shared. Your tracks, mute and solo stay your own."
                : "Press Play or Stop in the toolbar: the host starts both of you at the same moment. The speed, loop, metronome and count-in follow the host. Your tracks, mute and solo stay your own."}
            </p>
          </div>
          <div className={cn(CARD, "flex flex-col gap-2")}>
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
              {together.quality === "auto" && ` Now using ${QUALITY_LABELS[state.preset]}.`} The
              sound is always made on your own computer.
            </p>
          </div>
        </TogetherContent>
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
