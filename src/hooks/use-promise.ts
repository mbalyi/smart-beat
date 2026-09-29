import { useEffect, useEffectEvent, useState } from "react";

export type PromiseState<T> =
  | { status: "pending" }
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: unknown };

/**
 * Runs `load` once when the component mounts and tracks its result. Dialog
 * content mounts on open, so this re-fetches each time a dialog is shown.
 */
export function usePromise<T>(load: () => Promise<T>): PromiseState<T> {
  const [state, setState] = useState<PromiseState<T>>({ status: "pending" });
  const run = useEffectEvent(load);

  useEffect(() => {
    let active = true;
    run().then(
      (value) => {
        if (active) setState({ status: "fulfilled", value });
      },
      (error: unknown) => {
        if (active) setState({ status: "rejected", error });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return state;
}
