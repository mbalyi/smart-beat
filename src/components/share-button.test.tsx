import { screen } from "@testing-library/react";

import { ShareButton } from "@/components/share-button";
import { renderWithProviders } from "@/test/render";
import { backend, mockTauri } from "@/test/tauri";
import { ShareProvider } from "@/providers/share-provider";

describe("ShareButton", () => {
  it("is not shown where sharing is not wired up", () => {
    mockTauri();
    renderWithProviders(<ShareButton target={{ kind: "cloud", item: "drive:1", name: "a.gp" }} />);
    expect(screen.queryByRole("button", { name: /Share a link/ })).not.toBeInTheDocument();
  });

  it("names the file and opens the share dialog", async () => {
    mockTauri();
    backend.cloudAccounts = [
      { provider: "drive", label: "Google Drive", account: "me@x.test", shareLevels: ["view"] },
    ];
    const { user } = renderWithProviders(
      <ShareProvider>
        <ShareButton target={{ kind: "cloud", item: "drive:1", name: "riff.gp" }} />
      </ShareProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Share a link to riff.gp" }));

    expect(
      await screen.findByRole("dialog", { name: "Who can use the link?" }),
    ).toBeInTheDocument();
  });
});
