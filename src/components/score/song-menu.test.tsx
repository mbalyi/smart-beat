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

describe("FileMenu: Record to Tab (#108)", () => {
  it("lists Record to Tab… next to Import from Audio…", async () => {
    const onRecordToTab = vi.fn();
    const { user } = renderWithProviders(
      <FileMenu {...base} onImportAudio={vi.fn()} onRecordToTab={onRecordToTab} />,
    );
    await user.click(screen.getByRole("button", { name: /File/ }));
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items.slice(0, 2)).toEqual(["Import from Audio…", "Record to Tab…Beta"]);
    await user.click(screen.getByRole("menuitem", { name: /^Record to Tab…/ }));
    expect(onRecordToTab).toHaveBeenCalledTimes(1);
  });

  it("leaves it out while the feature is off", async () => {
    const { user } = renderWithProviders(<FileMenu {...base} />);
    await user.click(screen.getByRole("button", { name: /File/ }));
    expect(screen.queryByRole("menuitem", { name: /^Record to Tab…/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")[0]).toHaveTextContent("Save");
  });
});
