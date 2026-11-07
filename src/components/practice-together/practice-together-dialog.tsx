import {
  BanIcon,
  CheckIcon,
  CopyIcon,
  GlobeIcon,
  LogOutIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  UserCheckIcon,
  UserXIcon,
  UsersIcon,
  WifiIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";

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
import { Tip } from "@/components/ui/tip";
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
import { MAX_PLAYERS } from "@/lib/practice-together/protocol";
import {
  QUALITY_CHOICES,
  QUALITY_HINTS,
  QUALITY_LABELS,
  type QualityChoice,
} from "@/lib/practice-together/quality-presets";
import type { PeerInfo } from "@/lib/practice-together/session";

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
          {together.lastSession && <RejoinRow together={together} />}
          {together.elsewhere && <ElsewhereCard together={together} />}
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
                ? "You host: up to nine other players get this tab from you if they do not have it yet, and you start and stop for all of you."
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
                ? "All the computers on the same Wi-Fi or cable. The best choice: it is the steadiest and nothing leaves your network."
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
                <h3 className="text-base font-semibold">Give this code to the other players</h3>
                <div className="flex items-center gap-2" data-testid="room-code-row">
                  <output
                    data-testid="room-code"
                    className="min-w-0 rounded-lg border bg-background px-3 py-2 font-mono text-lg font-bold tracking-wider break-all sm:text-xl"
                  >
                    {code}
                  </output>
                  <Tip label={copied ? "Copied" : "Copy the code"}>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="shrink-0"
                      aria-label={copied ? "Copied" : "Copy"}
                      data-testid="copy-code"
                      onClick={() => void copy()}
                    >
                      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
                    </Button>
                  </Tip>
                </div>
                {together.hostCode?.address && (
                  <p className="text-sm text-muted-foreground">
                    Listening on {together.hostCode.address}. If the other computer cannot connect,
                    check that a firewall is not blocking Smart Beat.
                  </p>
                )}
                {state.phase === "waiting" && (
                  <p role="status" className="text-sm">
                    Waiting for the other players… Up to {MAX_PLAYERS - 1} can join, one by one.
                  </p>
                )}
                <ApprovalCard together={together} />
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

/** A player asks the host to let it in (the host sees them one at a time). */
/**
 * Moves the keyboard focus to `ref` when an inline question appears, and back to where it was when
 * the question goes away (a keyboard user is not left tabbing past the rows to reach it).
 */
function useQuestionFocus(ref: RefObject<HTMLButtonElement | null>) {
  useEffect(() => {
    const before = document.activeElement;
    ref.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, [ref]);
}

function ApprovalCard({ together }: { together: PracticeTogether }) {
  const first = useRef<HTMLButtonElement>(null);
  useQuestionFocus(first);
  if (!together.approval) return null;
  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label="Let this player in?"
      className="flex flex-col gap-3 rounded-lg border border-primary/60 p-3"
    >
      <p className="text-sm">
        <span className="font-semibold">{together.approval.name}</span> wants to join.
        {together.approvalsWaiting > 0 &&
          ` ${together.approvalsWaiting} more ${together.approvalsWaiting === 1 ? "is" : "are"} waiting.`}
      </p>
      <div className="flex gap-2">
        <Button ref={first} type="button" size="sm" onClick={() => together.approval?.answer(true)}>
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
  );
}

/**
 * A session is running in another tab of this app. The host can bring this tab into it (everybody
 * follows to it, and they still play one tab at a time); a guest follows the host without asking.
 */
function ElsewhereCard({ together }: { together: PracticeTogether }) {
  const elsewhere = together.elsewhere!;
  const tabs = `${elsewhere.tabs} ${elsewhere.tabs === 1 ? "tab" : "tabs"}`;
  const [adding, setAdding] = useState(false);
  if (elsewhere.role === "guest") {
    return (
      <div className={cn(CARD, "flex flex-col gap-1.5")} data-testid="live-elsewhere">
        <p className="text-sm font-semibold">You are in a session in another tab</p>
        <p className="text-sm text-muted-foreground">
          {tabs} in it. The host's tab comes to you; joining or starting a session here ends it.
        </p>
      </div>
    );
  }
  return (
    <div className={cn(CARD, "flex flex-col gap-3")} data-testid="live-elsewhere">
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-semibold">A session is running in another tab</p>
        <p className="text-sm text-muted-foreground">
          {tabs} in it. Add this tab and everybody follows to it when you show it; you play one tab
          at a time, as usual. Starting a new session below ends the running one.
        </p>
      </div>
      <div>
        <Button
          type="button"
          size="lg"
          disabled={adding}
          onClick={() => {
            setAdding(true);
            void Promise.resolve(together.addToSession?.()).finally(() => setAdding(false));
          }}
        >
          <PlusIcon aria-hidden="true" />
          {adding ? "Adding…" : "Add this tab to the session"}
        </Button>
      </div>
    </div>
  );
}

/** A guest that dropped out (or was removed) can try the session it was in again. */
function RejoinRow({ together }: { together: PracticeTogether }) {
  const last = together.lastSession!;
  return (
    <div
      className={cn(CARD, "flex flex-wrap items-center justify-between gap-3")}
      data-testid="rejoin"
    >
      <p className="min-w-0 flex-1 text-sm">
        {last.host ? `You were in ${last.host}'s session.` : "You were in a session."} Something
        went wrong? Join it again.
      </p>
      <Button
        type="button"
        size="sm"
        disabled={together.starting}
        onClick={() => void together.rejoin()}
      >
        <RotateCcwIcon data-icon="inline-start" />
        Rejoin
      </Button>
    </div>
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
  const [confirm, setConfirm] = useState<{ peer: PeerInfo; how: "kick" | "ban" } | null>(null);
  const peers = isHost ? (state.peers ?? []) : [];
  return (
    <>
      <DialogBody className="px-6 pb-4 md:px-9">
        <TogetherContent>
          {state.problem && <Problem message={state.problem.message} />}
          {isHost && <ApprovalCard together={together} />}
          <div className={cn(CARD, "flex flex-col gap-3")}>
            <h3 className="text-base font-semibold">
              In the session
              {isHost && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {peers.length + 1} of {MAX_PLAYERS} players
                </span>
              )}
            </h3>
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
              {isHost ? (
                peers.map((peer) => (
                  <GuestRow
                    key={peer.id}
                    peer={peer}
                    onKick={() => setConfirm({ peer, how: "kick" })}
                    onBan={() => setConfirm({ peer, how: "ban" })}
                  />
                ))
              ) : (
                <li className="flex items-center justify-between gap-3" data-testid="peer-other">
                  <span>{state.peerName ?? "Other player"}</span>
                  <span className="text-sm text-muted-foreground">Session clock</span>
                </li>
              )}
            </ul>
            {confirm && (
              <ConfirmRemoval
                peer={confirm.peer}
                how={confirm.how}
                onCancel={() => setConfirm(null)}
                onConfirm={() => {
                  if (confirm.how === "kick") together.kick(confirm.peer.id);
                  else together.ban(confirm.peer.id);
                  setConfirm(null);
                }}
              />
            )}
            {isHost && state.listening === false && (
              <p className="text-sm text-muted-foreground">
                New players can no longer join. The players already in stay connected.
              </p>
            )}
            {isHost && peers.length === 0 && (
              <p role="status" className="text-sm">
                Everyone has left. The code still works: {together.hostCode?.code}
              </p>
            )}
            <dl className="grid grid-cols-3 gap-2 text-sm">
              <Stat
                label={peers.length > 1 ? "Slowest round trip" : "Round trip"}
                value={`${Math.round(state.latency.p50)} ms`}
              />
              <Stat label="Starts ahead by" value={`${state.leadMs} ms`} />
              <Stat
                label="Drift"
                value={state.peer ? `${Math.round(state.peer.driftMs)} ms` : "—"}
              />
            </dl>
            <TransferLine transfer={together.transfer} />
            {(together.tabsInSession ?? 0) > 1 && (
              <p className="text-sm text-muted-foreground" data-testid="tabs-in-session">
                {together.tabsInSession} tabs are in this session: the one you show is the one that
                plays.
              </p>
            )}
            {isHost && peers.length > 0 && (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={together.syncTab}
                  disabled={!!together.transfer && together.transfer.done < together.transfer.total}
                >
                  <RefreshCwIcon aria-hidden="true" />
                  Sync tab
                </Button>
                <span className="text-sm text-muted-foreground">
                  Sends your tab to everyone again.
                </span>
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              {isHost
                ? "Press Play in the toolbar: all of you start together. Pause, Stop, speed, loop, metronome and count-in are shared. Your tracks, mute and solo stay your own."
                : "Press Play or Stop in the toolbar: the host starts everyone at the same moment. The speed, loop, metronome and count-in follow the host. Your tracks, mute and solo stay your own."}
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

const PHASE_TEXT: Partial<Record<PeerInfo["phase"], string>> = {
  approving: "Waiting to be let in",
  syncing: "Matching the clocks…",
  reconnecting: "Connection lost: can rejoin",
};

/** One guest of the host: who, how well in sync, and the buttons to remove it. */
function GuestRow({
  peer,
  onKick,
  onBan,
}: {
  peer: PeerInfo;
  onKick: () => void;
  onBan: () => void;
}) {
  const error = peer.peer?.errorMs;
  const synced = peer.phase === "synchronized" && error !== undefined;
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
      data-testid="peer-other"
      data-peer={peer.id}
      data-phase={peer.phase}
    >
      <span className="min-w-0 break-words">{peer.name}</span>
      <span className="flex items-center gap-2">
        {synced ? (
          <SyncQualityBadge
            quality={{
              errorMs: error,
              bucket: error <= 5 ? "excellent" : error <= 15 ? "good" : "unstable",
            }}
          />
        ) : (
          <span className="text-sm text-muted-foreground">
            {PHASE_TEXT[peer.phase] ?? "Matching the clocks…"}
          </span>
        )}
        <Tip label={`Kick ${peer.name}`}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Kick ${peer.name}`}
            onClick={onKick}
          >
            <UserXIcon aria-hidden="true" />
          </Button>
        </Tip>
        <Tip label={`Ban ${peer.name}`}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Ban ${peer.name}`}
            onClick={onBan}
          >
            <BanIcon aria-hidden="true" />
          </Button>
        </Tip>
      </span>
    </li>
  );
}

/** Asks the host to confirm a kick or a ban before it happens. */
function ConfirmRemoval({
  peer,
  how,
  onCancel,
  onConfirm,
}: {
  peer: PeerInfo;
  how: "kick" | "ban";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useQuestionFocus(cancel);
  return (
    <div
      role="alertdialog"
      aria-label={how === "kick" ? `Kick ${peer.name}?` : `Ban ${peer.name}?`}
      className="flex flex-col gap-3 rounded-lg border border-destructive/50 p-3"
    >
      <p className="text-sm">
        {how === "kick" ? (
          <>
            Remove <span className="font-semibold">{peer.name}</span> from the session? They can
            join again with the code.
          </>
        ) : (
          <>
            Ban <span className="font-semibold">{peer.name}</span> from this session? They cannot
            join again, even with the code. Starting a new session lets them in again.
          </>
        )}
      </p>
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="destructive" onClick={onConfirm}>
          {how === "kick" ? `Kick ${peer.name}` : `Ban ${peer.name}`}
        </Button>
        <Button ref={cancel} type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
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
