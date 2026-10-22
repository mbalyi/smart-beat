import { screen } from "@testing-library/react";

import { FileMenu } from "@/components/score/song-menu";
import { renderWithProviders } from "@/test/render";

const base = {
  onSave: vi.fn(),
  onSaveAs: vi.fn(),
  onExport: vi.fn(),
  onExportAudio: vi.fn(),
  onExportAll: vi.fn(),
  onPrint: vi.fn(),
};

describe("FileMenu", () => {
  it("lists Save first: Import from Audio and Record to Tab live in the AI menu", async () => {
    const { user } = renderWithProviders(<FileMenu {...base} />);
    await user.click(screen.getByRole("button", { name: /File/ }));
    expect(screen.getAllByRole("menuitem")[0]).toHaveTextContent("Save");
    expect(screen.queryByRole("menuitem", { name: /Import from Audio/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Record to Tab/ })).not.toBeInTheDocument();
  });
});
