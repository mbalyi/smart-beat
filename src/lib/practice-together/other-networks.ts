import type { PracticeHostAddress, PracticeHostInfo } from "@/lib/tauri";

/**
 * The host's networks other than the one its main code is for (#258), in the host's order, each
 * once. Empty when the host is on one network only (or an older core sent no list).
 */
export function otherNetworks(info: PracticeHostInfo): PracticeHostAddress[] {
  const seen = new Set([info.code]);
  return (info.addresses ?? []).filter((entry) => {
    if (seen.has(entry.code)) return false;
    seen.add(entry.code);
    return true;
  });
}

/** The room-code fields for the host's other networks: none at all when there are none. */
export function othersField(info: PracticeHostInfo): { others?: PracticeHostAddress[] } {
  const others = otherNetworks(info);
  return others.length > 0 ? { others } : {};
}
