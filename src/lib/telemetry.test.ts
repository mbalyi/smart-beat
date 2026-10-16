import { getUsageSettings, setUsageSettings, soundFontCounterId, track } from "@/lib/telemetry";
import { mockTauri } from "@/test/tauri";

const tracked = (calls: ReturnType<typeof mockTauri>) =>
  calls.filter((call) => call.cmd === "track_event").map((call) => call.args);

describe("track", () => {
  it("does nothing in a browser", () => {
    expect(() => track("loop_on")).not.toThrow();
  });

  it("sends the event name and nothing else", () => {
    const calls = mockTauri();
    track("loop_on");
    expect(tracked(calls)).toEqual([{ event: "loop_on", format: null }]);
  });

  it("sends a known file format in lower case", () => {
    const calls = mockTauri();
    track("export", "PDF");
    track("open_file", "gp5");
    expect(tracked(calls)).toEqual([
      { event: "export", format: "pdf" },
      { event: "open_file", format: "gp5" },
    ]);
  });

  it("counts the event without a format the core would refuse", () => {
    const calls = mockTauri();
    track("export", "alphatex");
    track("open_file", "my song.gp5");
    expect(tracked(calls)).toEqual([
      { event: "export", format: null },
      { event: "open_file", format: null },
    ]);
  });

  it("only sends fixed details belonging to the event", () => {
    const calls = mockTauri();
    track("pedal_add", "amp_sim");
    track("plugin_add", "VST3");
    track("copy_to_instrument", "bass-4");
    track("record_to_tab", "drums");
    track("sound_library_import", "cab");
    track("pedal_add", "vst3");
    track("plugin_add", "/Library/Audio/Plugins/private.vst3");
    track("audio_input_change", "My audio interface");
    expect(tracked(calls)).toEqual([
      { event: "pedal_add", format: "amp_sim" },
      { event: "plugin_add", format: "vst3" },
      { event: "copy_to_instrument", format: "bass-4" },
      { event: "record_to_tab", format: "drums" },
      { event: "sound_library_import", format: "cab" },
      { event: "pedal_add", format: null },
      { event: "plugin_add", format: null },
      { event: "audio_input_change", format: null },
    ]);
  });

  it("sends the sound set, the instrument and the tour only from the fixed lists (#153)", () => {
    const calls = mockTauri();
    track("soundfont_select", "Musescore-General");
    track("play_soundfont", "custom");
    track("soundfont_download", "arachno");
    track("record_to_tab_start", "bass");
    track("record_to_tab_file", "drums");
    track("tour_finish", "speed-trainer");
    track("soundfont_select", "My Bank.sf2");
    track("play_soundfont", "stored:my-bank");
    track("soundfont_download", "custom");
    track("record_to_tab_start", "violin");
    track("tour_start", "my tour");
    track("drum_normalize", "pdf");
    expect(tracked(calls)).toEqual([
      { event: "soundfont_select", format: "musescore-general" },
      { event: "play_soundfont", format: "custom" },
      { event: "soundfont_download", format: "arachno" },
      { event: "record_to_tab_start", format: "bass" },
      { event: "record_to_tab_file", format: "drums" },
      { event: "tour_finish", format: "speed-trainer" },
      { event: "soundfont_select", format: null },
      { event: "play_soundfont", format: null },
      { event: "soundfont_download", format: null },
      { event: "record_to_tab_start", format: null },
      { event: "tour_start", format: null },
      { event: "drum_normalize", format: null },
    ]);
  });

  it("names a sound set by its fixed id, and an imported file only as custom", () => {
    expect(soundFontCounterId({ id: "sonivox" })).toBe("sonivox");
    expect(soundFontCounterId({ id: "fluidr3" })).toBe("fluidr3");
    expect(soundFontCounterId({ id: "stored:arachno", stored: true, catalogue: "arachno" })).toBe(
      "arachno",
    );
    expect(soundFontCounterId({ id: "stored:my-bank", stored: true, catalogue: null })).toBe(
      "custom",
    );
    expect(soundFontCounterId({ id: "stored:my-bank", stored: true })).toBe("custom");
  });

  it("never throws or rejects when the core fails", async () => {
    mockTauri({
      track_event: () => {
        throw { kind: "io", message: "disk on fire" };
      },
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    track("play");
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("usage settings", () => {
  it("are absent in a browser", async () => {
    expect(await getUsageSettings()).toBeNull();
  });

  it("are read from and written to the core", async () => {
    const calls = mockTauri();
    expect(await getUsageSettings()).toEqual({ enabled: true, available: false, noticeSeen: true });
    expect(await setUsageSettings({ enabled: false })).toMatchObject({ enabled: false });
    expect(calls.find((c) => c.cmd === "set_usage_settings")?.args).toEqual({
      enabled: false,
      noticeSeen: null,
    });
    expect(await setUsageSettings({ noticeSeen: false })).toEqual({
      enabled: false,
      available: false,
      noticeSeen: false,
    });
  });
});
