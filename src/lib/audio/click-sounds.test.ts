import { clickBuffer, clickSample, clickSeconds } from "@/lib/audio/click-sounds";
import { CLICK_SOUNDS } from "@/lib/score/practice";

const RATE = 48_000;
const render = (id: (typeof CLICK_SOUNDS)[number]["id"], accent: boolean, count = 2000) =>
  Array.from({ length: count }, (_, i) => clickSample(id, accent, i / RATE));

describe("click sounds (#182)", () => {
  it.each(CLICK_SOUNDS.map((s) => s.id))("%s is audible, bounded and ends", (id) => {
    for (const accent of [true, false]) {
      const n = Math.ceil(clickSeconds(id) * RATE);
      const samples = Array.from({ length: n + 100 }, (_, i) => clickSample(id, accent, i / RATE));
      const peak = Math.max(...samples.map(Math.abs));
      expect(peak).toBeGreaterThan(0.05);
      expect(peak).toBeLessThanOrEqual(1);
      expect(samples.slice(n).every((v) => Math.abs(v) < 1e-3)).toBe(true);
    }
    expect(render(id, true)).not.toEqual(render(id, false)); // the first beat is accented
  });

  it("sounds different for every sound", () => {
    const all = CLICK_SOUNDS.map((s) => JSON.stringify(render(s.id, false)));
    expect(new Set(all).size).toBe(CLICK_SOUNDS.length);
  });

  it("fills an audio buffer as long as the click", () => {
    const channel = new Float32Array(Math.ceil(clickSeconds("bell") * RATE));
    const ctx = {
      sampleRate: RATE,
      createBuffer: (_c: number, length: number) => ({
        getChannelData: () => channel.subarray(0, length),
      }),
    };
    clickBuffer(ctx as never, "bell", true);
    expect(Math.max(...channel.map(Math.abs))).toBeGreaterThan(0.05);
  });
});
