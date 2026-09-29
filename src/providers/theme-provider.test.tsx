import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useTheme } from "@/hooks/use-theme";
import { THEME_STORAGE_KEY, ThemeProvider } from "@/providers/theme-provider";
import { installMatchMedia, setSystemDark } from "@/test/match-media";
import { mockTauri } from "@/test/tauri";

function ThemeProbe() {
  const { theme, resolvedTheme, setTheme, toggleTheme } = useTheme();
  return (
    <div>
      <p>theme: {theme}</p>
      <p>resolved: {resolvedTheme}</p>
      <button onClick={() => setTheme("dark")}>dark</button>
      <button onClick={() => setTheme("system")}>system</button>
      <button onClick={toggleTheme}>toggle</button>
    </div>
  );
}

const root = () => document.documentElement;

function renderProbe() {
  return {
    user: userEvent.setup(),
    ...render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    ),
  };
}

describe("ThemeProvider", () => {
  it("follows the OS setting by default", () => {
    installMatchMedia({ dark: true });
    renderProbe();

    expect(screen.getByText("theme: system")).toBeInTheDocument();
    expect(screen.getByText("resolved: dark")).toBeInTheDocument();
    expect(root()).toHaveClass("dark");
    expect(root().style.colorScheme).toBe("dark");
  });

  it("reacts when the OS appearance changes", () => {
    renderProbe();
    expect(root()).not.toHaveClass("dark");

    act(() => setSystemDark(true));

    expect(screen.getByText("resolved: dark")).toBeInTheDocument();
    expect(root()).toHaveClass("dark");
  });

  it("persists an explicit choice", async () => {
    const { user } = renderProbe();

    await user.click(screen.getByRole("button", { name: "dark" }));

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(root()).toHaveClass("dark");
  });

  it("restores a stored choice and ignores invalid values", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const { unmount } = renderProbe();
    expect(screen.getByText("theme: dark")).toBeInTheDocument();
    unmount();

    localStorage.setItem(THEME_STORAGE_KEY, "purple");
    renderProbe();
    expect(screen.getByText("theme: system")).toBeInTheDocument();
  });

  it("toggles between light and dark", async () => {
    const { user } = renderProbe();

    await user.click(screen.getByRole("button", { name: "toggle" }));
    expect(screen.getByText("resolved: dark")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "toggle" }));
    expect(screen.getByText("resolved: light")).toBeInTheDocument();
  });

  it("still works when storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { user } = renderProbe();

    await user.click(screen.getByRole("button", { name: "dark" }));

    expect(screen.getByText("theme: dark")).toBeInTheDocument();
  });

  it("keeps the native title bar in sync", async () => {
    const calls = mockTauri();
    const { user } = renderProbe();

    await user.click(screen.getByRole("button", { name: "dark" }));
    await user.click(screen.getByRole("button", { name: "system" }));

    const values = calls
      .filter((c) => c.cmd === "plugin:window|set_theme")
      .map((c) => (c.args as { value: unknown }).value);
    expect(values).toEqual([null, "dark", null]);
  });

  it("logs instead of crashing when the native theme cannot be set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockTauri({
      "plugin:window|set_theme": () => {
        throw new Error("not allowed");
      },
    });

    renderProbe();

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.getByText("theme: system")).toBeInTheDocument();
  });
});

describe("useTheme", () => {
  it("requires a ThemeProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useTheme())).toThrow(/within <ThemeProvider>/);
  });
});
