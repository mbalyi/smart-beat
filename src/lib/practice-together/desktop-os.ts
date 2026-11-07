/** The desktop systems Smart Beat runs on, for the one place that shows steps per system. */
export type DesktopOs = "macos" | "windows" | "linux" | "unknown";

/** The parts of `navigator` that tell the system (a plain object in tests). */
export interface NavigatorLike {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

/**
 * Which desktop system this is. Phones and tablets, and anything not recognised, are
 * "unknown" so that the help shows the short generic tip rather than another system's steps.
 */
export function detectDesktopOs(
  nav: NavigatorLike | undefined = typeof navigator === "undefined" ? undefined : navigator,
): DesktopOs {
  if (!nav) return "unknown";
  const hint = [nav.userAgentData?.platform, nav.platform, nav.userAgent].filter(Boolean).join(" ");
  if (/iPhone|iPad|iPod|Android|CrOS/i.test(hint)) return "unknown";
  if (/Mac/i.test(hint)) return "macos";
  if (/Win/i.test(hint)) return "windows";
  if (/Linux|X11/i.test(hint)) return "linux";
  return "unknown";
}
