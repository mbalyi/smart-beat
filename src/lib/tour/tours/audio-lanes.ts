import type { TourDefinition } from "@/lib/tour/tour-types";

/** The mixer with the track list, where the audio lanes sit. */
const MIXER = { mixer: true } as const;

export const audioLanesTour: TourDefinition = {
  id: "audio-lanes",
  title: "Audio lanes tour",
  description:
    "Add audio files on lanes, colour them, edit and split clips, and record audio takes.",
  steps: [
    {
      id: "intro",
      target: "score",
      title: "Audio next to the tab",
      body: "Audio lanes hold recordings, backing tracks and stems next to your tracks. A song can have several, each with its own colour, mix and effects.",
      needsSong: true,
      show: MIXER,
      placement: "center",
    },
    {
      id: "add",
      target: "add-audio-lane",
      title: "Add a lane",
      body: "Open an mp3, m4a, wav, flac, ogg or aiff file as a new lane, or drag files onto the window. Dropped on a lane, a file lands where you let go.",
      needsSong: true,
      show: MIXER,
      placement: "top",
    },
    {
      id: "color",
      target: "lane-color",
      title: "Colour each lane",
      body: "Lanes take the stem colours in turn: guitar violet, drums magenta, bass cyan, vocals yellow. Pick another here.",
      needsSong: true,
      show: MIXER,
      placement: "left",
    },
    {
      id: "effects",
      target: "lane-effects",
      title: "Effects on a lane",
      body: "Each lane has its own pedalboard, with the same effects and plugins as the tracks.",
      needsSong: true,
      show: MIXER,
      placement: "left",
    },
    {
      id: "clips",
      target: "tracks",
      title: "Edit the clips",
      body: "Drag a clip along its lane or onto another one, and drag its edges to trim it. Press S to split it at the dashed edit cursor, G to glue pieces back, ⌘D to duplicate. Double-click a lane for the editor with sync points, and Studio for every lane at once.",
      needsSong: true,
      show: MIXER,
      placement: "top",
    },
    {
      id: "record",
      target: "record-audio",
      title: "Record audio",
      body: "Record your playing as a plain take on a lane: from the playhead, punched into the selected bars, or looped with one take a pass. No tab is written.",
      needsSong: true,
      show: MIXER,
      placement: "top",
    },
  ],
};
