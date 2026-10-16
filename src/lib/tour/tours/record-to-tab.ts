import type { TourDefinition } from "@/lib/tour/tour-types";

/** Every step after the first is drawn inside the Record to Tab dialog, which the tour opens. */
const inRecordDialog = { needsSong: true, show: { dialog: "record" }, inDialog: true } as const;

export const recordToTabTour: TourDefinition = {
  id: "record-to-tab",
  title: "Record to tab tour",
  description: "Record guitar, bass, piano or drums and get tab you can edit (beta).",
  // Started with the dialog already open: begin inside it.
  startAt: { selector: '[data-tour="record-dialog"][data-state="open"]', step: "instrument" },
  steps: [
    {
      id: "record",
      target: "record",
      title: "Record to Tab",
      body: "This red button opens Record to Tab: play guitar, bass, piano or drums and get notes you can edit.",
      needsSong: true,
      placement: "bottom",
    },
    {
      id: "instrument",
      target: "record-instrument",
      title: "Choose your instrument",
      body: "Pick Guitar, Bass, Piano or Drums. The tracks and settings below change to suit it.",
      ...inRecordDialog,
    },
    {
      id: "mode",
      target: "record-mode",
      title: "Recording mode",
      body: "Click: play along with the click from the start bar; the take replaces those bars on the track. Free: play at your own tempo and get a new song. File: use an MP3, WAV, FLAC or OGG recording.",
      ...inRecordDialog,
    },
    {
      id: "tuning",
      target: "record-track",
      title: "Guitar and bass: match the tuning",
      body: "Tune your guitar or bass to match the track's tuning, or choose New track and set the strings and tuning there.",
      ...inRecordDialog,
    },
    {
      id: "piano",
      target: "record-piano-model",
      title: "Piano: better notes",
      body: "With Piano chosen, pick High accuracy under Piano model and download it once. It finds nearly every note and runs on your computer.",
      ...inRecordDialog,
    },
    {
      id: "drums",
      target: "record-instrument",
      title: "Drums",
      body: "With Drums chosen, kick, snare and hi-hat are found well and go to a drum track. Toms and crashes are experimental.",
      ...inRecordDialog,
    },
    {
      id: "limits",
      target: "record-limits",
      title: "It's a beta",
      body: "This note lists what the chosen instrument can do and how accurate it is. Always check the result and correct it.",
      ...inRecordDialog,
    },
    {
      id: "start",
      target: "record-start",
      title: "Start recording",
      body: "When you're ready, press Record (or Make tab for a file). Recording stops when you press Stop or Space.",
      offerTours: true,
      ...inRecordDialog,
    },
  ],
};
