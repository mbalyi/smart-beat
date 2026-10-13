import { defaultEffect } from "@/lib/audio/effects";
import {
  DEFAULT_MONITOR,
  describeLatency,
  MONITOR_STORAGE_KEY,
  monitorParams,
  newMonitorTrack,
  rememberMonitorTrack,
} from "@/lib/audio/monitor";

describe("a new monitor track", () => {
  it("starts from the defaults the first time", () => {
    expect(newMonitorTrack()).toEqual(DEFAULT_MONITOR);
  });

  it("starts from the last one used, switched on, not muted and not soloed", () => {
    const eq = { lowDb: 3, midDb: 0, midHz: 800, highDb: -2 };
    rememberMonitorTrack({
      ...DEFAULT_MONITOR,
      enabled: false,
      mute: true,
      solo: true,
      volume: 0.5,
      pan: 0.25,
      eq,
      effects: [defaultEffect("gate")],
    });
    expect(newMonitorTrack()).toEqual({
      ...DEFAULT_MONITOR,
      volume: 0.5,
      pan: 0.25,
      eq,
      effects: [defaultEffect("gate")],
    });
  });

  it("is a copy: changing it does not change the next one", () => {
    const first = newMonitorTrack();
    first.eq.lowDb = 9;
    expect(newMonitorTrack().eq.lowDb).toBe(0);
  });

  it.each(["{", "null", '"x"', '{"volume":"loud","pan":7}'])(
    "ignores damaged storage (%j)",
    (raw) => {
      localStorage.setItem(MONITOR_STORAGE_KEY, raw);
      const monitor = newMonitorTrack();
      expect(monitor.enabled).toBe(true);
      expect(monitor.volume).toBeGreaterThanOrEqual(0);
      expect(monitor.volume).toBeLessThanOrEqual(1);
      expect(Math.abs(monitor.pan)).toBeLessThanOrEqual(1);
    },
  );
});

describe("monitorParams", () => {
  it("leaves the effects out", () => {
    expect(monitorParams({ ...DEFAULT_MONITOR, effects: [defaultEffect("gate")] })).toEqual({
      enabled: true,
      volume: 0.8,
      pan: 0,
      mute: false,
      solo: false,
      eq: DEFAULT_MONITOR.eq,
    });
  });
});

describe("describeLatency", () => {
  it.each([
    [0.4, "< 1 ms"],
    [8.6, "9 ms"],
  ])("%d ms is %j", (ms, text) => expect(describeLatency(ms)).toBe(text));
});
