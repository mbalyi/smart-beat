import { screen } from "@testing-library/react";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

function Example({ size }: { size?: "sm" | "xl" }) {
  return (
    <Dialog open>
      <DialogContent size={size}>
        <DialogHeader>
          <DialogTitle>Example</DialogTitle>
          <DialogDescription>A long dialog.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {Array.from({ length: 50 }, (_, i) => (
            <p key={i}>Line {i}</p>
          ))}
        </DialogBody>
        <DialogFooter>
          <button type="button">Done</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

describe("Dialog (#53)", () => {
  it("caps the height to the viewport and only lets the body scroll, vertically", async () => {
    renderWithProviders(<Example />);
    const dialog = screen.getByRole("dialog", { name: "Example" });
    expect(dialog.className).toMatch(/max-h-\[calc\(100dvh-2rem\)\]/);
    expect(dialog.className).toContain("overflow-hidden");
    expect(dialog.className).toContain("flex-col");

    const body = dialog.querySelector("[data-slot=dialog-body]")!;
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).toContain("overflow-x-hidden");
    expect(body.className).toContain("min-h-0");
    // The header and footer never shrink or scroll away.
    expect(dialog.querySelector("[data-slot=dialog-header]")!.className).toContain("shrink-0");
    expect(dialog.querySelector("[data-slot=dialog-footer]")!.className).toContain("shrink-0");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    await expectNoA11yViolations();
  });

  it("has width presets", () => {
    const { unmount } = renderWithProviders(<Example />);
    expect(screen.getByRole("dialog").className).toContain("sm:max-w-sm");
    unmount();
    renderWithProviders(<Example size="xl" />);
    expect(screen.getByRole("dialog").className).toContain("sm:max-w-3xl");
  });
});
