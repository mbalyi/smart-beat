import { CableIcon, CheckIcon, CopyIcon, LinkIcon, NetworkIcon, WifiIcon } from "lucide-react";
import { useId, useState, type ComponentType } from "react";

import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tip";
import type { PracticeHostAddress, PracticeNetworkKind } from "@/lib/tauri";

/** How long a row says "Copied". */
const COPIED_MS = 1500;

const KIND: Record<
  PracticeNetworkKind,
  { label: string; Icon: ComponentType<{ className?: string }> }
> = {
  wifi: { label: "Wi-Fi", Icon: WifiIcon },
  cable: { label: "Cable", Icon: CableIcon },
  "link-local": { label: "Direct link", Icon: LinkIcon },
  other: { label: "Network", Icon: NetworkIcon },
};

type Props = {
  /** The host's networks other than the main code's (#258). */
  networks: PracticeHostAddress[];
};

/**
 * The room codes for the host's other networks: a player on a cable or a direct link between two
 * laptops uses the code of that network. Shown only when there is one.
 */
export function OtherNetworks({ networks }: Props) {
  const titleId = useId();
  const [copied, setCopied] = useState<string | null>(null);
  if (networks.length === 0) return null;

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied((now) => (now === code ? null : now)), COPIED_MS);
    } catch {
      // The code is on screen to read out.
    }
  };

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2" data-testid="other-networks">
      <div className="flex flex-col gap-0.5">
        <h4 id={titleId} className="text-sm font-semibold">
          Other networks
        </h4>
        <p className="text-sm text-muted-foreground">
          This computer is on more than one network. A player on another one (a cable, say) uses
          that network&apos;s code.
        </p>
      </div>
      <ul className="flex flex-col gap-1.5">
        {networks.map((network) => {
          const { label, Icon } = KIND[network.kind] ?? KIND.other;
          const isCopied = copied === network.code;
          return (
            <li
              key={network.code}
              data-testid="other-network"
              className="flex items-center gap-2 rounded-lg border bg-background/60 px-3 py-2"
            >
              <Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-xs text-muted-foreground">
                  {label} · {network.name} · {network.address}
                </span>
                <span className="font-mono text-sm font-semibold tracking-wider break-all">
                  {network.code}
                </span>
              </div>
              <Tip label={isCopied ? "Copied" : `Copy the ${network.name} code`}>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  className="shrink-0 bg-card"
                  aria-label={
                    isCopied ? `Copied the ${network.name} code` : `Copy the ${network.name} code`
                  }
                  onClick={() => void copy(network.code)}
                >
                  {isCopied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
                </Button>
              </Tip>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
