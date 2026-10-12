import { screen } from "@testing-library/react";

import { AppFooter } from "@/components/app-footer";
import { expectNoA11yViolations } from "@/test/axe";
import { renderWithProviders } from "@/test/render";

import pkg from "../../package.json";

describe("AppFooter", () => {
  it("shows the app's real version from package.json, not a preview label", async () => {
    renderWithProviders(<AppFooter />);

    expect(screen.getByRole("contentinfo")).toHaveTextContent(`Version ${pkg.version}`);
    expect(screen.queryByText(/early preview/i)).not.toBeInTheDocument();
    await expectNoA11yViolations();
  });
});
