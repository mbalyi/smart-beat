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
      title: "Add an empty lane",
      body: "New audio lane makes an empty lane to drop files on, record into or fill from the studio.",
      needsSong: true,
      show: MIXER,
      placement: "top",
    },
    {
      id: "import",
      target: "import-audio",
      title: "Import an audio file",
      body: "Import audio opens an mp3, m4a, wav, flac, ogg or aiff file as a new lane. You can also drag files onto the window; dropped on a lane, a file lands where you let go.",
      needsSong: true,
      show: MIXER,
      placement: "top",
    },
    {
      id: "stems",
      target: "import-audio",
      title: "Stems as lanes",
      body: "Separated a song into stems? On the stem page, Export stems › Add to a tab puts each stem you choose on a lane of its own, in an open tab or a new one. Each lane keeps the stem colour and is named after the stem and the model.",
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
      id: "band",
      target: "lanes-band",
      title: "Lanes under the tabs",
      body: "Click the eye on a lane to show it on the same bars as the notes. That needs the continuous layout, so the app switches to it and the Page layout waits until you hide the lanes again. The lane shows alone at first; turn on a track with its eye to put its tab above the lanes, so you can see the audio against the notes. Move, trim, split and fade clips there as in the track list. (Shown when a lane is on under the tabs.)",
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
