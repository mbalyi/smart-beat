import source from "@/demo/demo-song.atex?raw";

/** The demo song of the guided tour (#84): original, four tracks, 24 bars. See `scripts/make-demo-song.mjs`. */
export const DEMO_SONG_TITLE = "Smart Beat Demo";

export const demoSongFile = (): File =>
  new File([source], "demo-song.atex", { type: "text/plain" });
