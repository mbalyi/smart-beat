import type { ReactNode } from "react";
import { LoaderCircleIcon } from "lucide-react";

import type { PromiseState } from "@/hooks/use-promise";

/** Renders loading / error / success states of a {@link PromiseState} accessibly. */
export function AsyncContent<T>({
  state,
  loadingLabel,
  errorMessage,
  children,
}: {
  state: PromiseState<T>;
  loadingLabel: string;
  errorMessage: (error: unknown) => ReactNode;
  children: (value: T) => ReactNode;
}) {
  if (state.status === "pending") {
    return (
      <p role="status" className="flex items-center gap-2 text-muted-foreground">
        <LoaderCircleIcon
          className="size-4 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        {loadingLabel}
      </p>
    );
  }
  if (state.status === "rejected") {
    return (
      <p role="alert" className="text-destructive">
        {errorMessage(state.error)}
      </p>
    );
  }
  return <>{children(state.value)}</>;
}
