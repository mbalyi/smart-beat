import { renderHook, waitFor } from "@testing-library/react";

import { usePromise } from "@/hooks/use-promise";

describe("usePromise", () => {
  it("starts pending and resolves to the value", async () => {
    const { result } = renderHook(() => usePromise(() => Promise.resolve(42)));

    expect(result.current).toEqual({ status: "pending" });
    await waitFor(() => expect(result.current).toEqual({ status: "fulfilled", value: 42 }));
  });

  it("captures rejections", async () => {
    const error = new Error("boom");
    const { result } = renderHook(() => usePromise(() => Promise.reject(error)));

    await waitFor(() => expect(result.current).toEqual({ status: "rejected", error }));
  });

  it("loads once per mount", async () => {
    const load = vi.fn().mockResolvedValue("ok");
    const { rerender, result } = renderHook(() => usePromise(load));

    await waitFor(() => expect(result.current.status).toBe("fulfilled"));
    rerender();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("ignores results that arrive after unmount", async () => {
    let resolve!: (value: string) => void;
    const { result, unmount } = renderHook(() =>
      usePromise(() => new Promise<string>((r) => (resolve = r))),
    );

    unmount();
    resolve("late");
    await Promise.resolve();

    expect(result.current).toEqual({ status: "pending" });
  });
});
