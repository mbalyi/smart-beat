import type { TourDefinition } from "@/lib/tour/tour-types";

export const recordToTabTour: TourDefinition = {
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
};
