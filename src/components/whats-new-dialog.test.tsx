import { screen } from "@testing-library/react";

import { FEATURES } from "@/components/welcome-features";
import { WhatsNewDialog } from "@/components/whats-new-dialog";
import { whatsNewImage } from "@/components/whats-new-images";
import { FEATURE_REGISTRY, type FeatureEntry } from "@/lib/tour/feature-registry";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

const features: FeatureEntry[] = [
  { id: "a", title: "Alpha feature", summary: "Does alpha.", since: "1.1.0", tour: "editing" },
  { id: "b", title: "Beta feature", summary: "Does beta.", since: "1.1.0" },
];

function renderDialog() {
  const onOpenChange = vi.fn();
  const onShowMe = vi.fn();
  const utils = renderWithProviders(
    <WhatsNewDialog
      open
      onOpenChange={onOpenChange}
      version="1.1.0"
      features={features}
      onShowMe={onShowMe}
    />,
  );
  return { ...utils, onOpenChange, onShowMe };
}

describe("WhatsNewDialog", () => {
  it("lists the features under the version", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "What’s new in 1.1.0" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Alpha feature" })).toBeInTheDocument();
    expect(screen.getByText("Does beta.")).toBeInTheDocument();
  });

  it("offers Show me only for features with a tour", () => {
    renderDialog();
    expect(screen.getAllByRole("button", { name: /^Show me/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Show me: Alpha feature" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show me: Beta feature" })).not.toBeInTheDocument();
  });

  it("closes and starts the tour on Show me", async () => {
    const { user, onOpenChange, onShowMe } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Show me: Alpha feature" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onShowMe).toHaveBeenCalledExactlyOnceWith("editing");
  });

  it("cycles three decorative icons over the cards", () => {
    const many: FeatureEntry[] = ["a", "b", "c", "d"].map((id) => ({
      id,
      title: `Feature ${id}`,
      summary: "Does it.",
      since: "1.1.0",
    }));
    renderWithProviders(
      <WhatsNewDialog
        open
        onOpenChange={vi.fn()}
        version="1.1.0"
        features={many}
        onShowMe={vi.fn()}
      />,
    );
    const cards = screen.getAllByTestId("whats-new-card");
    const srcs = cards.map((card) => card.querySelector("img")!.getAttribute("src"));
    expect(new Set(srcs).size).toBe(3);
    expect(srcs[3]).toBe(srcs[0]);
    for (const card of cards) {
      expect(card.querySelector("img")).toHaveAttribute("aria-hidden", "true");
    }
  });

  describe("pictures", () => {
    const homeImage = (title: string) => FEATURES.find((f) => f.title === title)!.image;

    it("gives every feature of the registry a picture, never a generic icon", () => {
      for (const entry of FEATURE_REGISTRY) {
        expect(whatsNewImage(entry.id), entry.id).toBeTruthy();
      }
    });

    it("shows the start page card's artwork for a feature without a picture of its own", () => {
      expect(whatsNewImage("audio-lanes")).toBe(homeImage("Audio tracks & editing"));
      expect(whatsNewImage("hybrid-lanes")).toBe(homeImage("Audio tracks & editing"));
      expect(whatsNewImage("practice-together-lanes")).toBe(homeImage("Practice together"));
      expect(whatsNewImage("practice-together-editing")).toBe(homeImage("Practice together"));
      for (const id of ["edit-palette", "insert-rest", "repeat-count", "smoother-editing"]) {
        expect(whatsNewImage(id), id).toBe(homeImage("Write tabs and scores"));
      }
      expect(whatsNewImage("stacked-tracks-any")).toBe(homeImage("Open, play and practice"));
    });

    it("uses the Export stems logo for the stem export", () => {
      expect(whatsNewImage("stem-export")).toBeTruthy();
      expect(whatsNewImage("stem-export")).not.toBe(homeImage("Stem separation"));
    });

    it("puts those pictures on the cards of 1.3", () => {
      const release = FEATURE_REGISTRY.filter((f) => f.since === "1.3.0");
      renderWithProviders(
        <WhatsNewDialog
          open
          onOpenChange={vi.fn()}
          version="1.3.0"
          features={release}
          onShowMe={vi.fn()}
        />,
      );
      const cards = screen.getAllByTestId("whats-new-card");
      expect(cards).toHaveLength(release.length);
      for (const [index, entry] of release.entries()) {
        const img = cards[index]!.querySelector("img")!;
        expect(img.getAttribute("src"), entry.id).toBe(whatsNewImage(entry.id));
        expect(img).toHaveAttribute("aria-hidden", "true");
        expect(img).toHaveAttribute("alt", "");
      }
    });
  });

  it("lays the cards out in one, two or three columns by width", () => {
    renderDialog();
    expect(screen.getByRole("list", { name: "New features" })).toHaveClass(
      "grid-cols-1",
      "sm:grid-cols-2",
      "lg:grid-cols-3",
    );
  });

  it("has no accessibility violations", async () => {
    renderDialog();
    await expectNoA11yViolations();
  });
});
