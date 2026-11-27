import type { TourDefinition } from "@/lib/tour/tour-types";

/** The mixer with the track list, where the lanes sit. */
const MIXER = { mixer: true } as const;

/** MIDI lanes, the MIDI editor, pad controllers and recording (ADR 0006). */
export const midiTour: TourDefinition = {
  id: "midi",
  title: "MIDI and pads tour",
  description:
    "Add a MIDI lane, draw and edit notes, connect a pad controller or keyboard, map its pads, and record what you play.",
  steps: [
    {
      id: "intro",
      target: "score",
      title: "Notes you can play and edit",
      body: "A MIDI lane holds notes instead of audio. It sounds with a General MIDI instrument, the drum kit, a pad bank of your own samples or a VST3 or CLAP instrument, through the lane's own effects.",
      needsSong: true,
      show: MIXER,
      placement: "center",
    },
    {
      id: "add",
      target: "add-midi-lane",
      title: "Add a MIDI lane",
      body: "New MIDI lane adds a lane with an empty four-bar clip at the position line and opens the MIDI editor on it.",
      needsSong: true,
      show: MIXER,
      placement: "top",
    },
    {
      id: "editor",
      target: "score",
      title: "The MIDI editor",
      body: "Draw notes with the pencil, drag them to move or lengthen them, and drag their top edge for velocity. Switch between the piano roll, the drum grid and the event list, snap to straight, triplet, dotted or swung grids, and quantize, humanize or transpose. Your playing is kept, so Unquantize always goes back.",
      needsSong: true,
      placement: "center",
    },
    {
      id: "pads",
      target: "score",
      title: "Your pad controller",
      body: "Plug in a pad controller, keyboard or electronic drum kit; it shows up in Settings › MIDI devices. The pad board lights the pad you hit, learns which note it sends and lets you choose what it plays: a drum, or a sample with its own tune, volume, pan, choke group and effect sends.",
      needsSong: true,
      placement: "center",
    },
    {
      id: "record",
      target: "score",
      title: "Record what you play",
      body: "The record icon on a MIDI lane arms it: you hear what you play straight away. Press Record, play along with the song, and Space keeps the take. Choose a new take, overdub or replace, loop the selected bars, and put the result on the lane, a new lane or straight into the tab.",
      needsSong: true,
      placement: "center",
    },
  ],
};
