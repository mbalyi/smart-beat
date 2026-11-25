import type { TourDefinition } from "@/lib/tour/tour-types";

/** The Samples tab of the Inspector, open beside the lanes. */
const SAMPLES = { inspector: true, inspectorTab: "samples", mixer: true } as const;

export const sampleBrowserTour: TourDefinition = {
  id: "sample-browser",
  title: "Sample browser tour",
  description:
    "Link, import or unpack sample folders, audition the files and put them on an audio lane.",
  steps: [
    {
      id: "tab",
      target: "samples-tab",
      title: "Your samples, beside the lanes",
      body: "The Samples tab keeps your sample folders next to the tab, so you can hear a file and put it on a lane without hunting through a file chooser.",
      needsSong: true,
      show: SAMPLES,
      placement: "left",
    },
    {
      id: "add",
      target: "samples-add",
      title: "Bring samples in",
      body: "Add samples links a folder where it is, copies a whole folder into Smart Beat, or unpacks a .zip or .7z sample pack. Linking never moves or deletes your files.",
      needsSong: true,
      show: SAMPLES,
      placement: "left",
    },
    {
      id: "search",
      target: "samples-search",
      title: "Find a sound",
      body: "Type part of a name to narrow the list. Every word you type has to match.",
      needsSong: true,
      show: SAMPLES,
      placement: "left",
    },
    {
      id: "list",
      target: "samples-list",
      title: "Audition with the keys",
      body: "Click a sample or use the Up and Down keys to hear it. Space plays or stops. The preview has its own volume and never starts, stops or moves the song.",
      needsSong: true,
      show: SAMPLES,
      placement: "left",
    },
    {
      id: "insert",
      target: "samples-insert",
      title: "Put it on a lane",
      body: "Insert, Enter or a double-click places the sample at the position line, snapped to the grid, on the lane open in the editor or on a new lane. You can also drag a sample onto any lane.",
      needsSong: true,
      show: SAMPLES,
      placement: "left",
    },
  ],
};
