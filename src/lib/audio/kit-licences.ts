import type { KitLicenceKind } from "@/lib/tauri";

/** How each licence of an imported drum kit is named (#40). */
export const LICENCE_LABELS: Record<KitLicenceKind, string> = {
  cc0: "CC0 (no rights reserved)",
  "public-domain": "Public domain",
  "cc-by": "CC BY (credit the author)",
  "cc-by-sa": "CC BY-SA (credit, share alike)",
  "other-commercial": "Another licence that allows commercial use",
  unknown: "Unknown",
};
