import { screen } from "@testing-library/react";

import { LicensesDialog } from "@/components/licenses-dialog";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

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
});
