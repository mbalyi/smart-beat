import {
  anySoloed,
  gainOf,
  gainsOf,
  initMixer,
  isSoloedOut,
  mixerReducer,
  type StemMixer,
} from "@/lib/stems/mixer";

const fresh = (): StemMixer => initMixer(["drums", "bass", "vocals", "other"]);
const find = (mixer: StemMixer, kind: string) => mixer.find((channel) => channel.kind === kind)!;

describe("the stem mixer", () => {
  it("starts with every stem at full volume, heard", () => {
    const mixer = fresh();
    expect(mixer.map((c) => c.kind)).toEqual(["drums", "bass", "vocals", "other"]);
    expect(gainsOf(mixer)).toEqual({ drums: 1, bass: 1, vocals: 1, other: 1 });
    expect(anySoloed(mixer)).toBe(false);
  });

  it("mutes and unmutes one stem and leaves the others alone", () => {
    const muted = mixerReducer(fresh(), { type: "toggle-mute", kind: "bass" });
    expect(gainsOf(muted)).toEqual({ drums: 1, bass: 0, vocals: 1, other: 1 });
    const back = mixerReducer(muted, { type: "toggle-mute", kind: "bass" });
    expect(gainsOf(back).bass).toBe(1);
  });

  it("keeps the volume of a muted stem for when it is heard again", () => {
    let mixer = mixerReducer(fresh(), { type: "set-volume", kind: "vocals", volume: 0.4 });
    mixer = mixerReducer(mixer, { type: "toggle-mute", kind: "vocals" });
    expect(gainOf(mixer, find(mixer, "vocals"))).toBe(0);
    mixer = mixerReducer(mixer, { type: "toggle-mute", kind: "vocals" });
    expect(gainOf(mixer, find(mixer, "vocals"))).toBe(0.4);
  });

  it("plays only the soloed stems when one is soloed", () => {
    const solo = mixerReducer(fresh(), { type: "toggle-solo", kind: "drums" });
    expect(gainsOf(solo)).toEqual({ drums: 1, bass: 0, vocals: 0, other: 0 });
    expect(isSoloedOut(solo, find(solo, "bass"))).toBe(true);
    expect(isSoloedOut(solo, find(solo, "drums"))).toBe(false);
    const two = mixerReducer(solo, { type: "toggle-solo", kind: "bass" });
    expect(gainsOf(two)).toEqual({ drums: 1, bass: 1, vocals: 0, other: 0 });
    const none = mixerReducer(two, { type: "toggle-solo", kind: "drums" });
    const off = mixerReducer(none, { type: "toggle-solo", kind: "bass" });
    expect(gainsOf(off)).toEqual({ drums: 1, bass: 1, vocals: 1, other: 1 });
  });

  it("lets solo override mute", () => {
    let mixer = mixerReducer(fresh(), { type: "toggle-mute", kind: "drums" });
    mixer = mixerReducer(mixer, { type: "toggle-solo", kind: "drums" });
    expect(find(mixer, "drums").muted).toBe(true);
    expect(gainsOf(mixer).drums).toBe(1);
    // Without the solo the mute is back.
    mixer = mixerReducer(mixer, { type: "toggle-solo", kind: "drums" });
    expect(gainsOf(mixer).drums).toBe(0);
  });

  it("applies the volume to a soloed stem", () => {
    let mixer = mixerReducer(fresh(), { type: "set-volume", kind: "bass", volume: 0.25 });
    mixer = mixerReducer(mixer, { type: "toggle-solo", kind: "bass" });
    expect(gainsOf(mixer).bass).toBe(0.25);
  });

  it("keeps the volume between 0 and 1", () => {
    const loud = mixerReducer(fresh(), { type: "set-volume", kind: "bass", volume: 3 });
    expect(find(loud, "bass").volume).toBe(1);
    const quiet = mixerReducer(fresh(), { type: "set-volume", kind: "bass", volume: -2 });
    expect(find(quiet, "bass").volume).toBe(0);
  });

  it("ignores a volume that is not a number", () => {
    const mixer = fresh();
    expect(mixerReducer(mixer, { type: "set-volume", kind: "bass", volume: NaN })).toBe(mixer);
  });

  it("does not change the mixer it was given", () => {
    const mixer = fresh();
    const snapshot = JSON.stringify(mixer);
    mixerReducer(mixer, { type: "toggle-mute", kind: "bass" });
    mixerReducer(mixer, { type: "toggle-solo", kind: "bass" });
    expect(JSON.stringify(mixer)).toBe(snapshot);
  });

  it("resets every stem", () => {
    let mixer = mixerReducer(fresh(), { type: "toggle-solo", kind: "bass" });
    mixer = mixerReducer(mixer, { type: "set-volume", kind: "drums", volume: 0.1 });
    expect(mixerReducer(mixer, { type: "reset" })).toEqual(fresh());
  });
});
