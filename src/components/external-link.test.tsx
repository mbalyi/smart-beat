import { screen, waitFor } from "@testing-library/react";

import { ExternalLink } from "@/components/external-link";
import { Toaster } from "@/components/ui/sonner";
import { renderWithProviders } from "@/test/render";
import { mockTauri } from "@/test/tauri";

const URL = "https://alphatab.net/";

describe("ExternalLink", () => {
  it("is an ordinary link in a new tab in a browser", async () => {
    const { user } = renderWithProviders(<ExternalLink href={URL}>alphaTab</ExternalLink>);
    const link = screen.getByRole("link", { name: "alphaTab" });

    expect(link).toHaveAttribute("href", URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    // Nothing is intercepted: the browser follows the link itself.
    let prevented: boolean | undefined;
    document.addEventListener("click", (event) => (prevented = event.defaultPrevented), {
      once: true,
    });
    await user.click(link);
    expect(prevented).toBe(false);
  });

  it("opens the page in the system browser in the desktop app, not in the app's window", async () => {
    const calls = mockTauri();
    const { user } = renderWithProviders(<ExternalLink href={URL}>alphaTab</ExternalLink>);
    let followed = true;
    document.addEventListener("click", (event) => (followed = !event.defaultPrevented), {
      once: true,
    });

    await user.click(screen.getByRole("link", { name: "alphaTab" }));

    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({
          cmd: "plugin:opener|open_url",
          args: expect.objectContaining({ url: URL }),
        }),
      ),
    );
    expect(followed).toBe(false);
  });

  it("says so when the page could not be opened", async () => {
    mockTauri({
      "plugin:opener|open_url": () => {
        throw "Not allowed to open this URL.";
      },
    });
    const { user } = renderWithProviders(
      <>
        <ExternalLink href={URL}>alphaTab</ExternalLink>
        <Toaster />
      </>,
    );

    await user.click(screen.getByRole("link", { name: "alphaTab" }));

    expect(await screen.findByText("Couldn't open the link")).toBeInTheDocument();
    expect(screen.getByText("Not allowed to open this URL.")).toBeInTheDocument();
  });
});
