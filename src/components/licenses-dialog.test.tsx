import { screen } from "@testing-library/react";

import { LicensesDialog } from "@/components/licenses-dialog";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";
import { mockTauri } from "@/test/tauri";

const NOTICES = "react 19.3.0 — MIT License\n\nCopyright (c) Meta Platforms, Inc.";

describe("LicensesDialog", () => {
  it("shows the bundled notices in a keyboard-scrollable region", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(NOTICES)));
    renderWithProviders(<LicensesDialog open onOpenChange={() => {}} />);

    const region = await screen.findByRole("region", { name: "License notices" });
    expect(region).toHaveTextContent("react 19.3.0 — MIT License");
    expect(region).toHaveAttribute("tabindex", "0");
    await expectNoA11yViolations();
  });

  it("explains how notices are produced when the file is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    renderWithProviders(<LicensesDialog open onOpenChange={() => {}} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("pnpm licenses:generate");
  });

  it("credits the drum kits the user imported (#40)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(NOTICES)));
    mockTauri({
      kits_list: () => [
        {
          id: "free-kit",
          name: "Free Kit",
          format: "sfz",
          licence: { kind: "cc-by", attribution: "Recorded by Jane Doe" },
          pieces: [],
          missing: [],
          sizeBytes: 1,
          warnings: [],
        },
        {
          id: "cc0-kit",
          name: "Open Kit",
          format: "sf2",
          licence: { kind: "cc0", attribution: "Somebody" },
          pieces: [],
          missing: [],
          sizeBytes: 1,
          warnings: [],
        },
      ],
    });
    renderWithProviders(<LicensesDialog open onOpenChange={() => {}} />);
    const credits = await screen.findAllByTestId("kit-credit");
    expect(credits[0]).toHaveTextContent(
      "Free Kit — CC BY (credit the author). Recorded by Jane Doe",
    );
    // CC0 asks for no credit.
    expect(credits[1]).toHaveTextContent("Open Kit — CC0 (no rights reserved)");
    expect(credits[1]).not.toHaveTextContent("Somebody");
    await expectNoA11yViolations();
  });
});
