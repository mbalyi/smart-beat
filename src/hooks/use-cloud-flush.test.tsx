import { act, screen, waitFor } from "@testing-library/react";

import { Toaster } from "@/components/ui/sonner";
import { useCloudFlush } from "@/hooks/use-cloud-flush";
import { renderWithProviders } from "@/test/render";
import { mockTauri } from "@/test/tauri";

function Probe() {
  useCloudFlush();
  return <Toaster />;
}

describe("useCloudFlush", () => {
  it("flushes at the start and on focus, and reports the outcomes", async () => {
    let round = 0;
    const calls = mockTauri({
      cloud_flush: () =>
        round++ === 0
          ? [{ name: "riff.gp", outcome: "uploaded" }]
          : [
              { name: "solo.gp", outcome: "conflict" },
              { name: "wait.gp", outcome: "waiting" },
            ],
    });
    renderWithProviders(<Probe />);

    expect(await screen.findByText("“riff.gp” uploaded")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByText("“solo.gp” changed online")).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.cmd === "cloud_flush")).toHaveLength(2));
    expect(screen.queryByText(/wait\.gp/)).not.toBeInTheDocument();
  });
});
