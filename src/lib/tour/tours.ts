import type { TourPanelRequest } from "@/lib/tour/tour-bus";
import type { TourId } from "@/lib/tour/feature-registry";

/**
 * The places a tour can point at. Each is a `data-tour` attribute on a real control, so a step
 * follows the control wherever it moves (no coordinates), and a missing one is skipped.
 */
export type TourTarget =
  | "open-file"
  | "score"
  | "play"
  | "practice"
  | "loop"
  | "speed-trainer"
  | "metronome"
  | "practice-view"
  | "tracks"
  | "instrument"
  | "edit"
  | "note-palette"
  | "history"
  | "mastering"
  | "record"
  | "help";

export interface TourStep {
  id: string;
  target: TourTarget;
  title: string;
  body: string;
  /** The step needs an open song: the tour opens the demo song first when there is none. */
  needsSong?: boolean;
  /** Panels to show (or Edit mode) before the step; put back when the tour ends. */
  show?: TourPanelRequest;
  /** Where the coach mark sits relative to the target. */
  placement?: "top" | "bottom" | "left" | "right" | "center";
}

export interface TourDefinition {
  id: TourId;
  title: string;
  /** Shown in Help › Tours. */
  description: string;
  steps: readonly TourStep[];
}

export const TOURS: Record<TourId, TourDefinition> = {
  main: {
    id: "main",
    title: "Quick tour",
    description: "From opening a song to playing and practising it.",
    steps: [
      {
        id: "open",
        target: "open-file",
        title: "Open a song",
        body: "Open a Guitar Pro, MuseScore, MusicXML or MIDI file, or drop one on the window. Next, we open a demo song to try things on.",
        placement: "bottom",
      },
      {
        id: "score",
        target: "score",
        title: "Your score",
        body: "Notation and tab for the current track. Click a bar to jump there.",
        needsSong: true,
        placement: "center",
      },
      {
        id: "play",
        target: "play",
        title: "Play it",
        body: "Press Play, or Space. The cursor follows the music; click a bar first to start from it.",
        needsSong: true,
        placement: "bottom",
      },
      {
        id: "practice",
        target: "practice",
        title: "Slow it down and loop",
        body: "Change the speed, or turn Loop on and drag across bars to repeat a hard part.",
        needsSong: true,
        placement: "bottom",
      },
      {
        id: "metronome",
        target: "metronome",
        title: "Metronome and count-in",
        body: "Keep time with a click, and count one bar in before you play.",
        needsSong: true,
        placement: "bottom",
      },
      {
        id: "practice-view",
        target: "practice-view",
        title: "Practice View",
        body: "Hide everything but the score and the playback controls, with your track in focus and the others turned down.",
        needsSong: true,
        placement: "bottom",
      },
      {
        id: "tracks",
        target: "tracks",
        title: "Tracks and mixer",
        body: "Pick a track, mute or solo it, set its volume and pan. Open it any time with the Mixer button.",
        needsSong: true,
        show: { mixer: true },
        placement: "top",
      },
      {
        id: "instrument",
        target: "instrument",
        title: "Instrument view",
        body: "See the notes on a fretboard, a keyboard or drum pads, and follow along as it plays.",
        needsSong: true,
        placement: "bottom",
      },
      {
        id: "edit",
        target: "edit",
        title: "Editing",
        body: "Edit mode lets you write notes. It has its own short tour under Help › Tours.",
        needsSong: true,
        placement: "bottom",
      },
      {
        id: "help",
        target: "help",
        title: "You are set",
        body: "Replay this tour, open the demo song or see the keyboard shortcuts any time from Help.",
        placement: "bottom",
      },
    ],
  },
  editing: {
    id: "editing",
    title: "Editing tour",
    description: "Write notes and drums, undo and redo, and work with tracks.",
    steps: [
      {
        id: "edit",
        target: "edit",
        title: "Edit mode",
        body: "Turn Edit mode on to write notes with the keyboard and mouse.",
        needsSong: true,
        placement: "bottom",
      },
      {
        id: "palette",
        target: "note-palette",
        title: "Note palette",
        body: "Pick a duration and a technique. On a drum track, the drum picker names each element, and Normalize drum notation tidies the staff.",
        needsSong: true,
        show: { editing: true },
        placement: "bottom",
      },
      {
        id: "history",
        target: "history",
        title: "Undo and redo",
        body: "Every edit can be undone, and redone.",
        needsSong: true,
        placement: "bottom",
      },
      {
        id: "tracks",
        target: "tracks",
        title: "Tracks",
        body: "Add a track, or open a track's menu to copy it to another instrument or normalize a drum track.",
        needsSong: true,
        show: { mixer: true },
        placement: "top",
      },
    ],
  },
  "speed-trainer": {
    id: "speed-trainer",
    title: "Speed Trainer tour",
    description: "Loop a passage and speed it up a little each time round.",
    steps: [
      {
        id: "loop",
        target: "loop",
        title: "Choose a passage",
        body: "Turn Loop on and drag across the bars to repeat, or pick a named section.",
        needsSong: true,
        placement: "bottom",
      },
      {
        id: "trainer",
        target: "speed-trainer",
        title: "Speed Trainer",
        body: "Start slowly and let each round of the loop go a little faster, up to your target. Stopping it puts the speed back to 100%.",
        needsSong: true,
        placement: "bottom",
      },
    ],
  },
  effects: {
    id: "effects",
    title: "Effects tour",
    description: "Guitar effects, the pedalboard and the mastering strip.",
    steps: [
      {
        id: "tracks",
        target: "tracks",
        title: "Effects per track",
        body: "Each track has volume, pan, EQ and effects. Open a track's menu to edit its effects in the pedalboard, where you drag them into order.",
        needsSong: true,
        show: { mixer: true },
        placement: "top",
      },
      {
        id: "mastering",
        target: "mastering",
        title: "Mastering",
        body: "The master strip sets the whole mix; its pedalboard button adds effects to everything.",
        needsSong: true,
        show: { mixer: true },
        placement: "top",
      },
    ],
  },
  "record-to-tab": {
    id: "record-to-tab",
    title: "Record to tab tour",
    description: "Record guitar, bass, piano or drums and get tab you can edit (beta).",
    steps: [
      {
        id: "record",
        target: "record",
        title: "Record to Tab",
        body: "Record yourself on guitar, bass, piano or drums, or use a recording. The result opens as a new, editable song. It is a beta: check the Limits on the start page.",
        needsSong: true,
        placement: "bottom",
      },
      {
        id: "settings",
        target: "help",
        title: "Choose your audio input",
        body: "Pick the microphone or audio interface in Help › Settings….",
        needsSong: true,
        placement: "bottom",
      },
    ],
  },
};

export const TOUR_LIST: readonly TourDefinition[] = Object.values(TOURS);
