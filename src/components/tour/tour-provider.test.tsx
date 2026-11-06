import { act, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { TourProvider } from "@/components/tour/tour-provider";
import { useTour } from "@/hooks/use-tour";
import { TOUR_STORAGE_KEY } from "@/lib/tour/tour-store";

vi.mock(import("sonner"), async (importOriginal) => ({
  ...(await importOriginal()),
  toast: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), info: vi.fn() }) as never,
}));

const wrapper = ({ children }: { children: ReactNode }) => <TourProvider>{children}</TourProvider>;

function setup() {
  const hook = renderHook(() => useTour(), { wrapper });
  act(() => {
    hook.result.current.init(true);
  });
  return hook;
}

describe("TourProvider: one-time hints", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(toast).mockClear();
  });

  it("offers Show me when the hint points at a tour", () => {
    const { result } = setup();
    act(() => result.current.hint("editing", "editing", "New to editing?"));
    expect(toast).toHaveBeenCalledTimes(1);
    const [message, options] = vi.mocked(toast).mock.calls[0]!;
    expect(message).toBe("New to editing?");
    expect(options?.action).toMatchObject({ label: "Show me" });
  });

  it("only informs when the hint has no tour (Practice together, #158)", () => {
    const { result } = setup();
    act(() => result.current.hint("practice-together", null, "The host starts and stops."));
    expect(toast).toHaveBeenCalledTimes(1);
    const [message, options] = vi.mocked(toast).mock.calls[0]!;
    expect(message).toBe("The host starts and stops.");
    expect(options?.action).toBeUndefined();
  });

  it("shows a hint once, and remembers it", () => {
    const { result } = setup();
    act(() => result.current.hint("practice-together", null, "First time."));
    act(() => result.current.hint("practice-together", null, "First time."));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(TOUR_STORAGE_KEY)!).hints).toEqual({
      "practice-together": true,
    });
  });

  it("shows it again after the tips are reset", () => {
    const { result } = setup();
    act(() => result.current.hint("practice-together", null, "First time."));
    act(() => result.current.resetHints());
    act(() => result.current.hint("practice-together", null, "First time."));
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it("renders its children", () => {
    const { getByText } = render(
      <TourProvider>
        <p>inside</p>
      </TourProvider>,
    );
    expect(getByText("inside")).toBeInTheDocument();
  });
});
