import { renderHook, waitFor } from "@testing-library/react";

import { NO_SONG_MENU, useMenuState } from "@/hooks/use-menu-state";
import type { MenuState } from "@/lib/tauri";
import { backend, mockTauri } from "@/test/tauri";

const OPEN: MenuState = { ...NO_SONG_MENU, songOpen: true, undo: "Add note", loop: true };

describe("useMenuState", () => {
  it("sends the menu state to the Rust core when it changes, and resets it on close", async () => {
    const calls = mockTauri();
    const sent = () => calls.filter((c) => c.cmd === "update_menu_state");
    const { rerender, unmount } = renderHook((state: MenuState) => useMenuState(state), {
      initialProps: OPEN,
    });

    await waitFor(() => expect(backend.menuState).toEqual(OPEN));
    rerender({ ...OPEN }); // same content: not sent again
    rerender({ ...OPEN, undo: null });
    await waitFor(() => expect(backend.menuState?.undo).toBeNull());
    expect(sent()).toHaveLength(2);

    unmount();
    await waitFor(() => expect(backend.menuState).toEqual(NO_SONG_MENU));
  });

  it("does nothing outside the desktop app", () => {
    backend.menuState = null;
    const { unmount } = renderHook(() => useMenuState(OPEN));
    unmount();
    expect(backend.menuState).toBeNull();
  });

  it("logs failures instead of breaking the UI", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockTauri({
      update_menu_state: () => {
        throw { kind: "invalid-menu-state", message: "nope" };
      },
    });
    renderHook(() => useMenuState(OPEN));
    await waitFor(() => expect(warn).toHaveBeenCalled());
  });
});
