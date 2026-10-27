import { render } from "@testing-library/react";

import { CloudProviderLogo } from "@/components/cloud-provider-logos";
import type { CloudProvider } from "@/lib/cloud";

describe("CloudProviderLogo", () => {
  it.each(["drive", "dropbox", "onedrive"] as const)(
    "renders the %s logo as a hidden image",
    (provider) => {
      const { container } = render(<CloudProviderLogo provider={provider} className="h-10" />);
      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      expect(img?.getAttribute("aria-hidden")).toBe("true");
      expect(img?.getAttribute("alt")).toBe("");
      expect(img?.getAttribute("src")).toBeTruthy();
      expect(img?.getAttribute("class")).toBe("h-10");
    },
  );

  it("gives each provider its own logo", () => {
    const srcs = (["drive", "dropbox", "onedrive"] as const).map((p) =>
      render(<CloudProviderLogo provider={p} />)
        .container.querySelector("img")
        ?.getAttribute("src"),
    );
    expect(new Set(srcs).size).toBe(3);
  });

  it("renders nothing for an unknown provider", () => {
    const { container } = render(<CloudProviderLogo provider={"box" as CloudProvider} />);
    expect(container).toBeEmptyDOMElement();
  });
});
