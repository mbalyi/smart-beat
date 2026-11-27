import { CheckIcon, CopyIcon, LoaderCircleIcon, RouterIcon, SquareIcon } from "lucide-react";
import { useId, useState } from "react";

import { CARD } from "@/components/practice-together/together-frame";
import { WifiQr } from "@/components/practice-together/wifi-qr";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";
import { useHostedNetwork } from "@/hooks/use-hosted-network";
import type { PracticeHostedNetwork } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** How long a copy button says "Copied". */
const COPIED_MS = 1500;

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // The value is on screen to read out.
    }
  };
  const action = copied ? `Copied the ${label.toLowerCase()}` : `Copy the ${label.toLowerCase()}`;
  return (
    <div className="flex flex-col gap-0.5" data-testid="network-value">
      <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2">
        <span className="min-w-0 rounded-lg border bg-background px-2.5 py-1.5 font-mono text-base font-bold tracking-wide break-all">
          {value}
        </span>
        <Tip label={copied ? "Copied" : `Copy the ${label.toLowerCase()}`}>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="shrink-0 bg-card"
            aria-label={action}
            onClick={() => void copy()}
          >
            {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          </Button>
        </Tip>
      </dd>
    </div>
  );
}

function RunningNetwork({
  network,
  busy,
  onStop,
}: {
  network: PracticeHostedNetwork;
  busy: boolean;
  onStop: () => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <p role="status" className="text-sm">
            Your network is on. The other players join it from their Wi-Fi list, or scan the code
            with a phone.
          </p>
          <dl className="flex flex-col gap-3">
            <CopyValue label="Network name" value={network.ssid} />
            <CopyValue label="Password" value={network.passphrase} />
          </dl>
        </div>
        <WifiQr
          text={network.wifiQr}
          label={`QR code to join the Wi-Fi network ${network.ssid}`}
          className="size-36 shrink-0 self-center rounded-lg border shadow-sm sm:self-start"
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Then go back, press Start a session and give the others the code for this network (it may be
        under Other networks).
      </p>
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="self-start bg-card"
        disabled={busy}
        onClick={onStop}
      >
        <SquareIcon data-icon="inline-start" aria-hidden="true" />
        {busy ? "Stopping…" : "Stop the network"}
      </Button>
    </>
  );
}

/**
 * "Host a network" (#258): on Windows and Linux the app makes a Wi-Fi network for the other
 * players. Shown only when this computer can; when starting fails, it says why and points to the
 * steps below, which make the network by hand.
 */
export function HostNetworkCard() {
  const { state, start, stop } = useHostedNetwork();
  const titleId = useId();
  if (state.phase === "checking" || state.phase === "unsupported") return null;

  const starting = state.phase === "starting";
  return (
    <section
      aria-labelledby={titleId}
      data-testid="host-network"
      data-phase={state.phase}
      className={cn(CARD, "flex flex-col gap-3 border-primary/50 shadow-sm shadow-primary/10")}
    >
      <div className="flex items-center gap-2">
        <RouterIcon className="size-5 text-primary" aria-hidden="true" />
        <h4 id={titleId} className="text-base font-semibold">
          Host a network
        </h4>
      </div>
      {(state.phase === "running" || state.phase === "stopping") && (
        <RunningNetwork
          network={state.network}
          busy={state.phase === "stopping"}
          onStop={() => void stop(state.network)}
        />
      )}
      {(state.phase === "idle" || starting) && (
        <p className="text-sm text-muted-foreground">
          No router? Smart Beat can make a Wi-Fi network on this computer for the other players. It
          gets a new name and password each time.
        </p>
      )}
      {state.phase === "failed" && (
        <p role="alert" className="text-sm text-destructive" data-testid="host-network-error">
          {state.message} Make the network by hand with the steps below instead.
        </p>
      )}
      {(state.phase === "idle" || starting || state.phase === "failed") && (
        <Button
          type="button"
          size="lg"
          className="self-start"
          disabled={starting}
          onClick={() => void start()}
        >
          {starting ? (
            <LoaderCircleIcon
              data-icon="inline-start"
              className="animate-spin"
              aria-hidden="true"
            />
          ) : (
            <RouterIcon data-icon="inline-start" aria-hidden="true" />
          )}
          {starting
            ? "Starting the network…"
            : state.phase === "failed"
              ? "Try again"
              : "Start a network"}
        </Button>
      )}
    </section>
  );
}
