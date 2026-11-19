import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLaneRecord, type LaneRecordEnv } from "@/components/audio-lanes/use-lane-record";

const lane = (id: string, over: Partial<{ folder: boolean; enabled: boolean }> = {}) => ({
  id,
  folder: false,
  enabled: true,
  ...over,
});

function setup(over: Partial<LaneRecordEnv> = {}, initial = [lane("a"), lane("b")]) {
  const env = {
    lanes: initial,
    recording: false,
    recordingLaneId: null as string | null,
    start: vi.fn(),
    stop: vi.fn(),
    discard: vi.fn(),
    setLiveInput: vi.fn(),
    engineOn: true,
    ensureEngine: vi.fn(() => true),
    inputName: "Scarlett 2i2",
    ...over,
  } satisfies LaneRecordEnv;
  const hook = renderHook((props: LaneRecordEnv) => useLaneRecord(props), { initialProps: env });
  return { ...hook, env };
}

describe("useLaneRecord", () => {
  beforeEach(() => localStorage.clear());

  it("leaves the player alone until a lane is armed, and when the song closes unarmed", () => {
    const { unmount, env } = setup();
    unmount();
    expect(env.setLiveInput).not.toHaveBeenCalled();
  });

  it("arms a lane without starting anything", () => {
    const { result, env } = setup();
    act(() => result.current.controls.toggle("a"));
    expect(result.current.controls.armedId).toBe("a");
    expect(env.start).not.toHaveBeenCalled();
  });

  it("arms one lane at a time", () => {
    const { result } = setup();
    act(() => result.current.controls.toggle("a"));
    act(() => result.current.controls.toggle("b"));
    expect(result.current.controls.armedId).toBe("b");
  });

  it("starts the take with the last choices of the dialog when the armed lane is pressed", () => {
    localStorage.setItem(
      "smart-beat:record-audio-setup",
      JSON.stringify({ mode: "punch", countIn: false, preRollBars: 2 }),
    );
    const { result, env } = setup();
    act(() => result.current.controls.toggle("a"));
    act(() => result.current.controls.toggle("a"));
    expect(env.start).toHaveBeenCalledWith({
      laneId: "a",
      mode: "punch",
      countIn: false,
      preRollBars: 2,
    });
  });

  it("stops the take when the recording lane is pressed, and ignores the other lanes", () => {
    const { result, rerender, env } = setup();
    act(() => result.current.controls.toggle("a"));
    rerender({ ...env, recording: true });
    act(() => result.current.controls.toggle("b"));
    expect(env.stop).not.toHaveBeenCalled();
    expect(result.current.controls.armedId).toBe("a");
    act(() => result.current.controls.toggle("a"));
    expect(env.stop).toHaveBeenCalledTimes(1);
  });

  it("lets the armed lane's effects be heard, and silences its clips during the take", () => {
    const { result, rerender, env } = setup();
    act(() => result.current.controls.toggle("a"));
    expect(env.setLiveInput).toHaveBeenLastCalledWith({ laneId: "a", hear: true, silence: false });
    rerender({ ...env, recording: true });
    expect(env.setLiveInput).toHaveBeenLastCalledWith({ laneId: "a", hear: true, silence: true });
  });

  it("gives the song's monitor track back when the lane is let go", () => {
    const { result, env } = setup();
    act(() => result.current.controls.toggle("a"));
    act(() => result.current.disarm());
    expect(result.current.controls.armedId).toBeNull();
    expect(env.setLiveInput).toHaveBeenLastCalledWith(null);
  });

  it("lets go of a lane that is deleted, switched off or turned into a folder", () => {
    const { result, rerender, env } = setup();
    act(() => result.current.controls.toggle("a"));
    rerender({ ...env, lanes: [lane("a", { enabled: false }), lane("b")] });
    expect(result.current.controls.armedId).toBeNull();
    expect(env.setLiveInput).toHaveBeenLastCalledWith(null);
  });

  it("hears the input of an audio interface by default, and not the computer's own microphone", () => {
    expect(setup().result.current.hear).toBe(true);
    expect(setup({ inputName: "MacBook Pro Microphone" }).result.current.hear).toBe(false);
  });

  it("remembers the Hear myself choice and needs no engine switch when it is off", () => {
    const { result, env } = setup({ engineOn: false });
    act(() => result.current.setHear(false));
    expect(localStorage.getItem("smart-beat:record-hear-myself")).toBe("0");
    act(() => result.current.controls.toggle("a"));
    expect(env.ensureEngine).not.toHaveBeenCalled();
    expect(env.setLiveInput).toHaveBeenLastCalledWith({ laneId: "a", hear: false, silence: false });
  });

  it("asks for the native engine when the input should be heard, and does not claim to hear it", () => {
    const { result, env } = setup({ engineOn: false });
    act(() => result.current.controls.toggle("a"));
    expect(env.ensureEngine).toHaveBeenCalled();
    expect(env.setLiveInput).toHaveBeenLastCalledWith({ laneId: "a", hear: false, silence: false });
  });

  describe("a take started from the Record audio dialog on a lane that is not armed (#249 review)", () => {
    it("keeps that lane's clips quiet during the take and gives them back after Stop or Escape", () => {
      const { result, rerender, env } = setup();
      // The dialog starts the take: the lane is quieted before the song starts...
      act(() => result.current.beforeTake("a"));
      expect(env.setLiveInput).toHaveBeenLastCalledWith({
        laneId: "a",
        hear: false,
        silence: true,
      });
      rerender({ ...env, recording: true, recordingLaneId: "a" });
      expect(env.setLiveInput).toHaveBeenLastCalledWith({
        laneId: "a",
        hear: false,
        silence: true,
      });
      // ...and the take ends (kept or thrown away): nothing is left on the player.
      rerender({ ...env, recording: false, recordingLaneId: null });
      expect(env.setLiveInput).toHaveBeenLastCalledWith(null);
      expect(result.current.armedId).toBeNull();
    });

    it("does not hear the input through the lane's effects when the lane is not armed", () => {
      const { rerender, env } = setup();
      rerender({ ...env, recording: true, recordingLaneId: "b" });
      expect(env.setLiveInput).toHaveBeenLastCalledWith({
        laneId: "b",
        hear: false,
        silence: true,
      });
    });

    it("goes back to the armed lane when the take was on another lane", () => {
      const { result, rerender, env } = setup();
      act(() => result.current.controls.toggle("a"));
      rerender({ ...env, recording: true, recordingLaneId: "b" });
      expect(env.setLiveInput).toHaveBeenLastCalledWith({
        laneId: "b",
        hear: false,
        silence: true,
      });
      rerender({ ...env, recording: false, recordingLaneId: null });
      expect(env.setLiveInput).toHaveBeenLastCalledWith({
        laneId: "a",
        hear: true,
        silence: false,
      });
    });

    it("sends nothing for a take on a new lane", () => {
      const { result, env } = setup();
      act(() => result.current.beforeTake(null));
      expect(env.setLiveInput).not.toHaveBeenCalled();
    });
  });

  describe("keys during a take", () => {
    const press = (key: string) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      window.dispatchEvent(event);
      return event;
    };

    it("Escape throws the take away and Space keeps it", () => {
      const { env, rerender } = setup();
      rerender({ ...env, recording: true });
      expect(press("Escape").defaultPrevented).toBe(true);
      expect(env.discard).toHaveBeenCalledTimes(1);
      expect(env.stop).not.toHaveBeenCalled();
      press(" ");
      expect(env.stop).toHaveBeenCalledTimes(1);
    });

    it("leaves the keys alone when nothing is recording", () => {
      const { env } = setup();
      expect(press("Escape").defaultPrevented).toBe(false);
      expect(env.discard).not.toHaveBeenCalled();
    });
  });
});
