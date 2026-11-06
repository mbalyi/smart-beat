import { createContext, useContext } from "react";

import type { ShareTarget } from "@/lib/cloud-share";

/** Starts sharing a file (#201); `null` outside the provider, where there is nothing to share to. */
export type OpenShare = (target: ShareTarget) => void;

export const ShareContext = createContext<OpenShare | null>(null);

/** The way to share a file with a link, or `null` where sharing is not wired up (a share icon then stays hidden). */
export function useShare(): OpenShare | null {
  return useContext(ShareContext);
}
