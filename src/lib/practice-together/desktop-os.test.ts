import { describe, expect, it } from "vitest";

import { detectDesktopOs } from "@/lib/practice-together/desktop-os";

describe("detectDesktopOs", () => {
  it.each([
    [{ platform: "MacIntel" }, "macos"],
    [{ platform: "Win32" }, "windows"],
    [{ platform: "Linux x86_64" }, "linux"],
    [{ userAgentData: { platform: "macOS" }, platform: "" }, "macos"],
    [{ userAgentData: { platform: "Windows" } }, "windows"],
    [{ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605" }, "linux"],
    [{ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" }, "macos"],
    [{ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, "windows"],
  ] as const)("reads %j as %s", (nav, expected) => {
    expect(detectDesktopOs(nav)).toBe(expected);
  });

  it("does not guess for phones, tablets, Chromebooks or nothing at all", () => {
    expect(detectDesktopOs({ platform: "iPhone", userAgent: "Mac OS X like iPhone" })).toBe(
      "unknown",
    );
    expect(detectDesktopOs({ userAgent: "Mozilla/5.0 (Linux; Android 14)" })).toBe("unknown");
    expect(detectDesktopOs({ userAgent: "Mozilla/5.0 (X11; CrOS x86_64)" })).toBe("unknown");
    expect(detectDesktopOs({})).toBe("unknown");
    expect(detectDesktopOs({ platform: "SomethingElse" })).toBe("unknown");
  });
});
