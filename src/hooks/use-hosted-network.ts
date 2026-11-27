import { useCallback, useEffect, useState } from "react";

import {
  isCommandError,
  onPracticeNetworkStopped,
  practiceNetworkStart,
  practiceNetworkStop,
  practiceNetworkSupport,
  type PracticeHostedNetwork,
} from "@/lib/tauri";

/** Where "Host a network" stands. */
export type HostedNetworkState =
  | { phase: "checking" }
  | { phase: "unsupported"; reason: string }
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "running"; network: PracticeHostedNetwork }
  | { phase: "stopping"; network: PracticeHostedNetwork }
  | { phase: "failed"; message: string };

function messageOf(error: unknown): string {
  if (isCommandError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return "Could not make a network.";
}

/** Asks the core whether it can host a network, and starts and stops it. */
export function useHostedNetwork() {
  const [state, setState] = useState<HostedNetworkState>({ phase: "checking" });

  useEffect(() => {
    let current = true;
    practiceNetworkSupport()
      .then((support) => {
        if (!current) return;
        setState(
          support.canHost
            ? { phase: "idle" }
            : { phase: "unsupported", reason: support.reason ?? "" },
        );
      })
      .catch((error: unknown) => {
        if (current) setState({ phase: "unsupported", reason: messageOf(error) });
      });
    const unlisten = onPracticeNetworkStopped((reason) => {
      if (current) setState({ phase: "failed", message: reason });
    });
    return () => {
      current = false;
      void unlisten.then((stop) => stop());
    };
  }, []);

  const start = useCallback(async () => {
    setState({ phase: "starting" });
    try {
      setState({ phase: "running", network: await practiceNetworkStart() });
    } catch (error) {
      setState({ phase: "failed", message: messageOf(error) });
    }
  }, []);

  const stop = useCallback(async (network: PracticeHostedNetwork) => {
    setState({ phase: "stopping", network });
    try {
      await practiceNetworkStop();
      setState({ phase: "idle" });
    } catch (error) {
      setState({ phase: "failed", message: messageOf(error) });
    }
  }, []);

  return { state, start, stop };
}
